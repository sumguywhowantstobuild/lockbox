// The list's rows, drawn on their own: what each row holds decides where its columns fall, since a row is a line of parts
// that share its width (jsdom lays nothing out, so the parts themselves are what is checked).
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ItemSummary } from "../api";
import { ItemList } from "./ItemList";

afterEach(cleanup);

function item(id: string, title: string, collection: string | null): ItemSummary {
  return {
    id,
    kind: "login",
    title,
    username: `${id}@example.com`,
    collection,
    trashed: false,
    trashed_at: null,
    trashed_with: null,
    purging: false,
    site: null,
    created_at: "2026-11-10T10:00:00Z",
    modified_at: "2026-11-10T10:00:00Z",
    attachments: [],
  };
}

const ITEMS = [item("a", "In a folder", "f1"), item("b", "In no folder", null)];

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".lrow .rgo")];
}

test("every_row_keeps_the_folder_column_when_the_list_shows_folders", () => {
  // Found at stage 7: on All items a row with no folder left its folder part out, so its username or date slid 60 to 85
  // pixels right of the rows around it. Every row now has the part, empty where there is no folder.
  const { container } = render(
    <ItemList items={ITEMS} sort="name" openId={null} folderNames={new Map([["f1", "Work"]])} onOpen={() => {}} onCopy={() => {}} />,
  );
  const [inFolder, inNone] = rows(container);
  expect(inFolder?.querySelector(".rfold")?.textContent).toBe("Work");
  const empty = inNone?.querySelector(".rfold");
  expect(empty, "the folder part is there on a row with no folder").not.toBeNull();
  expect(empty?.textContent).toBe("");
  // The row's name for a screen reader is unchanged: kind, title and detail, with no folder word.
  expect(inNone?.textContent.replace(/\s+/g, " ").trim()).toBe("Login: In no folder b@example.com");
});

test("no_row_has_a_folder_column_when_the_list_is_one_folder", () => {
  const { container } = render(
    <ItemList items={ITEMS} sort="name" openId={null} folderNames={null} onOpen={() => {}} onCopy={() => {}} />,
  );
  for (const row of rows(container)) expect(row.querySelector(".rfold")).toBeNull();
});
