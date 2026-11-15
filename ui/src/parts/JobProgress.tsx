import { useEffect, useLayoutEffect, useRef } from "react";
import { formatBytes } from "../format";
import { announceJob, stopJob, useJobByOperation } from "../jobs";
import { Button } from "./Button";

/**
 * 9b's progress for one running job: what it is doing, the bar, the bytes in words ("1.2 GB of 3 GB"), the sentence about the laptop, and Cancel.
 * It draws what the job store knows of `operation` (ids and two numbers from the shell, nothing else) and nothing once the job is gone.
 *
 * Cancel stops that one operation (`stopJob`) and says "Cancelling…" until the job's own answer comes; `onStop` is told once it is pressed. The
 * bar is a progress bar for a screen reader, with its value as words. It has no live region of its own: the start is said in the page's
 * always-present spoken place (`announceJob`), the end is the result's own message, and nothing is said between, so ten figures a second
 * don't become ten announcements. The fill's width is set from script, as a style property the
 * page's policy allows; the markup has no `style` of its own.
 */
export function JobProgress({
  operation,
  label,
  sentence,
  warning,
  onStop,
}: {
  operation: number;
  /** What the job is doing, as its heading and the bar's name: "Adding a file". */
  label: string;
  /** One line under the heading: "Adding a file to your vault." */
  sentence?: string;
  /** The line about the laptop, from 9b. */
  warning?: string;
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
    if (shown) announceJob(`${label} started.`);
  }, [shown, label]);
  if (job === null) return null;
  const words = counted ? `${formatBytes(job.done)} of ${formatBytes(job.total)}` : "Starting…";
  return (
    <section className="ask job" aria-label={label}>
      <p className="jt">{label}</p>
      {sentence === undefined ? null : <p className="js">{sentence}</p>}
      <div
        className="prog"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={words}
      >
        <span ref={fill} />
      </div>
      <p className="pnum">{words}</p>
      {warning === undefined ? null : <p className="fwarn">{warning}</p>}
      <div className="ask-acts">
        <Button
          aria-disabled={job.stopping ? true : undefined}
          onClick={() => {
            if (job.stopping) return;
            void stopJob(operation);
            onStop?.();
          }}
        >
          {job.stopping ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </section>
  );
}
