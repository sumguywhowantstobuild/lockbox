// Plan 5, Task 9e, the review fix round (Codex, 19 findings; the numbers are the review's). Each test names its finding and
// reads the installer's files (or the smoke script, which runs only on the runner), as installer-ui.test.mjs does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const code = (text) => text.split("\n").map((line) => line.replace(/^\s*[;#].*$/, "").trimEnd()).filter((line) => line.trim() !== "");
const template = () => read("crates/petalock-desktop/windows/installer.nsi");
const hooks = () => read("crates/petalock-desktop/windows/hooks.nsh");
const ui = () => read("crates/petalock-desktop/windows/setup-ui.nsh");
const smoke = () => read("scripts/installer-smoke.ps1");
const fn = (text, name) => code(text).join("\n").match(new RegExp(`Function ${name}(?: ;[^\\n]*)?\\n([\\s\\S]*?)\\nFunctionEnd`))?.[1] ?? "";
const section = (name) => code(template()).join("\n").match(new RegExp(`Section ${name}\\n([\\s\\S]*?)\\nSectionEnd`))?.[1] ?? "";
const check = (name) => smoke().match(new RegExp(`\\$Checks\\["${name}"\\] = \\{\\n([\\s\\S]*?)\\n\\}\\n`))?.[1] ?? "";
const func = (name) => smoke().match(new RegExp(`^function ${name}\\b[^\\n]*\\{\\n([\\s\\S]*?)\\n\\}\\n`, "m"))?.[1] ?? "";

test("fix_2_the_old_uninstaller_is_launched_only_from_petalocks_own_folder", () => {
  const before = fn(hooks(), "PetalockBeforeOldUninstaller");
  // Both files must be there (the program too, which the guard alone lets be absent), as regular files with one link (the guard).
  assert.match(before, /StrCpy \$PetalockA "\$4\\\$\{MAINBINARYNAME\}\.exe"\n\s*Call PetalockAttr\n\s*\$\{If\} \$PetalockR == "absent"\n\s*\$\{OrIf\} \$PetalockR == "error"/);
  assert.match(before, /StrCpy \$PetalockA "\$4\\uninstall\.exe"/);
  // Both maintenance actions go through it.
  assert.match(section("PetalockRemoveOld"), /Call PetalockBeforeOldUninstaller/);
  assert.match(fn(ui(), "PetalockOnUninstallInstead"), /Call PetalockBeforeOldUninstaller/);
});

test("fix_3_interactive_update_mode_offers_and_runs_no_uninstall", () => {
  const render = fn(ui(), "PetalockRender");
  assert.match(render, /\$\{If\} \$UpdateMode <> 1\n\s*\$\{If\} \$PetalockCase == "reinstall"/, "no link or box is shown under /UPDATE");
  assert.match(section("PetalockRemoveOld"), /\$\{If\} \$PetalockRemoveFirst = 1\n\s*\$\{AndIf\} \$UpdateMode <> 1/);
  assert.match(fn(ui(), "PetalockOnUninstallInstead"), /^\s*\$\{If\} \$UpdateMode = 1\n\s*Return\n\s*\$\{EndIf\}/m);
  assert.match(fn(ui(), "PetalockDecide"), /\$\{If\} \$UpdateMode = 1\n\s*StrCpy \$PetalockRemoveFirst 0/);
  assert.match(smoke(), /\$Checks\["interactive_update_mode_offers_no_uninstall_choice"\]/);
});

test("fix_4_remove_first_is_refused_while_the_working_install_is_intact_when_files_were_added", () => {
  const added = fn(ui(), "PetalockHasAddedFiles");
  assert.match(added, /FindFirst/);
  for (const name of ["petalock", "uninstall.exe", "THIRD-PARTY-NOTICES.txt"]) assert.ok(added.toLowerCase().includes(name.toLowerCase()) || added.includes("MAINBINARYNAME"), name);
  const all = fn(ui(), "PetalockCheckAll");
  assert.match(all, /\$\{If\} \$PetalockRemoveFirst = 1\n\s*Call PetalockHasAddedFiles/);
  assert.match(all, /StrCpy \$PetalockProblem "added"/);
  assert.match(fn(ui(), "PetalockRender"), /Update in place|Remove \.\.\. before installing|untick/i);
  const remove = section("PetalockRemoveOld");
  assert.ok(remove.indexOf("Call PetalockHasAddedFiles") > 0 && remove.indexOf("Call PetalockHasAddedFiles") < remove.indexOf("ExecWait '$R1' $0"), "the section checks again before the child starts");
  assert.match(check("files_added_after_install_survive_upgrade_and_uninstall") + smoke(), /remove-first with an added file/);
});

test("fix_5_the_files_row_is_done_only_after_the_files_and_the_uninstaller_were_written", () => {
  const install = section("Install");
  const clear = install.indexOf("ClearErrors\n  SetOutPath $INSTDIR");
  assert.ok(clear > 0 || /ClearErrors\n\s*SetOutPath/.test(install), "errors are cleared before the first write");
  const uninstaller = install.indexOf("WriteUninstaller");
  const done = install.indexOf("!insertmacro PETALOCK_DONE files");
  // A fresh attempt takes out the files it wrote before the failure page (Greptile on #12), as the refused entry does below.
  const guard = install.indexOf('${If} ${Errors}\n    Call PetalockRollBackFreshFiles\n    !insertmacro PETALOCK_FAILED files');
  assert.ok(guard > uninstaller && guard < done, "a file-stage error is routed to the rollback and the failure handler before the row is Done");
  assert.match(check("a_write_that_is_denied_is_a_failure_not_a_receipt"), /Set-Deny/);
});

test("fix_6_the_bootstrapper_lives_in_setups_private_folder_and_nothing_in_temp_is_deleted", () => {
  const text = code(template()).join("\n");
  assert.ok(!/\$TEMP\\Microsoft/.test(text), "no fixed name in the user's temporary folder");
  assert.match(text, /InitPluginsDir/);
  assert.match(text, /File "\/oname=\$PLUGINSDIR\\MicrosoftEdgeWebview2Setup\.exe" "\$\{WEBVIEW2BOOTSTRAPPERPATH\}"/);
  const wv = section("WebView2");
  assert.ok(wv.indexOf("PLUGINSDIR\\MicrosoftEdgeWebview2Setup.exe") < wv.indexOf("PetalockWebviewTry:"), "extracted once, before the Retry label");
});

test("fix_7_a_same_version_uninstall_is_proved_before_it_is_called_done", () => {
  const body = fn(ui(), "PetalockOnUninstallInstead");
  const quit = body.indexOf("Quit");
  const program = body.indexOf('"$4\\${MAINBINARYNAME}.exe"');
  const entry = body.indexOf('ReadRegStr $1 SHCTX "${UNINSTKEY}"');
  assert.ok(program > 0 && program < quit, "the program is looked for before Setup ends");
  assert.ok(entry > 0 && entry < quit, "the entry is looked for before Setup ends");
  assert.ok(body.indexOf('Delete "$4\\uninstall.exe"') > program, "the uninstaller is left in place until the program is proved gone");
  assert.match(body, /MessageBox MB_OK\|MB_ICONEXCLAMATION/);
  const same = check("interactive_upgrade_keeps_start_with_windows");
  assert.match(same, /\[System\.IO\.File\]::Exists\(\(Join-Path \$DefaultDir 'petalock\.exe'\)\)/);
  assert.match(same, /\[System\.IO\.File\]::Exists\(\(Join-Path \$DefaultDir 'uninstall\.exe'\)\)/);
});

