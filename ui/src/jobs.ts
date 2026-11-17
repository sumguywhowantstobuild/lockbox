// The page's job store (Plan 4B Task 2). A long job (a file added or saved, and the backups later tasks add) is started by a command that took
// a `request` number the page chose; the shell tells the page which operation that became with `lockbox://job-started` (the operation never
// comes in an answer, since an answer arrives after the job has ended and its Cancel would have nothing to stop), and then sends
// `lockbox://progress`. This store ties them together by `request`, never by kind or session, so two jobs at once each get their own Cancel.
//
// A job belongs to a scope (a session at its generation, or the launch's lock epoch). Whatever the shell sends for a scope that has gone is
// dropped: a lock takes its vault's jobs off the screen, a new epoch takes the launch's. Only ids and two numbers pass through here: never a
// path, a name or a value.
import { useEffect, useSyncExternalStore } from "react";
import * as api from "./api";
import type { JobKind, JobScope, JobStartedEvent, LockEpochEvent, LockedEvent } from "./api";

/** What the page knows of one running job. `done` never passes `total`; `total` is 0 until the first figure. */
export interface Job {
  request: number;
  operation: number;
  scope: JobScope;
  kind: JobKind;
  done: number;
  total: number;
  /** The shell's last word on it: the job has ended, for whatever reason. */
  finished: boolean;
  /** Cancel was pressed and sent: it is stopping. */
  stopping: boolean;
}

/** How long a `job-started` for a request nobody waits for yet is kept, in milliseconds. */
const EARLY_MS = 1000;

