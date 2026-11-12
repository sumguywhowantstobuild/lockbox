import { Select as BaseSelect } from "@base-ui/react/select";
import type { Ref } from "react";
import { CheckIcon, ChevronDownIcon, ChevronsIcon } from "./Icon";
import { usePortalContainer } from "./Portal";

/** One thing to pick: what the box shows, and what the screen gets back (two folders may share a name). */
export interface SelectChoice {
  value: string;
  label: string;
}

/**
 * A short list to pick one from (a printer, a folder): a box that shows the chosen one and opens a list in the app's own
 * menu look. The box opens by click or the arrow keys, the arrow keys move through the list, Enter picks, Escape closes it
 * without picking, and focus goes back to the box. Always has one chosen (`value` is one of `items`); for many items
 * to narrow by typing, use `Combobox`. `label` is the visible label, which also names the box for a screen reader.
 * `triggerRef` reaches the box, for a screen that puts focus on it. An item is a plain string (shown and returned as it
 * is), or a `SelectChoice` when what is shown is not what identifies it. `compact` is the toolbar's form: a small box with
 * no label in view (the label still names it for a screen reader). `inRow` is a settings row's form (31a): small and filled, with
 * a down arrow, its label in the row beside it (still named by `label` for a screen reader).
 */
export function Select({
  label,
  items,
  value,
  onValueChange,
  triggerRef,
  compact = false,
  inRow = false,
}: {
  label: string;
  items: readonly (string | SelectChoice)[];
  value: string;
  onValueChange: (value: string) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  compact?: boolean;
  inRow?: boolean;
}) {
  const container = usePortalContainer();
  const choices = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
  return (
    <BaseSelect.Root
      items={choices}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <BaseSelect.Label className={compact || inRow ? "sr" : "flab"}>{label}</BaseSelect.Label>
      <BaseSelect.Trigger ref={triggerRef} className={inRow ? "ssort sfill sel" : compact ? "ssort sel" : "finp sel"}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="sel-i">{inRow ? <ChevronDownIcon /> : <ChevronsIcon />}</BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal container={container}>
        <BaseSelect.Positioner className="layer" sideOffset={6} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="menu sel-pop">
            <BaseSelect.List>
              {choices.map((choice) => (
                <BaseSelect.Item key={choice.value} value={choice.value} className="mi">
                  <BaseSelect.ItemText>{choice.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="sel-on">
                    <CheckIcon />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
