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
  const words = ui();
  assert.match(words, /Petalock’s files were copied, but Windows would not take its entry in Installed apps/);
  assert.match(words, /delete the Petalock folder/i);
  const entriesBranch = end.slice(end.indexOf('$PetalockFailStep == "entries"'));
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
  assert.match(func("Choose-Folder"), /WM_SETTEXT|SetText/);
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
