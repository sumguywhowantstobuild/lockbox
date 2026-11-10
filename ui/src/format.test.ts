import { expect, test } from "vitest";
import { changedText, dayWords, formatBytes } from "./format";

test("sizes_are_written_in_the_unit_people_read", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1024)).toBe("1 KB");
  expect(formatBytes(98_304)).toBe("96 KB");
  expect(formatBytes(1_048_576)).toBe("1 MB");
  expect(formatBytes(2_202_009)).toBe("2.1 MB");
  expect(formatBytes(3_435_973_837)).toBe("3.2 GB");
  expect(formatBytes(-1)).toBe("0 B");
  expect(formatBytes(Number.NaN)).toBe("0 B");
});

test("a_change_is_told_by_how_long_ago_then_by_month", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const said = (when: string) => changedText(when, now);
  expect(said("2026-11-06T09:00:00Z")).toBe("changed today");
  expect(said("2026-11-05T12:00:00Z")).toBe("changed yesterday");
  expect(said("2026-11-04T12:00:00Z")).toBe("changed 2 days ago");
  expect(said("2026-10-31T12:00:00Z")).toBe("changed 6 days ago");
  expect(said("2026-11-01T09:00:00Z")).toBe("changed 5 days ago");
  expect(said("2026-10-12T09:00:00Z")).toBe("changed last month");
  expect(said("2026-09-20T09:00:00Z")).toBe("changed in September");
  expect(said("2025-12-20T09:00:00Z")).toBe("changed in December 2025");
  // Later than now (the clock moved): not a time to the future.
  expect(said("2026-11-09T12:00:00Z")).toBe("changed today");
  // A date that cannot be read says nothing rather than something wrong.
  expect(said("")).toBe("");
  expect(said("not a date")).toBe("");
});

test("an_until_line_says_today_or_the_date", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const said = (when: string) => dayWords(when, now);
  expect(said("2026-11-06T09:00:00Z")).toBe("today");
  expect(said("2026-03-12T08:00:00Z")).toBe("12 March");
  // Yesterday is a date, not a word of its own: the line is "Until 5 November".
  expect(said("2026-11-05T09:00:00Z")).toBe("5 November");
  expect(said("2025-11-09T08:00:00Z")).toBe("9 November 2025");
  expect(said("")).toBe("");
  expect(said("not a date")).toBe("");
});

test("this_month_is_named_when_it_is_older_than_a_week", () => {
  expect(changedText("2026-11-01T12:00:00Z", new Date("2026-11-20T12:00:00Z"))).toBe("changed this month");
});
