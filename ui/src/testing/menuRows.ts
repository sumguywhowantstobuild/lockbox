/**
 * Whether a vault menu row reads `name` followed by its status line (`status`: "Locked", "Unlocked"), with or without the place on the list that a vault named
 * like another says ("Home, 2 of 3", `placedName`).
 */
export function rowReads(row: HTMLElement, name: string, status: string): boolean {
  const text = row.textContent;
  if (!text.startsWith(name) || !text.endsWith(status)) return false;
  const between = text.slice(name.length, text.length - status.length);
  return between === "" || /^, \d+ of \d+$/.test(between);
}
