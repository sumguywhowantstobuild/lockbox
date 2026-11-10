// Words for sizes and dates. Plain functions, so the screens say the same thing everywhere.

/** A size in bytes as people read it: "512 B", "96 KB", "2.1 MB", "3.2 GB". A size that makes no sense is "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal for the larger units, none when it would be ".0" or when the number is already large.
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${text} ${units[unit] ?? "B"}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// A calendar day as a number, so "yesterday" is the day before and not 24 hours ago.
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

/**
 * A day in the words of an "Until" line (11b): "today", or the date as "12 March" (with the year, "9 November 2025", when it is
 * not this year's). A date that cannot be read gives an empty string, so the screen says nothing instead of something wrong.
 */
export function dayWords(when: string, now: Date): string {
  const then = new Date(when);
  if (when === "" || Number.isNaN(then.getTime())) return "";
  if (dayNumber(now) === dayNumber(then)) return "today";
  const date = `${String(then.getDate())} ${MONTHS[then.getMonth()] ?? ""}`;
  return then.getFullYear() === now.getFullYear() ? date : `${date} ${String(then.getFullYear())}`;
}

/** How long ago `when` was, in the words both "changed ..." and "deleted ..." follow; empty when the date cannot be read. */
function agoWords(when: string, now: Date): string {
  const then = new Date(when);
  if (when === "" || Number.isNaN(then.getTime())) return "";
  const days = Math.max(0, dayNumber(now) - dayNumber(then));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${String(days)} days ago`;
  const months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();
  if (months <= 0) return "this month";
  if (months === 1) return "last month";
  const month = MONTHS[then.getMonth()] ?? "";
  return then.getFullYear() === now.getFullYear() ? `in ${month}` : `in ${month} ${String(then.getFullYear())}`;
}

/**
 * When an item last changed, in the words of the details panel: "changed today", "changed 2 days ago" for the first
 * week, then "changed this month", "changed last month", "changed in September", "changed in December 2025". A date
 * that cannot be read gives an empty string, so the screen says nothing instead of something wrong.
 */
export function changedText(modifiedAt: string, now: Date): string {
  const words = agoWords(modifiedAt, now);
  return words === "" ? "" : `changed ${words}`;
}

/** When an item went to the trash, in the same words as a change: "deleted today", "deleted 2 days ago", "deleted in September". */
export function deletedText(trashedAt: string, now: Date): string {
  const words = agoWords(trashedAt, now);
  return words === "" ? "" : `deleted ${words}`;
}
