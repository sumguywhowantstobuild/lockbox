// Hands-on probe for the parts library under the page's Content Security Policy (Plan 4A, Task 1). One dialog, menu,
// combobox, scroll area with a list, select and form, in Geist, and a list of every `securitypolicyviolation` the page
// has raised since it loaded. Pass is an empty list with all of them working by keyboard.
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import { Button } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Menu } from "@base-ui/react/menu";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { useState, useSyncExternalStore } from "react";
import "./PartsProbe.css";

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

let violations: readonly Violation[] = [];
const subscribers = new Set<() => void>();

function publish(next: readonly Violation[]): void {
  violations = next;
  for (const notify of subscribers) notify();
}

// Listening from the moment this file loads, before anything renders, so no early violation is missed. The window is
// the target of a violation that has no element, and the end of the path for one that has.
window.addEventListener("securitypolicyviolation", (event) => {
  publish([
    ...violations,
    {
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
      source: `${event.sourceFile}:${String(event.lineNumber)}`,
    },
  ]);
});

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

// The positive control for a "Policy violations: 0" result: adds a `<style>` element, which the page's policy refuses,
// so the list must show `style-src-elem`. The element is taken away again a moment later (it is inert once refused).
function causeTestViolation(): void {
  const style = document.createElement("style");
  style.textContent = "p {}";
  document.head.appendChild(style);
  setTimeout(() => {
    style.remove();
  }, 100);
}

const FRUIT =["Alpha", "Beta", "Gamma", "Delta"];
const CHOICES = [
  { label: "Gala", value: "gala" },
  { label: "Fuji", value: "fuji" },
  { label: "Pink Lady", value: "pink-lady" },
];
const ROWS = Array.from({ length: 12 }, (_, index) => `Row ${String(index + 1)}`);

export function PartsProbe() {
  const seen = useSyncExternalStore(subscribe, () => violations);
  const [menuChoice, setMenuChoice] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  return (
    <section aria-labelledby="parts-probe-heading" className="parts-probe probe-geist">
      <h2 id="parts-probe-heading">Parts probe</h2>
      <p>Policy violations: {seen.length}</p>
      {seen.length > 0 && (
        <ol aria-label="Policy violation list">
          {seen.map((violation, index) => (
            <li key={index}>
              {violation.directive}, blocked {violation.blocked}, from {violation.source}
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        onClick={() => {
          publish([]);
        }}
      >
        Clear violations
      </button>{" "}
      <button type="button" onClick={causeTestViolation}>
        Cause a test violation
      </button>

      <p>Geist: The quick brown fox jumps over the lazy dog 0123456789</p>
      <p className="probe-mono">Geist Mono: The quick brown fox jumps over the lazy dog 0123456789</p>

      <Dialog.Root>
        <Dialog.Trigger>Open probe dialog</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="probe-backdrop" />
          <Dialog.Popup className="probe-dialog probe-geist">
            <Dialog.Title>Probe dialog</Dialog.Title>
            <Dialog.Description>Focus stays in here until it is closed, then returns to the button.</Dialog.Description>
            <label>
              Probe field <input type="text" />
            </label>
            <Dialog.Close>Close probe dialog</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Menu.Root>
        <Menu.Trigger>Probe menu</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="probe-layer">
            <Menu.Popup className="probe-popup probe-geist">
              {["First item", "Second item", "Third item"].map((label) => (
                <Menu.Item
                  key={label}
                  onClick={() => {
                    setMenuChoice(label);
                  }}
                >
                  {label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {menuChoice !== undefined && <output> Menu chose: {menuChoice}</output>}

      <Combobox.Root items={FRUIT}>
        <label>
          Probe combobox <Combobox.Input />
        </label>
        <Combobox.Portal>
          <Combobox.Positioner className="probe-layer">
            <Combobox.Popup className="probe-popup probe-geist">
              <Combobox.Empty>No match</Combobox.Empty>
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

      <ScrollArea.Root className="probe-scroll">
        <ScrollArea.Viewport className="probe-scroll-viewport">
          <ScrollArea.Content>
            <ul aria-label="Probe list">
              {ROWS.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ul>
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar>
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      <Form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
        }}
      >
        <Field.Root name="probeName">
          <Field.Label>Probe name</Field.Label>
          <Field.Control required />
          <Field.Error />
        </Field.Root>
        <Select.Root name="probeChoice" items={CHOICES} defaultValue="gala">
          <Select.Label>Probe choice</Select.Label>
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="probe-layer">
              <Select.Popup className="probe-popup probe-geist">
                <Select.List>
                  {CHOICES.map((choice) => (
                    <Select.Item key={choice.value} value={choice.value}>
                      <Select.ItemText>{choice.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <Button type="submit">Submit probe form</Button>
        {submitted && <output> Probe form submitted</output>}
      </Form>
    </section>
  );
}
