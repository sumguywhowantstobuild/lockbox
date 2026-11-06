// What the key screens do with a recovery key on the page: cut it into its groups, pick two to be typed back, and check
// what was typed. The key is on the page only while it is shown (the store holds it, and a lock drops it); the check
// is made here because only the page has the key then. Only its result crosses, as `recovery_confirmed`.

/** The groups of the key as the engine shows it: 13 groups of 4, dashes between. */
export function groupsOf(key: string): string[] {
  return key.split(/[-\s]+/).filter((group) => group !== "");
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${String(n)}${suffix}`;
}

/** A whole number below `bound`, evenly, from the browser's own random numbers (values over the last whole multiple are redrawn). */
function randomBelow(bound: number): number {
  const range = 0x1_0000_0000;
  const limit = range - (range % bound);
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    const value = draw[0] ?? 0;
    if (value < limit) return value % bound;
  }
}

/**
 * Two different groups of `count`, by position from 0, the lower one first. `below(n)` gives a whole number from 0 to
 * n - 1; it is a parameter so a test can roll the dice.
 */
export function pickGroups(count: number, below: (bound: number) => number = randomBelow): [number, number] {
  const first = below(count);
  let second = below(count - 1);
  if (second >= first) second += 1;
  return first < second ? [first, second] : [second, first];
}

// As the engine reads a typed key: case, spaces and dashes don't count, O is 0 and I or L is 1.
function plain(text: string): string {
  return Array.from(text.toUpperCase())
    .filter((char) => char !== " " && char !== "-")
    .map((char) => (char === "O" ? "0" : char === "I" || char === "L" ? "1" : char))
    .join("");
}

/** Whether `typed` is group number `index` (from 0) of `key`. Nothing typed never matches. */
export function groupMatches(key: string, index: number, typed: string): boolean {
  const group = groupsOf(key)[index];
  const text = plain(typed);
  return group !== undefined && text !== "" && plain(group) === text;
}
