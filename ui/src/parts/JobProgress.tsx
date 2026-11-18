import { useEffect, useLayoutEffect, useRef } from "react";
import { formatBytes } from "../format";
import { announceJob, stopJob, useJobByOperation, type Job } from "../jobs";
import { Button } from "./Button";

/** The button's word: "Cancel" (what is not done is not kept), or "Stop" where what is done stays, as saving a folder's files draws it. */
type StopWord = "Cancel" | "Stop";

/**
 * 9b's progress for one running job: what it is doing, the bar, the bytes in words ("1.2 GB of 3 GB"), the sentence about the laptop, and Cancel.
 * It draws what the job store knows of `operation` (ids and two numbers from the shell, nothing else) and nothing once the job is gone.
 *
 * Three layouts, as drawn:
 * - `card` (the default; a job's card over the list, or in the search box): one card holds the heading, the sentence, the bar, the figure, the
 *   line about the laptop and Cancel.
 * - `panel` (9b, 9f's progress, 22b, and 33b behind its question): the sentence above, a card holding only the name with the count or per cent
 *   beside it, the bar and the figure, and the line about the laptop under the card. Cancel is the panel's own, in its foot: the screen puts a
 *   `JobStop` there.
 * - `step` (24c, a full-window step under its own heading): no card; the name with its per cent beside it, the bar, the figure, the line about
 *   the laptop, then Cancel.
 *
 * Cancel stops that one operation (`stopJob`) and says "Cancelling…" until the job's own answer comes; `onStop` is told once it is pressed. The
 * bar is a progress bar for a screen reader, with its value as words. It has no live region of its own: the start is said in the page's
 * always-present spoken place (`announceJob`, keyed by the operation so a second job with the same words is heard too), the end is the result's
 * own message, and nothing is said between, so ten figures a second don't become ten announcements. The fill's width is set from script, as a
 * style property the page's policy allows; the markup has no `style` of its own.
 *
 * A batch of files says which file is going in (`now`: its name and "2 of 3", both worked out by the screen from the sizes it holds). A block
 * that sits under a heading already naming the job leaves the name out (`heading={false}`: the card's heading, or the first line's name in the
 * other layouts); it is still named for a screen reader. In the `panel` layout, `stopWord` and `onStop` belong to the foot's `JobStop`.
 */
