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
