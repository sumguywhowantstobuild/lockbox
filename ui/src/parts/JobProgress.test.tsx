// 9b's progress part: the bar, the bytes in words, and Cancel. The screens' own tests (FileActions) cover it inside a real window.
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectNoAxe } from "../testing/axe";
import { readBeside } from "../testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

type Handler = (event: { payload: unknown }) => void;
let jobs: typeof import("../jobs");
let JobProgress: typeof import("./JobProgress").JobProgress;
let JobStop: typeof import("./JobProgress").JobStop;
const handlers = new Map<string, Handler[]>();

function emit(event: string, payload: unknown): void {
  act(() => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  });
}

const GB = 1024 ** 3;
const SESSION = { type: "session", session: 3, generation: 7 } as const;

/** What the page's spoken place holds for the jobs right now. */
function spoken(): string {
  const { result } = renderHook(() => jobs.useJobAnnouncement());
  return result.current;
}

/** Starts a job for a request, as the shell does, and gives its operation. */
function start(operation: number, kind = "import"): number {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", { request, operation, scope: SESSION, kind });
  return request;
}

function move(operation: number, done: number, total: number, finished = false, kind = "import"): void {
  emit("lockbox://progress", { operation, scope: SESSION, kind, done, total, finished });
}

beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  listen.mockReset();
  handlers.clear();
  listen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return Promise.resolve(() => undefined);
  });
  const bridge = await import("../bridge");
  jobs = await import("../jobs");
  ({ JobProgress, JobStop } = await import("./JobProgress"));
  invoke.mockResolvedValueOnce({ session: 3, generation: 7, data: "info" });
  await bridge.open("unlock_vault", { id: 1, password: "x" });
  await jobs.startJobs();
});

afterEach(() => {
  cleanup();
});

test("progress_bar_can_say_the_per_cent_alone_as_the_restore_draws_it", () => {
  start(1, "restore");
  render(<JobProgress operation={1} label="Checking and unpacking" figures="percent" />);
  expect(screen.getByText("Starting…")).toBeTruthy();
  move(1, 48, 100, false, "restore");
  expect(screen.getByText("48%")).toBeTruthy();
  expect(screen.queryByText(/ of /)).toBeNull();
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("48");
  expect(bar.getAttribute("aria-valuetext")).toBe("48%");
  // Never rounded up to 100 before the work is done.
  move(1, 999, 1000, false, "restore");
  expect(screen.getByText("99%")).toBeTruthy();
});

