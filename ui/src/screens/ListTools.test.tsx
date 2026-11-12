import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { SAID_FOR_MS, SETTLE_MS } from "../useSpokenLine";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
  type FakeItem,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
import { readBeside } from "../testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  // Only the date: the answers arrive on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

/** The sample vault with two keys added: six items in all (two keys, two logins, a note and a file), four of them in a folder. */
function items(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: itemId(6), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: "demo-value-aaa", modified_at: "2026-11-06T08:00:00Z" },
    { id: itemId(7), kind: "key", title: "WEBHOOK_SECRET", collection: FOLDER, value: "demo-value-bbb", modified_at: "2026-11-05T08:00:00Z" },
  ];
}

/** Types the password on the lock screen and waits for the list. No role lookups, which crawl a page of thousands of rows. */
async function typePassword() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await vi.waitFor(
    () => {
      expect(document.querySelector("h1.big")?.textContent).toBe("All items");
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    },
    { timeout: 20_000 },
  );
}

/** The app on its lock screen with `vaults`, unlocked through the screen as a person would. */
async function unlocked(vaults: FakeVault[] = [{ id: 7, name: "My vault", items: items() }]) {
  shell = installFakeShell(invoke, listen, vaults);
  const view = render(<App />);
  await typePassword();
  return view;
}

/** The box of the kind list or of the sort list, found by its place in the toolbar as drawn. */
function box(which: "kind" | "sort"): HTMLElement {
  const found = document.querySelector<HTMLElement>(which === "kind" ? ".tb .sortw.k [role=combobox]" : ".tb .sortw:not(.k) [role=combobox]");
  if (found === null) throw new Error(`no ${which} box`);
  return found;
}

/**
 * The elements with a style attribute that the page itself wrote: none are allowed. Left out are the select part's hidden
 * input and its list where the library places it on the page, both set by the library through script (the policy allows
 * that; it refuses style in the HTML itself).
 */
function ownStyles(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("[style]")].filter(
    (element) => element.closest(".tb .sortw") === null && element.closest("[data-base-ui-portal]") === null,
  );
}

// A list that is open: the select part keeps a closed one on the page, hidden.
const OPEN_LIST = ".layer:not([hidden]) [role=listbox]";

/** Opens the kind or sort list and picks `label` with a click, as a person would. */
async function pick(which: "kind" | "sort", label: string) {
  const trigger = box(which);
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>(`${OPEN_LIST} [role=option]`)].find((entry) => entry.textContent === label);
    if (found === undefined) throw new Error(`no option ${label}`);
    return found;
  });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await vi.waitFor(() => {
    expect(box(which).textContent).toBe(label);
    expect(document.querySelector(OPEN_LIST)).toBeNull();
  });
}

/** The titles of the rows on the page, in order. */
function titles(): string[] {
  return [...document.querySelectorAll("main li.lrow .rname")].map((name) => name.textContent);
}

function rows(): number {
  return document.querySelectorAll("main li.lrow").length;
}

/** The line on screen that says how the list is narrowed (not the hidden place that says it aloud). */
function shownLine(): HTMLElement {
  const line = screen.getByRole("main").querySelector<HTMLElement>("p.lnote");
  if (line === null) throw new Error("no narrowed line on screen");
  return line;
}

function filterBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Filter this list");
}

