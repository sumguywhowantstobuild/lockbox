import type { ItemKind } from "../api";
import { Select } from "../parts/Select";
import { setForm, useForm } from "../store";

/** The kinds an item in the list can be (a folder is not one). */
export type ListedKind = Exclude<ItemKind, "collection">;

/** Which kind the list shows: all of them, or one. */
export type KindChoice = "all" | ListedKind;

/** The order of the list: in a group for each kind, by name, or by when each item last changed. */
export type SortChoice = "kind" | "name" | "changed";

/** Where the typed filter, the kind and the order live in a vault's own record, which a lock takes away whole. */
export const FILTER = "filter";
const KIND = "kind";
const SORT = "sort";

const KINDS: { value: KindChoice; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "login", label: "Logins" },
  { value: "key", label: "Keys" },
  { value: "note", label: "Notes" },
  { value: "file", label: "Files" },
];

const SORTS: { value: SortChoice; label: string }[] = [
  { value: "kind", label: "Kind" },
  { value: "name", label: "Name" },
  { value: "changed", label: "Changed" },
];

/** One of a kind, and several, in the words of a count: "1 key", "3 keys". */
const WORDS: Record<ListedKind, [string, string]> = {
  login: ["login", "logins"],
  key: ["key", "keys"],
  note: ["note", "notes"],
  file: ["file", "files"],
};

/** "1 key" or "3 keys". */
export function kindCount(kind: ListedKind, count: number): string {
  return `${String(count)} ${WORDS[kind][count === 1 ? 0 : 1]}`;
}

/** The kind in the plural, for "No keys here". */
export function kindPlural(kind: ListedKind): string {
  return WORDS[kind][1];
}

/** "1 item" or "6 items". */
export function itemCount(count: number): string {
  return `${String(count)} ${count === 1 ? "item" : "items"}`;
}

/** The kind the vault's list shows: all of them until one is chosen. */
export function useKind(session: number): KindChoice {
  const stored = useForm(session, KIND);
  return KINDS.find((choice) => choice.value === stored)?.value ?? "all";
}

/** The order of the vault's list: by kind until another is chosen. */
export function useSort(session: number): SortChoice {
  const stored = useForm(session, SORT);
  return SORTS.find((choice) => choice.value === stored)?.value ?? "kind";
}

/** Back to every item: the typed filter and the kind are both cleared. The order stays, since it hides nothing. */
export function showAll(session: number): void {
  setForm(session, FILTER, "");
  setForm(session, KIND, "");
}

/**
 * The two lists in the toolbar (17a, 17b): which kind to show, and in what order. Each is named for a screen reader and shows
 * its choice in the box. What is chosen is kept with the vault's own record, so it stays while moving between folders and
 * goes with a lock.
 */
export function ListTools({ session }: { session: number }) {
  const kind = useKind(session);
  const sort = useSort(session);
  return (
    <>
      <div className="sortw k">
        <Select
          compact
          label="Show only one kind"
          items={KINDS}
          value={kind}
          onValueChange={(next) => {
            setForm(session, KIND, next);
          }}
        />
      </div>
      <div className="sortw">
        <Select
          compact
          label="Sort"
          items={SORTS}
          value={sort}
          onValueChange={(next) => {
            setForm(session, SORT, next);
          }}
        />
      </div>
    </>
  );
}
