import { expect, test } from "vitest";
import { agoWords, changedText, dayWords, deletedText, formatBytes, fileFromWords, fullDay } from "./format";

test("a_leftover_file_is_named_by_the_local_day_it_was_written", () => {
  // Ask 5's rows, as drawn: "File from 12 March 2026". The seconds are the shell's (since 1970); the day is the PC's own.
  const at = (iso: string) => Date.parse(iso) / 1000;
  expect(fileFromWords(at("2026-03-12T12:00:00Z"))).toBe("File from 12 March 2026");
  expect(fileFromWords(at("2026-04-03T12:00:00Z"))).toBe("File from 3 April 2026");
  // The local day, not the UTC one: whatever the PC's zone puts that moment on.
  const moment = new Date(at("2026-03-12T23:30:00Z") * 1000);
  expect(fileFromWords(at("2026-03-12T23:30:00Z"))).toBe(`File from ${String(moment.getDate())} ${moment.toLocaleString("en-GB", { month: "long" })} 2026`);
  // A time that can't be a date says nothing wrong: a file from no known day.
  expect(fileFromWords(Number.NaN)).toBe("File");
  expect(fileFromWords(0)).toBe("File");
});

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

test("a_backup_says_the_local_day_it_was_made_with_its_year", () => {
  // 23b's "Made": the day in the PC's own time, whatever year it is (a backup is looked for by its date), and nothing when it can't be read.
  expect(fullDay("2026-10-02T12:00:00Z")).toBe("2 October 2026");
  expect(fullDay("2025-01-30T12:00:00Z")).toBe("30 January 2025");
  expect(fullDay("")).toBe("");
  expect(fullDay("not a date")).toBe("");
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