test("fix_8_the_same_checks_run_after_the_folder_is_resolved_in_every_mode", () => {
  const onInit = fn(template(), "\\.onInit");
  const folder = onInit.lastIndexOf("Call RestorePreviousInstallLocation");
  assert.ok(onInit.indexOf("Call PetalockCheckAll") > folder, "the control-independent checks follow the last place the folder is set");
  assert.match(onInit, /Call PetalockQuietChecks/);
  const gui = fn(template(), "PetalockGuiInit");
  assert.ok(gui.indexOf("InitPluginsDir") > 0, "the band and the licence are unpacked in the window's init, after .onInit's checks");
  const quiet = fn(ui(), "PetalockQuietChecks");
  assert.match(quiet, /\$\{If\} \$\{Silent\}\n\s*\$\{OrIf\} \$PassiveMode = 1/);
  assert.match(quiet, /SetErrorLevel 2/);
  assert.match(quiet, /PETALOCK_CONSOLE/);
  assert.match(fn(ui(), "PetalockMainShow"), /PetalockProblem/, "a window shows the result it kept");
});

test("fix_11_webview2_is_done_only_for_a_runtime_that_was_found_or_installed", () => {
  const wv = section("WebView2");
  assert.match(wv, /ClearErrors\n\s*ExecWait '"\$6" \$\{WEBVIEW2INSTALLERARGS\} \/install' \$1\n\s*\$\{If\} \$\{Errors\}\n\s*StrCpy \$1 -1\n\s*\$\{EndIf\}\n\s*\$\{If\} \$1 = 0/);
  const had = [...wv.matchAll(/StrCpy \$PetalockWv "had"/g)].length;
  assert.equal(had, 1);
  const at = wv.indexOf('StrCpy $PetalockWv "had"');
  assert.match(wv.slice(Math.max(0, at - 160), at), /\$\{If\} \$4 != ""/);
  assert.match(wv, /StrCpy \$PetalockWv "missing"/);
  assert.match(fn(ui(), "PetalockStepText"), /\$PetalockWv == "missing"/);
});

test("fix_12_a_registration_failure_is_told_apart_from_a_file_failure_and_its_advice_works", () => {
  const end = fn(ui(), "PetalockEndShow");
  assert.match(end, /\$\{ElseIf\} \$PetalockFailStep == "entries"/);
  // (The advice itself was rewritten in the second fix round: see fix2_2.)
  const entriesBranch = end.slice(end.indexOf('$PetalockFailStep == "entries"'));
  assert.match(entriesBranch, /Windows would not take/);
  assert.ok(!/running Setup again replaces them/.test(entriesBranch.slice(0, entriesBranch.indexOf("${Else}"))), "the file-copy advice is not given for a registration failure");
});

test("fix_13_slash_s_launches_nothing_even_with_slash_r", () => {
  const body = fn(template(), "\\.onInstSuccess");
  assert.ok(!/\$\{OrIf\} \$\{Silent\}|\$\{If\} \$\{Silent\}/.test(body), "/S is not a launching mode");
  assert.match(body, /\$\{If\} \$PassiveMode = 1\n\s*\$\{AndIfNot\} \$\{Silent\}/, "not even /S /P");
  assert.match(check("quiet_installs_return_exit_codes_and_launch_nothing"), /'\/S', '\/R'/);
});