test("progress_block_is_laid_out_as_drawn", async () => {
  // 22b, 9b, 9f's progress and 33b behind its question: in a panel, the sentence sits above the card, the card holds only the name, the count
  // or per cent and the bar with its figure, the line about the laptop sits under the card, and Cancel is the panel's own, in its foot.
  start(1, "backup");
  const { container } = render(
    <>
      <JobProgress operation={1} label="Backing up My vault" layout="panel" sentence="For My vault." warning="Keep the laptop open." />
      <footer>
        <JobStop operation={1} />
      </footer>
    </>,
  );
  move(1, 61, 100, false, "backup");
  const card = screen.getByRole("region", { name: "Backing up My vault" });
  const head = card.querySelector(".jhead");
  expect(head?.textContent).toBe("Backing up My vault61%");
  expect(card.contains(screen.getByRole("progressbar"))).toBe(true);
  expect(card.textContent).not.toContain("For My vault.");
  expect(card.textContent).not.toContain("Keep the laptop open.");
  expect(card.querySelector("button")).toBeNull();
  const sentence = screen.getByText("For My vault.");
  const warning = screen.getByText("Keep the laptop open.");
  expect(sentence.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The foot's Cancel stops this one operation.
  const stop = within(container.querySelector("footer") as HTMLElement).getByRole("button", { name: "Cancel" });
  invoke.mockResolvedValueOnce(null);
  fireEvent.click(stop);
  expect(invoke).toHaveBeenLastCalledWith("cancel_operation", { operation: 1, scope: SESSION });
  expect(await within(container.querySelector("footer") as HTMLElement).findByRole("button", { name: "Cancelling…" })).toBeTruthy();
  // A batch names the file going in and its place, where a single job says its per cent.
  cleanup();
  start(2);
  render(<JobProgress operation={2} label="Adding files" layout="panel" now={{ name: "design-files-demo.zip", place: "2 of 3" }} />);
  move(2, 1.3 * GB, 3.2 * GB);
  expect(screen.getByRole("region", { name: "Adding files" }).querySelector(".jhead")?.textContent).toBe("design-files-demo.zip2 of 3");
  expect(screen.getByText("1.3 GB of 3.2 GB")).toBeTruthy();
});

test("backup_bar_shows_the_percent_and_the_backups_own_size", () => {
  // The engine counts a backup's bytes twice (written, then read back to check them), so the figure is half of its numbers: the backup's own
  // size, as 22b draws it. The per cent is of the whole job, and never passes it.
  start(1, "backup");
  render(<JobProgress operation={1} label="Backing up My vault" layout="panel" countsTwice />);
  const MB = 1024 ** 2;
  const size = Math.round(1.2 * GB);
  move(1, 2 * 750 * MB, 2 * size, false, "backup");
  expect(screen.getByText("750 MB of 1.2 GB")).toBeTruthy();
  expect(screen.getByText("61%")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("61%, 750 MB of 1.2 GB");
  // The store keeps what is done within the whole, so the halved words never pass it either.
  move(1, 3 * size, 2 * size, false, "backup");
  expect(screen.getByText("1.2 GB of 1.2 GB")).toBeTruthy();
  expect(screen.getByText("100%")).toBeTruthy();
});

test("restore_bar_keeps_its_percent_beside_the_name", () => {
  // 24c, a full-window step: no card, the name and its per cent on one line over the bar, the line about the laptop, then Cancel.
  start(1, "restore");
  render(<JobProgress operation={1} label="Checking and unpacking" layout="step" figures="percent" warning="Keep the laptop open." />);
  move(1, 48, 100, false, "restore");
  const block = screen.getByRole("region", { name: "Checking and unpacking" });
  expect(block.classList.contains("ask")).toBe(false);
  expect(block.querySelector(".jhead")?.textContent).toBe("Checking and unpacking48%");
  // The per cent is said once, beside the name, not again under the bar.
  expect(screen.getAllByText("48%")).toHaveLength(1);
  const parts = [block.querySelector(".jhead"), screen.getByRole("progressbar"), screen.getByText("Keep the laptop open."), screen.getByRole("button", { name: "Cancel" })];
  for (let i = 1; i < parts.length; i += 1) {
    expect((parts[i - 1] as Node).compareDocumentPosition(parts[i] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  // Under a heading that already names the job (Open a backup's step, "Opening …"), the first line keeps only its per cent and the figure.
  cleanup();
  start(2, "open_backup");
  render(<JobProgress operation={2} label="Opening demo.petalock-backup" heading={false} layout="step" stopWord="Stop" />);
  move(2, 750 * 1024 ** 2, Math.round(1.2 * GB), false, "open_backup");
  const opening = screen.getByRole("region", { name: "Opening demo.petalock-backup" });
  expect(opening.querySelector(".jhead")?.textContent).toBe("61%");
  expect(screen.getByText("750 MB of 1.2 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("progress_bar_shows_done_and_total_in_words", () => {
  start(1);
  render(<JobProgress operation={1} label="Adding a file" />);
  move(1, 1.2 * GB, 3 * GB);
  expect(screen.getByText("1.2 GB of 3 GB")).toBeTruthy();
  move(1, 3 * GB, 3 * GB);
  expect(screen.getByText("3 GB of 3 GB")).toBeTruthy();
  // Before the first figure there is nothing to count yet, and the bar says so in words instead of "0 B of 0 B".
  cleanup();
  start(2);
  render(<JobProgress operation={2} label="Adding a file" />);
  expect(screen.getByText("Starting…")).toBeTruthy();
});

test("the_bar_width_is_set_by_script_and_never_past_the_whole", () => {
  start(1);
  render(<JobProgress operation={1} label="Adding a file" />);
  const bar = screen.getByRole("progressbar");
  const fill = bar.querySelector("span") as HTMLElement;
  move(1, 1, 4);
  expect(fill.style.width).toBe("25%");
  expect(fill.hasAttribute("style")).toBe(true); // a style property set from script, which the policy allows
  move(1, 9, 4);
  expect(fill.style.width).toBe("100%");
  // The part's source writes no `style=` in markup and no `<style>` element.
  const source = readBeside(import.meta.url, "./JobProgress.tsx");
  expect(source).not.toMatch(/style=|<style/);
});

test("progress_bar_is_announced_without_flooding", () => {
  start(1);
  const { container } = render(<JobProgress operation={1} label="Adding a file" />);
  const bar = screen.getByRole("progressbar", { name: "Adding a file" });
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("100");
  move(1, 1.2 * GB, 3 * GB);
  expect(bar.getAttribute("aria-valuenow")).toBe("40");
  expect(bar.getAttribute("aria-valuetext")).toBe("1.2 GB of 3 GB");
  // The part brings no live region of its own (a region that mounts with its text is not spoken): the start goes to the page's spoken place,
  // once, and nothing is said between however often the figures move.
  expect(container.querySelectorAll("[aria-live], [role='status'], [role='alert']")).toHaveLength(0);
  expect(spoken()).toBe("Adding a file started.");
  const said: string[] = [];
  for (let step = 1; step <= 20; step += 1) {
    move(1, (step * 3 * GB) / 20, 3 * GB);
    said.push(spoken());
  }
  expect(new Set(said)).toEqual(new Set(["Adding a file started."]));
});

// Task 2's carried item R1: two jobs whose start words are the same each get their own spoken update, because the update is keyed by the
// operation (a live region says what is added to it, and text that is the same as before is not a change a screen reader notices).
test("two_starts_with_the_same_words_are_both_spoken", () => {
  const place = renderHook(() => ({ said: jobs.useJobAnnouncement(), key: jobs.useJobAnnouncementKey() }));
  start(1);
  render(<JobProgress operation={1} label="Adding files" />);
  expect(place.result.current.said).toBe("Adding files started.");
  const first = place.result.current.key;
  expect(first).toBe(1);
  // A second job, with the same label, starts later: the words are the same, and the update is not.
  start(2);
  render(<JobProgress operation={2} label="Adding files" />);
  expect(place.result.current.said).toBe("Adding files started.");
  expect(place.result.current.key).toBe(2);
  expect(place.result.current.key).not.toBe(first);
});

test("the_spoken_place_is_a_new_element_for_each_start", async () => {
  // The always-present place of the message stack draws the update under a key: a new job's start is a new element, and so is heard.
  const { ToastStack } = await import("./Toast");
  start(1);
  const { container } = render(
    <>
      <ToastStack />
      <JobProgress operation={1} label="Adding files" />
    </>,
  );
  const before = container.querySelector(".tstack [role='status'] .sr");
  expect(before?.textContent).toBe("Adding files started.");
  start(2);
  render(<JobProgress operation={2} label="Adding files" />);
  const after = container.querySelector(".tstack [role='status'] .sr");
  expect(after?.textContent).toBe("Adding files started.");
  expect(after).not.toBe(before);
});

test("stop_calls_cancel_for_that_operation", async () => {
  start(1);
  const stopped = vi.fn();
  render(<JobProgress operation={1} label="Adding a file" onStop={stopped} />);
  invoke.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(invoke).toHaveBeenLastCalledWith("cancel_operation", { operation: 1, scope: SESSION });
  expect(stopped).toHaveBeenCalledOnce();
  // It says it is stopping, and a second press sends nothing more.
  const again = await screen.findByRole("button", { name: "Cancelling…" });
  expect(again.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(again);
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_operation")).toHaveLength(1);
});

test("two_jobs_at_once_each_stop_their_own", () => {
  start(10, "import");
  start(20, "save_copy");
  render(
    <>
      <JobProgress operation={10} label="Adding a file" />
      <JobProgress operation={20} label="Saving a copy" />
    </>,
  );
  invoke.mockResolvedValue(null);
  const cancels = screen.getAllByRole("button", { name: "Cancel" });
  expect(cancels).toHaveLength(2);
  fireEvent.click(cancels[1] as HTMLElement);
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_operation")).toEqual([
    ["cancel_operation", { operation: 20, scope: SESSION }],
  ]);
  fireEvent.click(cancels[0] as HTMLElement);
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_operation")).toEqual([
    ["cancel_operation", { operation: 20, scope: SESSION }],
    ["cancel_operation", { operation: 10, scope: SESSION }],
  ]);
});

test("a_job_that_is_gone_draws_nothing", () => {
  const { container } = render(<JobProgress operation={404} label="Adding a file" />);
  expect(container.textContent).toBe("");
});

test("job_progress_has_no_axe_violations", async () => {
  start(1);
  const { container } = render(
    <JobProgress operation={1} label="Adding a file" sentence="Adding a file to your vault." warning="Keep the laptop open." />,
  );
  move(1, 1.2 * GB, 3 * GB);
  await expectNoAxe(container);
});
