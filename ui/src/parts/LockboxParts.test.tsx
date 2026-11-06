/// <reference types="vite/client" />
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LockboxParts } from "./LockboxParts";

// Vitest globals are off, so Testing Library does not unmount between tests by itself.
afterEach(cleanup);

// React puts a `<style>` element into the document head and keeps it there; each test starts without any.
beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
});

function styleElements(): number {
  return document.querySelectorAll("style").length;
}

const OPEN_DIALOG = (
  <Dialog.Root defaultOpen>
    <Dialog.Portal>
      <Dialog.Popup>
        <Dialog.Title>Probe dialog</Dialog.Title>
        <Dialog.Close>Close</Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);

const OPEN_MENU = (
  <Menu.Root defaultOpen>
    <Menu.Trigger>Probe menu</Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner>
        <Menu.Popup>
          <Menu.Item>First</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

const OPEN_COMBOBOX = (
  <Combobox.Root items={["Alpha", "Beta"]} defaultOpen>
    <Combobox.Input aria-label="Probe combobox" />
    <Combobox.Portal>
      <Combobox.Positioner>
        <Combobox.Popup>
          <Combobox.List>
            {(item: string) => (
              <Combobox.Item key={item} value={item}>
                {item}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  </Combobox.Root>
);

// The two parts whose package source writes a `<style>` element (its scroll area and its select popup).
const SCROLL_AREA = (
  <ScrollArea.Root>
    <ScrollArea.Viewport>
      <ScrollArea.Content>
        <p>Scrolling text</p>
      </ScrollArea.Content>
    </ScrollArea.Viewport>
  </ScrollArea.Root>
);

const OPEN_SELECT = (
  <Select.Root defaultOpen items={[{ label: "Gala", value: "gala" }]}>
    <Select.Trigger aria-label="Probe select">
      <Select.Value />
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner>
        <Select.Popup>
          <Select.List>
            <Select.Item value="gala">
              <Select.ItemText>Gala</Select.ItemText>
            </Select.Item>
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
);

function inLockboxParts(part: ReactNode): void {
  render(<LockboxParts>{part}</LockboxParts>);
}

test("dialog_menu_combobox_add_no_style_elements", () => {
  for (const part of [OPEN_DIALOG, OPEN_MENU, OPEN_COMBOBOX, SCROLL_AREA, OPEN_SELECT]) {
    inLockboxParts(part);
    // The part is on the page (the check is not passing on an empty render), and left no style element.
    expect(document.body.textContent).not.toBe("");
    expect(styleElements()).toBe(0);
    cleanup();
  }
  // All of them together, as the probe section shows them.
  inLockboxParts(
    <>
      {OPEN_DIALOG}
      {OPEN_MENU}
      {OPEN_COMBOBOX}
      {SCROLL_AREA}
      {OPEN_SELECT}
    </>,
  );
  expect(styleElements()).toBe(0);
});

test("without_the_provider_scroll_area_and_select_do_add_style_elements", () => {
  // The control for the test above: the library does write a style element unless the provider says not to, so a
  // count of zero there is the provider's doing. (Both parts name the same element, which React adds to the document
  // once, so they go in together.)
  render(
    <>
      {SCROLL_AREA}
      {OPEN_SELECT}
    </>,
  );
  expect(styleElements()).toBeGreaterThan(0);
});

test("scroll_area_and_select_work_with_style_elements_off", () => {
  inLockboxParts(
    <>
      {SCROLL_AREA}
      {OPEN_SELECT}
    </>,
  );
  expect(screen.getByText("Scrolling text")).toBeTruthy();
  const option = screen.getByRole("option", { name: "Gala" });
  expect(option).toBeTruthy();
  // The selection is made and shown in the trigger.
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  expect(screen.getByRole("combobox", { name: "Probe select" }).textContent).toBe("Gala");
});

// The built style sheets and fonts, found by name only (the glob loads nothing). It finds none until `npm run build`
// has run.
const builtCss = Object.keys(import.meta.glob("../../dist/assets/*.css"));
const builtFonts = Object.keys(import.meta.glob("../../dist/assets/*.woff2"));

const BUILD_FIRST = "No built style sheet found in ui/dist/assets: run `npm run build` in ui/ first, then this test.";

test("fonts_build_without_data_uris", () => {
  const sheets = builtCss.map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  expect(sheets.length, BUILD_FIRST).toBeGreaterThan(0);

  const faces = sheets.flatMap((css) => css.match(/@font-face\s*\{[^}]*\}/g) ?? []);
  const families = new Set(faces.map((face) => /font-family:\s*["']?([^;"']+)/.exec(face)?.[1]));
  expect(families, "both fonts are in the built style sheet").toContain("Geist Variable");
  expect(families).toContain("Geist Mono Variable");

  const fontFiles = builtFonts.map((path) => path.slice(path.lastIndexOf("/") + 1));
  for (const face of faces) {
    const urls = [...face.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)].map((match) => match[1] ?? "");
    expect(urls.length, "every font face names a file").toBeGreaterThan(0);
    for (const url of urls) {
      // The Content Security Policy allows fonts only from the app itself (`font-src 'self'`), never from `data:`.
      expect(url.startsWith("data:"), "a font is embedded as a data: URI: assetsInlineLimit must be 0").toBe(false);
      expect(fontFiles, `${url} is shipped as its own file`).toContain(url.slice(url.lastIndexOf("/") + 1));
    }
  }
});