test("fix_14_copy_details_prepares_the_text_owns_the_clipboard_and_checks_each_result", () => {
  const copy = fn(ui(), "PetalockOnCopy");
  assert.ok(copy.indexOf("GlobalAlloc") < copy.indexOf("OpenClipboard"), "the text is prepared before the clipboard is touched");
  assert.match(copy, /OpenClipboard\(p \$HWNDPARENT\)/);
  assert.ok(!/OpenClipboard\(p 0\)/.test(copy));
  assert.match(copy, /SetClipboardData\(i 13, p r3\) p \.r5/);
  assert.match(copy, /GlobalFree/);
  assert.match(copy, /GetClipboardData\(i 13\)/);
  assert.match(copy, /MessageBox MB_OK\|MB_ICONEXCLAMATION "Copy details did not work/);
});

test("fix_16_one_status_follows_the_real_step_and_is_announced", () => {
  const begin = fn(ui(), "PetalockStepBegin");
  const done = fn(ui(), "PetalockStepDone");
  assert.match(begin, /Call PetalockSetStatus/);
  assert.match(begin, /Call PetalockAnnounce/);
  assert.match(done, /Call PetalockAnnounce/);
  const status = fn(ui(), "PetalockSetStatus");
  for (const words of ["Removing the earlier version…", "Checking for Microsoft WebView2…", "Downloading from Microsoft. This needs internet.", "Copying Petalock files…", "Adding it to the Start menu and to Installed apps…"]) assert.ok(status.includes(words), words);
  assert.ok(!/Copying Petalock files…/.test(fn(ui(), "PetalockProgressShow")), "the status does not start with a step that has not begun");
  assert.match(fn(ui(), "PetalockWebviewMissing"), /Call PetalockSetStatus/);
  assert.match(fn(ui(), "PetalockWebviewShowError") + fn(ui(), "PetalockFailed"), /PetalockAnnounce|PetalockSetStatus/);
});

test("fix_17_layout_follows_the_text_size_the_display_and_gives_the_state_its_own_column", () => {
  const setup = fn(ui(), "PetalockGuiSetup");
  assert.match(setup, /SystemParametersInfoForDpi\(i 0x29/);
  assert.match(setup, /IntOp \$PetalockDpi \$\d \* 8/, "the layout scale comes from the real message font: 12 px is 96");
  const paint = code(ui()).join("\n").match(/!macro PETALOCK_PAINT N Y H\n([\s\S]*?)\n!macroend/)?.[1] ?? "";
  // (Task 9h: the width a row's words get is what its state word's own column leaves, not a fixed 330; the room is tested in
  // installer-render.test.mjs, fault 5.)
  assert.match(paint, /PETALOCK_MOVEU \$PetalockHT\$\{N\} 44 \$\{Y\} \$PetalockTW \$\{H\}/, "a row with a state word keeps clear of its column");
  assert.match(paint, /PETALOCK_MOVEU \$PetalockHT\$\{N\} 44 \$\{Y\} 432 \$\{H\}/, "a row without one may use the width");
  assert.ok(!/^ManifestDPIAwareness PerMonitorV2/m.test(template()), "Windows scales the window itself when it is moved between monitors");
  assert.match(template(), /^ManifestDPIAware true/m);
  assert.match(template(), /system-DPI|system DPI/i);
});

test("fix_18_high_contrast_draws_no_fixed_blue_strip", () => {
  const chrome = fn(ui(), "PetalockChrome");
  assert.match(chrome, /\$\{If\} \$PetalockHC = 0\n[\s\S]*0x5400004E[\s\S]*\$\{EndIf\}/);
  assert.match(fn(ui(), "PetalockSink"), /\$\{If\} \$PetalockHC = 0\n[\s\S]*PetalockHBmp/);
});

test("fix_24_the_checkbox_says_what_it_removes", () => {
  const show = fn(template(), "un\\.ConfirmShow");
  assert.match(show, /w "Delete the application data\. This removes Petalock’s window cache from your Local and Roaming app data folders\./);
  assert.match(show, /Your vaults, the vault list and your settings are never deleted/);
  assert.match(show, /IntOp \$7 \d+ \* \$2/);
});

test("fix_19_the_options_check_drives_browse_without_d_and_its_table_has_its_own_name", () => {
  const options = check("quick_install_folder_from_options");
  assert.ok(!/\$seen\b/.test(options), "no $seen (Drive-Wizard has its own)");
  assert.match(options, /\$optionsObs/);
  assert.match(options, /Start-Tracked \$Installer @\(\)/, "Browse is driven from a launch without /D");
  assert.match(options, /Choose-Folder/);
  assert.match(options, /InstallLocation/);
  assert.match(options, /Uninstall-AsWindowsDoes/);
  assert.match(check("quick_install_folder_from_d"), /\/D=\$chosen/);
  // (The picker driver was rewritten in the second fix round for the tree-style folder dialog: see fix2_4.)
});

test("fix_20_the_default_install_check_starts_setup_with_a_typed_argument_list_and_requires_exit_zero", () => {
  const helper = func("Install-Interactive");
  assert.match(helper, /\[string\[\]\]\$argList = @\(\)/);
  assert.match(helper, /Start-Tracked \$Exe \$argList/);
  assert.match(helper, /Exit = /);
  assert.match(check("quick_install_default_folder_and_receipt"), /\$result\.Exit -ne 0/);
});

test("fix_21_slash_p_is_seen_showing_progress_and_both_waits_are_bounded", () => {
  const quiet = check("quiet_installs_return_exit_codes_and_launch_nothing");
  assert.match(quiet, /msctls_progress32/);
  assert.match(quiet, /the \/P install never showed a progress bar/);
  assert.match(quiet, /\$deadline/);
  assert.match(quiet, /the \/S install did not end within/);
  assert.ok(!/while \(-not \$p\.HasExited\) \{\n/.test(quiet), "no unbounded loop");
});

test("fix_22_tab_and_enter_are_sent_through_the_real_dialog", () => {
  const keys = check("keyboard_tab_order_and_default_buttons_on_the_real_dialog");
  assert.match(keys, /Send-Key/);
  assert.match(keys, /0x09/);
  assert.match(keys, /0x0D/);
  assert.match(keys, /Get-FocusedText/);
  assert.match(func("Get-FocusedText"), /FocusOf/);
  assert.match(keys, /Options/);
  assert.match(keys, /Licence/);
  assert.match(keys, /Assert-OneInstallation \$DefaultDir \$ToVersion/, "Enter on the newer-version screen leaves the installed version alone");
  assert.match(smoke().match(/public static void Key\(IntPtr dlg, int vk\) \{[\s\S]*?\n  \}/)?.[0] ?? "", /PostMessage\(target, 0x0100/);
  assert.match(fn(ui(), "PetalockCancelDefault"), /0x28/, "focus goes to Cancel on the newer-version screen");
  const upgrade = read(".github/workflows/build-installer.yml");
  assert.match(upgrade, /keyboard_tab_order_and_default_buttons_on_the_real_dialog/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 9e, the second fix round (Codex's re-check: new findings 1, 4 and 6, and the folder picker of runner trial 3).
// ---------------------------------------------------------------------------------------------------------------------

const NAME = "(?![A-Za-z0-9_])";

/**
 * The lines of `body` after the first `call` line that read `$PetalockA` before it is set again: the repaint macros reuse it for
 * window handles, so anything read there is a number and not the words the caller had put in it. Counts the lines it looked at.
 */
function readsAfterRepaint(body, call) {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.trim() === call);
  assert.ok(at >= 0, `${call} is in the function`);
  const reads = [];
  let looked = 0;
  let clobbered = true;
  for (const line of lines.slice(at + 1)) {
    looked++;
    const assign = line.match(new RegExp(`^\\s*StrCpy \\$PetalockA${NAME} (.*)$`));
    const uses = new RegExp(`\\$PetalockA${NAME}`).test(assign ? assign[1] : line);
    if (clobbered && uses) reads.push(line.trim());
    if (assign) clobbered = false;
  }
  assert.ok(looked > 0, "there are lines after the repaint to look at");
  return reads;
}

test("fix2_1_a_completed_step_keeps_its_outcome_words_through_the_repaint", () => {
  const paint = code(ui()).join("\n").match(/!macro PETALOCK_PAINT N Y H\n([\s\S]*?)\n!macroend/)?.[1] ?? "";
  // The reason: the repaint puts a window handle in $PetalockA (the colour helper takes its control there).
  assert.match(paint, new RegExp(`StrCpy \\$PetalockA \\$PetalockHS\\$\\{N\\}`));
  const done = fn(ui(), "PetalockStepDone");
  assert.deepEqual(readsAfterRepaint(done, "Call PetalockPaintRows"), [], "nothing reads $PetalockA after the repaint but what was set again");
  // The words are kept in a variable of their own and are what the status control receives.
  assert.match(code(ui()).join("\n"), /^Var PetalockOutcome\b/m);
  assert.match(done, /StrCpy \$PetalockOutcome \$PetalockA/);
  assert.match(done, /SendMessage \$PetalockHStat \$\{WM_SETTEXT\} 0 "STR:\$PetalockOutcome"/);
  // The comparison fires: the code as it was (the status sent from $PetalockA) is found, and so is a repaint that sets nothing again.
  const before = done.replace("STR:$PetalockOutcome", "STR:$PetalockA");
  assert.equal(readsAfterRepaint(before, "Call PetalockPaintRows").length, 1);
  const later = done.replace("Call PetalockPaintRows", () => 'Call PetalockPaintRows\n    SendMessage $0 0 0 "STR:$PetalockA"');
  assert.notEqual(later, done);
  assert.equal(readsAfterRepaint(later, "Call PetalockPaintRows").length, 1);
  // The status control has a fixed id the smoke check reads it by, and it is named wherever the control is made.
  const id = code(ui()).join("\n").match(/^!define PL_ID_STATUS (\d+)$/m)?.[1];
  assert.ok(id, "the status control's id is defined once");
  assert.match(fn(ui(), "PetalockNameStatus"), new RegExp(`SetWindowLongW\\(p \\$PetalockHStat, i -12, i \\$\\{PL_ID_STATUS\\}\\)`));
  for (const page of ["PetalockMainShow", "PetalockProgressShow"]) assert.match(fn(ui(), page), /Call PetalockNameStatus/, page);
  assert.match(check("a_completed_step_puts_words_in_the_status_line"), new RegExp(`\\[SmokeDlg\\]::StatusText\\(\\$d\\.Handle, ${id}\\)`));
});

test("fix2_2_the_registration_advice_deletes_nothing_and_a_fresh_attempt_removes_only_its_own_files", () => {
  const text = code([template(), hooks(), ui()].join("\n")).join("\n");
  assert.ok(!/delet\w*\s+(?:the\s+|this\s+|that\s+|its\s+|a\s+)?(?:Petalock\s+)?folder/i.test(text), "no instruction to delete a folder");
  assert.ok(!/RMDir\s+\/r\b/i.test(text), "no recursive removal");
  // The words, for each case the failure can happen in: the files were taken out again; they could not all be; an update.
  const end = fn(ui(), "PetalockEndShow");
  // The entries branch ends at the ${Else} after its last sentence's ${EndIf}; the file failure's branch runs from there.
  const updated = end.indexOf("Petalock’s files were updated, but Windows");
  const fileStart = end.indexOf("${Else}", end.indexOf("${EndIf}", updated));
  assert.ok(updated > 0 && fileStart > updated, "the entries branch and the file failure's branch are found");
  const branch = end.slice(end.indexOf('$PetalockFailStep == "entries"'), fileStart);
  // The file failure's own three cases (Greptile on #12): the same rollback, so the same three answers.
  const files = end.slice(fileStart, end.indexOf("!insertmacro PETALOCK_INK $PetalockHSlot1", fileStart));
  assert.match(files, /\$\{If\} \$PetalockRolledBack = 1\n[^\n]*"Setup couldn’t write one of Petalock’s files, so it removed the files it had just copied\. Run Setup again to try once more\."/);
  assert.match(files, /\$\{ElseIf\} \$PetalockMode == "fresh"\n[^\n]*"Setup couldn’t write one of Petalock’s files, and could not remove every file it copied\. Run Setup again and choose another folder under Options\."/);
  assert.match(files, /\$\{Else\}\n[^\n]*"Setup couldn’t write one of Petalock’s files\. Some files were already copied to its folder; running Setup again replaces them\."/);
  assert.ok(!/\bdelet/i.test(files), "no word of deleting in the file failure's advice");
  for (const sentence of files.match(/"[^"]{60,}"/g) ?? []) assert.ok(sentence.length <= 160, `short enough for two lines: ${sentence}`);
  assert.match(branch, /\$\{If\} \$PetalockRolledBack = 1/);
  assert.match(branch, /so Setup removed the files it had just copied\. Run Setup again to try once more\./);
  assert.match(branch, /\$\{ElseIf\} \$PetalockMode == "fresh"/);
  assert.match(branch, /and Setup could not remove every file it copied\. Run Setup again and choose another folder under Options\./);
  assert.match(branch, /Petalock’s files were updated, but Windows would not take the new entry in Installed apps\. Setup removed nothing\. Run Setup again to try once more\./);
  assert.ok(!/\bdelet/i.test(branch), "no word of deleting in the advice");
  assert.ok(!/Petalock folder|state folder/i.test(branch), "no folder is named as a thing to touch");
  // Each sentence fits the two lines the slot has (the details box starts below it).
  for (const sentence of branch.match(/"[^"]{60,}"/g) ?? []) assert.ok(sentence.length <= 160, `short enough for two lines: ${sentence}`);
  // The rollback: by name, only on a fresh attempt, never a folder, and proved before it is claimed.
  const roll = fn(template(), "PetalockRollBackFreshFiles");
  assert.ok(roll.length > 0, "the rollback function exists");
  assert.match(roll, /^\s*StrCpy \$PetalockRolledBack 0\n\s*\$\{If\} \$PetalockMode != "fresh"\n\s*Return\n\s*\$\{EndIf\}/m, "an update removes nothing");
  const removals = roll.split("\n").map((line) => line.trim()).filter((line) => /^(Delete|RMDir)\b/.test(line));
  const allowed = [
    /^Delete "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"$/,
    /^Delete "\$INSTDIR\\uninstall\.exe"$/,
    /^Delete "\$INSTDIR\\\\\{\{this(\.\[1\])?\}\}"$/,
    /^RMDir "\$INSTDIR\\\\\{\{this\}\}"$/,
  ];
  assert.ok(removals.length >= 4, `found ${removals.length} removals`);
  assert.deepEqual(removals.filter((line) => !allowed.some((re) => re.test(line))), [], "only the payload, by name");
  assert.ok(removals.includes('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"') && removals.includes('Delete "$INSTDIR\\uninstall.exe"'));
  assert.ok(!removals.some((line) => /^RMDir "\$INSTDIR"$/.test(line)), "the program folder itself is never removed");
  // Rolled back only when every file the attempt could have written is gone (review of Task 13c, finding 2): set, then cleared by
  // any one still there: the program, each resource, each binary, the uninstaller.
  const proved = roll.slice(roll.lastIndexOf("StrCpy $PetalockRolledBack 1"));
  assert.ok(roll.lastIndexOf("StrCpy $PetalockRolledBack 1") > roll.lastIndexOf("RMDir"), "the proof comes after every removal");
  for (const file of ['"$INSTDIR\\${MAINBINARYNAME}.exe"', '"$INSTDIR\\\\{{this.[1]}}"', '"$INSTDIR\\\\{{this}}"', '"$INSTDIR\\uninstall.exe"']) {
    assert.ok(proved.includes(`\${If} \${FileExists} ${file}\n    StrCpy $PetalockRolledBack 0`), `a file left behind clears the claim: ${file}`);
  }
  // NSIS's own Abort ends the section before its failure handling: the rollback runs there too, and nothing else does.
  assert.match(code(template()).join("\n"), /Function \.onInstFailed\n\s*Call PetalockRollBackFreshFiles\nFunctionEnd/);
  // Called three times: twice in the install section, each before its failure is recorded (a quiet run quits there), after its own check: a
  // file failure (Greptile on #12) and a refused entry; and in .onInstFailed, for NSIS's own Abort (checked below).
  const install = section("Install");
  assert.equal([...code(template()).join("\n").matchAll(/Call PetalockRollBackFreshFiles/g)].length, 3);
  assert.match(install, /\$\{If\} \$\{Errors\}\n\s*Call PetalockRollBackFreshFiles\n\s*!insertmacro PETALOCK_FAILED files/);
  assert.match(install, /\$\{If\} \$\{Errors\}\n\s*Call PetalockRollBackFreshFiles\n\s*!insertmacro PETALOCK_FAILED entries/);
  assert.ok(install.indexOf("Call PetalockPreflight") < install.indexOf("Call PetalockRollBackFreshFiles"));
  assert.ok(!/StrCpy \$PetalockMode/.test(install), "the mode the check found is the one the rollback reads");
  // The rows do not claim files that were taken out again.
  const rows = fn(ui(), "PetalockFailRows");
  assert.match(rows, /\$\{If\} \$PetalockRolledBack = 1/);
  assert.match(rows, /Petalock’s files were copied, then removed again/);
  assert.match(code(ui()).join("\n"), /ElseIf\} \$PetalockS\$\{N\} == "undone"\n\s*StrCpy \$PetalockW\$\{N\} "Removed"/);
  // The smoke check: a denied registry write, in both modes, with sentinels, and the retry works.
  const body = check("a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote");
  assert.match(body, /Set-RegDeny/);
  assert.match(body, /CreateSubKey/);
  assert.match(body, /SetValue/);
  assert.match(body, /MU-sentinel/);
  assert.match(body, /New-StateFixture/);
  assert.match(body, /Assert-Unchanged \$planted/);
  assert.match(body, /Clear-RegDeny/);
  assert.equal((body.match(/Install-Silent/g) ?? []).length >= 4, true, "each mode is run denied and then with the permission back");
});

/** The rectangles of the main page's controls (design pixels at 100 %), read from the source: where each is made, then the moves a state makes. */
function mainPageLayout(uiText) {
  const made = {};
  let regs = {};
  const lines = fn(uiText, "PetalockMainShow").split("\n").map((line) => line.trim());
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^!insertmacro PETALOCK_PX \$(R[6-9]) (\d+)$/))) regs[m[1]] = Number(m[2]);
    else if ((m = line.match(/^!insertmacro PETALOCK_LABEL \$(\w+) \$\w+ (\d+) (\d+) (\d+) (\d+) /))) {
      made[m[1]] = { x: +m[2], y: +m[3], w: +m[4], h: +m[5] };
      regs = {}; // the macro leaves scaled values in the registers
    } else if (/^\$\{NSD_Create\w+\} \$R6 \$R7 \$R8 \$R9 /.test(line)) {
      const name = lines[i + 1].match(/^Pop \$(\w+)$/)?.[1];
      assert.ok(name, `a control made at line ${i}`);
      for (const r of ["R6", "R7", "R8", "R9"]) assert.ok(regs[r] !== undefined, `${name}: ${r} is set before the control is made`);
      made[name] = { x: regs.R6, y: regs.R7, w: regs.R8, h: regs.R9 };
    }
  });
  const band = fn(uiText, "PetalockBand").match(/PETALOCK_LABEL \$PetalockHBand \$PetalockInner (\d+) (\d+) (\d+) (\d+)/);
  assert.ok(band, "the command band's rectangle");
  return { made, band: { x: +band[1], y: +band[2], w: +band[3], h: +band[4] } };
}

const moveLines = (text) => [...text.matchAll(/^\s*!insertmacro PETALOCK_MOVE \$(\w+) (\d+) (\d+) (\d+) (\d+)$/gm)].map((m) => ({ name: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] }));
const shownIn = (text) => [...text.matchAll(/ShowWindow \$(\w+) \$\{SW_SHOW\}/g)].map((m) => m[1]);

/** Every state of the slot below the rows: what is shown and where. Returns the problems found and counts what it looked at. */
function slotLayoutProblems(uiText, rowsEnd) {
  const { made, band } = mainPageLayout(uiText);
  const render = fn(uiText, "PetalockRender");
  const start = render.indexOf('${If} $PetalockProblem == "space"\n    SendMessage $PetalockHSlot1');
  const end = render.indexOf("GetDlgItem $0 $HWNDPARENT 1\n  ${If} $PetalockNoDown");
  assert.ok(start > 0 && end > start, "the slot's states are found");
  const home = moveLines(render.slice(0, start));
  const heads = {
    space: '${If} $PetalockProblem == "space"',
    running: '${ElseIf} $PetalockProblem == "running"',
    added: '${ElseIf} $PetalockProblem == "added"',
    write: '${ElseIf} $PetalockProblem != ""\n  ${AndIf} $PetalockCase != "new"',
    keep: '${ElseIf} $PetalockCase != "new"\n    !insertmacro PETALOCK_MOVE $PetalockHSlot1',
  };
  const at = Object.fromEntries(Object.entries(heads).map(([name, head]) => [name, render.indexOf(head, start)]));
  for (const [name, i] of Object.entries(at)) assert.ok(i >= start, `the ${name} state is found`);
  const order = Object.keys(at).sort((a, b) => at[a] - at[b]);
  const branch = {};
  order.forEach((name, i) => { branch[name] = render.slice(at[name], i + 1 < order.length ? at[order[i + 1]] : end); });
  const problems = [];
  // The new-install page with Options open: the link, the folder label, the field and Browse (shown before the slot's states).
  const newStart = render.indexOf('${If} $PetalockCase == "new"\n    ${If} $PetalockProblem == "folder"');
  assert.ok(newStart > 0 && newStart < start, "the new-install block is found");
  const newBlock = render.slice(newStart, start);
  const shown = {
    newOptions: ["PetalockHOptions", "PetalockHFLab", "PetalockHField", "PetalockHBrowse"],
    space: shownIn(branch.space), running: shownIn(branch.running), added: shownIn(branch.added), write: shownIn(branch.write),
    keepReinstall: ["PetalockHSlot1", "PetalockHUninst"], keepOther: ["PetalockHSlot1", "PetalockHOther", "PetalockHCheck"],
  };
  for (const name of [...shown.keepReinstall, ...shown.keepOther]) if (!shownIn(branch.keep).includes(name)) problems.push(`the update state no longer shows ${name}`);
  for (const name of shown.newOptions) if (!shownIn(newBlock).includes(name)) problems.push(`the new-install state no longer shows ${name}`);
  // The words of the first slot must have the lines they need (Segoe UI bold 9 pt measured at 5.4 to 5.8 px a character on a real
  // machine, 5.8 taken, and a tenth more for the words a line cannot break; a line is 16 design pixels).
  const defines = Object.fromEntries([...code(uiText).join("\n").matchAll(/^!define (PL_\w+) "([^"]*)"$/gm)].map((m) => [m[1], m[2]]));
  const expand = (text) => text.replace(/\$\{(PL_\w+)\}/g, (_, k) => defines[k] ?? "").replaceAll("${VERSION}", "0.100.100").replaceAll("$PetalockName", "Petalock 0.100.100").replace(/\$Petalock\w+/g, "XXXXXX");
  const linesFor = (text) => Math.ceil((expand(text).length * 5.8 * 1.1) / 452);
  let fitted = 0;
  let pairs = 0;
  for (const dpi of [96, 120, 144, 168, 192]) {
    const px = (v) => Math.floor((v * dpi) / 96);
    for (const [state, names] of Object.entries(shown)) {
      const own = state.startsWith("keep") ? branch.keep : state === "newOptions" ? newBlock : branch[state];
      const words = own.match(/SendMessage \$PetalockHSlot1 \$\{WM_SETTEXT\} 0 "STR:([^"]*)"/)?.[1];
      if (names.includes("PetalockHSlot1")) {
        if (words === undefined) problems.push(`${state}: the first words are not found`);
        else {
          let rect = { ...made.PetalockHSlot1 };
          for (const move of [...home, ...moveLines(own)]) if (move.name === "PetalockHSlot1") rect = { ...rect, h: move.h };
          fitted++;
          if (rect.h < linesFor(words) * 16) problems.push(`${state} at ${dpi}: the first words need ${linesFor(words)} lines (${linesFor(words) * 16}) and have ${rect.h}`);
        }
      }
      const rects = names.map((name) => {
        const rect = { ...made[name] };
        assert.ok(made[name], `${name} is made`);
        for (const move of [...home, ...moveLines(own)]) if (move.name === name) Object.assign(rect, { x: move.x, y: move.y, w: move.w, h: move.h });
        return { name, x: px(rect.x), y: px(rect.y), w: px(rect.w), h: px(rect.h) };
      });
      for (const r of rects) {
        if (r.y < px(rowsEnd)) problems.push(`${state} at ${dpi}: ${r.name} starts inside the rows`);
        if (r.y + r.h > px(band.y)) problems.push(`${state} at ${dpi}: ${r.name} runs into the command band`);
        if (r.x + r.w > px(band.w)) problems.push(`${state} at ${dpi}: ${r.name} runs off the right edge`);
      }
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          pairs++;
          const p = rects[a];
          const q = rects[b];
          if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) problems.push(`${state} at ${dpi}: ${p.name} overlaps ${q.name}`);
        }
      }
    }
  }
  assert.ok(pairs >= 5 * 8, `${pairs} pairs of controls were compared`);
  assert.ok(fitted >= 5 * 5, `${fitted} first-words rectangles were measured against their words`);
  // Slot 1 and the box go back to where they were made before every state (a state that moved them must not leave them moved).
  for (const name of ["PetalockHSlot1", "PetalockHCheck"]) {
    const m = home.find((move) => move.name === name);
    if (!m) problems.push(`${name} is not put back before the state is drawn`);
    else if (JSON.stringify([m.x, m.y, m.w]) !== JSON.stringify([made[name].x, made[name].y, made[name].w])) problems.push(`${name}'s home is not where it was made`);
  }
  return problems;
}

