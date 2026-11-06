import { expect, test } from "vitest";
import { fakeKey } from "../../testing/fakeShell";
import { groupMatches, groupsOf, ordinal, pickGroups } from "./keyGroups";

test("groups_are_read_from_the_display_form", () => {
  const key = fakeKey(3);
  const groups = groupsOf(key);
  expect(groups).toHaveLength(13);
  expect(groups.every((group) => group.length === 4)).toBe(true);
  expect(groups.join("-")).toBe(key);
});

test("ordinals_read_as_words_people_say", () => {
  const said = [1, 2, 3, 4, 9, 11, 12, 13, 21, 22].map(ordinal);
  expect(said).toEqual(["1st", "2nd", "3rd", "4th", "9th", "11th", "12th", "13th", "21st", "22nd"]);
});

test("two_different_groups_in_order_whatever_the_dice_say", () => {
  // Every pair a dice could give, including the same number twice in a row.
  for (let first = 0; first < 13; first += 1) {
    for (let second = 0; second < 13; second += 1) {
      const rolls = [first, second, (second + 5) % 13, (first + 7) % 13];
      let next = 0;
      const [a, b] = pickGroups(13, (bound) => (rolls[next++ % rolls.length] ?? 0) % bound);
      expect(a, `${String(first)},${String(second)}`).toBeLessThan(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(13);
    }
  }
});

test("the_real_dice_pick_many_different_pairs", () => {
  const seen = new Set<string>();
  for (let n = 0; n < 400; n += 1) {
    const pair = pickGroups(13);
    expect(pair[0]).toBeLessThan(pair[1]);
    seen.add(pair.join(","));
  }
  // 78 pairs exist; 400 draws that all landed on a handful would mean the pick is not random.
  expect(seen.size).toBeGreaterThan(40);
});

test("a_typed_group_matches_as_the_engine_reads_a_key", () => {
  // Built here, never written as a literal: the last group has a 0 and a 1 in it.
  const groups = [...groupsOf(fakeKey(5)).slice(0, 12), "A0B1"];
  const key = groups.join("-");
  const second = groups[1] ?? "";
  expect(groupMatches(key, 1, second)).toBe(true);
  // Case, spaces and dashes do not count; O is 0 and I or L is 1, as the engine reads a typed key.
  expect(groupMatches(key, 1, ` ${second.toLowerCase()} `)).toBe(true);
  expect(groupMatches(key, 1, `${second.slice(0, 2)}-${second.slice(2)}`)).toBe(true);
  expect(groupMatches(key, 12, "AOBI")).toBe(true);
  expect(groupMatches(key, 12, "ao bl")).toBe(true);
  // But not another group, a short one, a long one, or nothing.
  expect(groupMatches(key, 1, groups[2] ?? "")).toBe(false);
  expect(groupMatches(key, 1, second.slice(0, 3))).toBe(false);
  expect(groupMatches(key, 1, `${second}T`)).toBe(false);
  expect(groupMatches(key, 1, "")).toBe(false);
  expect(groupMatches(key, 99, second)).toBe(false);
});
