import { expect, test } from "vitest";
import { agoWords, changedText, dayWords, deletedText, formatBytes } from "./format";

test("a_row_sorted_by_date_says_when_in_the_words_of_a_change", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  // The words alone, as a row of a list sorted by date shows them (17b): what "changed ..." says, without the verb.
  for (const when of ["2026-11-10T09:00:00Z", "2026-11-09T12:00:00Z", "2026-11-04T12:00:00Z", "2026-10-01T09:00:00Z", "2025-12-20T09:00:00Z"]) {
    expect(`changed ${agoWords(when, now)}`).toBe(changedText(when, now));
  }
  expect(agoWords("2026-11-08T09:00:00Z", now)).toBe("2 days ago");
  expect(agoWords("", now)).toBe("");
  expect(agoWords("not a date", now)).toBe("");
});

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

test("a_delete_is_told_in_the_same_day_words_as_a_change", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const said = (when: string) => deletedText(when, now);
  expect(said("2026-11-10T09:00:00Z")).toBe("deleted today");
  expect(said("2026-11-09T12:00:00Z")).toBe("deleted yesterday");
  expect(said("2026-11-08T09:00:00Z")).toBe("deleted 2 days ago");
  expect(said("2026-11-01T09:00:00Z")).toBe("deleted this month");
  expect(said("2026-10-01T09:00:00Z")).toBe("deleted last month");
  expect(said("2026-09-20T09:00:00Z")).toBe("deleted in September");
  expect(said("2025-12-20T09:00:00Z")).toBe("deleted in December 2025");
  // The same words as a change, apart from the verb.
  for (const when of ["2026-11-10T09:00:00Z", "2026-11-04T12:00:00Z", "2026-09-20T09:00:00Z"]) {
    expect(said(when).replace(/^deleted/, "changed")).toBe(changedText(when, now));
  }
  expect(said("")).toBe("");
  expect(said("not a date")).toBe("");
});
