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
 * When an item last changed, in the words of the details panel: "changed today", "changed 2 days ago" for the first
 * week, then "changed this month", "changed last month", "changed in September", "changed in December 2025". A date
 * that cannot be read gives an empty string, so the screen says nothing instead of something wrong.
 */
export function changedText(modifiedAt: string, now: Date): string {
  const then = new Date(modifiedAt);
  if (modifiedAt === "" || Number.isNaN(then.getTime())) return "";
  const days = Math.max(0, dayNumber(now) - dayNumber(then));
  if (days === 0) return "changed today";
  if (days === 1) return "changed yesterday";
  if (days < 7) return `changed ${String(days)} days ago`;
  const months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();
  if (months <= 0) return "changed this month";
  if (months === 1) return "changed last month";
  const month = MONTHS[then.getMonth()] ?? "";
  return then.getFullYear() === now.getFullYear()
    ? `changed in ${month}`
    : `changed in ${month} ${String(then.getFullYear())}`;
}