test("the_kind_and_sort_lists_are_in_the_toolbar_and_named", async () => {
  const { container } = await unlocked();
  // Named for a screen reader as drawn, each showing its choice: every kind, in groups by kind.
  const kind = screen.getByRole("combobox", { name: "Show only one kind" });
  const sort = screen.getByRole("combobox", { name: "Sort" });
  expect(kind).toBe(box("kind"));
  expect(sort).toBe(box("sort"));
  expect(kind.textContent).toBe("All kinds");
  expect(sort.textContent).toBe("Kind");
  // What each offers, in the drawn order.
  fireEvent.pointerDown(kind, { button: 0 });
  fireEvent.click(kind);
  const kinds = await screen.findByRole("listbox");
  expect(within(kinds).getAllByRole("option").map((option) => option.textContent)).toEqual(["All kinds", "Logins", "Keys", "Notes", "Files"]);
  await expectNoAxe(kinds);
  fireEvent.keyDown(kinds, { key: "Escape" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  fireEvent.pointerDown(sort, { button: 0 });
  fireEvent.click(sort);
  const sorts = await screen.findByRole("listbox");
  expect(within(sorts).getAllByRole("option").map((option) => option.textContent)).toEqual(["Kind", "Name", "Changed"]);
  fireEvent.keyDown(sorts, { key: "Escape" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  expect(ownStyles(container)).toEqual([]);
  expect(container.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);
  // Not in the Trash, which has nothing to narrow or sort.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Trash/ }));
  expect(screen.queryByRole("combobox", { name: "Show only one kind" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Sort" })).toBeNull();
});

test("filter_shows_clearly_with_a_way_to_clear", async () => {
  const { container } = await unlocked();
  expect(rows()).toBe(6);
  await pick("kind", "Keys");
  // Only the keys, and the list says it is narrowed, with a way back: it must not look like missing items.
  expect(titles()).toEqual(["OPENAI_API_KEY", "WEBHOOK_SECRET"]);
  const main = screen.getByRole("main");
  expect(within(shownLine()).getByText("Showing 2 keys of 6 items.")).toBeTruthy();
  await expectNoAxe(container);
  fireEvent.click(within(main).getByRole("button", { name: "Show all" }));
  expect(rows()).toBe(6);
  expect(box("kind").textContent).toBe("All kinds");
  expect(main.querySelector("p.lnote")).toBeNull();
  expect(within(main).queryByRole("button", { name: "Show all" })).toBeNull();

  // One of a kind is said as one.
  await pick("kind", "Notes");
  expect(within(shownLine()).getByText("Showing 1 note of 6 items.")).toBeTruthy();

  // A typed filter on top of a kind: both are said, and Show all clears both.
  await pick("kind", "Logins");
  fireEvent.change(filterBox(), { target: { value: "console" } });
  expect(titles()).toEqual(["Bot admin console"]);
  expect(within(shownLine()).getByText("Showing 1 login of 6 items, filtered by “console”.")).toBeTruthy();
  fireEvent.click(within(main).getByRole("button", { name: "Show all" }));
  expect(rows()).toBe(6);
  expect(filterBox().value).toBe("");
  expect(box("kind").textContent).toBe("All kinds");

  // A typed filter alone keeps its own words, and its own way to clear in the box.
  fireEvent.change(filterBox(), { target: { value: "console" } });
  expect(within(shownLine()).getByText("Showing 1 of 6, filtered by “console”.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(rows()).toBe(6);

  // In a folder the count is the folder's.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Agency support agent/ }));
  await pick("kind", "Keys");
  expect(within(shownLine()).getByText("Showing 2 keys of 4 items.")).toBeTruthy();
});

/** The place in the list that says how it is narrowed: read out politely, as a whole, once the change has settled. */
function narrowedPlace(): HTMLElement {
  const found = screen.getByRole("main").querySelectorAll<HTMLElement>('[aria-live="polite"]');
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

/** From here on the page's timers are fake too (the vault's answers have already come, on real ones). */
function fakePageTimers() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
}

/** Lets `ms` pass on the page's timers. */
function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

test("a_narrowed_list_is_announced_as_it_changes", async () => {
  // Task 21's keyboard pass: a screen reader speaks only changes in a place it already knows, so the place that says how the list is
  // narrowed is on the page before anything is narrowed, and the same place says each change once it has settled. It is not a second
  // "status": the message at the foot of the window stays the one place that announces copies and saves.
  await unlocked();
  const place = narrowedPlace();
  expect(place.getAttribute("aria-atomic")).toBe("true");
  expect(place.textContent).toBe("");
  fakePageTimers();

  fireEvent.change(filterBox(), { target: { value: "console" } });
  wait(SETTLE_MS);
  expect(narrowedPlace()).toBe(place);
  expect(place.textContent).toBe("Showing 1 of 6, filtered by “console”.");

  await pick("kind", "Keys");
  wait(SETTLE_MS);
  // Nothing of that kind matches: the card says so on screen, and the place says it too, with how many items there really are.
  expect(narrowedPlace()).toBe(place);
  expect(place.textContent).toBe("Nothing here matches “console”. My vault has 6 items.");

  fireEvent.change(filterBox(), { target: { value: "" } });
  wait(SETTLE_MS);
  // The words only: "Show all" is a button on the line on screen, not part of what is said.
  expect(place.textContent).toBe("Showing 2 keys of 6 items.");

  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: /^Lineproof/ }));
  wait(SETTLE_MS);
  expect(narrowedPlace().textContent).toBe("No keys here. Lineproof has 1 item.");

  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Show all" }));
  wait(SETTLE_MS);
  expect(narrowedPlace().textContent).toBe("");
});

test("the_narrowed_line_is_said_once_typing_pauses", async () => {
  // Stage 7's NVDA check: a sentence per key typed ("Showing 11 of 19, filtered by d", "…by de", …) is noise. The list and the line
  // on screen change at once; what is said waits until typing has paused, says the result once, and goes again a little later, so
  // reading down the page doesn't meet it twice.
  await unlocked();
  const place = narrowedPlace();
  const said: string[] = [];
  const watcher = new MutationObserver(() => {
    if (place.textContent !== "") said.push(place.textContent);
  });
  watcher.observe(place, { childList: true, characterData: true, subtree: true });
  fakePageTimers();

  for (const typed of ["c", "co", "con", "cons", "console"]) {
    fireEvent.change(filterBox(), { target: { value: typed } });
    wait(SETTLE_MS - 100);
  }
  // On screen at once, with nothing said yet.
  expect(within(shownLine()).getByText("Showing 1 of 6, filtered by “console”.")).toBeTruthy();
  expect(place.textContent).toBe("");

  wait(100);
  await Promise.resolve();
  expect(place.textContent).toBe("Showing 1 of 6, filtered by “console”.");
  expect(said).toEqual(["Showing 1 of 6, filtered by “console”."]);

  wait(SAID_FOR_MS);
  expect(place.textContent).toBe("");
  watcher.disconnect();
});

test("nothing_matching_says_so", async () => {
  const { container } = await unlocked();
  fireEvent.change(filterBox(), { target: { value: "zzz" } });
  const main = screen.getByRole("main");
  // The drawn words (17c): what was typed, how many items there really are, and two ways on.
  expect(within(main).getByText("Nothing here matches “zzz”")).toBeTruthy();
  expect(within(main).getByText("My vault has 6 items. Clear the filter to see them.")).toBeTruthy();
  expect(rows()).toBe(0);
  await expectNoAxe(container);
  const card = within(main).getByText("Nothing here matches “zzz”").closest(".lempty") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Clear filter" }));
  expect(rows()).toBe(6);
  expect(filterBox().value).toBe("");

  // In a folder it is the folder that is named; and a kind chosen as well is cleared with the word.
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: /^Agency support agent/ }));
  await pick("kind", "Keys");
  fireEvent.change(filterBox(), { target: { value: "zzz" } });
  expect(within(main).getByText("Agency support agent has 4 items. Clear the filter to see them.")).toBeTruthy();
  fireEvent.click(within(within(main).getByText("Nothing here matches “zzz”").closest(".lempty") as HTMLElement).getByRole("button", { name: "Clear filter" }));
  expect(rows()).toBe(4);
  expect(box("kind").textContent).toBe("All kinds");

  // Search all vaults opens the search with the word already in it.
  fireEvent.change(filterBox(), { target: { value: "zzz" } });
  fireEvent.click(within(main).getByRole("button", { name: "Search all vaults" }));
  const search = await screen.findByPlaceholderText<HTMLInputElement>("Search unlocked vaults");
  expect(search.value).toBe("zzz");
});

test("a_kind_with_nothing_in_it_says_so", async () => {
  await unlocked();
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: /^Lineproof/ }));
  await pick("kind", "Notes");
  const main = screen.getByRole("main");
  expect(within(main).getByText("No notes here")).toBeTruthy();
  expect(within(main).getByText("Lineproof has 1 item. Show all kinds to see it.")).toBeTruthy();
  expect(rows()).toBe(0);
  fireEvent.click(within(main).getByRole("button", { name: "Show all" }));
  expect(titles()).toEqual(["Error tracker"]);
  // Each kind in its own word.
  await pick("kind", "Files");
  expect(within(main).getByText("No files here")).toBeTruthy();
  await pick("kind", "Keys");
  expect(within(main).getByText("No keys here")).toBeTruthy();
});

