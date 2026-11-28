// Plan 5, Task 1: the installer and its uninstall clean-up. These are the script tests: they read the installer's
// template, its hooks, the bundle configuration and the two workflow files, and they run `installer-smoke.ps1` in the
// ways that touch nothing (arguments refused, `-DryRun`, `-SelfTest`). The smoke script's own checks, which install and
// uninstall the real installer, run only on the GitHub runner inside `build-installer.yml`, never on a person's PC (the
// script refuses to start anywhere else); every test of the plan's list has its name in both places.
//
// The installer is built from `crates/petalock-desktop/windows/installer.nsi`, a copy of Tauri's NSIS template with the
// changes listed at its top. Hooks alone could not enforce the folder rule before each operation (the report of Task 1
// gives the lines); `hooks.nsh` holds the logic, the template only calls it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = "crates/petalock-desktop/windows/installer.nsi";
const HOOKS = "crates/petalock-desktop/windows/hooks.nsh";
const CONFIG = "crates/petalock-desktop/tauri.conf.json";
const BUILD = ".github/workflows/build-installer.yml";
const CI = ".github/workflows/ci.yml";
const SMOKE = "scripts/installer-smoke.ps1";

/** The plan's named tests: each is a check of the smoke script on the runner and a check of the files here. */
export const NAMED = [
  "install_folder_is_programs_petalock_by_default",
  "install_refuses_an_unsafe_folder",
  "files_added_after_install_survive_upgrade_and_uninstall",
  "install_writes_only_its_own_places",
  "uninstall_removes_open_copies_and_nothing_else",
  "the_app_data_box_removes_exactly_the_identifier_folders",
  "uninstall_never_follows_a_junction",
  "a_held_or_read_only_copy_is_reported_not_left_silently",
  "running_petalock_is_never_ended_and_silent_refuses_first",
  "uninstall_says_where_vaults_stay",
  "installed_copy_has_the_notices_file",
  // Plan 5, Task 9e: the one screen in Petalock's look.
  "quick_install_default_folder_and_receipt",
  "quick_install_folder_from_options",
  "quick_install_folder_from_d",
  "quiet_installs_return_exit_codes_and_launch_nothing",
  // The review fix round.
  "a_write_that_is_denied_is_a_failure_not_a_receipt",
  "interactive_update_mode_offers_no_uninstall_choice",
  // The second fix round.
  "a_completed_step_puts_words_in_the_status_line",
  "a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote",
];

/** Plan 5, Task 4: the checks that need two versions of the same code (-Installer the earlier, -Upgrade the later). */
export const UPGRADE_NAMED = [
  "upgrade_keeps_vaults_list_settings_and_state",
  "candidate_versions_upgrade_in_order",
  "downgrade_behaviour_is_the_specified_one",
  "uninstall_after_upgrade_is_clean",
  // Plan 5, Task 4b: an upgrade keeps "start with Windows", and the reinstall page installs over by default.
  "interactive_upgrade_keeps_start_with_windows",
  "upgrade_page_defaults_to_install_over",
  // Task 9e review fix round.
  "remove_first_with_an_added_file_leaves_the_install_intact",
  "keyboard_tab_order_and_default_buttons_on_the_real_dialog",
];

const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** The text from the first match of `start` to the next `end` after it (both included); fails when either is absent. */
function between(text, start, end, what) {
  const from = text.search(start);
  assert.ok(from >= 0, `${what}: no start found`);
  const rest = text.slice(from);
  const stop = rest.slice(1).search(end);
  assert.ok(stop >= 0, `${what}: no end found`);
  return rest.slice(0, stop + 1 + rest.slice(stop + 1).match(end)[0].length);
}

