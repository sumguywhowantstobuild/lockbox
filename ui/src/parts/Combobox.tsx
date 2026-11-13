import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { usePortalContainer } from "./Portal";

/**
 * A box to type in with a list that narrows as you type, for picking one of many (a folder, a vault). The arrow keys
 * move through the list, Enter picks, Escape closes it. `value` is the chosen text, or `null` for none.
 */
export function Combobox({
  label,
  items,
  value,
  onValueChange,
}: {
  label: string;
  items: readonly string[];
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const container = usePortalContainer();
  return (
    <BaseCombobox.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        onValueChange(next);
      }}
    >
      <label className="flab">
        {label}
        <BaseCombobox.Input className="finp" />
      </label>
      <BaseCombobox.Portal container={container}>
        <BaseCombobox.Positioner className="layer" sideOffset={6}>
          <BaseCombobox.Popup className="menu">
            <BaseCombobox.Empty className="mi">No match</BaseCombobox.Empty>
            <BaseCombobox.List>
              {(item: string) => (
                <BaseCombobox.Item key={item} value={item} className="mi">
                  {item}
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