test("an_empty_folder_keeps_its_own_words_whatever_kind_is_chosen", async () => {
  await unlocked([
    { id: 7, name: "My vault", items: [...items(), { id: itemId(0xf3), kind: "collection", title: "Empty one" }] },
  ]);
  await pick("kind", "Keys");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Empty one/ }));
  const main = screen.getByRole("main");
  // Nothing is narrowed away here: there is nothing in it at all.
  expect(within(main).getByText("Nothing in Empty one yet.")).toBeTruthy();
  expect(within(main).queryByText(/^No keys here/)).toBeNull();
});

test("sort_by_name_and_date", async () => {
  const { container } = await unlocked();
  const main = screen.getByRole("main");
  const headings = () => within(main).queryAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  // By kind, as before: a group for each kind, by name inside it.
  expect(headings()).toEqual(["Keys2", "Logins2", "Notes1", "Files1"]);
  expect(titles()).toEqual(["OPENAI_API_KEY", "WEBHOOK_SECRET", "Bot admin console", "Error tracker", "Rotation steps", "Client contract"]);

  // By name: one list, whatever the kind, which each row still says.
  await pick("sort", "Name");
  expect(headings()).toEqual([]);
  expect(titles()).toEqual(["Bot admin console", "Client contract", "Error tracker", "OPENAI_API_KEY", "Rotation steps", "WEBHOOK_SECRET"]);
  expect(within(main).getByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeTruthy();
  expect(within(main).getByText("admin@example.com")).toBeTruthy();
  await expectNoAxe(container);

  // By when it changed: the newest first, each row saying when (17b). A login keeps its username before the date, so two
  // logins of one name still say which account each is (its Copy puts that account's password on the clipboard).
  await pick("sort", "Changed");
  expect(headings()).toEqual([]);
  expect(titles()).toEqual(["OPENAI_API_KEY", "WEBHOOK_SECRET", "Bot admin console", "Error tracker", "Rotation steps", "Client contract"]);
  const when = [...document.querySelectorAll("main li.lrow .rdet")].map((detail) => detail.textContent);
  expect(when).toEqual([
    "today",
    "yesterday",
    "admin@example.com · 2 days ago",
    "team@example.com · last month",
    "in September",
    "in September",
  ]);
  expect(within(main).getByRole("button", { name: /^Key:\s*OPENAI_API_KEY\s+today/ })).toBeTruthy();
  await expectNoAxe(container);

  // The order holds under a kind and in a folder.
  await pick("kind", "Logins");
  expect(titles()).toEqual(["Bot admin console", "Error tracker"]);
  await pick("kind", "All kinds");
  await pick("sort", "Kind");
  expect(headings()).toEqual(["Keys2", "Logins2", "Notes1", "Files1"]);
  expect(ownStyles(container)).toEqual([]);
});

test("filter_cleared_on_lock", async () => {
  await unlocked();
  fireEvent.change(filterBox(), { target: { value: "console" } });
  await pick("kind", "Logins");
  await pick("sort", "Name");
  expect(titles()).toEqual(["Bot admin console"]);
  // A lock takes the word, the kind and the order with it, and says nothing.
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("no session");
  shell.lock(live.session);
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.documentElement.innerHTML).not.toContain("console");
  // The vault's whole record is gone from the page's memory, the word, the kind and the order with it: nothing of them is
  // kept for the next unlock to find.
  expect(debugState().sessions).toEqual([]);
  expect(JSON.stringify(debugState())).not.toContain("console");
  await typePassword();
  expect(filterBox().value).toBe("");
  expect(box("kind").textContent).toBe("All kinds");
  expect(box("sort").textContent).toBe("Kind");
  expect(rows()).toBe(6);
});

