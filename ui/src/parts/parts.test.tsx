// The parts every later screen is built from, under the app's real policy (`LockboxParts`): each draws what a screen
// reader needs, holds or returns focus as the design says, and writes no style into the page.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectNoAxe } from "../testing/axe";
import { Button } from "./Button";
import { Combobox } from "./Combobox";
import { Dialog } from "./Dialog";
import { LockboxParts } from "./LockboxParts";
import { Menu } from "./Menu";
import { Panel } from "./Panel";
import { PasswordField } from "./PasswordField";
import { Select } from "./Select";

afterEach(cleanup);

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
});

function Opener({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open it
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClose?.();
        }}
        title="Lock every vault?"
        description="Everything on screen goes."
      >
        <Button
          onClick={() => {
            setOpen(false);
          }}
        >
          Lock all
        </Button>
      </Dialog>
    </>
  );
}

test("a_dialog_holds_focus_and_gives_it_back", async () => {
  const closed = vi.fn();
  const { container } = render(
    <LockboxParts>
      <Opener onClose={closed} />
    </LockboxParts>,
  );
  const opener = screen.getByRole("button", { name: "Open it" });
  opener.focus();
  fireEvent.click(opener);

  const dialog = await screen.findByRole("dialog", { name: "Lock every vault?" });
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  expect(within(dialog).getByText("Everything on screen goes.")).toBeTruthy();
  // Focus is inside, and the page behind is out of reach of a screen reader and of Tab while it is open.
  await vi.waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  expect(screen.queryByRole("button", { name: "Open it" })).toBeNull();
  expect(document.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(document.body);

  // Escape closes it and puts focus back on what had it.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(opener);
  });
  expect(closed).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
});

test("a_dialog_answered_by_its_button_closes_and_gives_focus_back", async () => {
  render(
    <LockboxParts>
      <Opener />
    </LockboxParts>,
  );
  const opener = screen.getByRole("button", { name: "Open it" });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(await screen.findByRole("button", { name: "Lock all" }));
  await vi.waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(opener);
  });
});

test("a_menu_opens_from_its_button_and_chooses_one_item", async () => {
  const chosen = vi.fn<(which: string) => void>();
  render(
    <LockboxParts>
      <Menu
        label="More"
        items={[
          {
            label: "Rename",
            onSelect: () => {
              chosen("rename");
            },
          },
          {
            label: "Delete",
            onSelect: () => {
              chosen("delete");
            },
            danger: true,
          },
        ]}
      />
    </LockboxParts>,
  );
  const trigger = screen.getByRole("button", { name: "More" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu");
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(["Rename", "Delete"]);
  await expectNoAxe(menu);
  fireEvent.click(items[1] as HTMLElement);
  expect(chosen).toHaveBeenCalledWith("delete");
  await vi.waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("a_combobox_narrows_as_you_type_and_picks_one", async () => {
  function Pick() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <>
        <Combobox label="Folder" items={["Agency support agent", "Lineproof", "Portfolio"]} value={value} onValueChange={setValue} />
        <output>{value ?? "none"}</output>
      </>
    );
  }
  render(
    <LockboxParts>
      <Pick />
    </LockboxParts>,
  );
  const input = screen.getByRole("combobox", { name: "Folder" });
  input.focus();
  fireEvent.change(input, { target: { value: "line" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: "Lineproof" });
  expect(screen.queryByRole("option", { name: "Portfolio" })).toBeNull();
  await expectNoAxe(screen.getByRole("listbox"));
  fireEvent.click(option);
  expect(screen.getByRole("status").textContent).toBe("Lineproof");
});

function Choose({ onPick }: { onPick?: (value: string) => void }) {
  const [value, setValue] = useState("Hall Inkjet");
  return (
    <>
      <Select
        label="Printer"
        items={["Office Laser", "Hall Inkjet", "Back Office"]}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onPick?.(next);
        }}
      />
      <button type="button">After it</button>
    </>
  );
}

test("a_select_opens_by_keyboard_and_picks_with_arrows_and_enter", async () => {
  const picked = vi.fn<(value: string) => void>();
  const { container } = render(
    <LockboxParts>
      <Choose onPick={picked} />
    </LockboxParts>,
  );
  // Named by its visible label, showing the chosen one, and nothing is open yet.
  const trigger = screen.getByRole("combobox", { name: "Printer" });
  expect(trigger.textContent).toBe("Hall Inkjet");
  expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("listbox")).toBeNull();
  await expectNoAxe(container);

  // The arrow key opens it, with the list in the app's own menu look, one option per printer and the chosen one marked.
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const list = await screen.findByRole("listbox");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(list.closest(".menu")).not.toBeNull();
  const options = within(list).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Office Laser", "Hall Inkjet", "Back Office"]);
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  expect(options.every((option) => option.classList.contains("mi"))).toBe(true);
  expect(document.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(list);

  // Focus is in the list; ArrowDown moves to the next one, Enter picks it, and the list closes with focus back on the box.
  await vi.waitFor(() => {
    expect(list.contains(document.activeElement)).toBe(true);
  });
  const highlighted = () => options.find((option) => option.hasAttribute("data-highlighted"));
  expect(highlighted()?.textContent).toBe("Hall Inkjet");
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
  await vi.waitFor(() => {
    expect(highlighted()?.textContent).toBe("Back Office");
  });
  fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  expect(picked).toHaveBeenCalledExactlyOnceWith("Back Office");
  expect(trigger.textContent).toBe("Back Office");
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(trigger);
  });
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("a_select_picks_with_a_click_and_escape_changes_nothing", async () => {
  const picked = vi.fn<(value: string) => void>();
  render(
    <LockboxParts>
      <Choose onPick={picked} />
    </LockboxParts>,
  );
  const trigger = screen.getByRole("combobox", { name: "Printer" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const list = await screen.findByRole("listbox");
  // Escape closes it, picks nothing, and focus is back on the box.
  fireEvent.keyDown(list, { key: "Escape" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  expect(picked).not.toHaveBeenCalled();
  expect(trigger.textContent).toBe("Hall Inkjet");
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(trigger);
  });

  // A click on an option picks it.
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: "Office Laser" });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await vi.waitFor(() => {
    expect(trigger.textContent).toBe("Office Laser");
  });
  expect(picked).toHaveBeenCalledExactlyOnceWith("Office Laser");
});

test("a_panel_is_a_named_region_with_a_close_button", async () => {
  const closed = vi.fn();
  const { container } = render(
    <Panel title="Bot admin console" onClose={closed}>
      <p>Body</p>
    </Panel>,
  );
  const panel = screen.getByRole("complementary", { name: "Bot admin console" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Bot admin console" })).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(closed).toHaveBeenCalledTimes(1);
  await expectNoAxe(container);
});

test("a_password_field_is_hidden_named_and_never_remembered", async () => {
  function Typed() {
    const [value, setValue] = useState("");
    return <PasswordField label="Password for My vault" value={value} onChange={setValue} />;
  }
  const { container } = render(<Typed />);
  const field = screen.getByLabelText<HTMLInputElement>("Password for My vault");
  expect(field.type).toBe("password");
  // The browser is told not to keep, fill or correct what is typed.
  expect(field.getAttribute("autocomplete")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
  fireEvent.change(field, { target: { value: "typed" } });
  expect(field.value).toBe("typed");
  await expectNoAxe(container);
});
