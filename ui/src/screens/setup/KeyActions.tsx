import { useEffect, useRef, useState } from "react";
import { messageFor, messageText } from "../../messages";
import { Button } from "../../parts/Button";
import { Dialog } from "../../parts/Dialog";
import { Select } from "../../parts/Select";
import {
  confirmKeyPdf,
  loadPrinters,
  printKey,
  refusedAsPrinterGone,
  saveKeyPdf,
  type KeyPdf,
} from "../../store";

/**
 * What is running: asking Windows for its printers (`list`), a job going to a printer (`print`), or Save as PDF (which
 * includes a cloud question's yes) (`pdf`); or none.
 */
export type PrintRun = "list" | "print" | "pdf" | null;

/** The printer picker, open: the printers by name (none is possible) and the one chosen now. */
interface Picker {
  printers: string[];
  chosen: string;
}

const NO_PRINTER = "No printer is set up on this PC. Save as PDF instead, or add a printer in Windows' settings.";

/**
 * Print and Save as PDF under the recovery key (21c, 21f), and what they say. The page prints itself through the shell
 * (the key goes to the printer only as the printed page, so nothing here carries it); `print.css` leaves on paper only
 * the element marked `data-print-only`, and this row, its picker, its line and its alert are marked `data-print-hide`
 * inside it.
 *
 * Print opens Lockbox's own printer picker under the buttons (Windows' print window would keep its own copy of the page
 * past a lock): the printers by name with the default picked, Print and Cancel, or with no printer a sentence and only
 * Cancel. Print sends the page to the one chosen, with no window of Windows' own, and the status line says where it went.
 *
 * One print at a time: while the list loads or a job runs, Print, Save as PDF, the picker's buttons and the screen's
 * Continue (which would take the key off the page before it is captured) are all off, and the busy one says so to a
 * screen reader. They are `aria-disabled` and not `disabled`, so focus stays on the one pressed and is back there when a
 * dialog over it closes. The list takes focus when the picker opens, and Cancel or a sent job puts it back on Print. A
 * save in a cloud-synced folder asks first (21e) in a dialog over the key; a yes goes back with the shell's token, and
 * Escape or another folder leaves nothing written. A lock takes the whole screen away, picker included, and an answer
 * that comes after it says nothing (the store hands it back as stale).
 */