const byOperation = new Map<number, Job>();
const byRequest = new Map<number, number>();
const waiting = new Set<number>();
/** Requests whose stop was asked for before the page knew their operation: the stop goes out the moment `job-started` names it. */
const cancelWhenKnown = new Set<number>();
const early = new Map<number, { event: JobStartedEvent; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
let counter = 0;
let lastEpoch = 0;
let spoken = "";
let spokenKey = 0;
let started: Promise<void> | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isScope(value: unknown): value is JobScope {
  if (!isRecord(value)) return false;
  if (value.type === "session") return typeof value.session === "number" && typeof value.generation === "number";
  return value.type === "launch" && typeof value.epoch === "number";
}

function sameScope(a: JobScope, b: JobScope): boolean {
  if (a.type === "session") return b.type === "session" && a.session === b.session && a.generation === b.generation;
  return b.type === "launch" && a.epoch === b.epoch;
}

/** Whether the scope is still the one in force: the bridge holds the session's generation, or the launch's epoch is not older than the last one heard. */
function isCurrent(scope: JobScope): boolean {
  return scope.type === "session" ? api.isSessionCurrent(scope.session, scope.generation) : scope.epoch >= lastEpoch;
}

function remove(operation: number): void {
  const job = byOperation.get(operation);
  if (job === undefined) return;
  byOperation.delete(operation);
  if (byRequest.get(job.request) === operation) byRequest.delete(job.request);
  notify();
}

function dropWhere(gone: (job: Job) => boolean): void {
  for (const job of [...byOperation.values()]) if (gone(job)) remove(job.operation);
}

function accept(event: JobStartedEvent): void {
  if (!isCurrent(event.scope)) return;
  byOperation.set(event.operation, {
    request: event.request,
    operation: event.operation,
    scope: event.scope,
    kind: event.kind,
    done: 0,
    total: 0,
    finished: false,
    stopping: false,
  });
  byRequest.set(event.request, event.operation);
  notify();
  // A stop that was asked for while this was not yet known goes out now, for the operation the event names.
  if (cancelWhenKnown.delete(event.request)) void stopJob(event.operation);
}

function takeStarted(event: unknown): void {
  if (!isRecord(event) || typeof event.request !== "number" || typeof event.operation !== "number" || typeof event.kind !== "string") return;
  if (!isScope(event.scope)) return;
  const known = event as unknown as JobStartedEvent;
  if (waiting.has(known.request)) {
    accept(known);
    return;
  }
  // Not waited for yet (the screen that asked has not mounted its hook): kept for a second, then dropped.
  const older = early.get(known.request);
  if (older !== undefined) clearTimeout(older.timer);
  const timer = setTimeout(() => {
    early.delete(known.request);
  }, EARLY_MS);
  early.set(known.request, { event: known, timer });
}

function takeProgress(event: unknown): void {
  if (!isRecord(event) || typeof event.operation !== "number" || typeof event.done !== "number" || typeof event.total !== "number") return;
  if (!isScope(event.scope) || typeof event.finished !== "boolean") return;
  const job = byOperation.get(event.operation);
  if (job === undefined) return;
  // What has gone stale is dropped, and so is an event that names another scope than the job's own.
  if (!isCurrent(job.scope)) {
    remove(job.operation);
    return;
  }
  if (!sameScope(job.scope, event.scope) || job.finished) return;
  const total = Math.max(0, event.total);
  const done = Math.min(Math.max(0, event.done), total);
  byOperation.set(job.operation, { ...job, done, total, finished: event.finished });
  notify();
}

function takeLocked(event: LockedEvent): void {
  dropWhere((job) => job.scope.type === "session" && job.scope.session === event.session && job.scope.generation < event.generation);
}

function takeEpoch(event: LockEpochEvent): void {
  if (typeof event.epoch !== "number") return;
  const before = lastEpoch;
  lastEpoch = Math.max(lastEpoch, event.epoch);
  dropWhere((job) => job.scope.type === "launch" && job.scope.epoch < lastEpoch);
  if (lastEpoch !== before) notify();
}

/** The last lock epoch the shell announced (0 before any): a screen that holds typed text follows it and wipes the text when it moves. */
export function currentLockEpoch(): number {
  return lastEpoch;
}

/** The lock epoch as a screen reads it: it changes (and the screen draws again) on every `lockbox://lock-epoch`, even with no vault open. */
export function useLockEpoch(): number {
  return useSyncExternalStore(subscribe, currentLockEpoch);
}

/**
 * Starts listening (once). Each listener is separate: one that cannot be set up costs only what it carries (no bar), never the job itself,
 * which the screens still show as 4A's "working" words from `lockbox://busy`.
 */
export function startJobs(): Promise<void> {
  started ??= (async () => {
    const listens: (() => Promise<unknown>)[] = [
      () => api.onJobStarted(takeStarted),
      () => api.onProgress(takeProgress),
      () => api.onLocked(takeLocked),
      () => api.onLockEpoch(takeEpoch),
    ];
    for (const listen of listens) {
      try {
        await listen();
      } catch {
        // Without this one the page shows less; the shell's own work and its answers are unchanged.
      }
    }
  })();
  return started;
}

/** A new request number for a long command: a counter, unique in the page's run, and the page is now waiting for that request's job. */
export function nextRequest(): number {
  counter += 1;
  waiting.add(counter);
  return counter;
}

/** The page waits for `request`'s job (a screen's hook has mounted): a `job-started` kept for less than a second is taken now. */
export function expectRequest(request: number): void {
  waiting.add(request);
  const held = early.get(request);
  if (held === undefined) return;
  clearTimeout(held.timer);
  early.delete(request);
  accept(held.event);
}

/** The command that took `request` has answered: its job is over, whatever it came to, and the page forgets it. */
export function releaseRequest(request: number): void {
  waiting.delete(request);
  // A stop still waiting for its `job-started` goes with the request: the answer came first, so there is nothing left to stop.
  cancelWhenKnown.delete(request);
  const operation = byRequest.get(request);
  if (operation !== undefined) remove(operation);
  // What the start said has done its work; the end is said by the result the screen shows ("File added.", "Nothing was added.").
  if (byOperation.size === 0 && spoken !== "") {
    spoken = "";
    spokenKey = 0;
    notify();
  }
}

/**
 * Says a job has started, in the page's one always-present spoken place (the message stack's live region, `useJobAnnouncement`). A bar that
 * brought its own live region would be a new region, which a screen reader does not speak the first text of; this one is already on the
 * page when the text changes. Only the start is said here, once: progress is never spoken, and the end is the result's own message.
 */
export function announceJob(text: string, operation: number): void {
  spoken = text;
  spokenKey = operation;
  notify();
}

/** What the page's spoken place holds for the jobs: the last start, until the job's command has answered. */
export function useJobAnnouncement(): string {
  return useSyncExternalStore(subscribe, () => spoken);
}

/**
 * Whose start the spoken place holds: the operation. The place draws its text under this key, so two jobs whose start words are the same (two
 * batches in two vaults, "Adding files started.") are two updates, and the second is heard: a live region says what is added to it, and text that
 * is the same as before is not a change.
 */
export function useJobAnnouncementKey(): number {
  return useSyncExternalStore(subscribe, () => spokenKey);
}

export function jobOfRequest(request: number): Job | null {
  const operation = byRequest.get(request);
  return operation === undefined ? null : (byOperation.get(operation) ?? null);
}

export function jobOfOperation(operation: number): Job | null {
  return byOperation.get(operation) ?? null;
}

/**
 * Cancel was pressed: asks the shell to stop that one operation, in the scope it was started in. It says "stopping" at once, and a second press
 * sends nothing. A refusal (the job is over, or its scope has gone) shows nothing: the job ends with its own answer.
 */
export async function stopJob(operation: number): Promise<void> {
  const job = byOperation.get(operation);
  if (job === undefined || job.stopping || job.finished) return;
  byOperation.set(operation, { ...job, stopping: true });
  notify();
  try {
    await api.cancelOperation(operation, job.scope);
  } catch {
    // Nothing was running to stop.
  }
}

/**
 * Stops whatever `request` became, even if the page does not yet know: a job the page has heard of is stopped now (`stopJob`); one it has not (the
 * command has begun, its `job-started` has not come) is stopped the moment that event names it. A request whose answer has already come (or that
 * the page never waited for) has nothing to stop, so nothing is kept for it; one whose answer comes before the event has its wish dropped with it.
 */
export function cancelRequest(request: number): void {
  const operation = byRequest.get(request);
  if (operation !== undefined) void stopJob(operation);
  else if (waiting.has(request)) cancelWhenKnown.add(request);
}

/** The job a command's `request` became, once the shell has said so; `null` until then and after it ends. */
export function useJob(request: number | null): Job | null {
  useEffect(() => {
    if (request !== null) expectRequest(request);
  }, [request]);
  return useSyncExternalStore(subscribe, () => (request === null ? null : jobOfRequest(request)));
}

/** The job with this operation number, as the progress part draws it. */
export function useJobByOperation(operation: number | null): Job | null {
  return useSyncExternalStore(subscribe, () => (operation === null ? null : jobOfOperation(operation)));
}

/** Forgets everything, for the tests' fresh start. */
export function resetJobsForTests(): void {
  byOperation.clear();
  byRequest.clear();
  waiting.clear();
  cancelWhenKnown.clear();
  for (const { timer } of early.values()) clearTimeout(timer);
  early.clear();
  counter = 0;
  lastEpoch = 0;
  spoken = "";
  spokenKey = 0;
  started = undefined;
  notify();
}