test("fix2_3_the_added_file_refusal_gives_each_control_its_own_space_and_unticking_clears_it", () => {
  const rowsEnd = Number(code(ui()).join("\n").match(/^!define PL_ROW3 (\d+)$/m)[1]) + 20;
  assert.deepEqual(slotLayoutProblems(ui(), rowsEnd), []);
  // The comparison fires on the layout as it was (slot 1 and the box the same height, the link and the second label inside the box's band)...
  const pair = "    ShowWindow $PetalockHSlot1 ${SW_SHOW}\n    ShowWindow $PetalockHCheck ${SW_SHOW}";
  assert.equal(ui().split(pair).length, 2, "the refusal's two controls are shown in one place");
  const mutants = [
    // the explanation as tall as it was (it ends inside the box)
    ui().replace(/(\$\{ElseIf\} \$PetalockProblem == "added"\n(?:\s*;[^\n]*\n)*\s*!insertmacro PETALOCK_MOVE \$PetalockHSlot1 24 236 452 )\d+/, (_, head) => `${head}48`),
    // the second label and the link shown again
    ui().replace(pair, () => `${pair}\n    ShowWindow $PetalockHSlot2 \${SW_SHOW}\n    ShowWindow $PetalockHOther \${SW_SHOW}`),
    // the box and the slot not put back before a state is drawn
    ui().replace(/\n\s*!insertmacro PETALOCK_MOVE \$PetalockHCheck 24 280 452 20/, ""),
    // the "Petalock is open" words in a slot too short for them
    ui().replace(/(\$\{ElseIf\} \$PetalockProblem == "running"\n(?:\s*;[^\n]*\n)*\s*!insertmacro PETALOCK_MOVE \$PetalockHSlot1 24 236 452 )\d+/, (_, head) => `${head}32`),
    // the folder label as tall as it was (it runs into the folder field)
    ui().replace(/(PETALOCK_LABEL \$PetalockHFLab \$PetalockInner 24 257 452 )\d+/, (_, head) => `${head}22`),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, ui(), "the mutant differs");
    assert.ok(slotLayoutProblems(mutant, rowsEnd).length >= 1, "an overlapping or unrestored layout is found");
  }
  // ...and has nothing to compare when a control's rectangle is gone (it fails, never passes on an empty table).
  assert.throws(() => slotLayoutProblems(ui().replace("${NSD_CreateCheckBox} $R6 $R7 $R8 $R9", "; gone"), rowsEnd));
  // Unticking the box clears the refusal, so the page does not go on saying it.
  const onCheck = fn(ui(), "PetalockOnCheck");
  assert.match(onCheck, /\$\{Else\}\n\s*StrCpy \$PetalockRemoveFirst 0\n\s*\$\{If\} \$PetalockProblem == "added"\n\s*StrCpy \$PetalockProblem ""\n\s*\$\{EndIf\}/);
  const other = fn(ui(), "PetalockOnOther");
  assert.match(other, /BST_UNCHECKED\}\n\s*\$\{If\} \$PetalockProblem == "added"\n\s*StrCpy \$PetalockProblem ""/);
  // The smoke check goes on through an update in place once the box is unticked.
  const body = check("remove_first_with_an_added_file_leaves_the_install_intact");
  assert.match(body, /Click\(\$box\.Handle\)[\s\S]*Click\(\$box\.Handle\)/, "the box is ticked and then unticked");
  assert.match(body, /Drive-Wizard \$p 'install'/);
  assert.match(body, /Assert-OneInstallation \$DefaultDir \$ToVersion/);
  assert.match(body, /\[System\.IO\.File\]::Exists\(\$added\)/);
});