/** A script's code lines without comments (`;` and `#` start a comment in NSIS). */
const code = (text) => text.split("\n").map((line) => line.replace(/^\s*[;#].*$/, "").trimEnd()).filter((line) => line.trim() !== "");

const template = () => read(TEMPLATE);
// Plan 5, Task 9e: hooks.nsh includes setup-ui.nsh (the one screen), so every rule that reads "the hooks" reads both: a delete,
// a run or a registry write added there is held to the same lists as one in the template.
const UI = "crates/petalock-desktop/windows/setup-ui.nsh";
const ui = () => (existsSync(join(ROOT, UI)) ? read(UI) : "");
const hooks = () => read(HOOKS) + "\n" + ui();

/**
 * The lines of the template that are built when the install mode is `currentUser`: the branches of `!if "${INSTALLMODE}"
 * == "x"`, `!else if` and `!else` for the other modes are left out. Any other `!if` is taken as built (the safe side).
 */
export function builtLines(text, mode = "currentUser") {
  const out = [];
  const stack = []; // each: { modal: whether this `!if` tests the install mode, taken: some branch already built, on: this branch is built }
  const on = () => stack.every((frame) => frame.on);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const test = trimmed.match(/^!(?:else )?if "\$\{INSTALLMODE\}" == "(\w+)"$/);
    if (/^!if\b/.test(trimmed)) {
      const modal = Boolean(test);
      const taken = modal && test[1] === mode;
      stack.push({ modal, taken, on: modal ? taken : true });
      continue;
    }
    if (/^!else if\b/.test(trimmed)) {
      const frame = stack.at(-1);
      if (frame.modal && test) {
        frame.on = !frame.taken && test[1] === mode;
        frame.taken ||= frame.on;
      } else if (frame.modal) {
        frame.on = !frame.taken;
      }
      continue;
    }
    if (/^!else\b/.test(trimmed)) {
      const frame = stack.at(-1);
      if (frame.modal) frame.on = !frame.taken;
      continue;
    }
    if (/^!endif\b/.test(trimmed)) {
      stack.pop();
      continue;
    }
    if (on()) out.push(line);
  }
  assert.equal(stack.length, 0, "every !if is closed");
  return out;
}

/** Where the installer must check the folder and for a running copy: each problem found, as a sentence. */
export function placementProblems(text, uiText = ui()) {
  const problems = [];
  const onInit = between(text, /^Function \.onInit$/m, /^FunctionEnd$/m, ".onInit");
  const lastFolder = Math.max(onInit.lastIndexOf("Call RestorePreviousInstallLocation"), onInit.lastIndexOf("StrCpy $INSTDIR"));
  const preflight = onInit.indexOf("Call PetalockPreflight");
  if (lastFolder < 0) problems.push(".onInit sets no folder");
  if (preflight < 0 || preflight < lastFolder) problems.push(".onInit does not check the folder after the last place it is set");

  const unInit = between(text, /^Function un\.onInit$/m, /^FunctionEnd$/m, "un.onInit");
  if (!unInit.includes("Call un.PetalockPreflight")) problems.push("un.onInit does not check the folder and the running program");

  const webview = between(text, /^Section WebView2$/m, /^SectionEnd$/m, "Section WebView2");
  if (code(webview)[1]?.trim() !== "Call PetalockPreflight") problems.push("the WebView2 section does not start with the check");

  const install = code(between(text, /^Section Install$/m, /^SectionEnd$/m, "Section Install"));
  const setOut = install.findIndex((line) => line.trim().startsWith("SetOutPath"));
  const installCheck = install.findIndex((line) => line.trim() === "Call PetalockPreflight");
  if (installCheck < 0 || setOut < 0 || installCheck > setOut) problems.push("Section Install checks after SetOutPath made the folder");

  const uninstall = between(text, /^Section Uninstall$/m, /^SectionEnd$/m, "Section Uninstall");
  const firstDelete = uninstall.search(/^\s*(Delete|DeleteReg|RMDir)/m);
  const unCheck = uninstall.indexOf("Call un.PetalockPreflight");
  const clean = uninstall.indexOf("Call un.PetalockCleanOpen");
  if (unCheck < 0 || unCheck > firstDelete) problems.push("Section Uninstall checks after it began to delete");
  if (clean < 0 || clean < unCheck || clean > firstDelete) problems.push("open\\ is not cleaned first, right after the check");

  // Plan 5, Task 9e: the folder page is the one custom page; it checks the folder (the same guard, `PetalockCheckAll` runs
  // `PetalockGuardFolder`) when it is left, and stays when it is refused. The old uninstaller an upgrade runs is the first
  // section, and its command is built and checked before it runs.
  const pageLeave = between(uiText, /^Function PetalockMainLeave$/m, /^FunctionEnd$/m, "PetalockMainLeave");
  if (!/^Page custom PetalockMainShow PetalockMainLeave$/m.test(text)) problems.push("the page's leave is not the template's custom page");
  if (!pageLeave.includes("Call PetalockCheckAll")) problems.push("the folder page does not check the folder when it is left");
  const guardCall = between(uiText, /^Function PetalockCheckAll$/m, /^FunctionEnd$/m, "PetalockCheckAll");
  if (!guardCall.includes("Call PetalockGuardFolder")) problems.push("the page's checks do not run the folder guard");
  const remove = code(between(text, /^Section PetalockRemoveOld$/m, /^SectionEnd$/m, "Section PetalockRemoveOld")).join("\n");
  const check = remove.indexOf("Call PetalockBeforeOldUninstaller");
  const run = remove.indexOf("ExecWait '$R1' $0");
  if (check < 0 || run < 0 || check > run) problems.push("the old uninstaller is run before the folder is checked");
  if (code(between(text, /^Section PetalockRemoveOld$/m, /^SectionEnd$/m, "Section PetalockRemoveOld"))[1]?.trim() !== "Call PetalockPreflight") problems.push("the old-uninstaller section does not start with the check");
  return problems;
}

// Task 4 review: the installed program must carry the installer's own version (a build folder kept from a candidate build
// could otherwise put another version's program inside the tested installer).
test("the_installed_program_carries_the_installers_version", () => {
  const check = checkBody("install_folder_is_programs_petalock_by_default");
  assert.match(check, /\$want = Get-EmbeddedVersion \$Installer/);
  assert.match(check, /\$got = Get-EmbeddedVersion \(Join-Path \$DefaultDir 'petalock\.exe'\)/);
  assert.match(check, /if \(\$got -ne \$want\)/);
});

test("install_folder_is_programs_petalock_by_default", () => {
  const text = template();
  const config = JSON.parse(read(CONFIG));
  assert.equal(config.productName, "Petalock");
  // The default is assigned once, in the per-user branch, and it is never the state folder (`%LOCALAPPDATA%\Petalock`).
  const defaults = code(text).filter((line) => /StrCpy \$INSTDIR "\$LOCALAPPDATA\\/.test(line));
  assert.deepEqual(defaults.map((line) => line.trim()), ['StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${PRODUCTNAME}"']);
  assert.ok(!code(text).some((line) => line.includes('"$LOCALAPPDATA\\${PRODUCTNAME}"')), "Tauri's own default must be gone");
  const paths = read("crates/petalock-desktop/src/paths.rs");
  assert.match(paths, /\.join\("Petalock"\)/, "the state folder this test compares with");
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
});

test("install_refuses_an_unsafe_folder", () => {
  const text = template();
  assert.deepEqual(placementProblems(text), []);
  const guard = hooks();
  const lines = code(guard).join("\n");
  // Each refusal the plan lists, as the code that makes it.
  assert.match(lines, /\$LOCALAPPDATA\\Petalock/, "the state folder");
  assert.match(lines, /\$APPDATA\\\$\{BUNDLEID\}/, "the Roaming identifier folder");
  assert.match(lines, /\$LOCALAPPDATA\\\$\{BUNDLEID\}/, "the Local identifier folder");
  assert.match(lines, /vault\.json/, "a vault folder, by its header file");
  assert.match(lines, /GetFinalPathNameByHandleW/, "the folder as it really is, through any redirected parent");
  assert.match(lines, /0x400/, "a link at the folder itself");
  assert.match(lines, /uninstall\.exe/, "a folder with other people's files is refused unless the installer's own files are there");
  // The same refusal is made by the installer and by the uninstaller, and by the old uninstaller's launcher.
  assert.match(lines, /Function PetalockGuardFolder|Function \$\{UN\}PetalockGuardFolder/);
  assert.match(lines, /Function \$\{UN\}PetalockPreflight|Function PetalockPreflight/);
});

test("placement of the checks fails when one is missing, and finds none missing as built", () => {
  const text = template();
  assert.deepEqual(placementProblems(text), []);
  // The check counts what it looks for: calls to find, and a wrong template that must be refused.
  const calls = text.match(/Call (un\.)?Petalock(Preflight|CleanOpen|BeforeOldUninstaller)/g) ?? [];
  assert.ok(calls.length >= 7, `found ${calls.length} calls`);
  const without = text.replaceAll("Call PetalockPreflight", "; removed");
  assert.ok(placementProblems(without).length >= 3, "a template with no check must be refused");
  const late = text.replace("Call un.PetalockCleanOpen", "Delete \"$INSTDIR\\x\"\n  Call un.PetalockCleanOpen");
  assert.ok(placementProblems(late).length >= 1, "a delete before the clean-up must be refused");
  const noLeave = ui().replace("Call PetalockCheckAll", "; removed");
  assert.ok(placementProblems(text, noLeave).length >= 1, "a folder page without its check must be refused");
  const lateOld = text.replace("Call PetalockBeforeOldUninstaller", "; removed");
  assert.ok(placementProblems(lateOld).length >= 1, "an old uninstaller run with no check before it must be refused");
});

test("files_added_after_install_survive_upgrade_and_uninstall", () => {
  const both = code(template()).concat(code(hooks()));
  // NSIS's own `RMDir /r` follows junctions (NSIS 3.13 Source/exehead/util.c:229-234), and it empties whole folders:
  // neither is allowed. The installer's files go by name, the folder only when empty.
  assert.deepEqual(both.filter((line) => /RMDir\s+\/r\b/i.test(line)), []);
  const uninstall = between(template(), /^Section Uninstall$/m, /^SectionEnd$/m, "Section Uninstall");
  const deletes = code(uninstall).filter((line) => /^\s*Delete\s/.test(line)).map((line) => line.trim());
  assert.ok(deletes.includes('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"'));
  assert.ok(deletes.includes('Delete "$INSTDIR\\uninstall.exe"'));
  assert.ok(code(uninstall).some((line) => line.trim() === 'RMDir "$INSTDIR"'), "the folder is removed only when empty");
  assert.ok(!deletes.some((line) => /\*/.test(line)), "no wildcard deletes in the install folder");
});

test("install_writes_only_its_own_places", () => {
  const config = JSON.parse(read(CONFIG));
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser", "SHCTX is HKCU only in this mode");
  const all = template().split("\n");
  const built = code(builtLines(template()).join("\n"));
  // The evaluator drops the other install modes' lines (it must find some), and keeps the current user's.
  assert.ok(built.length < code(template()).length, "the per-machine branches are left out");
  assert.ok(code(template()).some((line) => /RequestExecutionLevel\s+admin/.test(line)), "the per-machine line is in the file");
  assert.ok(!built.some((line) => /RequestExecutionLevel\s+admin/.test(line)), "and not in what is built");
  assert.ok(built.some((line) => /RequestExecutionLevel\s+user/.test(line)));
  const writes = [...built, ...code(hooks())].filter((line) => /^\s*(WriteReg\w*|DeleteReg\w*|WriteUninstaller|CreateShortcut|CreateDirectory|File|SetOutPath)\b/.test(line));
  assert.ok(writes.length >= 15, `found ${writes.length} writing lines`);
  // No write names the machine's registry; the current user's, `SHCTX` or `HKCU`, only.
  const toMachine = writes.filter((line) => /\bHKLM\b|\bHKCR\b|\bHKU\b|\bHKCC\b|\bHKEY_LOCAL_MACHINE\b/.test(line));
  assert.deepEqual(toMachine, []);
  assert.ok(all.length > 0);
  // The check finds a machine-wide write where one is put.
  const wrong = builtLines(template().replace("Section Install\n", 'Section Install\n  WriteRegStr HKLM "Software\\x" "" "x"\n')).join("\n");
  assert.equal(code(wrong).filter((line) => /WriteRegStr HKLM/.test(line)).length, 1);
});

test("uninstall_removes_open_copies_and_nothing_else", () => {
  const text = hooks();
  const clean = between(text, /^Function un\.PetalockCleanOpen$/m, /^FunctionEnd$/m, "un.PetalockCleanOpen");
  const lines = code(clean).join("\n");
  assert.match(lines, /\$LOCALAPPDATA\\Petalock\\open/, "it cleans open\\ in the state folder");
  assert.match(lines, /un\.PetalockRemoveTree/);
  // Only `open\`: no other name of the state folder is ever a delete target.
  for (const other of ["vaults.json", "settings.json", "restore-journal.json", "pending-outputs.json", "vault-state.json"]) {
    assert.ok(!code(text).join("\n").includes(other), `${other} is never named by the clean-up`);
  }
  assert.ok(!/UpdateMode/.test(lines), "open\\ is cleaned on every uninstall, /UPDATE included");
  // The Run value and the program come out in the template's own section, by exact name.
  const section = between(template(), /^Section Uninstall$/m, /^SectionEnd$/m, "Section Uninstall");
  assert.match(section, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCTNAME\}"/);
  assert.match(section, /DeleteRegKey HKCU "\$\{UNINSTKEY\}"/);
  const startup = read("crates/petalock-desktop/src/startup.rs");
  assert.match(startup, /pub const RUN_VALUE: &str = "Petalock";/);
});

test("the_app_data_box_removes_exactly_the_identifier_folders", () => {
  const section = between(template(), /^Section Uninstall$/m, /^SectionEnd$/m, "Section Uninstall");
  const config = JSON.parse(read(CONFIG));
  assert.equal(config.identifier, "io.github.sumguywhowantstobuild.petalock");
  const block = between(section, /\$\{If\} \$DeleteAppDataCheckboxState = 1/, /\$\{EndIf\}/, "the app data block");
  assert.match(block, /\$\{AndIf\} \$UpdateMode <> 1/);
  const removals = code(block).filter((line) => line.includes("PetalockRemoveTree") || /RMDir/i.test(line) || /^\s*Push "/.test(line));
  assert.deepEqual(
    removals.map((line) => line.trim()),
    ['Push "$APPDATA\\${BUNDLEID}"', "Call un.PetalockRemoveTree", 'Push "$LOCALAPPDATA\\${BUNDLEID}"', "Call un.PetalockRemoveTree"],
  );
  assert.ok(!/RMDir\s+\/r/i.test(block));
  // The box's text and state come from the template, as the plan says.
  assert.match(template(), /DeleteAppDataCheckboxState/);
});

test("uninstall_never_follows_a_junction", () => {
  const text = hooks();
  const remove = between(text, /^Function un\.PetalockRemoveTree$/m, /^FunctionEnd$/m, "un.PetalockRemoveTree");
  const lines = code(remove).join("\n");
  assert.match(lines, /un\.PetalockAttr/);
  // A link is tested before it is listed; a link is removed itself (never listed); only a plain folder is listed.
  const test400 = lines.indexOf("0x400");
  const findFirst = lines.indexOf("FindFirst");
  assert.ok(test400 >= 0 && findFirst >= 0 && test400 < findFirst, "the link test comes before the listing");
  assert.match(lines, /RemoveDirectoryW/);
  assert.match(lines, /DeleteFileW/);
  assert.match(lines, /Call un\.PetalockRemoveTree/, "it descends by calling itself on each child, where each child is tested again");
  // The state folder itself is tested before `open\` is touched through it.
  const clean = between(text, /^Function un\.PetalockCleanOpen$/m, /^FunctionEnd$/m, "un.PetalockCleanOpen");
  const cleanLines = code(clean).join("\n");
  assert.ok(cleanLines.indexOf("0x400") >= 0 && cleanLines.indexOf("0x400") < cleanLines.indexOf("Call un.PetalockRemoveTree"));
});

test("a_held_or_read_only_copy_is_reported_not_left_silently", () => {
  const text = hooks();
  const remove = between(text, /^Function un\.PetalockRemoveTree$/m, /^FunctionEnd$/m, "un.PetalockRemoveTree");
  assert.match(code(remove).join("\n"), /SetFileAttributesW[^\n]*0x80|SetFileAttributes[^\n]*NORMAL/, "a read-only copy is made removable");
  const clean = between(text, /^Function un\.PetalockCleanOpen$/m, /^FunctionEnd$/m, "un.PetalockCleanOpen");
  const lines = code(clean).join("\n");
  assert.match(lines, /MB_RETRYCANCEL/);
  assert.match(lines, /\$\{If\} \$\{Silent\}|IfSilent/);
  assert.match(lines, /Abort/);
  assert.match(lines, /still in use/);
  // Nothing in the message or the log names a file or a folder.
  const shown = code(clean).filter((line) => /MessageBox|DetailPrint|FileWrite|PETALOCK_CONSOLE/.test(line));
  assert.ok(shown.length >= 2, `found ${shown.length} lines that show something`);
  // Every line of the files that shows something: no variable that holds a path or a name in it.
  const every = code(read(HOOKS)).concat(code(template())).filter((line) => /MessageBox|DetailPrint|FileWrite|PETALOCK_CONSOLE/.test(line));
  assert.ok(every.length >= 8, `found ${every.length} lines that show something`);
  for (const line of every) {
    // Only the quoted text is shown; a handle or a label outside the quotes is not.
    for (const [, quoted] of line.replace(/\$\\"/g, "").matchAll(/"([^"]*)"/g)) {
      const text = quoted.replace(/\$\\[rn]/g, "").replace(/\$\(\w+\)/g, "").replace(/\$\{\w+\}/g, "");
      assert.ok(!/\$\w/.test(text), `shows a variable: ${line.trim()}`);
    }
  }
});

test("running_petalock_is_never_ended_and_silent_refuses_first", () => {
  const both = code(template()).concat(code(hooks())).join("\n");
  // Tauri's own check offers to kill the program, and kills it in silent and passive mode: it is not used.
  for (const word of ["CheckIfAppIsRunning", "RmShutdown", "RmForceShutdown", "RmForceShutdown", "taskkill", "KillProcess", "TerminateProcess"]) {
    assert.ok(!both.includes(word), `${word} must not appear`);
  }
  const text = hooks();
  const running = between(text, /^Function \$\{UN\}PetalockEnsureNotRunning$|^Function PetalockEnsureNotRunning$/m, /^FunctionEnd$/m, "the running check");
  const lines = code(running).join("\n");
  assert.match(lines, /MB_RETRYCANCEL/);
  assert.match(lines, /Quit/);
  assert.match(lines, /IfSilent|\$\{Silent\}/);
  assert.match(lines, /PassiveMode/, "a passive run asks nothing either");
  assert.match(lines, /Abort/);
  assert.deepEqual(placementProblems(template()), []);
});

test("uninstall_says_where_vaults_stay", () => {
  const text = template() + "\n" + hooks();
  const sentence = "Your vaults stay where they are. Petalock keeps them in the folders you chose, by default Petalock Vaults in your user folder.";
  assert.ok(text.includes(sentence), "the finish page's words");
  const idx = text.indexOf("MUI_UNPAGE_FINISH");
  assert.ok(idx > 0, "an uninstaller finish page exists");
  assert.ok(text.lastIndexOf("MUI_FINISHPAGE_TEXT", idx) > text.lastIndexOf("MUI_UNPAGE_INSTFILES", idx), "the words are set for the uninstaller's finish page");
  assert.ok(text.indexOf(sentence) < idx);
  assert.match(text, /un\.SkipIfPassive/);
});

test("the bundle is the NSIS installer for the current user, built from this folder's template and hooks", () => {
  const config = JSON.parse(read(CONFIG));
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.equal(config.bundle.useLocalToolsDir, true);
  const windows = config.bundle.windows;
  assert.deepEqual(windows.webviewInstallMode, { type: "embedBootstrapper", silent: true });
  assert.equal(windows.nsis.installMode, "currentUser");
  assert.equal(windows.nsis.template, "windows/installer.nsi");
  assert.equal(windows.nsis.installerHooks, "windows/hooks.nsh");
  for (const key of ["template", "installerHooks"]) {
    assert.ok(existsSync(join(ROOT, "crates/petalock-desktop", windows.nsis[key])), `${key} exists`);
  }
  assert.equal(config.mainBinaryName, "petalock");
  assert.equal(config.bundle.publisher, "Petalock");
  assert.deepEqual(windows.nsis.languages, ["English"]);
});

test("the template says what it changed, and keeps the rest of Tauri's", () => {
  const text = template();
  assert.match(text, /Tauri's NSIS template/);
  assert.match(text, /tauri-bundler 2\.10\.5/);
  // Anchors of the upstream file that the changes sit between: if the pinned tool changes, a person compares again.
  for (const anchor of ["{{compression}}", "{{installer_hooks}}", "{{#each resources}}", "nsis_tauri_utils::SemverCompare", "!insertmacro MUI_PAGE_INSTFILES", "Section Uninstall"]) {
    assert.ok(text.includes(anchor), `${anchor} is kept`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The review fix round (Codex, 2026-11-25): one test or more for each finding fixed, each failing on the files before it.
// ---------------------------------------------------------------------------------------------------------------------

/** What the guard in hooks.nsh must do, as problems found in `text` (empty when all hold). Mutants of it must be refused. */
export function guardProblems(text) {
  const problems = [];
  const lines = code(text).join("\n");
  const fn = (name) => {
    const m = lines.match(new RegExp(`Function \\$\\{UN\\}${name}\\n([\\s\\S]*?)\\nFunctionEnd`));
    return m ? m[1] : "";
  };
  const guard = fn("PetalockGuardFolder");
  const pre = fn("PetalockPreflight");
  const running = fn("PetalockIsRunning");
  if (!/!if "\$\{UN\}" == "un\."\n\s*\$\{If\} \$PetalockMode != "maint"\n\s*StrCpy \$PetalockWhy "unregistered"/.test(pre)) problems.push("an uninstaller outside the recorded installation is not refused");
  if (!/Call \$\{UN\}PetalockSetMode/.test(pre)) problems.push("the mode is not set from the recorded installation");
  if (!/\$\{If\} \$5 <> 3/.test(guard) || !/StrCpy \$PetalockWhy "others"/.test(guard)) problems.push("a fresh folder is not proved empty");
  if (!/FindFirst \$3 \$4 "\$1\\\*\.\*"\n\s*StrCpy \$5 0\n\s*\$\{If\} \$4 == ""/.test(guard)) problems.push("a listing that gives nothing is not an error");
  for (const name of ["${MAINBINARYNAME}.exe", "uninstall.exe", "THIRD-PARTY-NOTICES.txt"]) {
    if (!guard.includes(`PETALOCK_PLAIN_FILE "\${UN}" "${name}"`)) problems.push(`${name} is not checked for links before it is overwritten`);
  }
  if (!/\$\{If\} \$7 == "\."\n\s*\$\{OrIf\} \$7 == " "/.test(guard)) problems.push("a name ending in a period or a space is accepted");
  if (!/\$6 == "\\\.\\"/.test(guard)) problems.push("a . segment is accepted");
  if (!/OpenMutexW\(i 0x00100000, i 0, w "Local\\\$\{BUNDLEID\}\.instance"\)/.test(running)) problems.push("a running copy is not found by the instance lock");
  if (!/\$\{If\} \$1 <> 2\n\s*StrCpy \$PetalockR 1/.test(running)) problems.push("an indeterminate lock answer is not a refusal");
  if (/IfFileExists/.test(lines)) problems.push("IfFileExists reads a failure as an absence");
  const attrOutside = lines.replace(/Function \$\{UN\}PetalockAttr\n[\s\S]*?\nFunctionEnd/, "");
  if (/GetFileAttributesW/.test(attrOutside)) problems.push("GetFileAttributesW is used outside PetalockAttr");
  return problems;
}

test("the guard as built holds every rule, and refuses the mutants that drop one", () => {
  const text = hooks();
  assert.deepEqual(guardProblems(text), []);
  const mutants = [
    ['StrCpy $PetalockWhy "unregistered"', 'StrCpy $PetalockWhy ""'],
    ["${If} $5 <> 3", "${If} $5 <> 99"],
    ['${If} $7 == "."\n      ${OrIf} $7 == " "', '${If} $7 == "~"\n      ${OrIf} $7 == "~"'],
    ["Local\\${BUNDLEID}.instance", "Local\\${BUNDLEID}.other"],
    ["${If} $1 <> 2\n    StrCpy $PetalockR 1", "${If} $1 <> 2\n    StrCpy $PetalockR 0"],
    ['!insertmacro PETALOCK_PLAIN_FILE "${UN}" "uninstall.exe"', ""],
    // Fix round, finding 1: the notices file setup now writes is guarded like the two files before it.
    ['!insertmacro PETALOCK_PLAIN_FILE "${UN}" "THIRD-PARTY-NOTICES.txt"', ""],
  ];
  for (const [from, to] of mutants) {
    assert.ok(text.includes(from), `the mutant's anchor is in the file: ${from}`);
    assert.ok(guardProblems(text.replace(from, to)).length >= 1, `dropping this must be refused: ${from}`);
  }
  assert.ok(guardProblems(text + "\nIfFileExists \"x\" 0 0").length >= 1);
  assert.ok(guardProblems(text.replace("Function ${UN}PetalockAttr", "Function ${UN}PetalockAttrX") + '\nSystem::Call "kernel32::GetFileAttributesW(w r0)"').length >= 1);
});

// Finding 1: no registry value controls which file setup deletes.
test("a_registry_value_never_names_a_file_setup_deletes", () => {
  const both = code(template()).concat(code(hooks()));
  assert.ok(!both.some((line) => /OldMainBinaryName|"MainBinaryName"/.test(line)), "the old-binary migration and its value are gone");
  // Every Delete names a fixed file: the program, the uninstaller, the shortcuts' fixed names, the WebView2 bootstrapper.
  const deletes = both.filter((line) => /^\s*Delete\s/.test(line)).map((line) => line.trim());
  assert.ok(deletes.length >= 8, `found ${deletes.length} deletes`);
  const allowed = [
    /^Delete "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"$/,
    /^Delete "\$INSTDIR\\uninstall\.exe"$/,
    /^Delete "\$4\\uninstall\.exe"$/,
    /^Delete "\$SMPROGRAMS\\(\$AppStartMenuFolder\\)?\$\{PRODUCTNAME\}\.lnk"$/,
    /^Delete "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk"$/,
    /^Delete "\$INSTDIR\\\\\{\{this(\.\[1\])?\}\}"$/, // the bundler's resource lists (empty for Petalock)
  ];
  const unknown = deletes.filter((line) => !allowed.some((re) => re.test(line)));
  assert.deepEqual(unknown, []);
  // The check finds a delete that names a registry value.
  const bad = ['Delete "$INSTDIR\\$OldMainBinaryName"', 'Delete "$INSTDIR\\$R0"'];
  for (const line of bad) assert.ok(!allowed.some((re) => re.test(line)), `${line} must not be allowed`);
});

// Finding 2: a fresh install needs an empty folder; maintenance is bound to the recorded installation.
test("fresh_install_needs_an_empty_folder_and_maintenance_binds_to_the_recorded_install", () => {
  const text = hooks();
  assert.deepEqual(guardProblems(text), []);
  // Two file names are not proof of an installation: no branch accepts a folder for holding both.
  assert.ok(!/MAINBINARYNAME\}\.exe" guard_/.test(code(text).join("\n")));
  const guard = code(text).join("\n");
  assert.match(guard, /PETALOCK_PLAIN_FILE "\$\{UN\}" "uninstall\.exe"/);
  // Maintenance works with the program missing: its absence is not a refusal (the plain-file check passes on absent).
  const macro = guard.match(/!macro PETALOCK_PLAIN_FILE UN NAME\n([\s\S]*?)\n!macroend/)[1];
  assert.match(macro, /\$\{If\} \$PetalockR != "absent"/);
  // The mode comes from the uninstall key's InstallLocation, and the old uninstaller is the recorded one.
  assert.match(guard, /ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "InstallLocation"/);
  assert.match(guard, /GetFileInformationByHandle/);
  assert.match(guard, /nNumberOfLinks|byte 40|\$1 \+ 40/);
});

// Finding 4: a failed read is not an absence.
test("a_failed_read_is_not_an_absence", () => {
  const text = hooks();
  const attr = between(text, /^Function \$\{UN\}PetalockAttr$/m, /^FunctionEnd$/m, "PetalockAttr");
  assert.match(code(attr).join("\n"), /\$\{If\} \$1 = 2\n\s*\$\{OrIf\} \$1 = 3\n\s*StrCpy \$PetalockR "absent"/);
  assert.match(code(attr).join("\n"), /StrCpy \$PetalockR "error"/);
  const remove = code(between(text, /^Function un\.PetalockRemoveTree$/m, /^FunctionEnd$/m, "RemoveTree")).join("\n");
  assert.match(remove, /\$\{If\} \$1 == "error"\n\s*IntOp \$PetalockStuck \$PetalockStuck \+ 1/);
  assert.match(remove, /FindFirst \$2 \$3 "\$0\\\*\.\*"\n\s*\$\{If\} \$3 == ""\n\s*FindClose \$2\n\s*IntOp \$PetalockStuck/);
  const clean = code(between(text, /^Function un\.PetalockCleanOpen$/m, /^FunctionEnd$/m, "CleanOpen")).join("\n");
  assert.match(clean, /\$\{If\} \$PetalockR == "error"\n\s*StrCpy \$PetalockStuck 1/);
  // open\ must be confirmed gone afterwards, whatever the removal said.
  assert.match(clean, /Call un\.PetalockRemoveTree\n\s*StrCpy \$PetalockA "\$LOCALAPPDATA\\Petalock\\open"\n\s*Call un\.PetalockAttr\n\s*\$\{If\} \$PetalockR != "absent"/);
  assert.ok(!/GetFileAttributesW/.test(clean) && !/IfFileExists/.test(code(text).join("\n")));
  // The script has the fixtures that make a read fail with "access denied".
  const script = read(SMOKE);
  assert.match(script, /Set-Deny \$denied 'RD'/);
  assert.match(script, /Set-Deny \$nolist 'RD'/);
});

// Finding 5: names Windows would normalise are refused before anything is compared.
test("noncanonical_names_are_refused_before_they_are_compared", () => {
  const guard = code(between(hooks(), /^Function \$\{UN\}PetalockGuardFolder$/m, /^FunctionEnd$/m, "Guard")).join("\n");
  const shape = guard.slice(0, guard.indexOf("PetalockResolve"));
  assert.match(shape, /\$\{If\} \$7 == "\."\n\s*\$\{OrIf\} \$7 == " "\n\s*\$\{OrIf\} \$7 == "\\"/);
  assert.match(shape, /StrCpy \$6 \$0 1 -1\n\s*\$\{If\} \$6 == "\."\n\s*\$\{OrIf\} \$6 == " "/);
  assert.match(shape, /\$6 == "\\\.\."\n\s*\$\{OrIf\} \$6 == "\\\.\\"/);
  // The script tries those spellings while the protected folders are absent, and checks that refusing made nothing.
  const script = read(SMOKE);
  for (const spelling of ['"$State."', '"$State "', '"$IdLocal."', '"$IdRoam."']) assert.ok(script.includes(spelling), spelling);
  assert.match(script, /the install into \$label made a folder/);
});

// Finding 6: a running copy is found by the app's instance lock, whatever folder is chosen.
test("a_running_copy_is_found_by_the_instance_lock_whatever_the_folder", () => {
  const running = code(between(hooks(), /^Function \$\{UN\}PetalockIsRunning$/m, /^FunctionEnd$/m, "IsRunning")).join("\n");
  const rust = read("crates/petalock-desktop/src/os/win.rs");
  const rustName = rust.match(/const INSTANCE_NAME: &str = "([^"]+)";/)[1].replaceAll("\\\\", "\\");
  const identifier = JSON.parse(read(CONFIG)).identifier;
  assert.equal(rustName, `Local\\${identifier}.instance`);
  assert.ok(running.includes('w "Local\\${BUNDLEID}.instance"'), "the lock's name is the app's, built from the identifier");
  // Order: the lock first (it does not depend on the folder), the file probe after.
  assert.ok(running.indexOf("OpenMutexW") < running.indexOf("CreateFileW"));
  // Anything but "not found" is running: the answer 2 is the only way on.
  assert.match(running, /\$\{If\} \$1 <> 2\n\s*StrCpy \$PetalockR 1\n\s*Goto running_done/);
  // The script runs a copy at one folder and installs to another.
  assert.match(read(SMOKE), /into another, empty folder with Petalock running/);
});

// Finding 7: open\ is cleaned on every uninstall.
test("uninstall_cleans_open_copies_with_update_too", () => {
  const clean = code(between(hooks(), /^Function un\.PetalockCleanOpen$/m, /^FunctionEnd$/m, "CleanOpen")).join("\n");
  assert.ok(!/UpdateMode/.test(clean));
  assert.ok(!/Return/.test(clean.split("clean_again:")[0]), "no early return before the clean-up");
  assert.match(read(SMOKE), /'\/S', '\/UPDATE', "_\?=\$DefaultDir"/);
});

// Finding 9: nothing read from the registry is executed.
test("the_old_uninstaller_command_is_built_from_the_verified_folder", () => {
  const leave = code(between(template(), /^Section PetalockRemoveOld$/m, /^SectionEnd$/m, "Section PetalockRemoveOld")).join("\n");
  assert.ok(!/ReadRegStr \$R1/.test(leave), "the command is not read from the registry");
  assert.ok(!/ReadRegStr \$4/.test(leave), "the folder is not read here either");
  assert.ok(leave.indexOf("Call PetalockBeforeOldUninstaller") < leave.indexOf("ExecWait '$R1' $0"));
  const before = code(between(hooks(), /^Function PetalockBeforeOldUninstaller$/m, /^FunctionEnd$/m, "BeforeOld")).join("\n");
  assert.match(before, /StrCpy \$R1 '"\$4\\uninstall\.exe"'/);
  assert.match(before, /PetalockRecordedLocation/);
  // The only read of UninstallString is the decision's "is there an installation" test (PetalockDecide, no page controls).
  const reads = code(template()).concat(code(hooks())).filter((line) => /ReadRegStr[^\n]*"UninstallString"/.test(line));
  assert.equal(reads.length, 1, reads.join("; "));
  assert.match(read(SMOKE), /A command planted in UninstallString|the command planted in UninstallString was run/);
});

// Finding 10: no machine-wide uninstall is started.
test("no_machine_wide_uninstall_is_run", () => {
  const all = code(template()).concat(code(hooks())).join("\n");
  for (const word of ["FindWixInstall", "WixMode", "msiexec", "StrLoc"]) assert.ok(!all.includes(word), `${word} is gone`);
  assert.ok(!/HKLM\s+"[^"]*Uninstall/.test(all), "no HKLM Uninstall key is read");
  // Every program the template runs: the old uninstaller (built from the recorded folder), WebView2's installer (quoted).
  const exec = all.split("\n").filter((line) => /^\s*ExecWait\b/.test(line)).map((line) => line.trim());
  assert.ok(exec.length >= 3, `found ${exec.length} ExecWait lines`);
  for (const line of exec) assert.ok(/^ExecWait '\$R1' \$0$|^ExecWait '"\$6" \$\{WEBVIEW2INSTALLERARGS\} \/install' \$1$|^ExecWait `"\$R1" \/install appguid=/.test(line), `an unexpected ExecWait: ${line}`);
  // Plan 5, Task 9e: both places that run the old uninstaller (the update's remove-first section, and the same version's
  // "Uninstall Petalock instead" link) run the command PetalockBeforeOldUninstaller built, and nothing else.
  assert.equal(exec.filter((line) => line === "ExecWait '$R1' $0").length, 2);
});

// Finding 11: no second registry key.
test("setup_writes_reads_and_deletes_no_second_registry_key", () => {
  const all = code(template()).concat(code(hooks())).join("\n");
  for (const word of ["MANUPRODUCTKEY", "MANUKEY", "MUI_LANGDLL_REGISTRY", "MUI_UNGETLANGUAGE", "Installer Language"]) assert.ok(!all.includes(word), `${word} is gone`);
  const regs = all.split("\n").filter((line) => /^\s*(WriteReg\w*|DeleteReg\w*)\b/.test(line));
  assert.ok(regs.length >= 10, `found ${regs.length}`);
  for (const line of regs) assert.ok(/UNINSTKEY|Software\\Microsoft\\Windows\\CurrentVersion\\Run|Software\\Classes/.test(line), `writes or deletes another key: ${line.trim()}`);
  const restore = code(between(template(), /^Function RestorePreviousInstallLocation$/m, /^FunctionEnd$/m, "Restore")).join("\n");
  assert.match(restore, /Call PetalockRecordedLocation/);
  assert.match(code(hooks()).join("\n"), /ReadRegStr \$0 SHCTX "\$\{UNINSTKEY\}" "InstallLocation"/);
  // The smoke script's allow-list no longer lets HKCU\Software\Petalock through, and plants an unrelated value to survive.
  const script = read(SMOKE);
  const allowed = script.match(/\$allowed = @\(([\s\S]*?)\)\n/)[1];
  assert.ok(!/Software\\Petalock/.test(allowed), "HKCU\\Software\\Petalock is not allowed");
  assert.ok(/Uninstall\\Petalock\|\*/.test(allowed), "the uninstall key still is");
  assert.match(script, /MU-unrelated/);
});

// Finding 12: the WebView2 installer's path is quoted.
test("the_webview2_installer_path_is_quoted", () => {
  const lines = code(template());
  const runs = lines.filter((line) => /ExecWait[^\n]*\$6/.test(line));
  assert.ok(runs.length >= 1, "the line that runs the bootstrapper");
  for (const line of runs) assert.match(line.trim(), /^ExecWait '"\$6" /);
});

// Finding 17: the running-app test cannot pass an aborted Retry or a state change after Cancel.
test("the_running_check_tests_prove_retry_does_the_work_and_cancel_changes_nothing", () => {
  const script = read(SMOKE);
  const body = script.slice(script.indexOf('$Checks["running_petalock_is_never_ended_and_silent_refuses_first"]'), script.indexOf('$Checks["uninstall_says_where_vaults_stay"]'));
  // Both installer inputs go through Retry, with the installer's exit read and a value it writes seen again.
  assert.match(body, /foreach \(\$kind in @\('install', 'upgrade'\)\) \{\n\s*\$exe = if \(\$kind -eq 'install'\) \{ \$Installer \} else \{ \$Upgrade \}\n\s*Start-Sleep/);
  assert.match(body, /Set-ItemProperty -LiteralPath \$UninstallKey -Name 'NoModify' -Value 0/);
  assert.match(body, /\$exit = Get-ExitCode \$p\n\s*if \(\$exit -ne 0\)/);
  assert.match(body, /\[int\]\(Get-UninstallValue 'NoModify'\) -ne 1/);
  // The state is compared after every Cancel (install, upgrade, uninstall).
  const cancels = body.match(/Assert-Unchanged \$stateBefore \(Get-Listing \$State -Hash\) ["']the state after Cancel/g) ?? [];
  assert.equal(cancels.length, 2, "once in the install/upgrade loop and once for the uninstall");
  assert.match(body, /the state after Cancel in the uninstall/);
  assert.match(body, /the state after Cancel in the \$kind/);
});

// Finding 19: the artifact is the file that was hashed and smoke-tested.
test("the_artifact_is_the_exact_file_that_was_tested", () => {
  const text = read(BUILD);
  const step = text.slice(text.indexOf("name: Keep the installer"), text.indexOf("name: Keep the smoke log"));
  assert.match(step, /path: \$\{\{ steps\.digest\.outputs\.path \}\}/);
  assert.ok(!/\*-setup\.exe|\*\.exe/.test(step), "no pattern selects the artifact again");
});

// Finding 20: only a full commit hash is built, and the checkout is checked.
test("only_a_full_commit_hash_is_built_and_the_checkout_is_checked", () => {
  const text = read(BUILD);
  const check = text.indexOf("name: Check the source is a full commit hash");
  const checkout = text.indexOf("uses: actions/checkout@");
  const head = text.indexOf("name: Check the checkout is the source commit");
  assert.ok(check > 0 && check < checkout && checkout < head, "the hash is checked before the checkout, the checkout after it");
  assert.match(text.slice(check, checkout), /-cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(text.slice(head, head + 400), /git rev-parse HEAD/);
  assert.match(text.slice(head, head + 500), /-ne \$env:SOURCE/);
  // The input reaches the shell by an environment variable, never as script text: three uses, two `env:` and the `ref:`.
  const used = text.slice(check, head + 400).match(/^.*\$\{\{ inputs\.source \}\}.*$/gm) ?? [];
  assert.equal(used.length, 3);
  for (const line of used) assert.ok(/^\s+(SOURCE|ref): \$\{\{ inputs\.source \}\}$/.test(line), `unexpected use: ${line}`);
});

/** The workflow's `uses:` lines. */
const uses = (text) => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:\s*#.*)?$/gm)].map((m) => m[1]);

test("build_installer_is_one_read_only_reusable_workflow_with_pinned_inputs", () => {
  const text = read(BUILD);
  assert.match(text, /^on:\n {2}workflow_call:/m);
  assert.match(text, /inputs:\n {6}source:\n {8}description:[^\n]*\n {8}required: true\n {8}type: string/);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/(contents|id-token|attestations|packages|actions): write/.test(text), "read-only");
  assert.ok(!/secrets\./.test(text), "no secret");
  assert.match(text, /runs-on: windows-2025-vs2026/);
  const actions = uses(text);
  assert.ok(actions.length >= 5, `found ${actions.length} actions`);
  for (const action of actions) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned by full commit`);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /ref: \$\{\{ inputs\.source \}\}/);
  // An input never reaches a shell as text: it goes by an environment variable.
  for (const run of text.split(/^\s*run: /m).slice(1)) assert.ok(!run.split("\n")[0].includes("inputs."), "an input inside a run line");
  const runBlocks = [...text.matchAll(/run: \|\n((?: {10,}.*\n|\n)+)/g)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 3);
  for (const block of runBlocks) assert.ok(!block.includes("${{"), "no expression inside a script");
});

/**
 * Session finding S1: what is wrong with how the provisioning step treats a restored `target\.tauri`. A build-cache hit brings
 * the folder back, and the unpacked NSIS folder is then renamed onto it and fails; worse, the bundler would find inputs nobody
 * checked this run. The step must remove the folder before it downloads anything. Problems found, as sentences.
 */
export function provisionClearProblems(workflow) {
  const problems = [];
  const start = workflow.indexOf("Provision the bundler's packaging inputs");
  const end = workflow.indexOf("Provision cargo-about");
  if (start < 0 || end < start) return ["the provisioning step was not found"];
  const step = workflow.slice(start, end);
  const clear = step.search(/if \(Test-Path \$tools\) \{ Remove-Item -LiteralPath \$tools -Recurse -Force \}/);
  const first = step.indexOf("Get-Verified $env:NSIS_URL");
  const make = step.indexOf("New-Item -ItemType Directory -Force $tools");
  if (clear < 0) problems.push("the step does not remove a restored target\\.tauri");
  else if (!(clear < make && clear < first)) problems.push("the step removes target\\.tauri after it has begun to provision it");
  if (!/\$tools = Join-Path \$env:GITHUB_WORKSPACE 'target\\\.tauri'/.test(step)) problems.push("the folder removed is not target\\.tauri");
  return problems;
}

test("build_installer_clears_a_restored_bundler_folder_before_it_provisions_the_inputs", () => {
  const text = read(BUILD);
  assert.deepEqual(provisionClearProblems(text), []);
  // The check fires on the file as it was (no clear), and when the clear comes too late.
  const clear = "          if (Test-Path $tools) { Remove-Item -LiteralPath $tools -Recurse -Force }\n";
  assert.ok(text.includes(clear), "the clear line is where the test expects");
  assert.match(provisionClearProblems(text.replace(clear, "")).join("\n"), /does not remove a restored/);
  const late = text.replace(clear, "").replace("          $zip = Join-Path $inputs 'nsis-3.13.zip'\n", `${clear}          $zip = Join-Path $inputs 'nsis-3.13.zip'\n`);
  assert.match(provisionClearProblems(late).join("\n"), /after it has begun/);
  assert.match(provisionClearProblems("nothing").join("\n"), /not found/);
});

/**
 * Task 9g: what is wrong with how the build checks the WebView2 bootstrapper. Microsoft repoints fwlink 2124703 at each new
 * build of the file, so a pinned SHA-256 breaks every build without warning (run 46090576875). The check is Microsoft's
 * Authenticode signature: valid, signed by Microsoft Corporation, on a chain that ends at a Microsoft root; the digest of the
 * file actually checked is logged and re-checked after the build. Problems found, as sentences.
 */
export function webviewSignatureProblems(workflow) {
  const problems = [];
  const start = workflow.indexOf("Provision the bundler's packaging inputs");
  const end = workflow.indexOf("Provision cargo-about");
  if (start < 0 || end < start) return ["the provisioning step was not found"];
  const step = workflow.slice(start, end);
  // Any WEBVIEW2_SHA256 key in YAML (quoted, upper case, anything) is a pin; the GITHUB_ENV hand-off is not YAML.
  if (/^\s*WEBVIEW2_SHA256\s*:/m.test(workflow)) problems.push("the bootstrapper still has a pinned SHA-256, which breaks on Microsoft's next build");
  if (/Get-Verified \$env:WEBVIEW2_URL/.test(step)) problems.push("the bootstrapper is still checked against a fixed digest");
  const sig = step.indexOf("Get-AuthenticodeSignature -LiteralPath $wv");
  if (sig < 0) problems.push("the bootstrapper's signature is not read");
  // Each refusal on its own: its condition is there and its own block throws.
  const guards = [
    ["$sig.Status -ne 'Valid'", "a signature that is not Valid"],
    ["$sig.SignerCertificate.Subject -cnotmatch '^CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US$'", "a signer other than Microsoft Corporation, exactly,"],
    ["-not $chain.Build($sig.SignerCertificate)", "a signer whose chain does not build"],
    ["$root.Subject -cnotmatch '^CN=Microsoft Root Certificate Authority 20(10|11), O=Microsoft Corporation, L=Redmond, S=Washington, C=US$'", "a chain that does not end at a Microsoft root by name"],
    ["$microsoftRoots -cnotcontains $rootSha256", "a root whose fingerprint is not a Microsoft root's"],
  ];
  let lastGuardEnd = -1;
  for (const [condition, what] of guards) {
    const at = step.indexOf(condition);
    if (at < 0) { problems.push(`${what} is not refused (its check is missing)`); continue; }
    const open = step.indexOf("{", at + condition.length);
    let depth = 0, close = -1;
    for (let i = open; open >= 0 && i < step.length; i++) {
      if (step[i] === "{") depth++;
      else if (step[i] === "}" && --depth === 0) { close = i; break; }
    }
    if (open < 0 || close < 0 || !/\bthrow\b/.test(step.slice(open, close))) problems.push(`${what} is not refused (its block does not stop the build)`);
    lastGuardEnd = Math.max(lastGuardEnd, close);
  }
  for (const fp of ["847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61", "DF545BF919A2439C36983B54CDFC903DFA4F37D3996D8D84B4C31EEC6F3C163E"]) {
    if (!step.includes(`'${fp}'`)) problems.push(`the Microsoft root fingerprint ${fp.slice(0, 8)}... is not in the accepted list`);
  }
  if (!/\$rootSha256 = \[System\.Convert\]::ToHexString\(\[System\.Security\.Cryptography\.SHA256\]::HashData\(\$root\.RawData\)\)/.test(step)) problems.push("the root's fingerprint is not taken from the root itself");
  const ignoreTime = step.indexOf("$chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid");
  const build = step.indexOf("$chain.Build(");
  if (ignoreTime < 0 || build < 0 || ignoreTime > build) problems.push("an expired but timestamped signer would stop the build (time validity is not set aside before the chain is built)");
  if (/AllowUnknownCertificateAuthority|AllFlags|NoFlag\b/.test(step)) problems.push("the chain policy sets aside more than time validity");
  if (!/"WEBVIEW2_SHA256=\$wvHash" >> \$env:GITHUB_ENV/.test(step)) problems.push("the checked file's digest is not handed to the re-check after the build");
  const hash = step.indexOf("$wvHash = (Get-FileHash $wv -Algorithm SHA256).Hash");
  if (hash < 0) problems.push("the checked file's digest is not taken");
  else if (sig < 0 || hash < lastGuardEnd) problems.push("the digest is taken before every certificate check has passed");
  if (!/^\s*"WebView2 bootstrapper: SHA-256 \$wvHash, signed by .*root \$\(\$root\.Subject\) \(\$rootSha256\)/m.test(step)) problems.push("the checked file's digest, signer and root are not written to the log");
  // After the build: the hand-off value compared, and a mismatch stops the run.
  const cargo = workflow.indexOf("cargo tauri build");
  const recheck = workflow.indexOf("(Join-Path $tools 'MicrosoftEdgeWebview2Setup.exe') = $env:WEBVIEW2_SHA256");
  const compare = workflow.indexOf("if ((Get-FileHash $path -Algorithm SHA256).Hash -ne $again[$path]) { throw \"a packaging input changed during the build: $path\" }");
  if (recheck < 0 || recheck < end || cargo < 0 || recheck < cargo) problems.push("the bootstrapper is not re-checked after the build");
  else if (compare < recheck) problems.push("a bootstrapper changed during the build does not stop the run");
  return problems;
}

test("build_installer_checks_the_webview2_bootstrapper_by_microsofts_signature_not_a_stale_digest", () => {
  const text = read(BUILD);
  assert.deepEqual(webviewSignatureProblems(text), []);
  // The check fires on the old pinned form, and on each part taken away.
  const pinned = text.replace("      WEBVIEW2_URL: https://go.microsoft.com/fwlink/p/?LinkId=2124703\n", "      WEBVIEW2_URL: https://go.microsoft.com/fwlink/p/?LinkId=2124703\n      WEBVIEW2_SHA256: " + "a".repeat(64) + "\n");
  assert.match(webviewSignatureProblems(pinned).join("\n"), /pinned SHA-256/);
  const quoted = pinned.replace("WEBVIEW2_SHA256: " + "a".repeat(64), "WEBVIEW2_SHA256: '" + "A".repeat(64) + "'");
  assert.match(webviewSignatureProblems(quoted).join("\n"), /pinned SHA-256/, "a quoted upper-case pin is a pin");
  const problemsOf = (from, to) => {
    assert.ok(text.includes(from), `the mutation's text is in the workflow: ${from}`);
    return webviewSignatureProblems(text.replace(from, to)).join("\n");
  };
  assert.match(problemsOf("$sig.Status -ne 'Valid'", "$false"), /not Valid is not refused/);
  assert.match(problemsOf("-cnotmatch '^CN=Microsoft Corporation,", "-notmatch '^CN=Microsoft Corporation,"), /Microsoft Corporation, exactly, is not refused/);
  assert.match(problemsOf("$root.Subject -cnotmatch", "$root.Subject -cmatch"), /Microsoft root by name is not refused/);
  assert.match(problemsOf("$microsoftRoots -cnotcontains $rootSha256", "$false"), /fingerprint is not a Microsoft root's is not refused/);
  // Each refusal taken away on its own (the comparison left in place) is caught by itself.
  for (const [from, what] of [
    ['{ throw "WebView2 bootstrapper: signature', /not Valid is not refused \(its block/],
    ['throw "WebView2 bootstrapper: signed by', /Microsoft Corporation, exactly, is not refused \(its block/],
    ['{ throw "WebView2 bootstrapper: the signer\'s chain', /chain does not build is not refused \(its block/],
    ['throw "WebView2 bootstrapper: the chain ends at', /Microsoft root by name is not refused \(its block/],
    ['{ throw "WebView2 bootstrapper: the root\'s fingerprint', /fingerprint is not a Microsoft root's is not refused \(its block/],
  ]) {
    const to = from.replace("throw ", "");
    const got = problemsOf(from, to);
    assert.match(got, what, `removing ${from} is caught`);
    assert.equal(got.split("\n").length, 1, `removing ${from} is the only problem: ${got}`);
  }
  assert.match(problemsOf("'847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61'", "'00'"), /847DF6A7\.\.\. is not in the accepted list/);
  assert.match(problemsOf("          $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid\n", ""), /expired but timestamped/);
  assert.match(problemsOf("::IgnoreNotTimeValid", "::AllFlags"), /more than time validity/);
  assert.match(problemsOf('"WEBVIEW2_SHA256=$wvHash" >> $env:GITHUB_ENV', ""), /re-check after the build/);
  // The digest moved up, right after the signature read, is caught; so is its log line taken away.
  const hashLine = "          $wvHash = (Get-FileHash $wv -Algorithm SHA256).Hash\n";
  const sigLine = "          $sig = Get-AuthenticodeSignature -LiteralPath $wv\n";
  assert.ok(text.includes(hashLine) && text.includes(sigLine));
  assert.match(webviewSignatureProblems(text.replace(hashLine, "").replace(sigLine, sigLine + hashLine)).join("\n"), /before every certificate check/);
  assert.match(problemsOf('"WebView2 bootstrapper: SHA-256 $wvHash', '"WebView2 bootstrapper: $wvHash'), /not written to the log/);
  // After the build: the comparison loop taken away, or its refusal, is caught.
  assert.match(problemsOf('{ throw "a packaging input changed during the build: $path" }', '{ "a packaging input changed during the build: $path" }'), /changed during the build does not stop the run/);
  assert.match(webviewSignatureProblems("nothing").join("\n"), /not found/);
});

test("build_installer_pins_the_tool_and_every_packaging_input_and_checks_each_digest_before_use", () => {
  const text = read(BUILD);
  // The CLI: one exact version, installed locked, cached by that version.
  assert.match(text, /cargo install tauri-cli --locked --version 2\.12\.5\b/);
  assert.match(text, /key: tauri-cli-2\.12\.5-/);
  assert.ok(!/tauri-cli[^\n]*[\^~]/.test(text), "no range");
  // The three inputs the bundler downloads (tauri-bundler 2.10.5, windows/nsis/mod.rs:38-44 and windows/util.rs:19). The two
  // versioned ones carry a pinned SHA-256; the WebView2 bootstrapper sits behind a link Microsoft repoints at each new build,
  // so it is checked by Microsoft's signature instead (below).
  const inputs = [
    { name: "NSIS 3.13", url: "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip" },
    { name: "nsis_tauri_utils 0.5.3", url: "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll" },
  ];
  assert.match(text, /WEBVIEW2_URL: https:\/\/go\.microsoft\.com\/fwlink\/p\/\?LinkId=2124703\n/);
  assert.deepEqual(webviewSignatureProblems(text), []);
  const lines = text.split("\n");
  for (const input of inputs) {
    const at = lines.findIndex((line) => line.includes(input.url));
    assert.ok(at >= 0, `${input.name}: the URL`);
    const digest = lines.slice(at, at + 3).join(" ").match(/\b[0-9a-f]{64}\b/);
    assert.ok(digest, `${input.name}: a SHA-256 beside the URL`);
  }
  const provision = text.indexOf("Get-Verified");
  const build = text.indexOf("cargo tauri build");
  assert.ok(provision > 0 && build > provision, "the inputs are in place and checked before the build");
  assert.match(text, /throw "SHA-256 mismatch/);
  assert.match(text, /Verifying NSIS package|Redownloading|Recreating/, "the build log is searched for any download of its own");
  assert.match(text, /--bundles nsis/);
  assert.match(text, /--locked/);
});

test("build_installer_smoke_tests_the_exact_bytes_it_built_and_keeps_the_log_on_failure", () => {
  const text = read(BUILD);
  const digest = text.indexOf("id: digest");
  // The first smoke run, on the tested installer (Task 4's run on the candidates comes after the installer is kept).
  const smoke = text.indexOf("installer-smoke.ps1", text.indexOf("name: Smoke-test the installer"));
  const again = text.indexOf("Check the installer did not change");
  const upload = text.indexOf("name: Keep the installer");
  assert.ok(digest > 0 && smoke > digest, "the digest is taken before the smoke run, and the smoke run uses that file");
  // Started from cmd by the full path of Windows PowerShell 5.1, so it never inherits a pwsh module path.
  const step = text.slice(smoke - 700, smoke + 300);
  assert.match(step, /shell: cmd/);
  assert.match(step, /%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(step, /-Installer "%INSTALLER%"/);
  assert.ok(again > smoke && upload > again, "the file is hashed again after the smoke run, and offered after that");
  assert.match(text, /outputs:\n(?: {4,}.*\n)*? {6}sha256:/);
  assert.match(text, /if: failure\(\)\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(text, /installer-smoke-log/);
  // After the smoke run, the file is hashed again: what was tested is what is offered.
  assert.ok(text.lastIndexOf("Get-FileHash") > smoke, "the installer is hashed again after the smoke run");
});

test("ci_calls_build_installer_on_every_push_alongside_rust", () => {
  const text = read(CI);
  const job = between(text, /^ {2}installer:$/m, /^ {2}[a-z0-9-]+:\n|\s*$/, "the installer job");
  // Side by side with the Rust job: the installer's result comes in about 25 minutes, not after the 47-minute Rust job.
  assert.doesNotMatch(job, /needs:/);
  assert.match(job, /uses: \.\/\.github\/workflows\/build-installer\.yml/);
  assert.match(job, /source: \$\{\{ github\.sha \}\}/);
  for (const key of ["rust:", "ui:", "scan:", "e2e:"]) assert.ok(text.includes(`\n  ${key}\n`), `${key} still there`);
});

// Runner trial 3: a posted BM_CLICK on Finish was dropped. The finished install page's Next press (a BM_CLICK) opens the
// Finish page inside its own handling, Finish is the same button, and a button ignores a BM_CLICK while it is still inside
// one. The wizard's buttons are pressed as NSIS handles them (WM_COMMAND posted to the outer dialog, what Enter sends).
test("wizard_buttons_are_pressed_as_a_posted_wm_command_to_the_outer_dialog", () => {
  const text = read(SMOKE);
  const press = between(text, /public static int Press\(/, /\n  \}/, "SmokeDlg.Press");
  assert.match(press, /PostMessage\(dlg, 0x0111, \(IntPtr\)id, button\)/);
  assert.doesNotMatch(press, /SendMessage/);
  assert.match(text, /\[DllImport\("user32\.dll", SetLastError = true\)\] static extern bool PostMessage/);
  const wizard = between(text, /^function Drive-Wizard/m, /^\}/m, "Drive-Wizard");
  assert.match(wizard, /\[SmokeDlg\]::Press\(\$d\.Handle, \$next\)/);
  assert.match(wizard, /\[SmokeDlg\]::Press\(\$d\.Handle, \$close\)/);
  assert.doesNotMatch(wizard, /\[SmokeDlg\]::Click\(\$(next|close)/);
  // The outer dialog's own buttons, found by id on the outer dialog, in the program this run started.
  assert.match(wizard, /\[SmokeDlg\]::Item\(\$d\.Handle, 1\)/);
  assert.match(wizard, /Get-Dialogs \$pids -Owned/);
  assert.match(text, /if \(\$Owned -and \(\$null -eq \$Pids -or/);
  // One press per page (the inner dialog NSIS makes for it); posted again only when it could not be queued.
  assert.match(wizard, /if \(\$lastPressError -eq 0\) \{ \$pageQueued = \$true \}/);
  // The press itself is guarded by $pageQueued, and a moment with no page visible neither presses nor resets the page.
  const pressAt = wizard.indexOf("[SmokeDlg]::Press($d.Handle, $next)");
  const guard = wizard.lastIndexOf("if (-not $pageQueued -and", pressAt);
  assert.ok(guard > 0 && pressAt - guard < 300, "the Next press sits inside the one-press-per-page guard");
  const skip = wizard.indexOf("if ($innerWnd -eq [IntPtr]::Zero) { continue }");
  assert.ok(skip > 0 && skip < wizard.indexOf("if ($innerWnd -ne $pageWnd)"), "no visible page: skipped before the page state is reset");
  assert.doesNotMatch(wizard, /TotalSeconds -gt 5/);
  // The main page's other way (Task 9e: "Other choices", then the box "Remove ... before installing ...") is a real click, must
  // read as ticked before Install, and must have been made at all; the same version's link is clicked, not read.
  assert.match(wizard, /\[SmokeDlg\]::GetCheck\(\$remove\.Handle\) -eq 1/);
  assert.match(wizard, /did not take/);
  assert.match(wizard, /\$_\.Text -like 'Remove\*before installing\*'/);
  assert.match(wizard, /\$_\.Text -like 'Uninstall Petalock instead\*'/);
  assert.match(wizard, /\$_\.Text -eq 'Other choices'/);
  assert.match(wizard, /if \(\$UninstallFirst -and -not \$chosen\) \{ throw/);
  // The last page's box is cleared: "Open Petalock" (this task), and the older boxes.
  assert.match(wizard, /\$_\.Text -like 'Open Petalock\*'/);
  // Runner trial 4: "uninstall first" shows the old uninstaller's own window from a child process: driven too.
  assert.match(wizard, /@\(\[int\]\$Process\.Id\) \+ @\(Get-ChildIds \(\[int\]\$Process\.Id\)\)/);
  assert.match(text, /\[wmisearcher\]"SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = \$ParentId"/);
  // ...and a clean-up after a failed check ends anything running from a folder under test.
  const reset = between(text, /^function Reset-World/m, /^\}/m, "Reset-World");
  assert.match(reset, /\$path\.StartsWith\(\$Work \+ '\\'/);
  // Runner trial 5: only the Start menu's own Config value is let through, only as a change; the key is not skipped.
  const places = between(text, /^function Get-PlacesSnapshot/m, /^\}/m, "Get-PlacesSnapshot");
  assert.doesNotMatch(places, /CurrentVersion\\Start'/);
  assert.match(text, /\$startConfig = 'changed: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Start\|Config'/);
  assert.match(text, /Compare-Listing \$before \$after \$allowed \| Where-Object \{ \$_ -ne \$startConfig \}/);
  // ...and the planted-write proof goes through the same filter and names the planted write.
  assert.match(text, /Compare-Listing \$before \$planted \$allowed \| Where-Object \{ \$_ -ne \$startConfig \}/);
  assert.match(text, /\$plantedDiff\[0\] -ne 'added: HKCU\\Software\\Petalock\|MU-planted'/);
  // Another program's window title is never written to the log.
  assert.doesNotMatch(wizard, /Caption\(\$front\)/);
});

// The smoke script, run in the ways that touch nothing.
// Windows PowerShell 5.1 by its full path, as the workflow starts it: never whatever `powershell` the parent's PATH finds.
const POWERSHELL = (() => {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(exe)) return null;
  const probe = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  return probe.status === 0 ? exe : null;
})();

/**
 * Runs the smoke script with no runner marks in the environment, so it can never reach the installing part, and without
 * the module path of the PowerShell 7 that may have started node (the scan job's shell): 5.1 works its own out.
 */
function smoke(args) {
  const env = { ...process.env };
  for (const name of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_TEMP", "PETALOCK_INSTALLER_SMOKE", "PSModulePath"]) delete env[name];
  return spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, SMOKE), ...args], {
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
}

const skipNoPowerShell = POWERSHELL ? false : "Windows PowerShell is not here";

test("the smoke script needs no module cmdlet that a PowerShell 7 parent's module path can hide", () => {
  const script = code(read(SMOKE).replace(/^\s*#.*$/gm, "")).join("\n");
  // Get-FileHash was not found when node ran under pwsh (scan job, 2026-11-25): hashing is .NET now.
  assert.ok(!/\bGet-FileHash\b/.test(script), "Get-FileHash");
  assert.match(script, /System\.Security\.Cryptography\.SHA256/);
});

test("the smoke script never judges an exit code it could not read, and closes an aborted page", () => {
  const script = code(read(SMOKE).replace(/^\s*#.*$/gm, "")).join("\n");
  // An empty ExitCode (Windows PowerShell with -PassThru and no kept handle) must not pass as "not zero": every read goes
  // through Get-ExitCode, which refuses an empty one, and every process is started where its handle is kept.
  const direct = script.split("\n").filter((line) => /\.ExitCode\b/.test(line) && !/\$code = \$Process\.ExitCode/.test(line));
  assert.deepEqual(direct, []);
  assert.match(script, /function Get-ExitCode/);
  assert.match(script, /\$null -eq \$code/);
  assert.match(script, /\$null = \$p\.Handle/);
  assert.ok((script.match(/Get-ExitCode/g) ?? []).length >= 3, "Get-ExitCode is used");
  // The page after an Abort: Next stays off and Cancel closes it.
  assert.match(script, /\$text -match 'Aborted'/);
  assert.match(script, /\[SmokeDlg\]::Item\(\$d\.Handle, 2\)/);
  // A window a failed check left open is closed before the install folder is removed.
  const reset = script.slice(script.indexOf("function Reset-World"), script.indexOf("function Get-RegValue"));
  assert.ok(reset.indexOf("Get-UninstallerCopies") > 0 && reset.indexOf("$Installer") > 0 && reset.indexOf("Get-UninstallerCopies") < reset.indexOf("Remove-Safely"));
});

test("a_refused_install_is_judged_by_the_program_file_before_and_after_not_by_its_presence", () => {
  const script = read(SMOKE);
  const check = script.slice(script.indexOf('$Checks["install_refuses_an_unsafe_folder"]'), script.indexOf('$Checks["files_added_after_install_survive_upgrade_and_uninstall"]'));
  // The fixture that starts with a petalock.exe (the foreign folder with both names) is in the list of cases...
  assert.match(check, /Write-Utf8 \(Join-Path \$both 'petalock\.exe'\)/);
  // ...so "a petalock.exe exists after the refusal" is a false failure on correct behaviour. The state before is kept and
  // compared, and the bare existence test is gone from the refusal loop.
  assert.ok(!/\[System\.IO\.File\]::Exists\(\(Join-Path \$dir 'petalock\.exe'\)\)/.test(check), "a bare existence test of petalock.exe in the refusal loop");
  assert.match(check, /\$programBefore = Get-ProgramState \(Join-Path \$dir 'petalock\.exe'\)/);
  assert.match(check, /Assert-ProgramUnchanged \$programBefore \(Get-ProgramState \(Join-Path \$dir 'petalock\.exe'\)\)/);
  // Its self-test: untouched passes, changed and appeared fail.
  const selfTest = script.slice(script.indexOf("function Invoke-SelfTest"), script.indexOf("function Stop-WithCode"));
  for (const what of ["a foreign petalock.exe left untouched is not a failure", "a foreign petalock.exe that changed is a failure", "a program file that appeared where none was is a failure"]) {
    assert.ok(selfTest.includes(what), what);
  }
});

test("the smoke script defines every named test, and the files here name them too", () => {
  const script = read(SMOKE);
  for (const name of [...NAMED, ...UPGRADE_NAMED]) {
    assert.ok(script.includes(`"${name}"`), `${name} in the script`);
    assert.ok(script.includes(`$Checks["${name}"] = {`), `${name} has its check`);
  }
  // The named tests of this file's top.
  const own = readFileSync(join(ROOT, "scripts/installer-smoke.test.mjs"), "utf8");
  for (const name of [...NAMED, ...UPGRADE_NAMED]) assert.ok(own.includes(`test("${name}"`), `${name} in the script tests`);
});

test("the smoke script refuses what it should", { skip: skipNoPowerShell }, () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    const fake = join(dir, "MU-setup.exe");
    writeFileSync(fake, "MU- not an installer");
    const none = smoke([]);
    assert.equal(none.status, 2, none.stdout + none.stderr);
    assert.match(none.stdout + none.stderr, /-Installer is required/);
    const missing = smoke(["-Installer", join(dir, "MU-missing.exe")]);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    const badUpgrade = smoke(["-Installer", fake, "-Upgrade", join(dir, "MU-missing-upgrade.exe")]);
    assert.equal(badUpgrade.status, 2, badUpgrade.stdout + badUpgrade.stderr);
    const unknown = smoke(["-Installer", fake, "-Only", "not_a_test"]);
    assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout + unknown.stderr, /unknown test/);
    // Off the runner it will not install anything: it stops before the first step and says why.
    const off = smoke(["-Installer", fake]);
    assert.equal(off.status, 3, off.stdout + off.stderr);
    assert.match(off.stdout + off.stderr, /only on a GitHub-hosted runner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the smoke script's dry run lists every test and installs nothing", { skip: skipNoPowerShell }, () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    const fake = join(dir, "MU-setup.exe");
    writeFileSync(fake, "MU- not an installer");
    const run = smoke(["-Installer", fake, "-DryRun"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const listed = [...run.stdout.matchAll(/^would run: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(listed, NAMED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Plan 5, Task 4: the two-version checks are listed only when -Upgrade is another file, and naming one without it is refused
// before anything is done (one installer cannot show an upgrade, so such a run could only pass by checking nothing).
test("the two-version checks need a second installer", { skip: skipNoPowerShell }, () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    const earlier = join(dir, "MU-setup-0.1.1.exe");
    const later = join(dir, "MU-setup-0.1.2.exe");
    writeFileSync(earlier, "MU- not an installer");
    writeFileSync(later, "MU- not an installer either");
    const both = smoke(["-Installer", earlier, "-Upgrade", later, "-DryRun"]);
    assert.equal(both.status, 0, both.stdout + both.stderr);
    const listed = [...both.stdout.matchAll(/^would run: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(listed, [...NAMED, ...UPGRADE_NAMED]);
    const only = smoke(["-Installer", earlier, "-Upgrade", later, "-Only", UPGRADE_NAMED.join(","), "-DryRun"]);
    assert.equal(only.status, 0, only.stdout + only.stderr);
    assert.deepEqual([...only.stdout.matchAll(/^would run: (\S+)$/gm)].map((m) => m[1]), UPGRADE_NAMED);
    for (const args of [["-Installer", earlier], ["-Installer", earlier, "-Upgrade", earlier]]) {
      const refused = smoke([...args, "-Only", UPGRADE_NAMED[0], "-DryRun"]);
      assert.equal(refused.status, 2, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /need -Upgrade, a later version of the same code/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The body of one of the smoke script's checks. */
const checkBody = (name) => between(read(SMOKE), new RegExp(`^\\$Checks\\["${name}"\\] = \\{$`, "m"), /^\}$/m, name);

test("upgrade_keeps_vaults_list_settings_and_state", () => {
  const check = checkBody("upgrade_keeps_vaults_list_settings_and_state");
  // Install N, plant Task 1's made-up state and the Run value the app writes (pointing at the installed program), install N+1.
  assert.match(check, /Assert-VersionPair/);
  assert.match(check, /Install-Good \$DefaultDir/);
  assert.match(check, /\$planted = New-StateFixture/);
  assert.match(check, /\$run = '"' \+ \(Join-Path \$DefaultDir 'petalock\.exe'\) \+ '" --hidden'/);
  assert.match(check, /Set-ItemProperty -LiteralPath \$RunKey -Name 'Petalock' -Value \$run/);
  assert.match(check, /Install-Silent \$Upgrade ''/);
  // Every planted file byte for byte, open\ included (installing over runs no uninstaller); one install folder; one entry,
  // with N+1's version; the program is N+1's; the Run value unchanged and still pointing at the installed program.
  assert.match(check, /Assert-Unchanged \$planted \(Get-Listing \$State -Hash\)/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$ToVersion/);
  assert.match(check, /\(Get-RegValue \$RunKey 'Petalock'\) -ne \$run/);
  const one = between(read(SMOKE), /^function Assert-OneInstallation/m, /^\}$/m, "Assert-OneInstallation");
  assert.match(one, /Get-UninstallValue 'DisplayVersion'/);
  assert.match(one, /Get-EmbeddedVersion \(Join-Path \$Dir 'petalock\.exe'\)/);
  assert.match(one, /DisplayName/);
  assert.match(one, /Programs/);
});

test("candidate_versions_upgrade_in_order", () => {
  const check = checkBody("candidate_versions_upgrade_in_order");
  // The versions the two files carry are read back and are plain x.y.z, the earlier first; then the registered version
  // before and after, on the silent path and through the window, whose main page must say which version is installed and to
  // which it updates (Task 9e: the words come from the two versions).
  assert.match(check, /Assert-VersionPair/);
  assert.match(check, /Install-Silent \$Upgrade ''/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$FromVersion/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$ToVersion/);
  assert.match(check, /Read-MainPage \$Upgrade/);
  assert.match(check, /Petalock \$FromVersion is on this PC\. This updates it to \$ToVersion\./);
  assert.match(check, /\$page\.Exit -ne 0/);
  // Runner trial 1 (run 45781912591): the first page comes before the progress, so the page is read while Drive-Wizard presses
  // through the window (each new page shown to -OnPage once), never by a separate wait that presses nothing.
  const smokeText = read(SMOKE);
  const reader = between(smokeText, /^function Read-MainPage/m, /^\}$/m, "Read-MainPage");
  assert.match(reader, /Drive-Wizard \$p 'install' \$false '' \$null 240 \$false \$reader/);
  assert.match(reader, /the window went through no page that says what Setup will do/);
  const driver = between(smokeText, /^function Drive-Wizard/m, /^\}$/m, "Drive-Wizard");
  assert.match(driver, /\[scriptblock\]\$OnPage = \$null\) \{/);
  assert.match(driver, /if \(\$innerWnd -ne \$pageWnd\) \{\n(?:.*\n){1,3}?\s+if \(\$OnPage\) \{ & \$OnPage \$d \}/);
  const pair = between(read(SMOKE), /^function Assert-VersionPair/m, /^\}$/m, "Assert-VersionPair");
  assert.match(pair, /Get-EmbeddedVersion \$Installer/);
  assert.match(pair, /Get-EmbeddedVersion \$Upgrade/);
  assert.match(pair, /\[version\]\$script:FromVersion -ge \[version\]\$script:ToVersion/);
  const embedded = between(read(SMOKE), /^function Get-EmbeddedVersion/m, /^\}$/m, "Get-EmbeddedVersion");
  assert.match(embedded, /FileVersionInfo\]::GetVersionInfo/);
  assert.match(embedded, /ProductVersion/);
});

test("downgrade_behaviour_is_the_specified_one", () => {
  const check = checkBody("downgrade_behaviour_is_the_specified_one");
  // Specified (Task 4, from the template and Tauri's default allowDowngrades = true; the page links older versions): a silent
  // downgrade installs over and keeps the state; through the window the page says a newer version is installed and offers
  // both ways (Downgrade, and 'Remove ... before installing ...' under 'Other choices'), and the earlier version ends up
  // installed with the state kept (open\ aside: an uninstall-first run cleans it).
  assert.match(check, /Install-Silent \$Upgrade ''[\s\S]*Install-Silent \$Installer ''/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$FromVersion/);
  assert.match(check, /Assert-Unchanged \$planted \(Get-Listing \$State -Hash\)/);
  assert.match(check, /A newer Petalock, \$ToVersion, is on this PC\./);
  assert.match(check, /\$page\.Next -ne 'Downgrade'/);
  assert.match(check, /Remove\*before installing\*/);
  assert.match(check, /Assert-Unchanged \(Without-Open \$planted\) \(Without-Open \(Get-Listing \$State -Hash\)\)/);
  // The template still allows it: a change to the setting must change this test too.
  assert.doesNotMatch(read(CONFIG), /allowDowngrades/);
});

test("uninstall_after_upgrade_is_clean", () => {
  const check = checkBody("uninstall_after_upgrade_is_clean");
  // Task 1's checks after an upgrade, with the registry sentinel also in the former child key (Task 1 re-check new 8).
  assert.match(check, /Install-Silent \$Upgrade ''[\s\S]*Uninstall-AsWindowsDoes \$DefaultDir/);
  assert.match(check, /HKCU:\\Software\\Petalock\\Petalock/);
  for (const sentence of [
    "the install folder is still there after the upgrade and uninstall",
    "the uninstall entry is still there after the upgrade and uninstall",
    "the Run\\\\Petalock value is still there after the upgrade and uninstall",
    "open\\\\ is still there after the upgrade and uninstall",
  ]) assert.match(check, new RegExp(sentence));
  assert.match(check, /Assert-Unchanged \(Without-Open \$planted\) \(Get-Listing \$State -Hash\)/);
  assert.match(check, /MU-child/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan 5, Task 4b: an upgrade keeps "start with Windows" (Ariel: "Both fixes (A and B)", 2026-11-26).
//   A: an uninstall-first run from an upgrade or a downgrade ($R0 = 1 or -1) runs the old uninstaller with /UPDATE, which keeps
//      the Run\Petalock value, the shortcuts and the app data (the same version's "Uninstall Petalock" stays a full uninstall).
//   B: on an upgrade or a downgrade the reinstall page opens with "Do not uninstall" ticked; the same-version page is Tauri's.
// The page's own controls are not run off the runner, so the template is read: each rule is a regular expression on the
// template's code lines, and the mutants below must each be refused (a check that finds nothing wrong in a wrong template
// would pass on any text).
// ---------------------------------------------------------------------------------------------------------------------

/** The body of one NSIS function in `text`'s code lines (comments dropped), or "" when it is not there. */
const functionBody = (text, name) => code(text).join("\n").match(new RegExp(`Function ${name}(?: ;[^\\n]*)?\\n([\\s\\S]*?)\\nFunctionEnd`))?.[1] ?? "";

/**
 * What the main page must do for B (Task 4b, kept by Task 9e): an update, a downgrade or an unknown version installs over by
 * default, and the way that removes first is a box, hidden under "Other choices", never ticked by the page and never set by
 * the page's leave. Problems found in the UI file `uiText` (empty when all hold).
 */
export function reinstallDefaultProblems(uiText) {
  const problems = [];
  const decide = functionBody(uiText, "PetalockDecide");
  const show = functionBody(uiText, "PetalockMainShow");
  const render = functionBody(uiText, "PetalockRender");
  const leave = functionBody(uiText, "PetalockMainLeave");
  const other = functionBody(uiText, "PetalockOnOther");
  const check = functionBody(uiText, "PetalockOnCheck");
  if (decide === "" || show === "" || render === "") return ["the main page is not in the UI file"];
  if (!/StrCpy \$PetalockRemoveFirst 0\n\s*ReadRegStr/.test(decide)) problems.push("the decision does not start with nothing removed first");
  if (/\$\{NSD_Check\} \$PetalockHCheck|\$\{NSD_SetState\} \$PetalockHCheck \$\{BST_CHECKED\}|SendMessage \$PetalockHCheck \$\{BM_SETCHECK\} (1|\$\{BST_CHECKED\})/.test(show + render)) problems.push("the page ticks the remove-first box itself");
  if (/StrCpy \$PetalockRemoveFirst 1/.test(show + render + leave + decide)) problems.push("something but the box sets remove-first");
  if (!/\$\{If\} \$0 = \$\{BST_CHECKED\}\n\s*StrCpy \$PetalockRemoveFirst 1/.test(check)) problems.push("the box does not set remove-first when it is ticked");
  if (!/StrCpy \$PetalockRemoveFirst 0\n\s*\$\{NSD_SetState\} \$PetalockHCheck \$\{BST_UNCHECKED\}/.test(other)) problems.push("hiding the other choices does not clear the box");
  // The box is shown only while "Other choices" is open, and the update-ish cases only.
  if (!/\$\{If\} \$PetalockOtherOpen = 1\n[^\n]*\n\s*SendMessage \$PetalockHCheck \$\{WM_SETTEXT\}[^\n]*\n\s*ShowWindow \$PetalockHCheck \$\{SW_SHOW\}/.test(render)) problems.push("the box is not shown only under 'Other choices'");
  // The default action of each case.
  for (const [kase, word] of [["update", "Update"], ["reinstall", "Reinstall"], ["newer", "Downgrade"], ["unknown", "Replace"]]) {
    if (!new RegExp(`\\$PetalockCase == "${kase}"\\n\\s*StrCpy \\$PetalockB "${word}"`).test(render)) problems.push(`the ${kase} case does not offer '${word}'`);
  }
  return problems;
}

/**
 * What the remove-first path must do for A (Task 4b, kept by Task 9e), as problems found in the template `text`, the UI file and
 * `hooksText`: the old uninstaller runs with /UPDATE exactly when the installed version is older, newer or unknown, `_?=` stays
 * last, the command is built and checked before it runs, and nothing but the decision writes the case.
 */
export function oldUninstallerProblems(text, uiText, hooksText) {
  const problems = [];
  const section = code(text).join("\n").match(/Section PetalockRemoveOld\n([\s\S]*?)\nSectionEnd/)?.[1] ?? "";
  if (section === "") return ["the remove-first section is not in the template"];
  const before = section.indexOf("Call PetalockBeforeOldUninstaller");
  const exec = section.indexOf("ExecWait '$R1' $0");
  const appends = section.split("\n").filter((line) => line.includes("/UPDATE"));
  const mine = appends.filter((line) => /\$PetalockCase/.test(line));
  if (before < 0 || exec < before) problems.push("the old uninstaller's command is not built before it is run");
  if (mine.length !== 1 || !/^\s*\$\{IfThen\} \$PetalockCase != "reinstall" \$\{\|\} StrCpy \$R1 "\$R1 \/UPDATE" \$\{\|\}$/.test(mine[0])) {
    problems.push("the old uninstaller does not get /UPDATE exactly when the installed version is older, newer or unknown (not the same)");
  } else {
    const line = section.indexOf(mine[0]);
    if (!(line > before && line < exec)) problems.push("the /UPDATE line is not between the command being built and its run");
  }
  if (appends.length !== 2 || !appends.some((line) => /\$UpdateMode = 1/.test(line))) problems.push("another /UPDATE is added on this path (only the update mode's and the version rule's are allowed)");
  // `_?=` must stay the last argument (NSIS reads everything after it as the folder), so /UPDATE comes before it.
  const folderArg = section.indexOf('StrCpy $R1 "$R1 _?=$4"');
  if (folderArg < 0) problems.push("the uninstaller's `_?=` folder argument is not added");
  else if (mine.length === 1 && section.indexOf(mine[0]) > folderArg) problems.push("/UPDATE is added after `_?=`, where the uninstaller would read it as part of the folder");
  // The case is decided once, before any page or section: nothing else writes it.
  const writes = code(uiText + "\n" + hooksText + "\n" + text).filter((line) => /StrCpy \$PetalockCase /.test(line));
  const outside = functionBody(uiText, "PetalockDecide").split("\n").filter((line) => /StrCpy \$PetalockCase /.test(line)).length;
  if (writes.length !== outside) problems.push("the case is written somewhere but the decision");
  // $R1 and $4 (the command and its folder) are set by the hook and used straight after: nothing in the section in between uses them.
  const between = section.slice(before, exec);
  if (/(?:StrCpy|Pop|ReadRegStr)\s+\$(?:R1|4)\b(?!\s+"\$R1)/.test(between.replace(/\$\{IfThen\}[^\n]*/g, ""))) problems.push("$R1 or $4 is rewritten between building the command and running it");
  // A run without the page (silent, passive, /UPDATE) never removes first: the section does nothing unless the person ticked the box.
  if (!/\$\{If\} \$PetalockRemoveFirst = 1/.test(section)) problems.push("the section no longer runs only when remove-first was chosen");
  return problems;
}

test("upgrade_page_defaults_to_install_over", () => {
  const uiText = ui();
  assert.deepEqual(reinstallDefaultProblems(uiText), []);
  // Each rule fails on a UI file that breaks it, and the pass above is not a pass on nothing.
  const mutants = [
    ["  StrCpy $PetalockRemoveFirst 0\n  ReadRegStr $0 SHCTX", "  ReadRegStr $0 SHCTX"], // the decision no longer starts with nothing removed
    ["  Call PetalockRender\n  ${If} $PetalockCase == \"newer\"", "  ${NSD_Check} $PetalockHCheck\n  Call PetalockRender\n  ${If} $PetalockCase == \"newer\""], // the page ticks the box
    ['    StrCpy $PetalockRemoveFirst 0\n    ${NSD_SetState} $PetalockHCheck ${BST_UNCHECKED}', "    ${NSD_SetState} $PetalockHCheck ${BST_UNCHECKED}"], // hiding keeps the tick
    ['StrCpy $PetalockB "Downgrade"', 'StrCpy $PetalockB "Update"'], // a newer version offered as an update
    ['${If} $0 = ${BST_CHECKED}\n    StrCpy $PetalockRemoveFirst 1', '${If} $0 = ${BST_UNCHECKED}\n    StrCpy $PetalockRemoveFirst 1'], // the box sets remove-first the wrong way round
  ];
  for (const [from, to] of mutants) {
    assert.ok(uiText.includes(from), `the mutant's anchor is in the UI file: ${from}`);
    assert.ok(reinstallDefaultProblems(uiText.replace(from, to)).length >= 1, `must be refused: ${from} -> ${to}`);
  }
  // A page of nothing at all is refused too (a check that finds nothing wrong in an empty file would pass on any text).
  assert.deepEqual(reinstallDefaultProblems(""), ["the main page is not in the UI file"]);
  // The smoke check on the runner: the page read on an upgrade and a downgrade (it installs over by default, and the other way
  // is offered), and on the same version (Reinstall, and a link to the full uninstall).
  const check = checkBody("upgrade_page_defaults_to_install_over");
  assert.match(check, /Read-MainPage \$Upgrade/);
  assert.match(check, /Read-MainPage \$Installer/);
  assert.match(check, /Assert-InstallOverDefault \$page "an upgrade from/);
  assert.match(check, /Assert-InstallOverDefault \$page "a downgrade from/);
  assert.match(check, /Assert-ReinstallPage \$page/);
  const over = between(read(SMOKE), /^function Assert-InstallOverDefault/m, /^\}$/m, "Assert-InstallOverDefault");
  assert.match(over, /\$Page\.Next -notin @\('Update', 'Downgrade', 'Replace'\)/);
  assert.match(over, /\$Page\.Links -notcontains 'Other choices'/);
  assert.match(over, /\$_\.Text -like 'Remove\*before installing\*'/);
  assert.match(over, /-not \$remove\.Enabled/);
  assert.match(over, /\$remove\.Checked/);
  const same = between(read(SMOKE), /^function Assert-ReinstallPage/m, /^\}$/m, "Assert-ReinstallPage");
  assert.match(same, /\$Page\.Next -ne 'Reinstall'/);
  assert.match(same, /Uninstall Petalock instead/);
  assert.match(same, /\$Page\.Choices\)\.Count -ne 0/);
  // The reader finds the page by its words, reads the default button and the links, then opens "Other choices" for the box.
  const reader = between(read(SMOKE), /^function Read-MainPage/m, /^\}$/m, "Read-MainPage");
  assert.match(reader, /What Setup will do/);
  assert.match(reader, /\[SmokeDlg\]::Item\(\$d\.Handle, 1\)/);
  assert.match(reader, /\$_\.Text -eq 'Other choices'/);
  assert.match(reader, /Remove\*before installing\*/);
  assert.match(reader, /GetCheck/);
});

/** What the uninstaller's confirm page must do for finding 3, as problems found in the template `text`. */
export function confirmBoxProblems(text) {
  const problems = [];
  const show = functionBody(text, "un\\.ConfirmShow");
  const leave = functionBody(text, "un\\.ConfirmLeave");
  const skip = show.search(/^\s*\$\{If\} \$UpdateMode = 1\n\s*Return\n\s*\$\{EndIf\}/m);
  const create = show.indexOf("CreateWindowEx");
  if (create < 0 || !show.includes('w "Delete the application data.')) problems.push("a full uninstall no longer gets the app-data box");
  if (skip < 0 || (create >= 0 && skip > create) || (show.indexOf("FindWindow") >= 0 && skip > show.indexOf("FindWindow"))) {
    problems.push("under /UPDATE the box is still created (the page must return before it makes anything)");
  }
  if (!/^\s*\$\{If\} \$UpdateMode = 1\n\s*Return\n\s*\$\{EndIf\}\n\s*SendMessage \$DeleteAppDataCheckbox \$\{BM_GETCHECK\} 0 0 \$DeleteAppDataCheckboxState/m.test(leave)) {
    problems.push("under /UPDATE the page's leave reads a box that was never made");
  }
  // The deletion itself still needs the box ticked and no update mode (unchanged).
  const section = code(text).join("\n").match(/Section Uninstall\n([\s\S]*?)\nSectionEnd/)?.[1] ?? "";
  if (!/\$\{If\} \$DeleteAppDataCheckboxState = 1\n\s*\$\{AndIf\} \$UpdateMode <> 1/.test(section)) problems.push("the deletion no longer requires the box ticked and no update mode");
  return problems;
}

test("the_app_data_box_is_not_offered_when_the_uninstaller_runs_with_update", () => {
  const text = template();
  assert.deepEqual(confirmBoxProblems(text), []);
  const guard = "  ${If} $UpdateMode = 1\n    Return\n  ${EndIf}\n";
  assert.ok(text.split(guard).length === 3, "the guard is in both functions");
  assert.ok(confirmBoxProblems(text.replace(guard, "")).length >= 1, "no guard in the show function is refused");
  assert.ok(confirmBoxProblems(text.replace(guard, "").replace(guard, "")).length >= 1, "no guard anywhere is refused");
  const moved = text.replace(guard, "").replace("  Pop $DeleteAppDataCheckbox\n", `  Pop $DeleteAppDataCheckbox\n${guard}`);
  assert.ok(confirmBoxProblems(moved).length >= 1, "a guard after the box is made is refused");
  assert.ok(confirmBoxProblems(text.replace("$UpdateMode = 1\n    Return", "$UpdateMode = 0\n    Return")).length >= 1, "a guard on the wrong value is refused");
  assert.ok(confirmBoxProblems(text.replace('w "Delete the application data.', 'w "x')).length >= 1, "a full uninstall that loses the box is refused");
  assert.ok(confirmBoxProblems(text.replace("${AndIf} $UpdateMode <> 1\n    SetShellVarContext", "${AndIf} 1 = 1\n    SetShellVarContext")).length >= 1, "a deletion that no longer needs the update-mode check is refused");
  // The child-dialog smoke check (the uninstall-first choices of interactive_upgrade_keeps_start_with_windows): the confirm page of the old
  // uninstaller is seen exactly once and offers no deletion; and the same-version full uninstall's page does (the reader finds the box).
  const check = checkBody("interactive_upgrade_keeps_start_with_windows");
  assert.match(check, /\$ConfirmPage = @\{ Seen = 0; Box = 0 \}/);
  assert.match(check, /Invoke-WindowOver \$Installer \$Upgrade \$uninstallFirst \$confirmReader/);
  assert.match(check, /Invoke-WindowOver \$Upgrade \$Installer \$true \$confirmReader/);
  assert.match(check, /Invoke-WindowOver \$Installer \$Installer \$true \$confirmReader/);
  assert.match(check, /Assert-ConfirmPageBox \$ConfirmPage \$false/);
  assert.match(check, /Assert-ConfirmPageBox \$ConfirmPage \$true/);
  const asserter = between(read(SMOKE), /^function Assert-ConfirmPageBox/m, /^\}$/m, "Assert-ConfirmPageBox");
  assert.match(asserter, /\.Seen -ne 1/);
  assert.match(asserter, /\.Box -ne 0/);
  assert.match(asserter, /\.Box -ne 1/);
  const reader = between(read(SMOKE), /^function New-ConfirmPageReader/m, /^\}$/m, "New-ConfirmPageReader");
  assert.match(reader, /-ne 'Uninstall'/);
  assert.match(reader, /Delete the application data\*/);
});

test("interactive_upgrade_keeps_start_with_windows", () => {
  const text = template();
  const uiText = ui();
  const hooksText = read(HOOKS);
  assert.deepEqual(oldUninstallerProblems(text, uiText, hooksText), []);
  const line = '${IfThen} $PetalockCase != "reinstall" ${|} StrCpy $R1 "$R1 /UPDATE" ${|}';
  assert.ok(text.includes(line), "the version rule's /UPDATE line is in the template");
  const mutants = [
    [line, ""], // the old uninstaller runs without /UPDATE and deletes the Run value
    [line, 'StrCpy $R1 "$R1 /UPDATE"'], // every remove-first run, the same version's included
    [line, '${IfThen} $PetalockCase == "update" ${|} StrCpy $R1 "$R1 /UPDATE" ${|}'], // a downgrade and an unknown version left out
    [line, '${IfThen} $PetalockCase == "reinstall" ${|} StrCpy $R1 "$R1 /UPDATE" ${|}'], // only the same version
    [line, '${IfThen} $PetalockOldVer != "reinstall" ${|} StrCpy $R1 "$R1 /UPDATE" ${|}'], // the wrong variable
  ];
  for (const [from, to] of mutants) assert.ok(oldUninstallerProblems(text.replace(from, to), uiText, hooksText).length >= 1, `must be refused: ${to || "(line removed)"}`);
  // Where the line sits matters: before the command is built it is wiped (the hook sets $R1), and after `_?=` the uninstaller
  // would read it as part of the folder.
  const run = "    ExecWait '$R1' $0\n";
  assert.ok(text.includes(run));
  assert.ok(oldUninstallerProblems(text.replace(`    ${line}\n`, "").replace(run, `    ${line}\n${run}`), uiText, hooksText).length >= 1, "a line after `_?=` is refused");
  assert.ok(oldUninstallerProblems(text.replace(`    ${line}\n`, "").replace("    Call PetalockBeforeOldUninstaller\n", `    ${line}\n    Call PetalockBeforeOldUninstaller\n`), uiText, hooksText).length >= 1, "a line before the command is built is refused");
  // Nothing but the decision writes the case, and a section that no longer waits for the choice is refused.
  assert.ok(oldUninstallerProblems(text, `${uiText}\nStrCpy $PetalockCase "reinstall"\n`, hooksText).length >= 1, "a second writer of the case is refused");
  assert.ok(oldUninstallerProblems(text.replace("${If} $PetalockRemoveFirst = 1", "${If} 1 = 1"), uiText, hooksText).length >= 1, "a section that always removes first is refused");
  assert.deepEqual(oldUninstallerProblems("", "", ""), ["the remove-first section is not in the template"]);
  // The smoke check on the runner (the plan's wording): 0.1.1 installed with its Run value, 0.1.2 through the window with the
  // page's default and then with the other choice, the value unchanged both times; and the downgrade, and the same version
  // as the control that still removes it (Task 9e: and now ends Setup, so nothing is installed afterwards).
  const check = checkBody("interactive_upgrade_keeps_start_with_windows");
  assert.match(check, /foreach \(\$uninstallFirst in @\(\$false, \$true\)\)/);
  assert.match(check, /Invoke-WindowOver \$Installer \$Upgrade \$uninstallFirst/);
  assert.match(check, /Invoke-WindowOver \$Upgrade \$Installer \$true/);
  assert.match(check, /Invoke-WindowOver \$Installer \$Installer \$true/);
  assert.match(check, /\(Get-RegValue \$RunKey 'Petalock'\) -ne \$r\.Run/);
  assert.match(check, /\$null -ne \(Get-RegValue \$RunKey 'Petalock'\)/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$ToVersion/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$FromVersion/);
  assert.match(check, /\[System\.IO\.File\]::Exists\(\(Join-Path \$DefaultDir 'petalock\.exe'\)\)\) \{ throw "the same-version 'Uninstall Petalock instead' left petalock\.exe" \}/);
  const helper = between(read(SMOKE), /^function Invoke-WindowOver/m, /^\}$/m, "Invoke-WindowOver");
  assert.match(helper, /Install-Silent \$First ''/);
  assert.match(helper, /\$planted = New-StateFixture/);
  assert.match(helper, /Set-ItemProperty -LiteralPath \$RunKey -Name 'Petalock' -Value \$run/);
  assert.match(helper, /\$run = '"' \+ \(Join-Path \$DefaultDir 'petalock\.exe'\) \+ '" --hidden'/);
  assert.match(helper, /Drive-Wizard \$p 'install' \$false '' \$null 240 \$UninstallFirst \$OnPage/);
  assert.match(helper, /Get-ExitCode \$p/);
  const kept = between(read(SMOKE), /^function Assert-WindowKept/m, /^\}$/m, "Assert-WindowKept");
  assert.match(kept, /the old uninstaller did not run \(open\\ is still there\)/);
  assert.match(kept, /open\\ included: no uninstaller runs/);
  assert.match(kept, /Assert-Unchanged \$r\.Others\[\$path\]/);
});

// The numbered list at the template's top names each change, and the two of Task 4b are in it.
test("the_template_lists_its_numbered_changes_including_the_reinstall_page_two", () => {
  const header = template().split("\nUnicode true")[0];
  const numbers = [...header.matchAll(/^; {1,3}(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(numbers.length >= 13, `found ${numbers.length} numbered changes`);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), "numbered in order, none missing");
  const item = (n) => header.match(new RegExp(`^; {1,3}${n}\\. ([\\s\\S]*?)(?=\\n; {1,3}\\d+\\. |(?![\\s\\S]))`, "m"))?.[1].replace(/\n;\s+/g, " ") ?? "";
  // Task 9e: item 11 is the one screen (the reinstall page it replaced is named), 12 the remove-first path, 13 the plugin folder
  // and the band picture.
  assert.match(item(11), /one custom page/i);
  assert.match(item(11), /reinstall/i);
  assert.match(item(11), /Do not uninstall/);
  assert.match(item(11), /focus/i);
  assert.match(item(12), /\/UPDATE/);
  assert.match(item(12), /Run\\Petalock/);
  assert.match(item(12), /Delete the application data/);
  assert.match(item(13), /addplugindir|additional plugin/i);
  assert.match(item(13), /headerImage/);
  // Each is marked where it is made, as the others are.
  const lines = template().split("\n");
  assert.ok(lines.some((line) => /^\s*; Petalock: .*Delete the application data/.test(line)), "the hidden box is marked where it is made");
  assert.ok(lines.some((line) => /^\s*; Petalock: .*one custom page/.test(line)), "the one screen is marked where it is made");
  assert.ok(lines.some((line) => /^\s*; Petalock: .*addplugindir|^\s*; Petalock: the additional plugins/.test(line)), "the plugin folder is marked where it is made");
  assert.ok(lines.some((line) => /^\s*; \/UPDATE for an update that removes first/.test(line)), "the /UPDATE line is marked where it is made");
});

// Task 1 re-check new 6: the uninstall-first upgrade must show that the old uninstaller really ran: an opened copy planted
// in open\ is gone afterwards (only the uninstaller cleans it).
test("the_uninstall_first_upgrade_proves_the_old_uninstaller_ran", () => {
  const check = checkBody("files_added_after_install_survive_upgrade_and_uninstall");
  const first = check.slice(check.indexOf("MU-first"));
  assert.match(first, /Write-Utf8 \(Join-Path \$State 'open\\MU-proof\.txt'\)/);
  assert.match(first, /the old uninstaller did not run \(the opened copy planted in open\\ is still there\)/);
});

// Plan 5, Task 4: the installer job also builds the same commit as two candidate versions (never published, after the tested
// installer is kept) and runs the two-version checks on them.
test("build_installer_builds_two_candidate_versions_and_runs_the_upgrade_checks", () => {
  const text = read(BUILD);
  const upload = text.indexOf("name: Keep the installer");
  const candidates = text.indexOf("name: Build the same commit as two candidate versions");
  const upgradeSmoke = text.indexOf("name: Smoke-test upgrades between the candidates");
  assert.ok(upload > 0 && candidates > upload, "the candidates are built after the tested installer is kept");
  assert.ok(upgradeSmoke > candidates, "the upgrade checks run on the candidates");
  const build = text.slice(candidates, upgradeSmoke);
  for (const version of ["0.1.1", "0.1.2"]) assert.ok(build.includes(version), `candidate ${version}`);
  assert.match(build, /--config tauri\.notices\.conf\.json --config/);
  assert.match(build, /"version":/);
  assert.match(build, /-- --locked/);
  // Moved out of the bundle folder, so a later run's digest step (exactly one installer) never sees them.
  assert.match(build, /Move-Item/);
  const smokeStep = text.slice(upgradeSmoke, upgradeSmoke + 1800);
  assert.match(smokeStep, /shell: cmd/);
  assert.match(smokeStep, /-Installer "%EARLIER%" -Upgrade "%LATER%"/);
  assert.match(smokeStep, new RegExp(`-Only ${UPGRADE_NAMED.join(",")}`));
  assert.match(smokeStep, /installer-smoke\\upgrade\.log/);
  // The bundle folder starts empty: a restored one could hold an installer from an earlier run.
  const clear = text.indexOf("target\\release\\bundle");
  const mainBuild = text.indexOf("name: Build the installer");
  assert.ok(clear > 0 && clear < mainBuild, "the bundle folder is cleared before the build");
});

// Plan 5, Task 3: the open-source licence texts inside the installer. `scripts/licences.test.mjs` tests the file and how it is
// made; this is the check on the runner that the installed copy is that file.
test("installed_copy_has_the_notices_file", () => {
  const script = read(SMOKE);
  const check = between(script, /^\$Checks\["installed_copy_has_the_notices_file"\] = \{$/m, /^\}$/m, "the check");
  // It installs, reads the installed file, and compares it with the one the build made.
  assert.match(check, /Install-Good \$DefaultDir/);
  assert.match(check, /Join-Path \$DefaultDir 'THIRD-PARTY-NOTICES\.txt'/);
  assert.match(check, /Assert-NoticesInstalled \$installed \$Notices/);
  // The comparison is of the contents (SHA-256 of the bytes), after the build's own file is shown to be a whole one: a long
  // text with its heading and its footer. Two empty files that are equal must not pass.
  const compare = between(script, /^function Assert-NoticesInstalled/m, /^\}$/m, "Assert-NoticesInstalled");
  assert.match(compare, /\(Get-Sha256 \$Installed\) -ne \(Get-Sha256 \$Expected\)/);
  assert.match(compare, /\$want\.Length -lt 20000/);
  assert.match(compare, /Petalock: third-party notices/);
  assert.match(compare, /End of third-party notices: /);
  assert.match(compare, /is not there, so the installed copy has nothing to be compared with/);
  // Fix round, finding 1: an upgrade over a notices file that has become a hard link or a symbolic link to a file outside the
  // install folder is refused, and that file is left as it was (its SHA-256 before and after).
  for (const kind of ["HardLink", "SymbolicLink"]) {
    assert.match(check, new RegExp(`New-Item -ItemType ${kind} -Path \\$installed -Target \\$outside`), `${kind} case`);
  }
  assert.match(check, /\$outsideHash = Get-Sha256 \$outside/);
  assert.match(check, /Install-Silent \$Upgrade ''/);
  assert.match(check, /an upgrade over a notices file that was a \$\(\$case\.Name\) exited 0/);
  assert.match(check, /\(Get-Sha256 \$outside\) -ne \$outsideHash/);
  assert.match(check, /the upgrade wrote through the \$\(\$case\.Name\) to the file outside/);
  // The uninstall takes it away with the program.
  assert.match(check, /Uninstall-AsWindowsDoes \$DefaultDir/);
  assert.match(check, /the uninstall left THIRD-PARTY-NOTICES\.txt/);
  // The file's own first line and footer are the ones the generator writes.
  const generator = readFileSync(join(ROOT, "scripts", "licences.mjs"), "utf8");
  assert.ok(generator.includes('"Petalock: third-party notices"'));
  assert.ok(generator.includes("End of third-party notices: ${distinct(crates)} Rust libraries, ${distinct(packages)} page packages."));
  // The workflow hands the script the file it generated, and the bundle takes the same file.
  const workflow = read(BUILD);
  assert.match(workflow, /-Installer "%INSTALLER%" -Notices "%GITHUB_WORKSPACE%\\target\\notices\\THIRD-PARTY-NOTICES\.txt" -LogPath/);
  const resources = JSON.parse(read("crates/petalock-desktop/tauri.notices.conf.json")).bundle.resources;
  assert.deepEqual(Object.values(resources), ["THIRD-PARTY-NOTICES.txt"]);
});

// Fix round, finding 14: the notices file is required before the first real operation, whenever its check is selected. A
// dynamic test would have to start the real checks (which reset the person's own Petalock folders on a PC), so this reads the
// order in the script; the -DryRun test above still proves a dry run needs no -Notices.
test("a_run_that_selects_the_notices_check_without_a_notices_file_is_refused_before_it_changes_anything", () => {
  const script = read(SMOKE);
  const dry = script.indexOf("if ($DryRun) {");
  const runner = script.indexOf("this runs only on a GitHub-hosted runner");
  const required = script.indexOf("-Notices is required");
  const firstOperation = script.indexOf("$Id = 'io.github.sumguywhowantstobuild.petalock'");
  assert.ok(dry > 0 && runner > dry && required > runner && firstOperation > required, "dry run, runner gate, then the requirement, then the first real step");
  const around = script.slice(script.lastIndexOf("if (", required), required + 200);
  assert.match(around, /\$selected -contains 'installed_copy_has_the_notices_file'/);
  assert.match(around, /\[string\]::IsNullOrEmpty\(\$Notices\)/);
  assert.match(around, /Stop-WithCode 2/);
});

test("the smoke script refuses a -Notices file that is not there", { skip: skipNoPowerShell }, () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    const fake = join(dir, "MU-setup.exe");
    writeFileSync(fake, "MU- not an installer");
    const run = smoke(["-Installer", fake, "-Notices", join(dir, "MU-missing-notices.txt"), "-DryRun"]);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /-Notices is not a file that exists/);
    // One that is there is taken, and the dry run still lists the check by name.
    const here = join(dir, "MU-notices.txt");
    writeFileSync(here, "MU- notices");
    const ok = smoke(["-Installer", fake, "-Notices", here, "-DryRun", "-Only", "installed_copy_has_the_notices_file"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^would run: installed_copy_has_the_notices_file$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the smoke script's comparisons fire on a wrong result and on no change at all", { skip: skipNoPowerShell }, () => {
  const run = smoke(["-SelfTest"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const out = run.stdout;
  assert.match(out, /selftest: (\d+) checks passed/);
  const count = Number(out.match(/selftest: (\d+) checks passed/)[1]);
  assert.ok(count >= 8, `only ${count} self-checks ran`);
  // A diff that found nothing where something changed, and one that found a change where nothing did, both fail.
  assert.match(out, /selftest: ok: a changed file is found/);
  assert.match(out, /selftest: ok: an added file is found/);
  assert.match(out, /selftest: ok: a removed file is found/);
  assert.match(out, /selftest: ok: no change is no change/);
  assert.match(out, /selftest: ok: an empty listing of a folder that holds files is refused/);
  // The installed notices against the build's: the same file passes, and every wrong copy and every unusable build file fails.
  assert.match(out, /selftest: ok: an installed notices file that is the build's passes/);
  assert.match(out, /selftest: ok: a changed, cut, absent or empty installed copy fails, and so does a build file that is empty, cut or missing/);
  // The status line's texts (second fix round): words with an outcome pass; a window handle, nothing read and no outcome fail.
  assert.match(out, /selftest: ok: the status line check passes words with an outcome, and fails a handle, nothing read and no outcome/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan 5, Task 9e: the one screen. The smoke checks that drive it run only on the runner; these read their bodies.
// ---------------------------------------------------------------------------------------------------------------------

test("quick_install_default_folder_and_receipt", () => {
  const check = checkBody("quick_install_default_folder_and_receipt");
  // Through the window, default folder: every sentence the design gives (plan, then receipt), the version from the build, the
  // program installed with that version, and Petalock not started (the driver clears the box on the last page).
  assert.match(check, /Install-Interactive \$Installer ''/);
  for (const sentence of ["What Setup will do", "Check for Microsoft WebView2", "Install Petalock for this Windows account", "Add it to the Start menu and to Installed apps", "What Setup did", "Petalock is installed for this Windows account", "Added to the Start menu and to Installed apps"]) {
    assert.ok(check.includes(`'${sentence}'`), `the check looks for: ${sentence}`);
  }
  assert.match(check, /Already installed.*Installed by Setup/);
  assert.match(check, /Get-EmbeddedVersion \$Installer/);
  assert.match(check, /\*Version \$want\*/);
  assert.match(check, /Test-Installed \$DefaultDir/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$want/);
  assert.match(check, /Get-Process -Name 'petalock'/);
  // The collected words are the statics of every page, so the receipt's words are the real last page's (not the plan's):
  // "Petalock is installed for this Windows account" is the receipt's row 2, the plan's is "Install Petalock for ...".
  assert.notEqual("Petalock is installed for this Windows account", "Install Petalock for this Windows account");
});

test("quick_install_folder_from_options", () => {
  const check = checkBody("quick_install_folder_from_options");
  // Review fix round, finding 19, and the second fix round (runner trial 3: the system's folder dialog is the tree-style
  // "Browse For Folder", with no Folder box): Browse is driven from a launch with no /D=. The dialog opens on the (empty) default
  // folder and a folder made beside it is chosen by typing its name into the tree; the page must then show that folder, and the
  // install lands there and nowhere else; the uninstall takes the program, the uninstaller and the entry away.
  assert.match(check, /Start-Tracked \$Installer @\(\)/);
  assert.match(check, /\$_\.Text -eq 'Options'/);
  assert.match(check, /\$_\.Class -eq 'Edit'/);
  assert.match(check, /Browse\*/);
  assert.match(check, /\$pickName = 'MU-picked-folder'/);
  assert.match(check, /Choose-Folder \$pickName/);
  assert.match(check, /New-Item -ItemType Directory -Force \$DefaultDir/, "the dialog opens on a default folder that exists");
  assert.match(check, /New-Item -ItemType Directory -Force \$picked/, "the folder to choose exists beside it");
  assert.match(check, /\$optionsObs\['Field'\] -ne \$chosen/);
  assert.match(check, /\$optionsObs\['Field'\] -eq \$DefaultDir/, "a picker that left the default must fail");
  assert.match(check, /Test-Installed \$chosen/);
  assert.match(check, /InstallLocation/);
  assert.match(check, /Uninstall-AsWindowsDoes \$chosen/);
  for (const gone of ["petalock\\.exe", "uninstall\\.exe"]) assert.match(check, new RegExp(`\\[System\\.IO\\.File\\]::Exists\\(\\(Join-Path \\$chosen '${gone}'\\)\\)`));
  assert.match(check, /Get-UninstallValue 'DisplayName'/);
  // A reader that saw no page must fail, never pass on an empty table.
  assert.match(check, /if \(\$optionsObs\.Count -eq 0\) \{ Save-Screen 'no-options'; throw/);
  // The driver finds the dialog by its owner and its tree, with no caption and no Folder box assumed.
  const picker = between(read(SMOKE), /^function Choose-Folder\b/m, /^\}$/m, "Choose-Folder");
  assert.match(picker, /SysTreeView32/);
  assert.match(picker, /\[SmokeDlg\]::Owner\(/);
  assert.doesNotMatch(picker, /'Edit'/);
  assert.doesNotMatch(picker, /\*Petalock\*/);
  assert.match(picker, /\[SmokeDlg\]::Item\(\$h, 1\)/);
});

test("a_completed_step_puts_words_in_the_status_line", () => {
  const check = checkBody("a_completed_step_puts_words_in_the_status_line");
  // A real install, the status control read by its id on every turn of a tight loop: each text it showed is kept, none may be a
  // number (the window handle that once took the outcome's place), and at least one must be a completed step's outcome.
  assert.match(check, /\[SmokeDlg\]::StatusText\(\$d\.Handle, 1950\)/);
  assert.match(check, /\$statuses\.Count -eq 0/);
  for (const outcome of ["Microsoft WebView2: Already installed", "Microsoft WebView2: Installed by Setup", "Petalock is installed for this Windows account", "Added to the Start menu and to Installed apps"]) {
    assert.ok(check.includes(`'${outcome}'`), `the outcome the check looks for: ${outcome}`);
  }
  assert.match(check, /Get-StatusProblems @\(\$statuses\) \$outcomes/);
  // The comparison counts what it found: nothing read, a number and no outcome each fail (its self-test runs these too).
  const compare = between(read(SMOKE), /^function Get-StatusProblems\b/m, /^\}$/m, "Get-StatusProblems");
  assert.match(compare, /@\('the status line was never read'\)/);
  assert.match(compare, /\^\\s\*\\d\+\\s\*\$/);
  assert.match(compare, /\$seen\.Count -eq 0/);
  assert.match(read(SMOKE), /selftest: ok: |& \$ok 'the status line check passes words with an outcome, and fails a handle, nothing read and no outcome'/);
  assert.match(check, /\$deadline/);
  assert.match(check, /Test-Installed \$DefaultDir/);
});

test("a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote", () => {
  const check = checkBody("a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote");
  // Fresh: Windows refuses the new entry (the right to create the key is denied); only Setup's own files go, the sentinel beside the
  // folder and the state folder (also named Petalock) stay, no entry exists, and the same install works once the right is back.
  assert.match(check, /Set-RegDeny \$UninstallParent 'CreateSubKey'/);
  assert.match(check, /MU-sentinel/);
  assert.match(check, /\$planted = New-StateFixture/);
  assert.match(check, /Assert-Unchanged \$planted \(Get-Listing \$State -Hash\)/);
  assert.match(check, /Clear-RegDeny/);
  // Update in place: the right to set the key's values is denied; nothing is removed and the earlier entry stays.
  assert.match(check, /Set-RegDeny \$UninstallKey 'SetValue'/);
  assert.match(check, /MU-added\.txt/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir/);
  // Each refusal is an error exit, never zero, and is followed by a success.
  assert.equal((check.match(/-eq 0\) \{ throw/g) ?? []).length >= 2, true);
  assert.equal((check.match(/-ne 0\) \{ throw/g) ?? []).length >= 2, true);
});

test("quick_install_folder_from_d", () => {
  const check = checkBody("quick_install_folder_from_d");
  assert.match(check, /Start-Tracked \$Installer @\("\/D=\$chosen"\)/);
  assert.match(check, /\$dObs\['Field'\] -ne \$chosen/);
  assert.match(check, /if \(\$dObs\.Count -eq 0\) \{ Save-Screen 'no-options-d'; throw/);
  assert.match(check, /Test-Installed \$chosen/);
  assert.match(check, /\[System\.IO\.Directory\]::Exists\(\$DefaultDir\)/);
});

test("quiet_installs_return_exit_codes_and_launch_nothing", () => {
  const check = checkBody("quiet_installs_return_exit_codes_and_launch_nothing");
  // /P: ends by itself with exit 0 and starts nothing; /S: no window at all, exit 0, nothing started; both refused folders end with
  // an error code, with the installed program unchanged.
  assert.match(check, /Start-Tracked \$Installer @\('\/P'\)/);
  assert.match(check, /\$deadline = \(Get-Date\)\.AddSeconds\(240\)/);
  assert.match(check, /the \/P install exited \$code/);
  assert.match(check, /Start-Tracked \$Installer @\('\/S', '\/R'\)/);
  assert.match(check, /Get-Dialogs @\(\[int\]\$p\.Id\) -Owned/);
  assert.match(check, /the \/S install showed a window/);
  assert.match(check, /foreach \(\$flags in @\(@\('\/S'\), @\('\/P'\)\)\)/);
  assert.match(check, /"\/D=\$State"/);
  assert.match(check, /if \(\$code -eq 0\) \{ throw/);
  assert.match(check, /Assert-Unchanged \$before \(Get-InstallState \$DefaultDir\)/);
  assert.equal((check.match(/Get-Process -Name 'petalock'/g) ?? []).length, 2, "Petalock is looked for after /P and after /S");
});

test("the running check works through the window: its words, Retry and Cancel on its own buttons, the keyboard route in words", () => {
  const script = read(SMOKE);
  const wait = between(script, /^function Wait-RunningPage/m, /^\}$/m, "Wait-RunningPage");
  assert.match(wait, /Close Petalock, then try again/);
  assert.match(wait, /What Setup will do/);
  assert.match(wait, /\[SmokeDlg\]::Press\(\$d\.Handle, \$next\)/);
  const body = script.slice(script.indexOf('$Checks["running_petalock_is_never_ended_and_silent_refuses_first"]'), script.indexOf('$Checks["uninstall_says_where_vaults_stay"]'));
  assert.match(body, /Wait-RunningPage \$p/);
  assert.match(body, /Quit it from its icon near the clock/);
  assert.match(body, /press Windows\+B/);
  assert.match(body, /\[SmokeDlg\]::Press\(\$box\.Handle, \[SmokeDlg\]::Item\(\$box\.Handle, 2\)\)/, "Cancel is the window's own Cancel button");
  assert.match(body, /\[SmokeDlg\]::Press\(\$box\.Handle, \[SmokeDlg\]::Item\(\$box\.Handle, 1\)\)/, "Retry is the window's own default button");
});

// Task 9e review fix round: the checks' bodies (their findings are pinned further in installer-fix-round.test.mjs).
test("a_write_that_is_denied_is_a_failure_not_a_receipt", () => {
  const check = checkBody("a_write_that_is_denied_is_a_failure_not_a_receipt");
  assert.match(check, /Set-Deny \$exe 'W'/);
  assert.match(check, /finally \{ Clear-Deny \$exe \}/);
  assert.match(check, /if \(\$code -eq 0\) \{ throw/);
  assert.match(check, /the install with the permission restored exited/);
});

test("interactive_update_mode_offers_no_uninstall_choice", () => {
  const check = checkBody("interactive_update_mode_offers_no_uninstall_choice");
  assert.match(check, /Read-MainPage \$Installer @\('\/UPDATE'\)/);
  assert.match(check, /Set-RunValue/);
  assert.match(check, /\$page\.Links -contains 'Other choices'/);
  assert.match(check, /\$page\.Links -contains 'Uninstall Petalock instead'/);
  assert.match(check, /\(Get-RegValue \$RunKey 'Petalock'\) -ne \$run/);
});

test("remove_first_with_an_added_file_leaves_the_install_intact", () => {
  const check = checkBody("remove_first_with_an_added_file_leaves_the_install_intact");
  assert.match(check, /MU-added\.txt/);
  assert.match(check, /be removed first/);
  assert.match(check, /the program was removed before the added file was noticed/);
  assert.match(check, /Assert-OneInstallation \$DefaultDir \$FromVersion/);
});

test("keyboard_tab_order_and_default_buttons_on_the_real_dialog", () => {
  const check = checkBody("keyboard_tab_order_and_default_buttons_on_the_real_dialog");
  assert.match(check, /Send-Key \$d 0x09/);
  assert.match(check, /Send-Key \$d 0x0D/);
  assert.match(check, /\$p\.WaitForExit\(60000\)/);
  assert.match(check, /Enter on the newer-version screen did not end Setup/);
});
