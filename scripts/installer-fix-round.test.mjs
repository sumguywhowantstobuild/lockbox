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
  const guard = install.indexOf('${If} ${Errors}\n    !insertmacro PETALOCK_FAILED files');
  assert.ok(guard > uninstaller && guard < done, "a file-stage error is routed to the failure handler before the row is Done");
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
  const paint = code(ui()).join("\n").match(/!macro PETALOCK_PAINT N Y\n([\s\S]*?)\n!macroend/)?.[1] ?? "";
  assert.match(paint, /PETALOCK_MOVE \$PetalockHT\$\{N\} 44 \$\{Y\} 330 20/, "a row with a state word keeps clear of its column");
  assert.match(paint, /PETALOCK_MOVE \$PetalockHT\$\{N\} 44 \$\{Y\} 432 20/, "a row without one may use the width");
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
  const paint = code(ui()).join("\n").match(/!macro PETALOCK_PAINT N Y\n([\s\S]*?)\n!macroend/)?.[1] ?? "";
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
  const branch = end.slice(end.indexOf('$PetalockFailStep == "entries"'), end.indexOf("${Else}\n      !insertmacro PETALOCK_LABEL $PetalockHSlot1"));
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
  assert.match(roll, /\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"\n\s*\$\{AndIfNot\} \$\{FileExists\} "\$INSTDIR\\uninstall\.exe"\n\s*StrCpy \$PetalockRolledBack 1/);
  // Called once, before the failure is recorded (a quiet run quits there), in the install section after its own check.
  const install = section("Install");
  assert.equal([...code(template()).join("\n").matchAll(/Call PetalockRollBackFreshFiles/g)].length, 1);
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
    ui().replace(/(PETALOCK_LABEL \$PetalockHFLab \$PetalockInner 24 258 452 )\d+/, (_, head) => `${head}20`),
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