test("fix2_4_the_folder_picker_is_found_by_its_owner_and_its_tree_and_driven_by_keyboard", () => {
  const picker = func("Choose-Folder");
  assert.ok(picker.length > 0, "the picker driver exists");
  assert.match(picker, /SysTreeView32/);
  assert.match(picker, /\[SmokeDlg\]::Owner\(/);
  assert.match(picker, /\[SmokeDlg\]::TypeChars\(\$tree/);
  assert.match(picker, /\[SmokeDlg\]::Item\(\$h, 1\)/, "OK is pressed by its control id");
  assert.ok(!/'Edit'|-like '\*Petalock\*'/.test(picker), "no Folder box is needed and no caption with the product name is dropped");
  assert.match(picker, /throw 'the folder dialog never appeared/);
  const c = check("quick_install_folder_from_options");
  // A folder that differs from the default is reached by typing the name of a folder made beside it.
  assert.match(c, /MU-picked-folder/);
  assert.match(c, /Choose-Folder \$pickName/);
  assert.match(c, /\$optionsObs\['Field'\] -ne \$chosen/);
  assert.match(c, /\$optionsObs\['Field'\] -eq \$DefaultDir/);
  assert.match(c, /Get-UninstallValue 'DisplayName'/);
  assert.match(c, /uninstall\.exe/);
  assert.match(c, /\$location\.Trim/);
  assert.match(smoke(), /public static IntPtr Owner\(IntPtr h\) \{ return GetWindow\(h, 4\); \}/);
  assert.match(smoke(), /public static void TypeChars\(IntPtr h, string s\)/);
  assert.match(smoke(), /public static string StatusText\(IntPtr dlg, int id\)/);
});

// Second fix round, Codex re-check finding 5: the finished WebView2 step's status line and announcement say the product AND its result.
test("fix2_5_the_webview2_completion_carries_its_result_in_the_status_line_and_the_smoke_check_requires_it", () => {
  const done = fn(ui(), "PetalockStepDone");
  const sentence = '    StrCpy $PetalockOutcome "$PetalockA: $PetalockR"';
  const at = done.indexOf(sentence);
  assert.ok(at > 0, "the webview2 outcome is the product, a colon and the result");
  assert.match(done.slice(Math.max(0, at - 80), at), /\$\{If\} \$PetalockStep == "webview2"\n\s*$/, "only for the webview2 step");
  assert.ok(at > done.indexOf("StrCpy $PetalockOutcome $PetalockA"), "it follows the plain words");
  assert.ok(at < done.indexOf("Call PetalockPaintRows"), "$PetalockR is read before the repaint reuses it");
  // The result's words, from the step's own text function, and so the sentences the window can say.
  const text = fn(ui(), "PetalockStepText");
  const step = text.slice(text.indexOf('${ElseIf} $PetalockStep == "webview2"'), text.indexOf('${ElseIf} $PetalockStep == "files"'));
  assert.match(step, /StrCpy \$PetalockA "Microsoft WebView2"/);
  const results = [...step.matchAll(/StrCpy \$PetalockR "([^"$]*)"/g)].map((m) => m[1]).filter((r) => /^(Already installed|Installed by Setup|Not found)/.test(r));
  assert.equal(results.length, 3, "three results: found, installed by Setup, missing on an update");
  const sentences = results.map((r) => `Microsoft WebView2: ${r}`);
  // The smoke check asks for those sentences whole, and refuses the product name alone.
  const body = check("a_completed_step_puts_words_in_the_status_line");
  for (const s of sentences) assert.ok(body.includes(`'${s}'`), `the smoke check looks for: ${s}`);
  assert.ok(!body.includes("'Microsoft WebView2'"), "the product name alone is not an outcome");
  const compare = func("Get-StatusProblems");
  assert.match(compare, /\^Microsoft WebView2/);
  assert.match(compare, /the product name alone/);
  for (const s of sentences) assert.ok(compare.includes(`'${s}'`), `the comparison knows the whole sentence: ${s}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan 5 end-of-plan review (installer findings 1, 3 and 6). Each rule is a function that returns the problems it finds, run on
// the real file (must find none) and on mutants of it (each must find at least one), so a rule that matched nothing would fail.
// ---------------------------------------------------------------------------------------------------------------------

const PROGRAM = 'Delete "$INSTDIR\\${MAINBINARYNAME}.exe"';
const PROGRAM_THERE = '${If} ${FileExists} "$INSTDIR\\${MAINBINARYNAME}.exe"';

/** Finding 1: the program goes first and, still there, stops the uninstall before its uninstaller, its entry or anything else goes. */
export function programFirstProblems(text) {
  const problems = [];
  const body = code(text).join("\n").match(/Section Uninstall\n([\s\S]*?)\nSectionEnd/)?.[1];
  if (!body) return ["no Section Uninstall"];
  const lines = body.split("\n").map((line) => line.trim());
  const removal = (line) => /^(Delete|DeleteReg\w*|RMDir)\b/.test(line);
  const del = lines.indexOf(PROGRAM);
  if (del < 0) return ["the program is not deleted by name"];
  if (lines.findIndex(removal) !== del) problems.push("something is removed before the program");
  const clean = lines.indexOf("Call un.PetalockCleanOpen");
  if (clean < 0 || clean > del) problems.push("open\\ is not cleaned before the program is deleted");
  if (lines[del - 1] !== "program_again:") problems.push("Retry has no label to go back to, right before the delete");
  if (lines[del + 1] !== PROGRAM_THERE) problems.push("the program is not looked for right after its delete");
  // The block of that check, with its nested ifs.
  let depth = 0;
  let end = -1;
  for (let i = del + 1; i < lines.length; i++) {
    if (/^\$\{If\}/.test(lines[i])) depth++;
    else if (lines[i] === "${EndIf}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [...problems, "the check of the program is not a closed block"];
  const block = lines.slice(del + 1, end + 1).join("\n");
  if (!/^\$\{If\} \$\{Silent\}\n\$\{OrIf\} \$PassiveMode = 1\n!insertmacro PETALOCK_CONSOLE "[^"]+"\nAbort\n\$\{EndIf\}\n/m.test(block.split("\n").slice(1).join("\n"))) problems.push("a silent or passive run does not say so and stop");
  if (!/\nMessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "[^"]+" \/SD IDCANCEL IDRETRY program_again\nAbort\n\$\{EndIf\}$/.test(block)) problems.push("a window does not offer Retry and Cancel (Cancel by default when nobody answers) and stop");
  for (const later of ['Delete "$INSTDIR\\uninstall.exe"', 'DeleteRegKey HKCU "${UNINSTKEY}"']) {
    const at = lines.indexOf(later);
    if (at < 0) problems.push(`${later} is gone`);
    else if (at < end) problems.push(`${later} comes before the check of the program`);
  }
  for (const line of lines.slice(0, del)) if (removal(line)) problems.push(`removed before the program: ${line}`);
  return problems;
}

function mutate(text, from, to) {
  assert.ok(text.includes(from), `the mutant's anchor is in the file: ${from}`);
  return text.replace(from, to);
}

test("end_1_a_program_that_cannot_be_deleted_stops_the_uninstall_before_its_uninstaller_and_entry", () => {
  const text = template();
  assert.deepEqual(programFirstProblems(text), []);
  const block = text.slice(text.indexOf("program_again:"), text.indexOf("  ; Delete resources"));
  assert.ok(block.includes("${If} ${FileExists}") && block.includes("IDRETRY program_again"), "the block that was cut out is the check");
  const mutants = {
    "no check at all": mutate(text, block, `program_again:\n  ${PROGRAM}\n\n`),
    "the check does not stop": mutate(text, "IDRETRY program_again\n    Abort\n  ${EndIf}", "IDRETRY program_again\n  ${EndIf}"),
    "no default answer for a window nobody answers": mutate(text, " /SD IDCANCEL IDRETRY program_again", " IDRETRY program_again"),
    "Retry goes nowhere": mutate(text, "IDRETRY program_again", "IDRETRY program_gone"),
    "a passive run is asked": mutate(text, "${OrIf} $PassiveMode = 1\n      !insertmacro PETALOCK_CONSOLE \"The program is still", "${OrIf} 0 = 1\n      !insertmacro PETALOCK_CONSOLE \"The program is still"),
    // In Section Uninstall itself: the same line also opens the install's rollback check, earlier in the file.
    "the check names another file": text.slice(0, text.indexOf("\nSection Uninstall\n")) + mutate(text.slice(text.indexOf("\nSection Uninstall\n")), PROGRAM_THERE, '${If} ${FileExists} "$INSTDIR\\uninstall.exe"'),
    "the uninstaller goes first": mutate(text, `program_again:\n  ${PROGRAM}`, `Delete "$INSTDIR\\uninstall.exe"\n  program_again:\n  ${PROGRAM}`),
    "the program is deleted after the entry": mutate(mutate(text, `program_again:\n  ${PROGRAM}`, "program_again:\n  ClearErrors"), '  ; Delete uninstaller\n  Delete "$INSTDIR\\uninstall.exe"', `  ${PROGRAM}\n  ; Delete uninstaller\n  Delete "$INSTDIR\\uninstall.exe"`),
    "open\\ is cleaned after the program": mutate(mutate(text, "  Call un.PetalockCleanOpen\n", ""), "  ; Delete resources\n", "  Call un.PetalockCleanOpen\n  ; Delete resources\n"),
  };
  for (const [what, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, text, what);
    assert.ok(programFirstProblems(mutant).length >= 1, `must be refused: ${what}`);
  }
  assert.deepEqual(programFirstProblems(""), ["no Section Uninstall"]);
});

test("end_1_the_words_of_the_stop_name_no_file_and_the_smoke_check_looks_for_them", () => {
  const text = template();
  const shown = text.slice(text.indexOf("program_again:"), text.indexOf("  ; Delete resources")).split("\n").filter((line) => /MessageBox|PETALOCK_CONSOLE/.test(line));
  assert.equal(shown.length, 2, "a console line and a box");
  for (const line of shown) {
    const words = line.match(/"([^"]*)"/)[1].replace(/\$\\[rn]/g, "");
    assert.ok(!/\$/.test(words), `no variable in the words: ${line.trim()}`);
    assert.match(words, /program/);
  }
  assert.match(shown[1], /Retry/);
  assert.match(shown[1], /Cancel stops here and leaves Petalock installed/);
  assert.match(shown[1], /still in use/);
  // The smoke check waits for the box by those words.
  assert.match(check("a_program_that_cannot_be_removed_stops_the_uninstall_with_its_entry_kept"), /-like '\*program is still in use\*'/);
});

test("end_1_the_old_uninstaller_that_stops_is_reported_as_the_earlier_version_not_removed", () => {
  const remove = section("PetalockRemoveOld");
  // Setup reads the child's exit code (a stop is non-zero: Abort) and, if it cannot be read, a failure; and it looks for the program too.
  assert.match(remove, /ExecWait '\$R1' \$0\n\s*BringToFront\n\s*\$\{IfThen\} \$\{Errors\} \$\{\|\} StrCpy \$0 2 \$\{\|\}\n\s*\$\{If\} \$0 <> 0\n\s*\$\{OrIf\} \$\{FileExists\} "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"\n\s*!insertmacro PETALOCK_FAILED remove_old "The earlier version was not removed\."\n\s*Return\n\s*\$\{EndIf\}/);
  // The failure page's advice is now true: the entry and the uninstaller are still there to run again.
  assert.match(fn(ui(), "PetalockEndShow"), /\$\{ElseIf\} \$PetalockFailStep == "remove_old"\n\s*!insertmacro PETALOCK_LABEL \$PetalockHSlot1 \$PetalockInner 24 236 452 38 0x54000080 \$PetalockFBody "The earlier version could not be removed, so Setup stopped before installing\. Run Setup again once nothing is using it\."/);
  // The same-version link still proves the program and the entry gone before it ends Setup.
  assert.match(fn(ui(), "PetalockOnUninstallInstead"), /Its uninstaller was left in place, so you can run it again from Installed apps\./);
});

test("end_1_the_smoke_check_refuses_the_program_its_delete_and_proves_nothing_went_then_everything_does", () => {
  const body = check("a_program_that_cannot_be_removed_stops_the_uninstall_with_its_entry_kept");
  assert.ok(body.length > 500, "the check is there");
  // The delete is refused (access denied on the file and on its folder's right to delete a child), not the file held open: a file held
  // open at all makes Setup's own running check (which asks for write access with no sharing, and counts a sharing violation as a
  // running Petalock) refuse first, and the new stop would never be reached.
  assert.match(body, /Set-Deny \$program 'DE'/);
  assert.match(body, /Set-Deny \$DefaultDir 'DC'/);
  assert.match(body, /\} finally \{\n\s*Clear-Deny \$program\n\s*Clear-Deny \$DefaultDir\n\s*\}/, "the denial is always taken away again");
  assert.ok(!/\[System\.IO\.File\]::Open\(/.test(body), "no handle is held");
  assert.match(body, /\$uninstaller = Join-Path \$DefaultDir 'uninstall\.exe'/);
  assert.match(body, /\$p = Start-Tracked \$uninstaller @\('\/S', "_\?=\$DefaultDir"\)/);
  assert.match(body, /@\('\/S', '\/UPDATE', "_\?=\$DefaultDir"\)/);
  assert.equal((body.match(/if \(\$\w*[cC]ode -eq 0\) \{ throw/g) ?? []).length >= 2, true, "both silent runs must exit non-zero");
  assert.match(body, /Assert-Unchanged \$installed \(Get-InstallState \$DefaultDir\)/);
  assert.match(body, /\[System\.IO\.File\]::Exists\(\$program\)/);
  assert.match(body, /\[System\.IO\.File\]::Exists\(\$uninstaller\)/);
  assert.match(body, /Get-UninstallValue 'DisplayName'/);
  assert.match(body, /if \(\$said\.Length -eq 0\) \{ throw/, "the output check fails on nothing");
  assert.match(body, /Assert-NamesNothing \$said @\(\$DefaultDir, 'petalock\.exe', 'uninstall\.exe'\)/);
  assert.match(body, /Uninstall-Interactive \$DefaultDir \$false 'Cancel'/);
  // Released, the same uninstall removes the program, its uninstaller, the folder and the entry.
  const release = body.indexOf("Clear-Deny $program");
  const again = body.indexOf("Uninstall-AsWindowsDoes $DefaultDir");
  assert.ok(release > 0 && again > release, "the denial is taken away, then the uninstall runs again");
  const after = body.slice(again);
  assert.match(after, /Exists\(\$program\)/);
  assert.match(after, /Exists\(\$DefaultDir\)|Directory\]::Exists\(\$DefaultDir\)/);
  assert.match(after, /Get-UninstallValue 'DisplayName'/);
  // It is one of the named checks, in the order the script runs them.
  assert.match(smoke(), /"a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote",\n\s*# Plan 5 end-of-plan review\.\n\s*"a_program_that_cannot_be_removed_stops_the_uninstall_with_its_entry_kept"\n\)/);
});

/** Finding 3: the old uninstaller an update runs shows no confirm page and no finish page (Setup shows its own receipt). */
export function updateUninstallerPagesProblems(text) {
  const problems = [];
  const lines = code(text).join("\n");
  const skip = lines.match(/Function un\.SkipIfPassiveOrUpdate\n([\s\S]*?)\nFunctionEnd/)?.[1] ?? "";
  if (!/^\s*\$\{If\} \$PassiveMode = 1\n\s*\$\{OrIf\} \$UpdateMode = 1\n\s*Abort\n\s*\$\{EndIf\}$/.test(skip)) problems.push("the skip does not leave out the page for a passive run and for /UPDATE");
  if (!/!define MUI_PAGE_CUSTOMFUNCTION_PRE un\.SkipIfPassiveOrUpdate\n!insertmacro MUI_UNPAGE_CONFIRM/.test(lines)) problems.push("the confirm page is not skipped by it");
  if (!/!define MUI_PAGE_CUSTOMFUNCTION_PRE un\.SkipIfPassiveOrUpdate\n!define MUI_FINISHPAGE_TITLE [^\n]*\n!define MUI_FINISHPAGE_TEXT [^\n]*\n!insertmacro MUI_UNPAGE_FINISH/.test(lines)) problems.push("the finish page is not skipped by it");
  if (/un\.SkipIfPassive\b/.test(lines)) problems.push("a page still uses the skip that ignores /UPDATE");
  return problems;
}

test("end_3_the_old_uninstaller_an_update_runs_shows_neither_its_confirm_page_nor_its_finish_page", () => {
  const text = template();
  assert.deepEqual(updateUninstallerPagesProblems(text), []);
  const mutants = {
    "the finish page is shown under /UPDATE": mutate(text, "!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassiveOrUpdate\n!define MUI_FINISHPAGE_TITLE", "!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive\n!define MUI_FINISHPAGE_TITLE"),
    "the confirm page is shown under /UPDATE": mutate(text, "!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassiveOrUpdate\n!insertmacro MUI_UNPAGE_CONFIRM", "!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive\n!insertmacro MUI_UNPAGE_CONFIRM"),
    "the skip forgets /UPDATE": mutate(text, "${OrIf} $UpdateMode = 1\n    Abort", "${OrIf} 0 = 1\n    Abort"),
    "the skip forgets a passive run": mutate(text, "${If} $PassiveMode = 1\n  ${OrIf} $UpdateMode = 1\n    Abort", "${If} 0 = 1\n  ${OrIf} $UpdateMode = 1\n    Abort"),
    "the skip is never defined": mutate(text, "Function un.SkipIfPassiveOrUpdate", "Function un.SkipSomething"),
  };
  for (const [what, mutant] of Object.entries(mutants)) assert.ok(updateUninstallerPagesProblems(mutant).length >= 1, `must be refused: ${what}`);
  assert.ok(updateUninstallerPagesProblems("").length >= 3, "an empty file is refused, not passed");
  // A full uninstall (no /UPDATE, not passive) is untouched: its box and its finish page stay (the guards inside them are unchanged).
  assert.match(text, /!define MUI_FINISHPAGE_TITLE "Petalock was uninstalled"/);
  assert.match(text, /un\.ConfirmShow/);
});

test("end_3_the_smoke_check_sees_no_page_of_the_old_uninstaller_under_update_and_both_pages_in_a_full_uninstall", () => {
  const body = check("interactive_upgrade_keeps_start_with_windows");
  assert.equal((body.match(/\$ConfirmPage = @\{ Seen = 0; Box = 0; Finish = 0 \}/g) ?? []).length, 3, "every run starts its counts at zero");
  assert.match(body, /if \(\$uninstallFirst\) \{ Assert-NoUninstallerPages \$ConfirmPage \$what \}/);
  assert.match(body, /Assert-NoUninstallerPages \$ConfirmPage \$what\n/);
  assert.match(body, /Assert-ConfirmPageBox \$ConfirmPage \$true "the same-version 'Uninstall Petalock instead'"/);
  const none = func("Assert-NoUninstallerPages");
  assert.match(none, /\$Seen\.Seen -ne 0\) \{ throw/);
  assert.match(none, /\$Seen\.Finish -ne 0\) \{ throw/);
  // The control: a full uninstall must show the page the reader looks for (a reader that finds nothing would pass the rest).
  assert.match(func("Assert-ConfirmPageBox"), /\$WithBox -and \$Seen\.Finish -ne 1\) \{ throw/);
  const reader = func("New-ConfirmPageReader");
  assert.match(reader, /\$ConfirmPage\.Finish\+\+/);
  assert.match(reader, /\*Petalock was uninstalled\*/);
  // Its words are the page's own title.
  assert.ok(template().includes('!define MUI_FINISHPAGE_TITLE "Petalock was uninstalled"'));
});

test("end_6_the_comments_say_what_the_code_does", () => {
  const head = template().split("\n").slice(0, 45).join("\n");
  assert.ok(!/folder page|both install sections/.test(head), "the template's list names no page and no section that is gone");
  assert.match(head, /the three sections/);
  assert.ok(!/from the folder page/.test(hooks()), "the preflight's comment names no page that is gone");
  assert.ok(!/the checks have not run/.test(ui()), "the first page's comment does not say the checks have not run");
  assert.match(ui(), /what the person sees first: the answer of the checks \.onInit ran/);
  const running = smoke().match(/# Plan 5, Task 9e: the window of an installer this run started \(\$Process\), with Petalock running\.[\s\S]*?\nfunction Wait-RunningPage/)?.[0] ?? "";
  assert.ok(running.length > 100, "the helper's comment is found");
  assert.ok(!/only after\s+# its default button is pressed|says so only after/.test(running), "the helper's comment does not say the page shows it only after a press");
  assert.match(running, /as soon as it says/);
});

/**
 * After the end-of-plan review (CI on #12): the last step's "Done" words stay on screen a moment before the window moves on to
 * the receipt, so a person sees the install finish, a screen reader can read it out before the page changes, and the smoke
 * check's reading of the status line is not a race. Only when there is a window (never in a silent install), and briefly.
 */
export function finalHoldProblems(text) {
  const lines = code(text).join("\n");
  const end = lines.match(/!insertmacro PETALOCK_DONE entries\n([\s\S]*?)\n\s*SetAutoClose true\nSectionEnd/)?.[1];
  if (end === undefined) return ["the install section does not end with the entries Done and then SetAutoClose"];
  const hold = end.match(/^\s*\$\{IfNot\} \$\{Silent\}\n\s*Sleep (\d+)\n\s*\$\{EndIf\}$/);
  if (hold === null) return ["between the last Done and SetAutoClose there is no hold of the window, only when not silent"];
  const ms = Number(hold[1]);
  if (ms < 800 || ms > 1500) return [`the hold is ${ms} ms, not between 800 and 1500`];
  return [];
}

test("end_hold_the_last_done_stays_on_screen_before_the_receipt", () => {
  const text = template();
  assert.deepEqual(finalHoldProblems(text), []);
  const mutants = {
    "no hold": mutate(text, "  ${IfNot} ${Silent}\n    Sleep 1000\n  ${EndIf}\n  SetAutoClose true", "  SetAutoClose true"),
    "a hold in a silent install too": mutate(text, "  ${IfNot} ${Silent}\n    Sleep 1000\n  ${EndIf}\n", "  Sleep 1000\n"),
    "a hold too long": mutate(text, "    Sleep 1000\n  ${EndIf}\n  SetAutoClose true", "    Sleep 5000\n  ${EndIf}\n  SetAutoClose true"),
    "a hold too short to see": mutate(text, "    Sleep 1000\n  ${EndIf}\n  SetAutoClose true", "    Sleep 100\n  ${EndIf}\n  SetAutoClose true"),
    "the hold before the Done": mutate(text, "  !insertmacro PETALOCK_DONE entries\n  ${IfNot} ${Silent}\n    Sleep 1000\n  ${EndIf}\n", "  ${IfNot} ${Silent}\n    Sleep 1000\n  ${EndIf}\n  !insertmacro PETALOCK_DONE entries\n"),
  };
  for (const [what, mutant] of Object.entries(mutants)) assert.ok(finalHoldProblems(mutant).length >= 1, `must be refused: ${what}`);
  assert.ok(finalHoldProblems("").length >= 1, "an empty file is refused, not passed");
});
