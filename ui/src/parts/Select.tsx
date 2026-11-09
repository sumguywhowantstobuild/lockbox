import { Select as BaseSelect } from "@base-ui/react/select";
import type { Ref } from "react";
import { CheckIcon, ChevronsIcon } from "./Icon";
import { usePortalContainer } from "./Portal";

/**
 * A short list to pick one from (a printer): a box that shows the chosen one and opens a list in the app's own menu
 * look. The box opens by click or the arrow keys, the arrow keys move through the list, Enter picks, Escape closes it
 * without picking, and focus goes back to the box. Always has one chosen (`value` is one of `items`); for many items
 * to narrow by typing, use `Combobox`. `label` is the visible label, which also names the box for a screen reader.
 * `triggerRef` reaches the box, for a screen that puts focus on it.
 */
export function Select({
  label,
  items,
  value,
  onValueChange,
  triggerRef,
}: {
  label: string;
  items: readonly string[];
  value: string;
  onValueChange: (value: string) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const container = usePortalContainer();
  return (
    <BaseSelect.Root
      items={items.map((item) => ({ label: item, value: item }))}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <BaseSelect.Label className="flab">{label}</BaseSelect.Label>
      <BaseSelect.Trigger ref={triggerRef} className="finp sel">
        <BaseSelect.Value />
        <BaseSelect.Icon className="sel-i">
          <ChevronsIcon />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal container={container}>
        <BaseSelect.Positioner className="layer" sideOffset={6} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="menu sel-pop">
            <BaseSelect.List>
              {items.map((item) => (
                <BaseSelect.Item key={item} value={item} className="mi">
                  <BaseSelect.ItemText>{item}</BaseSelect.ItemText>
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