/** `count` items of every kind in turn, each changed on a different day, half of them in a folder. */
function many(count: number): FakeItem[] {
  const kinds = ["login", "key", "note", "file"] as const;
  const list: FakeItem[] = [{ id: FOLDER, kind: "collection", title: "Agency support agent" }];
  for (let n = 0; n < count; n += 1) {
    const kind = kinds[n % kinds.length] ?? "note";
    const day = new Date(Date.UTC(2020, 0, 1 + n)).toISOString().replace(/\.\d+Z$/, "Z");
    list.push({
      id: itemId(0x1000 + n),
      kind,
      title: kind === "key" ? `DEMO_KEY_${String(n)}` : `Item ${String(n).padStart(5, "0")}`,
      username: kind === "login" ? `person${String(n)}@example.com` : null,
      collection: n % 2 === 0 ? FOLDER : null,
      modified_at: day,
    });
  }
  return list;
}

test("list_keeps_every_row_on_the_page", async () => {
  await unlocked([{ id: 7, name: "My vault", items: many(300) }]);
  // Every row is on the page in every order, so a screen reader and Ctrl+F on the page reach them all: none is made as it
  // scrolls into view.
  expect(rows()).toBe(300);
  await pick("sort", "Name");
  expect(rows()).toBe(300);
  await pick("sort", "Changed");
  expect(rows()).toBe(300);
  expect(titles()[0]).toBe("Item 00299");
  // What keeps that quick is the browser's own: a row out of view is not drawn, and keeps its height so the scroll bar does
  // not jump. jsdom draws nothing, so the rule is read from the style sheet.
  const css = readBeside(import.meta.url, "../styles/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /(?:^|\})\s*\.lrow\s*\{([^}]*)\}/.exec(css)?.[1]?.replace(/\s+/g, " ") ?? "";
  expect(rule).toMatch(/content-visibility: auto/);
  expect(rule).toMatch(/contain-intrinsic-size: auto \d+px/);
});

test("five_thousand_rows_stay_on_the_page", { timeout: 120_000 }, async () => {
  await unlocked([{ id: 7, name: "My vault", items: many(5000) }]);
  expect(rows()).toBe(5000);
  // Narrowed to one kind, then in another order: still every row there is, and the words say how many.
  await pick("kind", "Keys");
  expect(rows()).toBe(1250);
  expect(document.querySelector("main .lnote")?.textContent).toContain("Showing 1250 keys of 5000 items.");
  await pick("kind", "All kinds");
  await pick("sort", "Changed");
  expect(rows()).toBe(5000);
  expect(titles()[0]).toBe("Item 04999");
  // A typed word narrows across all of them.
  fireEvent.change(document.querySelector('[aria-label="Filter this list"]') as HTMLInputElement, { target: { value: "item 04998" } });
  expect(titles()).toEqual(["Item 04998"]);
});
