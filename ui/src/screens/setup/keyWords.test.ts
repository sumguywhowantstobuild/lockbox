import { expect, test } from "vitest";
import { fakeKey } from "../../testing/fakeShell";
import { asksFor, choicesFor, pickPositions, wordsOf } from "./keyWords";

/** A key that repeats words: positions 1, 2 and 3 are all "ember", and 4 and 5 are "ivory". */
const REPEATING =
  "ember ember ember ivory ivory quartz marble copper velvet saddle anchor beacon cactus dagger harbor jungle kernel " +
  "lantern magnet nectar orchid pepper quiver ribbon";

test("words_are_read_from_the_display_form", () => {
  const key = fakeKey(3);
  const words = wordsOf(key);
  expect(words).toHaveLength(24);
  expect(words.every((word) => /^[a-z]+$/.test(word))).toBe(true);
  expect(words.join(" ")).toBe(key);
});

test("three_different_numbers_whatever_the_dice_say", () => {
  // Every first two rolls a dice could give, including the same number twice in a row.
  for (let a = 0; a < 24; a += 1) {
    for (let b = 0; b < 24; b += 1) {
      const rolls = [a, b, (a + b) % 24, (b + 5) % 24, a, a, 0, 23];
      let next = 0;
      const picked = pickPositions(24, 3, (bound) => (rolls[next++ % rolls.length] ?? 0) % bound);
      expect(new Set(picked).size, `${String(a)},${String(b)}`).toBe(3);
      expect(picked.every((at) => at >= 0 && at < 24)).toBe(true);
      expect(picked).toEqual([...picked].sort((x, y) => x - y));
    }
  }
});

test("the_real_dice_pick_many_different_triples", () => {
  const seen = new Set<string>();
  const hits = new Array<number>(24).fill(0);
  for (let n = 0; n < 600; n += 1) {
    const triple = pickPositions(24, 3);
    expect(new Set(triple).size).toBe(3);
    seen.add(triple.join(","));
    for (const at of triple) hits[at] = (hits[at] ?? 0) + 1;
  }
  // 2,024 triples exist; 600 draws that landed on a handful would mean the pick is not random.
  expect(seen.size).toBeGreaterThan(300);
  // Every place gets asked about, so the whole key is checked over time (expected 75 each).
  expect(Math.min(...hits)).toBeGreaterThan(30);
});

test("choices_are_four_distinct_words_from_the_key", () => {
  const key = fakeKey(2);
  const words = wordsOf(key);
  for (let at = 0; at < 24; at += 1) {
    const choices = choicesFor(words, at);
    expect(choices).toHaveLength(4);
    expect(new Set(choices).size).toBe(4);
    // The right one is there, once, and the others are the key's own words from other places.
    expect(choices.filter((word) => word === words[at])).toHaveLength(1);
    for (const word of choices) expect(words).toContain(word);
  }
});

test("choices_skip_words_equal_to_the_right_one_or_each_other_in_a_key_that_repeats", () => {
  const words = wordsOf(REPEATING);
  expect(words).toHaveLength(24);
  for (let at = 0; at < 24; at += 1) {
    for (let round = 0; round < 40; round += 1) {
      const choices = choicesFor(words, at);
      expect(choices, String(at)).toHaveLength(4);
      expect(new Set(choices).size, `${String(at)}: ${choices.join(",")}`).toBe(4);
      expect(choices).toContain(words[at]);
    }
  }
  // Whatever the dice: the right word at place 0 is "ember" and two more sit in places 1 and 2.
  const worst = choicesFor(words, 0, () => 0);
  expect(new Set(worst).size).toBe(4);
  expect(worst).toContain("ember");
  const last = choicesFor(words, 23, (bound) => bound - 1);
  expect(new Set(last).size).toBe(4);
});

test("choices_come_in_random_order_with_the_right_one_in_every_place", () => {
  const words = wordsOf(fakeKey(4));
  const spot = new Array<number>(4).fill(0);
  for (let n = 0; n < 400; n += 1) {
    const where = choicesFor(words, 5).indexOf(words[5] ?? "");
    spot[where] = (spot[where] ?? 0) + 1;
  }
  // Expected 100 each.
  expect(Math.min(...spot)).toBeGreaterThan(50);
});

test("three_asks_name_places_from_1_and_hold_the_right_word_among_four", () => {
  const key = fakeKey(6);
  const words = wordsOf(key);
  const asks = asksFor(key);
  expect(asks).toHaveLength(3);
  expect(new Set(asks.map((ask) => ask.position)).size).toBe(3);
  for (const ask of asks) {
    expect(ask.position).toBeGreaterThanOrEqual(1);
    expect(ask.position).toBeLessThanOrEqual(24);
    expect(ask.choices).toHaveLength(4);
    expect(ask.choices).toContain(words[ask.position - 1]);
  }
});

test("a_key_with_too_few_different_words_still_gives_choices_without_a_crash", () => {
  // Cannot happen with a real key; it must not hang or throw if the shell ever sent one.
  const words = wordsOf(Array.from({ length: 24 }, () => "ember").join(" "));
  expect(choicesFor(words, 3)).toEqual(["ember"]);
});