export function KeyActions({
  session,
  running,
  setRunning,
}: {
  session: number;
  /** What is running, if anything. The screen owns it, so Continue waits too: the page is what gets printed. */
  running: PrintRun;
  setRunning: (run: PrintRun) => void;
}) {
  // What the status line says (where the PDF went, or the printer the job was sent to).
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The cloud question's token, while the question is on screen.
  const [token, setToken] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  // Counts the times a list was put on screen, so focus moves to it each time and not on every later render.
  const [listed, setListed] = useState(0);
  // A second press before the first has an answer sends nothing.
  const working = useRef(false);
  const safeAnswer = useRef<HTMLButtonElement>(null);
  const printButton = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // The list takes focus when it appears (with no printer, Cancel, the only thing there is to press).
  useEffect(() => {
    if (listed > 0) (select.current ?? cancel.current)?.focus();
  }, [listed]);

  const begin = (which: Exclude<PrintRun, null>): boolean => {
    if (working.current) return false;
    working.current = true;
    setRunning(which);
    setNote(null);
    setFailure(null);
    return true;
  };

  const end = () => {
    working.current = false;
    setRunning(null);
  };

  /** Puts a fresh list in the picker: the default one picked, or the first when there is none. */
  const show = (list: { printers: string[]; default: string | null }) => {
    const chosen = list.default !== null && list.printers.includes(list.default) ? list.default : (list.printers[0] ?? "");
    setPicker({ printers: list.printers, chosen });
    setListed((count) => count + 1);
  };

  const openPicker = async () => {
    if (working.current) return;
    if (picker !== null) {
      // Already open: go back to the list rather than asking Windows again.
      (select.current ?? cancel.current)?.focus();
      return;
    }
    if (!begin("list")) return;
    try {
      const list = await loadPrinters(session);
      if (list !== "stale") show(list);
    } catch (refusal) {
      setFailure(messageText(messageFor(refusal)));
    } finally {
      end();
    }
  };

  const closePicker = () => {
    if (working.current) return;
    setPicker(null);
    printButton.current?.focus();
  };

  const sendPrint = async () => {
    if (picker === null || picker.printers.length === 0 || !begin("print")) return;
    const printer = picker.chosen;
    try {
      const result = await printKey(session, printer);
      if (result === "stale") {
        setPicker(null);
        return;
      }
      setPicker(null);
      setNote(`Sent to ${printer}.`);
      printButton.current?.focus();
    } catch (refusal) {
      setFailure(messageText(messageFor(refusal)));
      if (refusedAsPrinterGone(refusal)) {
        // The list was out of date: ask again, and show what is there now.
        try {
          const list = await loadPrinters(session);
          if (list !== "stale") show(list);
        } catch {
          // The words above stand; the list stays as it was.
        }
      }
    } finally {
      end();
    }
  };

  const go = async (run: () => Promise<KeyPdf>) => {
    if (!begin("pdf")) return;
    try {
      const result = await run();
      setToken(typeof result === "object" && "confirm" in result ? result.confirm : null);
      if (typeof result === "object" && "saved" in result) setNote(`Saved in ${result.saved}.`);
    } catch (refusal) {
      setToken(null);
      setFailure(messageText(messageFor(refusal)));
    } finally {
      end();
    }
  };

  const off = running === null ? undefined : true;
  return (
    <div className="fu-actions" data-print-hide>
      <div className="fu-row">
        <button
          ref={printButton}
          type="button"
          className="fu-sec"
          aria-disabled={off}
          aria-busy={running === "list" ? true : undefined}
          aria-expanded={picker !== null}
          onClick={() => {
            void openPicker();
          }}
        >
          Print
        </button>
        <button
          type="button"
          className="fu-sec"
          aria-disabled={off}
          aria-busy={running === "pdf" ? true : undefined}
          onClick={() => {
            void go(() => saveKeyPdf(session));
          }}
        >
          Save as PDF
        </button>
      </div>
      {picker === null ? null : (
        <div className="fu-picker" role="group" aria-label="Choose a printer">
          {picker.printers.length === 0 ? (
            <p className="fu-none">{NO_PRINTER}</p>
          ) : (
            <Select
              label="Printer"
              items={picker.printers}
              value={picker.chosen}
              triggerRef={select}
              onValueChange={(chosen) => {
                setPicker({ ...picker, chosen });
              }}
            />
          )}
          <div className="fu-row">
            {picker.printers.length === 0 ? null : (
              <Button
                look="main"
                aria-disabled={off}
                aria-busy={running === "print" ? true : undefined}
                onClick={() => {
                  void sendPrint();
                }}
              >
                Print
              </Button>
            )}
            <button
              ref={cancel}
              type="button"
              className="fu-sec"
              aria-disabled={off}
              onClick={closePicker}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="fu-status" role="status">
        {note}
      </p>
      {failure === null ? null : (
        <p className="err" role="alert">
          {failure}
        </p>
      )}
      <Dialog
        open={token !== null}
        onOpenChange={(open) => {
          // Closing it asks nothing of the shell: the parked save stays parked, and nothing is written.
          if (!open && !working.current) setToken(null);
        }}
        title="This folder is synced to the cloud"
        description="This file would be uploaded unprotected."
        initialFocus={safeAnswer}
      >
        <Button
          aria-disabled={off}
          onClick={() => {
            if (token !== null) void go(() => confirmKeyPdf(session, token));
          }}
        >
          Continue
        </Button>
        <Button
          ref={safeAnswer}
          look="pill-main"
          aria-disabled={off}
          onClick={() => {
            if (working.current) return;
            setToken(null);
            void go(() => saveKeyPdf(session));
          }}
        >
          Pick another folder
        </Button>
      </Dialog>
    </div>
  );
}
