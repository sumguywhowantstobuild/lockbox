// Measures the colour pairs the screens use, from `tokens.css` itself, in light and dark and for each vault's accent.
// Text is held to 4.5 to 1 and every part that shows a state to 3 to 1 (the plan's rule: a pair for every part that
// shows a state, translucent colours measured as they look on screen, so each is laid over the surface behind it
// first). A pair that is not listed here is not measured; a colour added to the screens gets its pair here.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const TOKENS = readBeside(import.meta.url, "./tokens.css");

/** Every rule of the file: its selector and its declarations. The file has flat rules only. */
function rules(css: string): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
    const declarations = found.get(selector) ?? new Map<string, string>();
    for (const declaration of (match[2] ?? "").split(";")) {
      const at = declaration.indexOf(":");
      if (at > 0) declarations.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
    }
    found.set(selector, declarations);
  }
  return found;
}

const RULES = rules(TOKENS);
const MODES = ["light", "dark"] as const;
const VAULTS = ["work", "home", "old"] as const;

/** The variables in force on a screen of this mode and vault. */
function variables(mode: string, vault: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const selector of [".app", `.mode-${mode}`, `.v-${vault}`, `.mode-${mode}.v-${vault}`]) {
    const own = RULES.get(selector);
    expect(own, `${selector} is in tokens.css`).toBeDefined();
    for (const [name, value] of own ?? []) merged.set(name, value);
  }
  return merged;
}

function hexToRgba(hex: string): Rgba {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.replace(/./g, "$&$&") : digits;
  expect(full, `${hex} is a colour`).toMatch(/^[0-9a-f]{6}$/i);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1];
}

/** A colour as written in the file, with `var(--x)` followed. */
function parseColor(value: string, vars: Map<string, string>): Rgba {
  const text = value.trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(text);
  if (reference) {
    const next = vars.get(reference[1] ?? "");
    expect(next, `${text} is defined`).toBeDefined();
    return parseColor(next ?? "", vars);
  }
  if (text.startsWith("#")) return hexToRgba(text);
  const functional = /^rgba?\(([^)]*)\)$/.exec(text);
  expect(functional, `${text} is a colour`).not.toBeNull();
  const parts = (functional?.[1] ?? "").split(",").map((part) => Number(part.trim()));
  expect(parts.every(Number.isFinite), text).toBe(true);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

