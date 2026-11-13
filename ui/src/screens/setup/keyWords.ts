// What the key screens do with a recovery key on the page: cut it into its words, choose three places to be asked about,
// and make the four choices for each. The key is on the page only while it is shown (the store holds it, and a lock
// drops it); the check is made here because only the page has the key then. Only its result crosses, as
// `recovery_confirmed`. The 2,048-word list stays in Rust: the wrong choices are the key's own words from other places.

/** How many places are asked about. */
export const QUESTIONS = 3;

/** How many words each question offers. */
const CHOICES = 4;

/** One question: the word's number (from 1), and the words to pick from, the right one among them, in random order. */
export interface Ask {
  position: number;
  choices: readonly string[];
}

/** The words of the key as the shell shows it: 24 lowercase words, single spaces, no numbers. */
export function wordsOf(key: string): string[] {
  return key.split(" ").filter((word) => word !== "");
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

/** Every `below` is a parameter so a test can roll the dice: `below(n)` gives a whole number from 0 to n - 1. */
type Below = (bound: number) => number;

/** The same items in random order (Fisher-Yates). */
function shuffled<T>(items: readonly T[], below: Below): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    const kept = out[i] as T;
    out[i] = out[j] as T;
    out[j] = kept;
  }
  return out;
}

/** `count` different places out of `size`, by position from 0, the lowest first. */
export function pickPositions(size: number, count: number, below: Below = randomBelow): number[] {
  const pool = Array.from({ length: size }, (_, at) => at);
  const take = Math.min(count, size);
  for (let i = 0; i < take; i += 1) {
    const j = i + below(size - i);
    const kept = pool[i] as number;
    pool[i] = pool[j] as number;
    pool[j] = kept;
  }
  return pool.slice(0, take).sort((a, b) => a - b);
}

/**
 * The words to pick from for the place `at` (from 0): the right word, and three different words from the key's other
 * places, skipping any equal to the right word or to one already taken (a key can repeat a word), in random order. A key
 * with too few different words gives fewer; a real key never does.
 */
export function choicesFor(words: readonly string[], at: number, below: Below = randomBelow): string[] {
  const right = words[at] ?? "";
  const taken = new Set([right]);
  const others = shuffled(
    words.filter((_, place) => place !== at),
    below,
  );
  for (const word of others) {
    if (taken.size === CHOICES) break;
    taken.add(word);
  }
  return shuffled([...taken], below);
}

/** The three questions for a key: three different places, each with its choices. */
export function asksFor(key: string, below: Below = randomBelow): Ask[] {
  const words = wordsOf(key);
  return pickPositions(words.length, QUESTIONS, below).map((at) => ({
    position: at + 1,
    choices: choicesFor(words, at, below),
  }));
}
