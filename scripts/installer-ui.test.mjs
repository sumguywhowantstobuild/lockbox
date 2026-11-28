// Plan 5, Task 9e: the installer's one screen in Petalock's look (design D, "Plain terms"). These are the script tests: they
// read the template (`installer.nsi`), its helpers (`hooks.nsh`, which includes `setup-ui.nsh`), the bundle configuration, the
// artwork and the smoke script, as `installer-smoke.test.mjs` does for Tasks 1 and 4. The smoke script's own checks, which
// install and uninstall the real installer, run only on the GitHub runner; the pictures at 100, 125, 150 and 200 %, a monitor
// switch, larger Windows text, NVDA and a high-contrast theme are the session's hands-on step (the task's report says how to
// reach each state).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { problem as artProblem } from "./make-installer-art.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = "crates/petalock-desktop/windows/installer.nsi";
const HOOKS = "crates/petalock-desktop/windows/hooks.nsh";
const UI = "crates/petalock-desktop/windows/setup-ui.nsh";
const CONFIG = "crates/petalock-desktop/tauri.conf.json";
const SMOKE = "scripts/installer-smoke.ps1";
const ART = "crates/petalock-desktop/windows/band.bmp";

const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const exists = (path) => existsSync(join(ROOT, path));
/** A script's code lines without comments (`;` and `#` start a comment in NSIS). */
const code = (text) => text.split("\n").map((line) => line.replace(/^\s*[;#].*$/, "").trimEnd()).filter((line) => line.trim() !== "");
const template = () => read(TEMPLATE);
const ui = () => (exists(UI) ? read(UI) : "");
/** Everything the installer runs: template, hooks and the UI file, as code lines. */
const everything = () => code(template() + "\n" + read(HOOKS) + "\n" + ui()).join("\n");

/** The body of one NSIS function in `text`'s code lines, or "" when it is not there. */
function fn(text, name) {
  return code(text).join("\n").match(new RegExp(`Function ${name}(?: ;[^\\n]*)?\\n([\\s\\S]*?)\\nFunctionEnd`))?.[1] ?? "";
}
/** The body of one Section of the template, or "". */
function section(name) {
  return code(template()).join("\n").match(new RegExp(`Section ${name}\\n([\\s\\S]*?)\\nSectionEnd`))?.[1] ?? "";
}
const PAGE_CONTROLS = /\$\{NSD_|nsDialogs::|GetDlgItem|CreateWindowEx|SendMessage \$HWNDPARENT|SetCtlColors|ShowWindow/;

test("the_installer_has_one_custom_page_a_restyled_progress_page_and_a_custom_receipt", () => {
  const text = code(template()).join("\n");
  const pages = [...text.matchAll(/^(Page custom \S+ \S+|!insertmacro MUI_PAGE_\w+|!insertmacro MUI_UNPAGE_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(pages, [
    "Page custom PetalockMainShow PetalockMainLeave",
    "!insertmacro MUI_PAGE_STARTMENU",
    "!insertmacro MUI_PAGE_INSTFILES",
    "Page custom PetalockEndShow PetalockEndLeave",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    "!insertmacro MUI_UNPAGE_FINISH",
  ]);
  assert.match(text, /!define MUI_PAGE_CUSTOMFUNCTION_SHOW PetalockProgressShow\n!insertmacro MUI_PAGE_INSTFILES/);
  for (const gone of ["MUI_PAGE_WELCOME", "MUI_PAGE_LICENSE", "MUI_PAGE_DIRECTORY", "MUI_PAGE_FINISH", "MULTIUSER_PAGE_INSTALLMODE", "PageReinstall", "MUI_FINISHPAGE_RUN", "MUI_FINISHPAGE_SHOWREADME"]) {
    assert.ok(!text.includes(gone), `${gone} is gone`);
  }
  assert.match(text, /^BrandingText " "$/m);
  assert.ok(!/^BrandingText "\$\{COPYRIGHT\}"/m.test(text), "the Nullsoft line is not shown");
  // The uninstaller keeps its confirm / progress / finish pages in that order, and its layout (the confirm page's own box).
  assert.match(text, /un\.ConfirmShow/);
});

test("path_checks_and_maintenance_decisions_run_without_page_controls", () => {
  const decide = fn(ui(), "PetalockDecide");
  const check = fn(ui(), "PetalockCheckAll");
  const preflight = fn(read(HOOKS), "\\$\\{UN\\}PetalockPreflight");
  assert.ok(decide.length > 100 && check.length > 100 && preflight.length > 50, "the three functions are there");
  for (const [name, body] of [["PetalockDecide", decide], ["PetalockCheckAll", check]]) {
    assert.ok(!PAGE_CONTROLS.test(body), `${name} touches a page control`);
    assert.ok(!/MessageBox/.test(body), `${name} shows a box (a silent run must not)`);
  }
  // .onInit decides before any page exists; every install section checks again with the same guard.
  const onInit = fn(template(), "\\.onInit");
  assert.match(onInit, /Call PetalockDecide/);
  assert.match(onInit, /Call PetalockPreflight/);
  assert.ok(onInit.indexOf("Call PetalockDecide") < onInit.indexOf("Call PetalockPreflight") || onInit.indexOf("Call PetalockPreflight") < onInit.indexOf("Call PetalockDecide"));
  for (const name of ["PetalockRemoveOld", "WebView2", "Install"]) {
    assert.match(section(name).split("\n").slice(0, 3).join("\n"), /Call PetalockPreflight/, `${name} starts with the check`);
  }
  // The page's own leave runs the same checks first, then leaves.
  const leave = fn(ui(), "PetalockMainLeave");
  assert.ok(leave.indexOf("Call PetalockCheckAll") >= 0 && leave.indexOf("Call PetalockCheckAll") < leave.indexOf("Return"), "leave checks before it lets the page go");
});

test("slash_p_shows_progress_slash_s_shows_nothing_and_both_return_exit_codes", () => {
  const all = everything();
  // /P: the pages before and after the progress page are skipped, the progress page closes by itself, and nobody clicks Finish.
  assert.match(fn(ui(), "PetalockMainShow"), /\$\{If\} \$PassiveMode = 1\n\s*Abort/);
  assert.match(fn(ui(), "PetalockEndShow"), /\$\{If\} \$PassiveMode = 1\n\s*Abort/);
  // The sections go straight on to the next page when they are done (a window: the receipt; /P: the end of Setup).
  assert.match(section("Install"), /SetAutoClose true/);
  assert.match(fn(ui(), "PetalockFailed"), /SetAutoClose true/);
  // /S: no page at all (NSIS), nothing launched: the program is started only by the receipt's own Finish, or by /R in a quiet run.
  assert.match(fn(ui(), "PetalockEndLeave"), /RunMainBinary/);
  assert.equal((all.match(/RunAsUser/g) ?? []).length, 2, "the program is started in two places only (Finish, and /R)");
  assert.match(fn(template(), "\\.onInstSuccess"), /\$\{GetOptions\} \$CMDLINE "\/R" \$R0/);
  // Exit codes: a failed step in a quiet run ends with an error level and stops; the same step in a window goes to the error page.
  const fail = fn(ui(), "PetalockFailed");
  assert.match(fail, /SetErrorLevel 2/);
  assert.match(fail, /\$\{If\} \$\{Silent\}\n\s*\$\{OrIf\} \$PassiveMode = 1/);
  assert.match(fail, /Abort/);
  assert.match(fail, /PETALOCK_CONSOLE/);
  // A refusal in a quiet run was already an error exit (Task 1); the helpers still say so.
  assert.match(read(HOOKS), /PETALOCK_CONSOLE "Petalock cannot use this folder\. Nothing was changed\."/);
});

test("slash_d_the_remembered_folder_and_the_per_user_default_are_kept", () => {
  const onInit = fn(template(), "\\.onInit");
  // Tauri issue #6928: the template must not overwrite /D. NSIS sets $INSTDIR from /D before .onInit; the default and the
  // remembered folder are taken only while it is still the placeholder.
  assert.match(onInit, /\$\{If\} \$INSTDIR == "\$\{PLACEHOLDER_INSTALL_DIR\}"\n[\s\S]*StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{PRODUCTNAME\}"[\s\S]*Call RestorePreviousInstallLocation\n\s*\$\{EndIf\}/);
  assert.match(code(template()).join("\n"), /!define PLACEHOLDER_INSTALL_DIR "placeholder\\\$\{PRODUCTNAME\}"\nInstallDir "\$\{PLACEHOLDER_INSTALL_DIR\}"/);
  // The page never writes $INSTDIR except from Browse (the folder the person picked), and the Options field only shows it.
  const show = fn(ui(), "PetalockMainShow");
  assert.ok(!/StrCpy \$INSTDIR/.test(show), "the page's show does not overwrite the folder");
  const writes = code(ui()).filter((line) => /StrCpy \$INSTDIR/.test(line));
  const inBrowse = code(fn(ui(), "PetalockOnBrowse")).filter((line) => /StrCpy \$INSTDIR/.test(line));
  assert.ok(writes.length >= 1 && writes.length === inBrowse.length, "the folder is set only in Browse");
  // The folder the page offers is checked by the same guard before anything is written.
  assert.match(fn(ui(), "PetalockCheckAll"), /Call PetalockGuardFolder/);
});

test("the_three_plan_lines_are_the_operations_the_script_runs_in_their_real_order", () => {
  // Real order, remove-first: the old uninstaller, then WebView2, then the files (D-amendments "Settled in the build").
  const sections = [...code(template()).join("\n").matchAll(/^Section (\w+)$/gm)].map((m) => m[1]).filter((name) => name !== "Uninstall");
  assert.deepEqual(sections, ["PetalockRemoveOld", "WebView2", "Install"]);
  const steps = [];
  for (const name of sections) {
    for (const m of section(name).matchAll(/!insertmacro PETALOCK_BEGIN (\w+)/g)) steps.push(m[1]);
  }
  assert.deepEqual(steps, ["remove_old", "webview2", "files", "entries"]);
  // The plan, the progress and the receipt all come from one table: each step's row in each layout, rows never going back.
  const rowOf = fn(ui(), "PetalockRowOf");
  assert.ok(rowOf.length > 100, "the row table is there");
  // The table is read as the function runs it: the default row first, then the layout's own `If` chain (layout 2 is the first
  // branch, layout 1 the `Else`).
  const fallback = Number(rowOf.match(/^\s*StrCpy \$0 (\d)$/m)[1]);
  const [, layout2, layout1] = rowOf.match(/\$PetalockLayout = 2\n([\s\S]*?)\n\s*\$\{Else\}\n([\s\S]*)\n\s*\$\{EndIf\}$/);
  const rowFor = (block, id) => {
    const at = block.indexOf(`$PetalockStep == "${id}"`);
    return at < 0 ? fallback : Number(block.slice(at).match(/StrCpy \$0 (\d)/)[1]);
  };
  for (const [layout, block] of [["1", layout1], ["2", layout2]]) {
    // Layout 1 never runs the old uninstaller (it is only for remove-first).
    const rows = (layout === "1" ? steps.slice(1) : steps).map((id) => [id, rowFor(block, id)]);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i][1] >= rows[i - 1][1], `layout ${layout}: ${rows[i][0]} does not come before ${rows[i - 1][0]}`);
    assert.deepEqual([...new Set(rows.map((r) => r[1]))].sort((a, b) => a - b), [1, 2, 3], `layout ${layout} fills rows 1 to 3`);
  }
  // Remove-first: the old uninstaller is row 1, WebView2 row 2, the files and the entries share row 3. Normal: one row each.
  assert.deepEqual(steps.map((id) => rowFor(layout2, id)), [1, 2, 3, 3]);
  assert.deepEqual(steps.slice(1).map((id) => rowFor(layout1, id)), [1, 2, 3]);
  // The words of the plan rows are in the file (the drawing's own).
  const words = ui();
  for (const w of [
    "Check for Microsoft WebView2",
    "If it’s missing, Setup downloads it from Microsoft and needs internet.",
    "Install Petalock for this Windows account",
    "Add it to the Start menu and to Installed apps",
    "What Setup will do",
    "What Setup is doing",
    "What Setup did",
    "Getting Microsoft WebView2…",
    "Copying Petalock files…",
    "Remove ",
    " first, with its temporary copies of opened files",
  ]) assert.ok(words.includes(w), `the words: ${w}`);
  assert.deepEqual([...words.matchAll(/"(Done|Now|Next|Failed|Not started)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["Done", "Failed", "Next", "Not started", "Now"]);
});

test("receipt_rows_follow_real_outcomes", () => {
  const sec = (n) => section(n);
  // A row is Done only after its step succeeded: DONE comes after the operation it names, in the same section.
  const wv = sec("WebView2");
  assert.ok(wv.indexOf("ExecWait") < wv.indexOf("!insertmacro PETALOCK_DONE webview2"), "WebView2 is Done after its installer ran");
  assert.match(wv, /StrCpy \$PetalockWv "had"/);
  assert.match(wv, /StrCpy \$PetalockWv "got"/);
  const inst = sec("Install");
  assert.ok(inst.indexOf("WriteUninstaller") < inst.indexOf("!insertmacro PETALOCK_DONE files"), "the files are Done after the program and the uninstaller were written");
  assert.ok(inst.indexOf("WriteRegDWORD SHCTX \"${UNINSTKEY}\" \"NoRepair\"") < inst.indexOf("!insertmacro PETALOCK_DONE entries"), "the entries are Done after the Installed apps entry was written");
  assert.ok(inst.indexOf("CreateOrUpdateStartMenuShortcut") < inst.indexOf("!insertmacro PETALOCK_DONE entries"));
  // Nothing marks Done before its step: the plan and the progress code set Next and Now only.
  assert.ok(!/StrCpy \$PetalockS\d "done"/.test(fn(ui(), "PetalockPlanRows")), "the plan marks nothing Done");
  // Mixed outcomes: the shortcut result is its own variable, and the receipt words say skipped / failed beside a good entry.
  const shortcut = fn(template(), "CreateOrUpdateStartMenuShortcut");
  assert.match(shortcut, /StrCpy \$PetalockSc "skipped"/);
  assert.match(shortcut, /StrCpy \$PetalockSc "failed"/);
  assert.match(shortcut, /StrCpy \$PetalockSc "added"/);
  const words = ui();
  for (const w of ["The Start menu shortcut was skipped; Installed apps lists Petalock", "The Start menu shortcut couldn’t be made; Installed apps lists Petalock", "Added to the Start menu and to Installed apps", "Start menu shortcut kept; Installed apps shows", "Start menu shortcut added; Installed apps shows", "Already installed", "Installed by Setup"]) {
    assert.ok(words.includes(w), `receipt words: ${w}`);
  }
  // The receipt is built from outcomes, never from the plan's own text: its rows ask the same words function the progress uses,
  // in the "done" state, and that function reads what happened ($PetalockWv, $PetalockSc).
  const receipt = fn(ui(), "PetalockReceiptRows");
  assert.match(receipt, /StrCpy \$PetalockB "done"\n\s*StrCpy \$PetalockStep "webview2"\n\s*Call PetalockRowAs/);
  assert.match(fn(ui(), "PetalockRowAs"), /Call PetalockStepText/, "each row's words come from the same words function the progress uses");
  assert.match(receipt, /\$PetalockSc == "failed"/);
  assert.ok(!/Call PetalockPlanRows/.test(receipt), "the receipt does not use the plan");
  const stepText = fn(ui(), "PetalockStepText");
  assert.match(stepText, /\$PetalockWv == "got"/);
  assert.match(stepText, /\$PetalockSc == "skipped"/);
});

test("update_reinstall_newer_installed_and_unknown_words_come_from_the_versions", () => {
  const decide = fn(ui(), "PetalockDecide");
  assert.match(decide, /ReadRegStr \$PetalockOldVer SHCTX "\$\{UNINSTKEY\}" "DisplayVersion"/);
  assert.match(decide, /nsis_tauri_utils::SemverCompare "\$\{VERSION\}" \$PetalockOldVer/);
  for (const c of ["new", "update", "reinstall", "newer", "unknown"]) assert.match(decide, new RegExp(`StrCpy \\$PetalockCase "${c}"`), c);
  const words = ui();
  for (const w of ["is on this PC. This updates it to", "is already on this PC.", "A newer Petalock, ", "Petalock is on this PC, but Setup can’t tell which version.", "Updating Petalock", "Petalock was updated", "Setup leaves your vault files in place.", "Uninstall Petalock instead…", "Other choices", "Hide other choices", "Downgrade", "Reinstall", "Replace", "Update"]) {
    assert.ok(words.includes(w), `words: ${w}`);
  }
  // Tauri's downgrade policy stays as the template has it: the config does not set allowDowngrades, and the template's own
  // switch decides whether a downgrade in place is offered; the action that proceeds is named after "Other choices".
  assert.doesNotMatch(read(CONFIG), /allowDowngrades/);
  assert.match(code(template()).join("\n"), /!define ALLOWDOWNGRADES "\{\{allow_downgrades\}\}"/);
  assert.match(decide, /!if "\$\{ALLOWDOWNGRADES\}" == "false"/);
  assert.match(words, /Remove \$PetalockName before installing \$\{VERSION\}/);
  // Replace on an unknown version follows the same policy: it installs over unless the build forbids downgrades, in which case
  // it waits for the remove-first choice, as a newer version does (the decision sets $PetalockNoDown, the page reads it).
  assert.match(decide, /\$\{If\} \$PetalockCase == "newer"\n\s*\$\{OrIf\} \$PetalockCase == "unknown"\n\s*StrCpy \$PetalockNoDown 1/);
  assert.match(fn(ui(), "PetalockRender"), /\$\{If\} \$PetalockNoDown = 1\n\s*\$\{AndIf\} \$PetalockRemoveFirst = 0\n\s*EnableWindow \$0 0/);
  // The same version's full uninstall is a link that opens the existing uninstaller and ends Setup (no install after it).
  const un = fn(ui(), "PetalockOnUninstallInstead");
  assert.match(un, /Call PetalockBeforeOldUninstaller/);
  assert.match(un, /ExecWait '\$R1' \$0/);
  assert.match(un, /Quit/);
  assert.ok(!/\/UPDATE/.test(un), "a full uninstall, not the update's");
  // An upgrade or a downgrade that removes first runs the old uninstaller with /UPDATE (keeps Run\Petalock, shortcuts, app data).
  const remove = section("PetalockRemoveOld");
  assert.match(remove, /\$\{IfThen\} \$PetalockCase != "reinstall" \$\{\|\} StrCpy \$R1 "\$R1 \/UPDATE" \$\{\|\}/);
  assert.ok(remove.indexOf('"$R1 /UPDATE"') < remove.indexOf('_?=$4'), "/UPDATE comes before `_?=`");
  assert.ok(remove.indexOf("Call PetalockBeforeOldUninstaller") < remove.indexOf("ExecWait '$R1' $0"), "the command is built and checked before it runs");
  // Silent, passive and /UPDATE runs never remove first.
  assert.match(fn(ui(), "PetalockDecide"), /StrCpy \$PetalockRemoveFirst 0/);
});

test("blocked_and_failed_states_have_their_words_and_their_way_out", () => {
  const words = ui();
  for (const w of [
    "Not enough space on drive ",
    "Free some space, then choose Retry.",
    "Setup can’t write to this folder. Choose another one.",
    "Setup can’t write to Petalock’s folder",
    "Close Petalock, then try again.",
    "Setup never closes it for you.",
    "right-click it, then Quit",
    "Setup couldn’t get Microsoft WebView2",
    "Petalock isn’t fully installed",
    "Nothing was changed.",
    "Copy details",
  ]) assert.ok(words.includes(w), `words: ${w}`);
  // Low space names the drive and both numbers; the free space is asked of the drive the folder is on.
  const check = fn(ui(), "PetalockCheckAll");
  assert.match(check, /GetDiskFreeSpaceExW/);
  assert.match(check, /StrCpy \$PetalockProblem "space"/);
  assert.match(check, /StrCpy \$PetalockProblem "write"/);
  assert.match(check, /StrCpy \$PetalockProblem "running"/);
  assert.match(check, /StrCpy \$PetalockProblem "folder"/);
  // Order: the folder rules first (nothing is asked of a folder that is refused), then the program running, then space and write access.
  assert.ok(check.indexOf('"folder"') < check.indexOf('"running"') && check.indexOf('"running"') < check.indexOf('"space"') && check.indexOf('"space"') < check.indexOf('"write"'));
  // Write access is asked without writing: the nearest folder that exists is opened for adding files and folders.
  assert.match(fn(ui(), "PetalockCanWrite"), /CreateFileW\(w "\$PetalockA", i 0x6,/);
  // A running Petalock is never ended; Retry checks again (the same leave), Cancel stays.
  assert.ok(!/RmShutdown|taskkill|TerminateProcess/.test(everything()));
  assert.match(fn(ui(), "PetalockMainLeave"), /Abort/);
  // WebView2: Retry reruns that step and resumes; the offline reason only when the machine says it is offline.
  const wv = section("WebView2");
  assert.match(wv, /PetalockWebviewTry:/);
  assert.match(wv, /MB_RETRYCANCEL/);
  assert.match(wv, /Goto PetalockWebviewTry/);
  assert.match(fn(ui(), "PetalockWebviewReason"), /InternetGetConnectedState/);
  assert.match(fn(ui(), "PetalockWebviewReason"), /Microsoft couldn’t be reached: this PC seems to be offline\./);
  assert.ok(!/refused/i.test(words.match(/Setup couldn’t get Microsoft WebView2[\s\S]{0,400}/)?.[0] ?? ""), "no 'refused' wording");
  // A failure midway: no success receipt (the end page shows the error layout, the receipt only when nothing failed), the
  // failed step named, what was already changed said, a file name and Windows code only when captured.
  const end = fn(ui(), "PetalockEndShow");
  assert.match(end, /\$\{If\} \$PetalockFailStep != ""/);
  assert.match(fn(ui(), "PetalockFailed"), /StrCpy \$PetalockFailStep/);
  assert.match(words, /Some files were already copied to its folder; running Setup again replaces them\./);
  // A file name and a Windows error code are shown only when Setup captured them: nothing in this build captures either, so
  // no such words are typed (the details field shows $PetalockDetail, which holds only fixed words or the bootstrapper's code).
  assert.ok(!/Windows error \d/.test(words), "no invented code");
  assert.match(fn(ui(), "PetalockEndShow"), /\$\{NSD_CreateText\} \$R6 \$R7 \$R8 \$R9 "\$PetalockDetail"/);
});

test("the_cancel_boundary_is_one_place_and_comes_back_after_a_failure", () => {
  const lock = fn(ui(), "PetalockLockCancel");
  const unlock = fn(ui(), "PetalockUnlockCancel");
  for (const body of [lock, unlock]) {
    assert.match(body, /GetDlgItem \$0 \$HWNDPARENT 2/, "the Cancel button");
    assert.match(body, /EnableWindow \$0/);
    assert.match(body, /GetSystemMenu/);
    assert.match(body, /EnableMenuItem[^\n]*0xF060/, "SC_CLOSE, which Esc and the title-bar close use");
  }
  assert.match(lock, /EnableWindow \$0 0/);
  assert.match(unlock, /EnableWindow \$0 1/);
  // Off before each first step Setup can't safely stop: the old uninstaller, the WebView2 bootstrapper, the first file.
  const remove = section("PetalockRemoveOld");
  assert.ok(remove.indexOf("Call PetalockLockCancel") >= 0 && remove.indexOf("Call PetalockLockCancel") < remove.indexOf("ExecWait '$R1' $0"));
  const wv = section("WebView2");
  assert.ok(wv.indexOf("Call PetalockLockCancel") >= 0 && wv.indexOf("Call PetalockLockCancel") < wv.indexOf("ExecWait '\"$6\""));
  const inst = section("Install");
  assert.ok(inst.indexOf("Call PetalockLockCancel") >= 0 && inst.indexOf("Call PetalockLockCancel") < inst.indexOf("SetOutPath $INSTDIR"));
  // Not through the checks (the page, its leave, the checks, the preflight): none of them locks.
  for (const body of [fn(ui(), "PetalockMainShow"), fn(ui(), "PetalockMainLeave"), fn(ui(), "PetalockCheckAll"), fn(ui(), "PetalockDecide")]) assert.ok(!/PetalockLockCancel/.test(body));
  // Back on after a failure (and the failure keeps the window open on the error page).
  assert.match(fn(ui(), "PetalockFailed"), /Call PetalockUnlockCancel/);
});

test("the_uninstaller_keeps_its_layout_and_only_its_words_are_clarified", () => {
  const text = template();
  const show = fn(text, "un\\.ConfirmShow");
  assert.match(show, /CreateWindowEx/);
  assert.match(show, /w "Delete the application data\./);
  assert.match(text, /Your vaults, the vault list and your settings are never deleted/);
  assert.ok(!/\$\(deleteAppData\)/.test(show), "the clarified words replace the stock ones");
  // The finish page's sentence is the one the earlier task pinned.
  assert.ok(text.includes("Your vaults stay where they are. Petalock keeps them in the folders you chose, by default Petalock Vaults in your user folder."));
  // Order of the uninstaller's pages is unchanged.
  const unpages = [...text.matchAll(/^!insertmacro (MUI_UNPAGE_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(unpages, ["MUI_UNPAGE_CONFIRM", "MUI_UNPAGE_INSTFILES", "MUI_UNPAGE_FINISH"]);
});

test("tab_order_enter_and_the_default_button_follow_the_design_notes", () => {
  const show = fn(ui(), "PetalockMainShow");
  // Creation order is tab order: Options, folder field, Browse, Licence, then the wizard's own Install and Cancel.
  const order = ["PetalockHOptions", "PetalockHField", "PetalockHBrowse", "PetalockHOther", "PetalockHUninst", "PetalockHLicence"].map((v) => show.search(new RegExp(`StrCpy \\$${v} |Pop \\$${v}\\b`)));
  assert.ok(order.every((n) => n >= 0), `all controls are created: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "created in tab order");
  // The grey band is a non-focusable static (no WS_TABSTOP), behind the buttons; the bitmap too.
  assert.match(show, /band/i);
  assert.match(fn(ui(), "PetalockFrame"), /SetWindowPos[^\n]*\$0, p 0/, "the wizard's buttons are raised above the page");
  // Enter on Browse or a link activates that control: they are real buttons and links of the page, so the dialog's default
  // button is Install only when none of them has the focus; on a newer-version screen Cancel is the default.
  assert.match(show, /\$\{NSD_OnClick\} \$PetalockHBrowse PetalockOnBrowse/);
  assert.match(show, /\$\{NSD_OnClick\} \$PetalockHLicence PetalockOnLicence/);
  assert.match(show, /\$\{NSD_OnClick\} \$PetalockHOptions PetalockOnOptions/);
  assert.match(show, /BM_SETSTYLE|DM_SETDEFID|PetalockCancelDefault/);
  // The receipt: the Open Petalock box comes before Finish and is checked by default; Finish starts the program only when ticked.
  const end = fn(ui(), "PetalockEndShow");
  assert.match(end, /Open Petalock/);
  assert.match(end, /\$\{NSD_Check\} \$PetalockHOpen|BM_SETCHECK[^\n]*\$PetalockHOpen|SendMessage \$PetalockHOpen \$\{BM_SETCHECK\} 1 0/);
  const endLeave = fn(ui(), "PetalockEndLeave");
  assert.match(endLeave, /\$\{NSD_GetState\} \$PetalockHOpen \$0/);
  assert.match(endLeave, /\$\{If\} \$0 = \$\{BST_CHECKED\}/);
  assert.match(endLeave, /\$\{If\} \$PetalockFailStep == ""/);
  // The path field is read-only and scrolls.
  assert.match(show, /EM_SETREADONLY/);
});

test("high_contrast_themes_skip_every_painted_colour_and_use_system_colours", () => {
  const all = code(ui()).join("\n");
  assert.match(all, /SystemParametersInfoW\(i 0x42, i 12, p r1, i 0\)/, "SPI_GETHIGHCONTRAST is asked");
  assert.match(fn(ui(), "PetalockColour"), /\$\{If\} \$PetalockHC = 1\n\s*Return/);
  // Every SetCtlColors is inside PetalockColour or PetalockBand (which has the same guard), never anywhere else.
  const outside = all.replace(/Function PetalockColour\n[\s\S]*?\nFunctionEnd/, "").replace(/Function PetalockBand\n[\s\S]*?\nFunctionEnd/, "");
  assert.ok(!/SetCtlColors/.test(outside), "SetCtlColors only through the guarded helpers");
  assert.match(fn(ui(), "PetalockBand"), /\$\{If\} \$PetalockHC = 1\n\s*Return/);
  assert.ok(!/SetCtlColors/.test(code(template()).join("\n").replace(/Function un\.[\s\S]*?\nFunctionEnd/g, "")), "the template itself paints nothing");
});

test("the_version_shown_comes_from_the_build_and_the_wordmark_is_not_a_picture_of_a_number", () => {
  const words = ui();
  assert.match(words, /Version \$\{VERSION\}/);
  assert.ok(!/0\.2\.0/.test(words + template()), "the drawing's sample version is not typed");
  assert.match(words, /Public preview/);
  assert.match(words, /A local password manager and encrypted file vault\./);
});

test("the_committed_band_is_what_the_script_draws_and_the_comparison_fires_on_a_wrong_file", () => {
  const bytes = readFileSync(join(ROOT, ART));
  // No change at all passes, and the drawing really draws something (a blank white picture would equal a blank white drawing).
  assert.equal(artProblem(bytes), undefined);
  const ink = [...bytes.subarray(54)].filter((value) => value !== 255).length;
  assert.ok(ink > 20000, `the picture holds ${ink} coloured bytes`);
  // A wrong result fails: a blank picture, a changed region, a shifted file, something that is not a BMP.
  const blank = Buffer.from(bytes);
  blank.fill(255, 54);
  assert.match(artProblem(blank) ?? "", /differ from the drawing/);
  const changed = Buffer.from(bytes);
  for (let i = 54; i < 54 + 6000; i += 1) changed[i] = (changed[i] + 40) % 256;
  assert.match(artProblem(changed) ?? "", /differ from the drawing/);
  assert.match(artProblem(bytes.subarray(0, bytes.length - 3)) ?? "", /length differs/);
  assert.match(artProblem(Buffer.from("MU- not a picture")) ?? "", /not a BMP file/);
  // A one-step difference (a sine rounded the other way) is tolerated; it is the only difference that is.
  const rounded = Buffer.from(bytes);
  const at = bytes.findIndex((value, i) => i > 54 && value < 200);
  assert.ok(at > 54, "a coloured byte was found to nudge");
  rounded[at] += 1;
  assert.equal(artProblem(rounded), undefined);
  rounded[at] += 1;
  assert.match(artProblem(rounded) ?? "", /differ from the drawing/, "two steps is a difference");
});

test("the_engraved_band_is_a_two_times_bitmap_made_by_a_script_and_shipped_through_the_config", () => {
  const conf = JSON.parse(read(CONFIG));
  assert.equal(conf.bundle.windows.nsis.headerImage, "windows/band.bmp");
  assert.ok(exists(ART), "the bitmap is committed");
  const bytes = readFileSync(join(ROOT, ART));
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "BM");
  assert.equal(bytes.readInt32LE(18), 952, "2x the 476 px of the design");
  assert.equal(Math.abs(bytes.readInt32LE(22)), 104);
  assert.equal(bytes.readUInt16LE(28), 24, "24 bits, which LoadImage reads everywhere");
  assert.equal(bytes.readUInt32LE(30), 0, "uncompressed");
  // The template puts it on the page as a non-focusable bitmap, scaled to the control, from the build's own path.
  assert.match(code(template()).join("\n"), /File "\/oname=\$PLUGINSDIR\\band\.bmp" "\$\{HEADERIMAGE\}"/);
  // The picture is a static with SS_BITMAP | SS_REALSIZECONTROL (stretched to the control), loaded from that file.
  const chrome = fn(ui(), "PetalockChrome");
  assert.match(chrome, /i 0x5400004E/);
  assert.match(chrome, /LoadImageW\(p 0, w "\$PLUGINSDIR\\band\.bmp"/);
  assert.match(chrome, /SendMessage \$0 0x172 0 \$1/, "STM_SETIMAGE");
  assert.ok(!/^!define MUI_HEADERIMAGE/m.test(template().replace(/^!if "\$\{UNINSTALLERHEADERIMAGE\}" != ""[\s\S]*?!endif/m, "")), "the stock header image is not switched on for the installer");
  // The script that makes it is reproducible (the check mode compares pixels, as make-icon.mjs does).
  assert.ok(exists("scripts/make-installer-art.mjs"));
});