/** A colour laid over a surface, as it looks on screen. */
function over(top: Rgba, below: Rgba): Rgba {
  const [r, g, b, a] = top;
  expect(below[3], "the surface behind is solid").toBe(1);
  return [r * a + below[0] * (1 - a), g * a + below[1] * (1 - a), b * a + below[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgb | Rgba): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgba, b: Rgba): number {
  expect(a[3] === 1 && b[3] === 1, "both colours are solid by now").toBe(true);
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

test("the_measure_itself_is_right_and_can_fail", () => {
  expect(ratio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
  expect(ratio([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 1);
  // A translucent colour is measured over what is behind it: half white over black is mid grey, not white.
  const grey = over([255, 255, 255, 0.5], [0, 0, 0, 1]);
  expect(grey[0]).toBeCloseTo(127.5, 5);
  expect(ratio(grey, [255, 255, 255, 1])).toBeLessThan(4);
  // The file really holds the colours it is said to: a light and a dark mode, and an accent for each.
  expect([...RULES.keys()]).toEqual(
    expect.arrayContaining([".mode-light", ".mode-dark", ".mode-light.v-work", ".mode-dark.v-old"]),
  );
});

interface Failure {
  where: string;
  pair: string;
  ratio: string;
  needed: number;
}

test("text_and_state_pairs_hold_in_light_and_dark", () => {
  const failures: Failure[] = [];
  let measured = 0;

  for (const mode of MODES) {
    for (const vault of VAULTS) {
      const vars = variables(mode, vault);
      const where = `${mode}, ${vault}`;
      const c = (name: string): Rgba => parseColor(`var(${name})`, vars);
      const rgbOf = (name: string): Rgb => {
        const parts = (vars.get(name) ?? "").split(",").map((part) => Number(part.trim()));
        expect(parts, `${name} is three numbers`).toHaveLength(3);
        return parts as Rgb;
      };
      const check = (pair: string, foreground: Rgba, background: Rgba, needed: number) => {
        measured += 1;
        const got = ratio(foreground, background);
        if (got < needed) failures.push({ where, pair, ratio: got.toFixed(2), needed });
      };

      const ground = c("--ground");
      const rail = c("--rail");
      const card = c("--card");
      const paper = c("--paper");
      const surfaces: [string, Rgba][] = [
        ["ground", ground],
        ["rail", rail],
        ["card", card],
        ["panel", paper],
      ];
      // The tints, as they look: laid over the surface they sit on.
      const selectedNav = over(c("--sel"), rail);
      const selectedRow = over(c("--row-on"), card);
      const hoveredRow = over(c("--hov"), card);
      const hoveredNav = over(c("--hov"), rail);
      const pressedRow = over(c("--prs"), card);
      const pressedNav = over(c("--prs"), rail);
      const tinted: [string, Rgba][] = [
        ["selected side-menu item", selectedNav],
        ["selected row", selectedRow],
        ["hovered row", hoveredRow],
        ["hovered side-menu item", hoveredNav],
        ["pressed row", pressedRow],
        ["pressed side-menu item", pressedNav],
      ];

      // Text, 4.5 to 1: on every surface and every tint.
      for (const [name, surface] of [...surfaces, ...tinted]) {
        check(`text on ${name}`, c("--ink"), surface, 4.5);
        check(`quiet text on ${name}`, c("--ink2"), surface, 4.5);
      }
      for (const [name, surface] of surfaces.filter(([name]) => name !== "rail")) {
        check(`error text on ${name}`, c("--danger"), surface, 4.5);
      }
      check("error text on the side menu", c("--danger"), rail, 4.5);
      // The main button's words in each of its states, and the accent as words on a hovered copy button.
      for (const [state, fill] of [["rest", "--add"], ["hover", "--addh"], ["pressed", "--addp"]] as const) {
        check(`button words, ${state}`, c("--addi"), c(fill), 4.5);
      }
      check("accent words on a hovered copy button", c("--v"), pressedRow, 4.5);
      // The lock screen's Unlock: the ground's colour on the ink, at rest and hovered.
      check("Unlock words, rest", ground, c("--ink"), 4.5);
      check("Unlock words, hover", ground, c("--ink2"), 4.5);
      check("Unlock button against the plate", c("--ink"), ground, 3);
      check("focus ring on the lock screen's plate", c("--ink"), ground, 3);
      // The vault's mark, a line drawing in the vault's own colour: on its row of the lock screen's list (at rest,
      // hovered, pressed) and in the side menu (at rest, hovered).
      for (const [name, surface] of [
        ["its row on the lock screen", card],
        ["its row, hovered", hoveredRow],
        ["its row, pressed", pressedRow],
        ["the side menu", rail],
        ["the side menu, hovered", hoveredNav],
      ] as const) {
        check(`vault mark on ${name}`, c("--v"), surface, 3);
      }
      // The message bar, and its countdown, which is white at 86 per cent.
      check("message bar words", c("--toast-ink"), c("--toast"), 4.5);
      check("message bar countdown", over([255, 255, 255, 0.86], c("--toast")), c("--toast"), 4.5);
      check("lock screen words", c("--field-ink"), c("--field"), 4.5);
      // Picked text: the vault's wash over what is behind it, with the words in that surface's own colour (base.css).
      for (const [name, surface] of surfaces) check(`picked text on ${name}`, c("--ink"), over(c("--select"), surface), 4.5);
      check("picked words on the lock screen's dark side", c("--field-ink"), over(c("--select"), c("--field")), 4.5);
      check("picked words in the message bar", c("--toast-ink"), over(c("--select"), c("--toast")), 4.5);
      // The closed side menu's folder letters: the tile's colour mixed with the text colour, on its own tint.
      const mix = Number.parseFloat(vars.get("--tile-mix") ?? "") / 100;
      expect(mix, "--tile-mix is a percentage").toBeGreaterThan(0);
      for (const tile of ["--t0", "--t1", "--t2", "--t3", "--t4"]) {
        const base = rgbOf(tile);
        const ink = c("--ink");
        const mixed = (channel: 0 | 1 | 2) => base[channel] * mix + ink[channel] * (1 - mix);
        const letter: Rgba = [mixed(0), mixed(1), mixed(2), 1];
        check(`folder letter ${tile}`, letter, over([...base, 0.15] as Rgba, rail), 4.5);
      }
      // A marked button at the side menu's foot (Settings open): its edge against the side menu, as a state part.
      check("marked side-menu button's edge", c("--ink2"), rail, 3);
      // A dangerous answer: its words on its red fill.
      check("danger button words", c("--danger-fill-ink"), c("--danger-fill"), 4.5);
      // A list row's kind icon: a line drawing, the tile's colour mixed with the text colour, on its tint over the list
      // and over a selected row. A picture, so 3 to 1.
      const iconMix = Number.parseFloat(vars.get("--icon-mix") ?? "") / 100;
      expect(iconMix, "--icon-mix is a percentage").toBeGreaterThan(0);
      for (const tile of ["--t0", "--t1", "--t2", "--t3", "--t4"]) {
        const base = rgbOf(tile);
        const ink = c("--ink");
        const mixed = (channel: 0 | 1 | 2) => base[channel] * iconMix + ink[channel] * (1 - iconMix);
        const icon: Rgba = [mixed(0), mixed(1), mixed(2), 1];
        for (const [name, surface] of [
          ["a row", card],
          ["a hovered row", hoveredRow],
          ["a pressed row", pressedRow],
          ["a selected row", selectedRow],
        ] as const) {
          check(`row icon ${tile} on ${name}`, icon, over([...base, 0.15] as Rgba, surface), 3);
        }
      }

      // Parts that show a state, 3 to 1.
      // The focus ring is the accent, drawn outside the part: against every surface behind it, and against the dark
      // lock screen and the message bar where it is white.
      const ringed: [string, Rgba][] = [
        ...surfaces,
        ["selected side-menu item", selectedNav],
        ["selected row", selectedRow],
      ];
      for (const [name, surface] of ringed) {
        check(`focus ring on ${name}`, c("--v"), surface, 3);
      }
      check("focus ring on the lock screen's dark side", c("--field-ink"), c("--field"), 3);
      check("focus ring on the message bar", c("--toast-ink"), c("--toast"), 3);
      // The selected row: its marker against the row's own tint, its neighbours and a hovered neighbour.
      for (const [name, surface] of [["its own tint", selectedRow], ["the rows around it", card], ["a hovered neighbour", hoveredRow]] as const) {
        check(`selected row marker on ${name}`, c("--add"), surface, 3);
      }
      for (const [name, surface] of [["its own tint", selectedNav], ["the menu around it", rail], ["a hovered neighbour", hoveredNav]] as const) {
        check(`selected side-menu marker on ${name}`, c("--add"), surface, 3);
      }
      // The vault chosen on the lock screen: its two-pixel border against the ground it sits on.
      check("chosen vault's border", c("--ink"), ground, 3);
      // A field's edge, and the main button against what it sits on, in each state.
      for (const [name, surface] of [["ground", ground], ["card", card]] as const) {
        check(`field edge on ${name}`, c("--edge"), surface, 3);
      }
      for (const [name, surface] of surfaces) {
        for (const [state, fill] of [["rest", "--add"], ["hover", "--addh"], ["pressed", "--addp"]] as const) {
          check(`main button, ${state}, on ${name}`, c(fill), surface, 3);
        }
      }
      // The first-use screens: the recovery key's box (its edge against the plate, its words on the card), the quiet
      // link-buttons (words on the plate at rest, hovered and pressed) and a field in error (its edge against the plate).
      check("recovery key box edge on the plate", c("--edge"), ground, 3);
      // The create form's password rule once it is met: the check mark in the vault's colour on the plate (its words are
      // the ordinary text colour, measured above).
      check("password rule's met check mark on the plate", c("--v"), ground, 3);
      check("recovery key words on their box", c("--ink"), card, 4.5);
      for (const [state, tint] of [["rest", ground], ["hover", over(c("--hov"), ground)], ["pressed", over(c("--prs"), ground)]] as const) {
        check(`link-button words, ${state}`, c("--ink"), tint, 4.5);
      }
      check("link-button words, disabled", c("--ink2"), ground, 4.5);
      // The key screen's Print and Save as PDF: card-coloured buttons with an edge on the plate. Words at rest, hovered and
      // pressed (the tint laid over the card), greyed while another print runs, and the edge against the plate at rest.
      for (const [state, fill] of [["rest", card], ["hover", over(c("--hov"), card)], ["pressed", over(c("--prs"), card)]] as const) {
        check(`Print and Save as PDF words, ${state}`, c("--ink"), fill, 4.5);
      }
      check("Print and Save as PDF words, waiting", c("--ink2"), card, 4.5);
      check("Print and Save as PDF edge on the plate", c("--edge"), ground, 3);
      // The saved line's words on the plate, and the cloud question's quiet answer on the panel behind it.
      check("saved line words on the plate", c("--ink"), ground, 4.5);
      // The printer picker under them: its list (a field on the plate: words on the card, edge on the plate, and its label
      // and sentence on the plate), its Print (the screen's main button: at rest, hovered, and greyed while a job runs, with
      // its fill against the plate), and its Cancel (a quiet button, measured above).
      check("printer list words on its field", c("--ink"), card, 4.5);
      check("printer list edge on the plate", c("--edge"), ground, 3);
      // The list opened from it (the menu's look): the arrows in the box, and each option's words at rest, highlighted and
      // pressed (the tints laid over the card).
      check("printer list arrows on its field", c("--ink2"), card, 3);
      for (const [state, fill] of [["rest", card], ["highlighted", over(c("--hov"), card)], ["pressed", over(c("--prs"), card)]] as const) {
        check(`printer list option words, ${state}`, c("--ink"), fill, 4.5);
      }
      check("printer label on the plate", c("--ink2"), ground, 4.5);
      check("no-printer sentence on the plate", c("--ink"), ground, 4.5);
      check("picker Print words, rest", ground, c("--ink"), 4.5);
      check("picker Print words, hover", ground, c("--ink2"), 4.5);
      check("picker Print words, waiting", c("--ink2"), over(c("--line"), ground), 4.5);
      check("picker Print fill against the plate", c("--ink"), ground, 3);
      check("cloud question words on the panel", c("--ink2"), card, 4.5);
      // Its quiet pill (Continue) on the panel: the shade is translucent, so each state is laid over the card.
      for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
        check(`quiet pill words on the panel, ${state}`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, card), 4.5);
      }
      // The app's questions: a banner's words and its refusal line on its card, and its edge against the screen it sits on
      // (the plate, or the list's ground). Its Close and answer buttons are the quiet pill measured above, on the card, and
      // Ask 3's two buttons are the dialog's own (the quiet pill, and the main button on the panel, both measured). The
      // dialog is on the card too, so its refusal line is the same pair as the banner's.
      check("banner words on its card", c("--ink"), card, 4.5);
      check("banner refusal line on its card", c("--danger"), card, 4.5);
      check("banner edge on the screen", c("--edge"), ground, 3);
      check("field in error, edge on the plate", c("--danger"), ground, 3);
      check("field in error, edge on the card", c("--danger"), card, 3);
      // The vault menu (5a): the vault's name as a button on the side menu (at rest, hovered, pressed, and its focus ring
      // against the side menu), and in the menu each vault's name and its state words (Unlocked, Locked), which are the
      // only mark of the state, on the card the menu is drawn on; its one action at rest, highlighted and pressed.
      for (const [state, fill] of [["rest", rail], ["hover", hoveredNav], ["pressed", pressedNav]] as const) {
        check(`vault button words, ${state}`, c("--ink"), fill, 4.5);
      }
      check("vault button focus ring on the side menu", c("--ink"), rail, 3);
      check("vault menu name words on the card", c("--ink"), card, 4.5);
      check("vault menu state words on the card", c("--ink2"), card, 4.5);
      for (const [state, fill] of [["rest", card], ["highlighted", hoveredRow], ["pressed", pressedRow]] as const) {
        check(`vault menu action words, ${state}`, c("--ink"), fill, 4.5);
      }
      // 5b: its Got it is the panel's main pill, measured above; its words are on the card like any dialog's.
      check("first-close message words on the card", c("--ink2"), card, 4.5);
      // The switch: its off track against the card, its knob against both tracks, and its on track against the card.
      check("switch, off track on the card", c("--switch-off"), card, 3);
      check("switch, knob on the off track", c("--switch-knob"), c("--switch-off"), 3);
      check("switch, knob on the on track", c("--switch-knob"), c("--add"), 3);
      check("switch, on track on the card", c("--add"), card, 3);
      // Search. Its button in the side menu: words at rest, hovered and pressed (the tints over the side menu), its key cap
      // (quiet words on the ground), and the same button's focus ring (the side menu's ring, measured above).
      for (const [state, fill] of [["rest", rail], ["hover", hoveredNav], ["pressed", pressedNav]] as const) {
        check(`search button words, ${state}`, c("--ink2"), fill, 4.5);
      }
      check("key cap words on the ground", c("--ink2"), ground, 4.5);
      // The box over the window, on the card: what is typed, its placeholder, the line under it that marks where focus is,
      // and the key cap beside it.
      check("search box words on the card", c("--ink"), card, 4.5);
      check("search box placeholder on the card", c("--ink2"), card, 4.5);
      check("search box focus line on the card", c("--v"), card, 3);
      check("search icon on the card", c("--ink2"), card, 3);
      // A result at rest, with the pointer on it and with focus in it (the tint over the card): its title and its quiet
      // detail line are measured above as text on those tints. Its buttons are the quiet pill, translucent, laid over the
      // row as it looks then; the focus ring on a result is the ordinary one.
      const resultRows: [string, Rgba][] = [["at rest", card], ["with the pointer on it", hoveredRow]];
      for (const [row, surface] of resultRows) {
        for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
          const pill = over([...rgbOf("--sh"), alpha] as Rgba, surface);
          check(`search result button words, ${state}, on a result ${row}`, c("--ink"), pill, 4.5);
        }
        check(`focus ring on a result ${row}`, c("--ink"), surface, 3);
      }
      // The foot of the box (Lock all and Close) is on the ground, under the results.
      for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
        check(`search foot button words, ${state}`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, ground), 4.5);
      }
      check("focus ring on the search foot", c("--ink"), ground, 3);
      // What it says when nothing is found, which vaults were busy, and a refusal, all on the card (the pairs above).
      check("search sentences on the card", c("--ink2"), card, 4.5);
      check("search refusal on the card", c("--danger"), card, 4.5);

      // Add, the new-login form and the generator. Add is the main button on the toolbar's ground (its words in each state
      // and its fill against the ground are the main button's pairs above). In the form: its fields are the panel's card
      // (words, edge and error edge measured above), and its hint and the folder list's words are the ordinary text.
      check("form hint on the panel", c("--ink2"), paper, 4.5);
      check("form error line on the panel", c("--danger"), paper, 4.5);
      check("form field in error, edge on the panel", c("--danger"), paper, 3);
      // The generator's block is a faint tint on the panel; its value sits on a card inside it.
      const genBlock = over([...rgbOf("--sh"), 0.05] as Rgba, paper);
      check("generator labels on their block", c("--ink"), genBlock, 4.5);
      check("generator value on its card", c("--ink"), card, 4.5);
      check("generator refusal line on its block", c("--danger"), genBlock, 4.5);
      check("generator value's focus ring on its card", c("--v"), card, 3);
      // The slider and the two checkboxes are drawn in the vault's colour on that block.
      check("generator slider and checkboxes on their block", c("--v"), genBlock, 3);
      // The save box (Task 18): the copied value's box is a field on the panel, showing its dots or the value itself; the vault's name
      // is a field too; the clear-the-clipboard tick box is drawn in the vault's colour on the panel, with its words and its hint beside it
      // (the hint is the form hint above), and a note of the page's own (what the copy was, or that it changed) is the quiet words.
      check("copied value, hidden dots on its box", c("--ink2"), card, 4.5);
      check("copied value, shown, on its box", c("--ink"), card, 4.5);
      check("clear the clipboard tick box on the panel", c("--v"), paper, 3);
      check("clear the clipboard words on the panel", c("--ink"), paper, 4.5);
      check("save box note on the panel", c("--ink2"), paper, 4.5);
      // Characters or Passphrase: the track is a tint on the block; the chosen one is a filled card with a thin edge in the quiet
      // text colour, so the choice does not rest on a tint, and both kinds' words are the ordinary text colour on what they sit on.
      const segTrack = over([...rgbOf("--sh"), 0.08] as Rgba, genBlock);
      const segTrackOnPanel = over([...rgbOf("--sh"), 0.08] as Rgba, paper);
      check("kind button words, not chosen, on the track in the form", c("--ink"), segTrack, 4.5);
      check("kind button words, not chosen, on the track on the page", c("--ink"), segTrackOnPanel, 4.5);
      check("kind button words, chosen, on its card", c("--ink"), card, 4.5);
      check("chosen kind's edge against the track in the form", c("--ink2"), segTrack, 3);
      check("chosen kind's edge against the track on the page", c("--ink2"), segTrackOnPanel, 3);
      // The form's quiet pills (Generate, Try another, Cancel) are the pill measured above, here on the panel and on the block.
      for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
        check(`quiet pill words on the generator block, ${state}`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, genBlock), 4.5);
        check(`quiet pill words on the panel, ${state}`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, paper), 4.5);
      }
      // "Saved" is the message bar's words, measured above.

      // Move, trash and folders (Task 14). Move to trash and the Trash's two answers are rows of a card: Delete for good and Move
      // to trash in the error colour, Restore in the vault's colour, at rest, hovered and pressed (the tints laid over the card).
      // A question's dangerous answer is the filled red button, measured above.
      for (const [state, fill] of [["rest", card], ["hover", over(c("--hov"), card)], ["pressed", over(c("--prs"), card)]] as const) {
        check(`card row danger words, ${state}`, c("--danger"), fill, 4.5);
        check(`card row Restore words, ${state}`, c("--v"), fill, 4.5);
      }
      // Undo on the message bar: white words on the white tint over the bar, at rest and hovered.
      for (const [state, alpha] of [["rest", 0.14], ["hover", 0.24]] as const) {
        check(`Undo words, ${state}`, c("--toast-ink"), over([255, 255, 255, alpha], c("--toast")), 4.5);
      }
      // The Trash entry once picked is a picked side-menu item: its words and count on the tint, and its marker.
      check("Trash entry words, picked", c("--ink"), selectedNav, 4.5);
      check("Trash entry count, picked", c("--ink2"), selectedNav, 4.5);
      check("Trash entry marker, picked", c("--add"), selectedNav, 3);
      // The folder marked in the Move menu: its check mark and its words on the menu's card, at rest, highlighted and pressed.
      for (const [state, fill] of [["rest", card], ["highlighted", hoveredRow], ["pressed", pressedRow]] as const) {
        check(`Move menu check mark, ${state}`, c("--ink"), fill, 3);
        check(`Move menu folder words, ${state}`, c("--ink"), fill, 4.5);
      }
      // The new folder's name box in the side menu: its edge (the quiet text colour, since the ordinary field edge is a hair
      // under 3 to 1 against the side menu's tint) against the side menu, its words on its own card, its error edge.
      check("new folder box edge on the side menu", c("--ink2"), rail, 3);
      check("new folder box words on its card", c("--ink"), card, 4.5);
      check("new folder box error edge on the side menu", c("--danger"), rail, 3);
      check("new folder box focus ring on the side menu", c("--v"), rail, 3);

      // Show one kind, and sort (Task 15). The two lists in the toolbar are on the list's ground: their words and their
      // arrow pair at rest, hovered or open, and pressed (the tints laid over the ground), and their focus ring.
      for (const [state, fill] of [["rest", ground], ["hover or open", over(c("--hov"), ground)], ["pressed", over(c("--prs"), ground)]] as const) {
        check(`kind and sort list words, ${state}`, c("--ink"), fill, 4.5);
        check(`kind and sort list arrows, ${state}`, c("--ink2"), fill, 3);
      }
      check("kind and sort list focus ring on the ground", c("--v"), ground, 3);
      // The list each opens (the menu's look): an option's words and the chosen one's check mark, at rest, highlighted and
      // pressed.
      for (const [state, fill] of [["rest", card], ["highlighted", hoveredRow], ["pressed", pressedRow]] as const) {
        check(`kind and sort option words, ${state}`, c("--ink"), fill, 4.5);
        check(`kind and sort option check mark, ${state}`, c("--ink"), fill, 3);
      }
      // The line that says the list is narrowed, on the ground, and "Show all" in it at rest, hovered and pressed.
      check("narrowed-list line on the ground", c("--ink2"), ground, 4.5);
      for (const [state, fill] of [["rest", ground], ["hover", over(c("--hov"), ground)], ["pressed", over(c("--prs"), ground)]] as const) {
        check(`Show all words, ${state}`, c("--ink"), fill, 4.5);
      }
      // Nothing matching (17c), on a card: its words (the text pairs above), Clear filter and Show all as the main pill
      // (its words on its fill in each state, and its fill against the card), and Search all vaults as the quiet pill.
      for (const [state, fill] of [["rest", "--add"], ["hover", "--addh"], ["pressed", "--addp"]] as const) {
        check(`Clear filter words, ${state}`, c("--addi"), c(fill), 4.5);
        check(`Clear filter button against its card, ${state}`, c(fill), card, 3);
      }
      for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
        check(`Search all vaults words, ${state}`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, card), 4.5);
      }

      // Paste a .env (Task 17, 15a to 15c). The box is a field on the panel (its words, edge and hint are measured above). The
      // rows sit on a card: a key's name, the dots for its hidden value and "Already here" in their own words, and the button
      // that leaves a row out, an icon alone, at rest and hovered (the tint laid over the card).
      check("pasted key name on its card", c("--ink"), card, 4.5);
      check("hidden value and Already here words on the card", c("--ink2"), card, 4.5);
      for (const [state, fill] of [["rest", card], ["hover", over(c("--hov"), card)], ["pressed", over(c("--prs"), card)]] as const) {
        check(`leave out button icon, ${state}`, c("--ink2"), fill, 3);
      }
      // Replace, Keep both, Cancel: the track is a tint on the card, the chosen one a filled card with a thin edge in the quiet
      // text colour, so the choice rests on an edge and on "pressed" said to a screen reader, never on a tint alone.
      const envTrack = over([...rgbOf("--sh"), 0.08] as Rgba, card);
      check("clash choice words, not chosen, on the track", c("--ink"), envTrack, 4.5);
      check("clash choice words, chosen, on its card", c("--ink"), card, 4.5);
      check("chosen clash choice's edge against the track", c("--ink2"), envTrack, 3);
      check("Saves as words on the card", c("--ink2"), card, 4.5);
      // Save while there is nothing to save: the panel's main pill, greyed (the shade of a disabled button), on the panel.
      check("panel Save words, off", c("--ink2"), over(c("--line"), paper), 4.5);
      check("panel Save words, off, on a dialog's card", c("--ink2"), over(c("--line"), card), 4.5);
      // Cancel (the quiet pill) while a save runs, on a dialog's card: the quiet words over the pill's shade.
      check("quiet pill words, off, on a dialog's card", c("--ink2"), over([...rgbOf("--sh"), 0.07] as Rgba, card), 4.5);

      // Settings (Task 20, 31a and 31b). The rows are on a group's card: a row's words, its hint, a refusal under it and the quiet pill
      // (Change, Cancel, laid over the card at rest, hovered and pressed).
      check("settings row words on the card", c("--ink"), card, 4.5);
      check("settings row hint on the card", c("--ink2"), card, 4.5);
      check("settings refusal line on the card", c("--danger"), card, 4.5);
      check("version words on the card", c("--ink"), card, 4.5);
      for (const [state, alpha] of [["rest", 0.07], ["hover", 0.13], ["pressed", 0.18]] as const) {
        check(`Change and Cancel words, ${state}, on the card`, c("--ink"), over([...rgbOf("--sh"), alpha] as Rgba, card), 4.5);
      }
      // The saved shortcut's key cap (quiet words on the ground's colour, laid on the card's row), and the one that waits for keys: its words and
      // the vault's colour round it, which is its mark, against the card.
      check("saved key cap words on the card's row", c("--ink2"), ground, 4.5);
      check("waiting key cap words on the card", c("--ink"), card, 4.5);
      check("waiting key cap edge on the card", c("--v"), card, 3);
      // Light, Dark and System: the track is a tint on the card, the chosen one a filled card with a thin edge in the quiet text colour.
      const themeTrack = over([...rgbOf("--sh"), 0.08] as Rgba, card);
      check("theme button words, not chosen, on the track", c("--ink"), themeTrack, 4.5);
      check("theme button words, chosen, on its card", c("--ink"), card, 4.5);
      check("chosen theme's edge against the track", c("--ink2"), themeTrack, 3);
      // The two lists: words and arrows on the card, and the field's edge, which is what marks the box.
      check("settings list words on the card", c("--ink"), card, 4.5);
      check("settings list arrows on the card", c("--ink2"), card, 3);
      check("settings list edge on the card", c("--edge"), card, 3);
      // The switches: the off track, the knob on each track and the on track, all against the card (the track is the part that shows the state,
      // and the knob's side says it as well). Its focus ring is the ordinary one, measured above.
      check("settings switch, off track on the card", c("--switch-off"), card, 3);
      check("settings switch, on track on the card", c("--add"), card, 3);
      check("settings switch, knob on the off track", c("--switch-knob"), c("--switch-off"), 3);
      check("settings switch, knob on the on track", c("--switch-knob"), c("--add"), 3);
    }
  }

  expect(measured, "the pairs were measured").toBeGreaterThan(400);
  expect(failures, "pairs below their ratio").toEqual([]);
});