export function JobProgress({
  operation,
  label,
  sentence,
  warning,
  now,
  heading = true,
  stopWord = "Cancel",
  figures = "bytes",
  layout = "card",
  countsTwice = false,
  onStop,
}: {
  operation: number;
  /** What the job is doing, as its heading and the bar's name: "Adding a file". */
  label: string;
  /** One line under the heading: "Adding a file to your vault." */
  sentence?: string;
  /** The line about the laptop, from 9b. */
  warning?: string;
  /** The file going in now and its place in the batch, from what the screen holds: `{ name, place: "2 of 3" }`. */
  now?: { name: string; place: string } | null;
  /** Whether the block names the job itself: the card's heading, or the first line's name (a batch's first line names its file either way). */
  heading?: boolean;
  stopWord?: StopWord;
  /** What the figure under the bar says: the bytes in words ("1.2 GB of 3 GB", the default), or the per cent alone ("48%", as 24c draws it). */
  figures?: "bytes" | "percent";
  layout?: "card" | "panel" | "step";
  /**
   * The engine counts each byte twice (a backup: written, then read back to check it), so the bytes in words are half of its numbers: the
   * backup's own size, as 22b draws it. The per cent is of the whole job.
   */
  countsTwice?: boolean;
  onStop?: () => void;
}) {
  const job = useJobByOperation(operation);
  const fill = useRef<HTMLSpanElement>(null);
  const counted = job !== null && (job.total > 0 || job.finished);
  // A whole number of per cent, never past 100 and never rounded up to it before the work is done.
  const percent = job === null || job.total === 0 ? null : Math.min(100, Math.floor((job.done / job.total) * 100 + 1e-9));
  useLayoutEffect(() => {
    if (fill.current !== null) fill.current.style.width = `${String(percent ?? 0)}%`;
  });
  // The start is said once, in the page's always-present spoken place, after this has mounted; see `announceJob`.
  const shown = job !== null;
  useEffect(() => {
    if (shown) announceJob(`${label} started.`, operation);
  }, [shown, label, operation]);
  if (job === null) return null;
  const shownPercent = `${String(percent ?? (job.finished ? 100 : 0))}%`;
  const share = countsTwice ? 2 : 1;
  // The job store already keeps `done` within `total`.
  const bytes = `${formatBytes(job.done / share)} of ${formatBytes(job.total / share)}`;
  const bar = (text: string) => (
    <div className="prog" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={text}>
      <span ref={fill} />
    </div>
  );

  if (layout === "card") {
    const words = counted ? (figures === "percent" ? shownPercent : bytes) : "Starting…";
    return (
      // `data-operation` says whose card it is: when a job ends, focus moves only if it was in that job's own card (`takeJobFocus`).
      <section className="ask job" aria-label={label} data-operation={operation}>
        {heading ? <p className="jt">{label}</p> : null}
        {sentence === undefined ? null : <p className="js">{sentence}</p>}
        {now === undefined || now === null ? null : (
          <p className="jn">
            <b>{now.name}</b>
            <span>{now.place}</span>
          </p>
        )}
        {bar(words)}
        <p className="pnum">{words}</p>
        {warning === undefined ? null : <p className="fwarn">{warning}</p>}
        <div className="ask-acts">
          <StopButton job={job} operation={operation} stopWord={stopWord} onStop={onStop} />
        </div>
      </section>
    );
  }

  // The first line: the file going in and its place in the batch, or the job's name and its per cent.
  const batch = now !== undefined && now !== null;
  const beside = batch ? now.place : counted ? shownPercent : null;
  const figure = !counted ? "Starting…" : figures === "bytes" ? bytes : null;
  const said = [batch ? null : beside, figure].filter((part): part is string => part !== null).join(", ");
  const block = (
    <section className={layout === "panel" ? "ask job jcard" : "job jstep"} aria-label={label} data-operation={operation}>
      <p className="jhead">
        {/* Under a heading that already names the job (Open a backup's full-window step), the line keeps only its per cent. */}
        {batch ? <b>{now.name}</b> : heading ? <b>{label}</b> : null}
        {beside === null ? null : <span>{beside}</span>}
      </p>
      {bar(said)}
      {figure === null ? null : <p className="pnum">{figure}</p>}
      {layout === "step" ? (
        <>
          {warning === undefined ? null : <p className="fwarn">{warning}</p>}
          <div className="ask-acts">
            <StopButton job={job} operation={operation} stopWord={stopWord} onStop={onStop} />
          </div>
        </>
      ) : null}
    </section>
  );
  if (layout === "step") return block;
  return (
    <>
      {sentence === undefined ? null : <p className="psub">{sentence}</p>}
      {block}
      {warning === undefined ? null : <p className="fwarn">{warning}</p>}
    </>
  );
}

/**
 * The Cancel (or Stop) of a job shown in a panel's `panel` layout: it goes in the panel's foot, as drawn, and draws nothing once the job is gone.
 */
export function JobStop({ operation, stopWord = "Cancel", onStop }: { operation: number; stopWord?: StopWord; onStop?: () => void }) {
  const job = useJobByOperation(operation);
  if (job === null) return null;
  return <StopButton job={job} operation={operation} stopWord={stopWord} onStop={onStop} />;
}

function StopButton({ job, operation, stopWord, onStop }: { job: Job; operation: number; stopWord: StopWord; onStop?: (() => void) | undefined }) {
  return (
    <Button
      aria-disabled={job.stopping ? true : undefined}
      onClick={() => {
        if (job.stopping) return;
        void stopJob(operation);
        onStop?.();
      }}
    >
      {job.stopping ? (stopWord === "Stop" ? "Stopping…" : "Cancelling…") : stopWord}
    </Button>
  );
}
