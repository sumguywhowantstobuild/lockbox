#requires -Version 5.1
<#
Plan 5, Task 1: the installer's smoke checks. Installs, upgrades and uninstalls the real installer, for the current user, on
a clean GitHub-hosted Windows runner, and checks what it did and did not touch.

  installer-smoke.ps1 -Installer <path> [-Upgrade <path>] [-Notices <path>] [-LogPath <file>] [-Only <name>,...] [-DryRun]
  installer-smoke.ps1 -SelfTest

Exit 0 only when every check selected passed. 2: the arguments were refused. 3: this is not a GitHub-hosted runner, so
nothing was done (the script installs and removes a program and its settings: it must never run on a person's PC). Every
check logs PASS or FAIL with what differed, to -LogPath and to the console; a failed interactive check also leaves a picture
of the screen beside the log.

-Upgrade is the installer run over the first one (default: the same file). Given as another file, it must be a later version
of the same code (Task 4: the job builds the commit as 0.1.1 and 0.1.2), and the two-version checks are added to the run.
-Notices is the THIRD-PARTY-NOTICES.txt the build made (Task 3): the check installed_copy_has_the_notices_file compares the
installed copy with it, byte for byte, and fails without it.
-DryRun lists the checks and stops. -SelfTest runs the script's own comparisons on made-up folders under the temporary folder
and stops: it installs nothing and touches no registry; it proves each comparison fails on a wrong result and on no change.

Everything made up carries MU-. The checks touch only: the install folder under test, the per-user places the installer writes,
the state folder and the two identifier folders (all planted with made-up files), and the files under $RUNNER_TEMP.
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [string]$Upgrade,
  [string]$Notices,
  [string]$LogPath,
  [string[]]$Only,
  [switch]$DryRun,
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The plan's named checks, in the order they run.
$AllTests = @(
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
  # Plan 5, Task 9e: the one screen in Petalock's look (default folder and receipt; a folder chosen under Options; /P and /S).
  "quick_install_default_folder_and_receipt",
  "quick_install_folder_from_options",
  "quick_install_folder_from_d",
  "quiet_installs_return_exit_codes_and_launch_nothing",
  # The review fix round.
  "a_write_that_is_denied_is_a_failure_not_a_receipt",
  "interactive_update_mode_offers_no_uninstall_choice",
  # The second fix round.
  "a_completed_step_puts_words_in_the_status_line",
  "a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote"
)

# Plan 5, Task 4: the checks that need two versions of the same code, -Installer the earlier and -Upgrade the later.
$UpgradeTests = @(
  "upgrade_keeps_vaults_list_settings_and_state",
  "candidate_versions_upgrade_in_order",
  "downgrade_behaviour_is_the_specified_one",
  "uninstall_after_upgrade_is_clean",
  "interactive_upgrade_keeps_start_with_windows",
  "upgrade_page_defaults_to_install_over",
  # Plan 5, Task 9e review fix round: the added-file refusal and the real keyboard walk (they need an earlier and a later version).
  "remove_first_with_an_added_file_leaves_the_install_intact",
  "keyboard_tab_order_and_default_buttons_on_the_real_dialog"
)

$Sentence = 'Your vaults stay where they are. Petalock keeps them in the folders you chose, by default Petalock Vaults in your user folder.'

# ---------------------------------------------------------------------------------------------------------------------
# Comparisons (pure: they read folders and in-memory tables only, and are what -SelfTest proves)
# ---------------------------------------------------------------------------------------------------------------------

function Get-Sha256([string]$Path) {
  # .NET, not Get-FileHash: that cmdlet comes from a module Windows PowerShell can fail to load when it is started by
  # PowerShell 7 and inherits its module path (the scan job's run on the runner), and the script must not depend on it.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
  finally { $stream.Dispose(); $sha.Dispose() }
}

# A table of what is under a folder: name relative to it -> 'dir', 'link' (a junction or link: listed, never entered), or
#  'file:<sha256>' (-Hash), 'file' (-Names: names only, for folders Windows writes to itself) or 'file:<length>:<last write>'.
# -Depth limits how far down it looks.
function Get-Listing([string]$Root, [int]$Depth = 64, [switch]$Hash, [switch]$Names) {
  $result = @{}
  if (-not [System.IO.Directory]::Exists($Root)) { return $result }
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($Root, '', 0))
  while ($stack.Count -gt 0) {
    $item = $stack.Pop()
    $entries = @()
    try { $entries = @([System.IO.Directory]::EnumerateFileSystemEntries($item[0])) } catch { continue }
    foreach ($entry in $entries) {
      $name = [System.IO.Path]::GetFileName($entry)
      $key = if ($item[1] -eq '') { $name } else { $item[1] + '\' + $name }
      try { $attributes = [System.IO.File]::GetAttributes($entry) } catch { continue }
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $result[$key] = 'link'
      } elseif ($attributes -band [System.IO.FileAttributes]::Directory) {
        $result[$key] = 'dir'
        if ($item[2] + 1 -lt $Depth) { $stack.Push(@($entry, $key, ($item[2] + 1))) }
      } elseif ($Names) {
        $result[$key] = 'file'
      } elseif ($Hash) {
        $result[$key] = 'file:' + (Get-Sha256 $entry)
      } else {
        $info = New-Object System.IO.FileInfo $entry
        $result[$key] = 'file:' + $info.Length + ':' + $info.LastWriteTimeUtc.Ticks
      }
    }
  }
  return $result
}

# What differs between two tables, as sentences, leaving out the names that match one of the wildcard patterns in -Allowed.
function Compare-Listing($Before, $After, [string[]]$Allowed = @()) {
  $found = New-Object System.Collections.ArrayList
  foreach ($key in $After.Keys) {
    if (-not $Before.ContainsKey($key)) { [void]$found.Add(@('added', $key)) }
    elseif ($Before[$key] -ne $After[$key]) { [void]$found.Add(@('changed', $key)) }
  }
  foreach ($key in $Before.Keys) {
    if (-not $After.ContainsKey($key)) { [void]$found.Add(@('removed', $key)) }
  }
  $left = New-Object System.Collections.ArrayList
  foreach ($pair in $found) {
    $skip = $false
    foreach ($pattern in $Allowed) { if ($pair[1] -like $pattern) { $skip = $true } }
    if (-not $skip) { [void]$left.Add($pair[0] + ': ' + $pair[1]) }
  }
  return [string[]]@($left | Sort-Object)
}

# A listing that came back empty for a folder that holds something is not "nothing changed": it fails.
function Assert-Listing($Listing, [string]$Root, [string]$What) {
  $holds = $false
  if ([System.IO.Directory]::Exists($Root)) {
    try { $holds = @([System.IO.Directory]::EnumerateFileSystemEntries($Root)).Count -gt 0 } catch { $holds = $false }
  }
  if ($holds -and $Listing.Count -eq 0) { throw "the listing of $What is empty, but the folder holds files: the comparison would pass on nothing" }
}

# Fails with every difference found. -Expect is how many there must be (a check that found none where some are expected fails).
function Assert-Unchanged($Before, $After, [string]$What, [string[]]$Allowed = @()) {
  $diff = @(Compare-Listing $Before $After $Allowed)
  if ($diff.Count -ne 0) { throw ("$What changed: " + ($diff -join '; ')) }
}

# What a program file is before and after a run: 'absent', or its SHA-256. A refused install must leave it as it was, whether
# it was there (someone else's file) or not.
function Get-ProgramState([string]$Path) {
  if (-not [System.IO.File]::Exists($Path)) { return 'absent' }
  return 'file:' + (Get-Sha256 $Path)
}

function Assert-ProgramUnchanged([string]$Before, [string]$After, [string]$What) {
  if ($Before -ne $After) { throw "$What changed the program file ($Before, then $After)" }
}

# Text an uninstaller or installer printed names no made-up file.
function Assert-NamesNothing([string]$Text, [string[]]$Names, [string]$What) {
  foreach ($name in $Names) {
    if ($Text -like "*$name*") { throw "$What names a file ($name)" }
  }
}

# Removes a file or folder and what is in it, never following a junction or a link: a link is removed itself.
function Remove-Safely([string]$Path) {
  $isDir = [System.IO.Directory]::Exists($Path)
  if (-not $isDir -and -not [System.IO.File]::Exists($Path)) { return }
  $attributes = [System.IO.File]::GetAttributes($Path)
  if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    if ($isDir) { [System.IO.Directory]::Delete($Path) }
    else { [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Normal); [System.IO.File]::Delete($Path) }
    return
  }
  if ($isDir) {
    foreach ($child in @([System.IO.Directory]::EnumerateFileSystemEntries($Path))) { Remove-Safely $child }
    [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Directory)
    [System.IO.Directory]::Delete($Path)
  } else {
    [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($Path)
  }
}

function New-Junction([string]$Link, [string]$Target) {
  $out = & cmd.exe /c mklink /J "$Link" "$Target" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "mklink /J failed: $out" }
}

# An access-denied fixture: this account is denied one right (RD: list a folder, RA: read attributes) on a made-up path, so
# that a read of it fails with "access denied" and not "not found". Clear-Deny takes it away again (a folder that cannot be
# listed also cannot be removed, so every Set-Deny sits in a try with its Clear-Deny in the finally).
function Get-OwnSid { return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Set-Deny([string]$Path, [string]$Right) {
  $out = & icacls.exe $Path /deny ("*" + (Get-OwnSid) + ":(" + $Right + ")") 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls /deny failed: $out" }
}
function Clear-Deny([string]$Path) {
  if ([System.IO.Directory]::Exists($Path) -or [System.IO.File]::Exists($Path)) {
    $out = & icacls.exe $Path /remove:d ("*" + (Get-OwnSid)) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "icacls /remove:d failed: $out" }
  }
}

# The same for a registry key of the current user (Plan 5, Task 9e, second fix round): this account is denied one right on it
# (CreateSubKey: make the key's children, SetValue: change its values) so that Windows refuses the installer's entry in Installed
# apps. $Path is a HKCU:\ path of a key that exists. Clear-RegDeny takes the same rule away; every Set-RegDeny sits in a try with
# its Clear-RegDeny in the finally. Only ever run on the runner.
function Get-RegDenyRule([string]$Right) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier((Get-OwnSid))
  return (New-Object System.Security.AccessControl.RegistryAccessRule($sid, [System.Security.AccessControl.RegistryRights]$Right,
    [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny))
}
function Open-RegForAcl([string]$Path) {
  $sub = $Path -replace '^HKCU:\\', ''
  $rights = [System.Security.AccessControl.RegistryRights]::ChangePermissions -bor [System.Security.AccessControl.RegistryRights]::ReadKey
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
  if ($null -eq $key) { throw "the registry key $Path cannot be opened to change who may write it" }
  return $key
}
function Set-RegDeny([string]$Path, [string]$Right) {
  $key = Open-RegForAcl $Path
  try {
    $acl = $key.GetAccessControl()
    $acl.AddAccessRule((Get-RegDenyRule $Right))
    $key.SetAccessControl($acl)
  } finally { $key.Close() }
}
function Clear-RegDeny([string]$Path, [string]$Right) {
  $key = Open-RegForAcl $Path
  try {
    $acl = $key.GetAccessControl()
    [void]$acl.RemoveAccessRule((Get-RegDenyRule $Right))
    $key.SetAccessControl($acl)
  } finally { $key.Close() }
}

function Write-Utf8([string]$Path, [string]$Text) {
  $folder = [System.IO.Path]::GetDirectoryName($Path)
  if (-not [System.IO.Directory]::Exists($folder)) { [void][System.IO.Directory]::CreateDirectory($folder) }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# The licence notices as installed against the file the build made (scripts/licences.mjs): the same bytes. The build's own file
# must be a whole one first (a long text with its heading and its footer), so two empty or cut files that happen to be equal
# can never pass.
function Assert-NoticesInstalled([string]$Installed, [string]$Expected) {
  if ([string]::IsNullOrEmpty($Expected) -or -not [System.IO.File]::Exists($Expected)) { throw 'the notices file the build made is not there, so the installed copy has nothing to be compared with' }
  $want = [System.IO.File]::ReadAllText($Expected, [System.Text.Encoding]::UTF8)
  if ($want.Length -lt 20000 -or $want -notmatch '(?m)^Petalock: third-party notices\r?$' -or $want -notmatch '(?m)^End of third-party notices: \d+ Rust libraries, \d+ page packages\.\r?$') {
    throw 'the notices file the build made is not a whole one (too short, or without its heading or its footer)'
  }
  if (-not [System.IO.File]::Exists($Installed)) { throw "the installer did not put THIRD-PARTY-NOTICES.txt in the install folder ($Installed)" }
  if ((Get-Sha256 $Installed) -ne (Get-Sha256 $Expected)) {
    throw "the installed THIRD-PARTY-NOTICES.txt is not the file the build made ($((Get-Item -LiteralPath $Installed).Length) bytes, the build's has $((Get-Item -LiteralPath $Expected).Length))"
  }
}

# The texts the installer's status line showed during a real install (Plan 5, Task 9e, second fix round): the problems found, as
# sentences. None read at all is a problem (nothing was compared), a text that is only digits is a problem (a window handle took
# the place of the words), and so is a run that never showed any of the -Outcomes (a completed step's own sentence).
function Get-StatusProblems([string[]]$Texts, [string[]]$Outcomes) {
  $problems = @()
  if ($null -eq $Texts -or @($Texts).Count -eq 0) { return @('the status line was never read') }
  foreach ($t in @($Texts)) {
    if ($t -match '^\s*\d+\s*$') { $problems += "the status line showed a number ('$t') where words belong" }
  }
  $seen = @(@($Texts) | Where-Object { $Outcomes -contains $_ })
  if ($seen.Count -eq 0) { $problems += "no completed step's outcome was ever shown in the status line (it showed: $(@($Texts) -join ' | '))" }
  return $problems
}

# ---------------------------------------------------------------------------------------------------------------------
# -SelfTest: each comparison above on made-up folders in the temporary folder, wrong result and no change both.
# ---------------------------------------------------------------------------------------------------------------------

function Invoke-SelfTest {
  $script:passed = 0
  $ok = { param($what) Write-Output "selftest: ok: $what"; $script:passed++ }
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ('petalock-smoke-selftest-' + [guid]::NewGuid().ToString('N'))
  [void][System.IO.Directory]::CreateDirectory($root)
  try {
    $a = Join-Path $root 'a'
    $outside = Join-Path $root 'MU-outside'
    Write-Utf8 (Join-Path $a 'MU-one.txt') 'MU-one'
    Write-Utf8 (Join-Path $a 'sub\MU-two.txt') 'MU-two'
    Write-Utf8 (Join-Path $outside 'MU-sentinel.txt') 'MU-sentinel'
    $known = Join-Path $root 'MU-known.txt'
    Write-Utf8 $known 'x'
    if ((Get-Sha256 $known) -ne '2D711642B726B04401627CA9FBAC32F5C8530FB1903CC4DB02258717921A4881') { throw 'selftest: Get-Sha256 gave a wrong SHA-256 for a known file' }
    & $ok 'the SHA-256 of a known file is right'
    [System.IO.File]::Delete($known)
    $before = Get-Listing $a -Hash
    if ($before.Count -ne 3) { throw "selftest: the listing found $($before.Count) entries, expected 3" }
    & $ok 'a listing counts what is there'

    $diff = @(Compare-Listing $before (Get-Listing $a -Hash))
    if ($diff.Count -ne 0) { throw "selftest: a change found where nothing changed: $diff" }
    & $ok 'no change is no change'

    Write-Utf8 (Join-Path $a 'MU-one.txt') 'MU-one, changed'
    $diff = @(Compare-Listing $before (Get-Listing $a -Hash))
    if ($diff.Count -ne 1 -or $diff[0] -ne 'changed: MU-one.txt') { throw "selftest: a changed file was not found: $diff" }
    & $ok 'a changed file is found'

    Write-Utf8 (Join-Path $a 'MU-one.txt') 'MU-one'
    Write-Utf8 (Join-Path $a 'MU-added.txt') 'MU-added'
    $diff = @(Compare-Listing $before (Get-Listing $a -Hash))
    if ($diff.Count -ne 1 -or $diff[0] -ne 'added: MU-added.txt') { throw "selftest: an added file was not found: $diff" }
    & $ok 'an added file is found'

    [System.IO.File]::Delete((Join-Path $a 'MU-added.txt'))
    [System.IO.File]::Delete((Join-Path $a 'sub\MU-two.txt'))
    $diff = @(Compare-Listing $before (Get-Listing $a -Hash))
    if ($diff.Count -ne 1 -or $diff[0] -ne 'removed: sub\MU-two.txt') { throw "selftest: a removed file was not found: $diff" }
    & $ok 'a removed file is found'

    $diff = @(Compare-Listing $before (Get-Listing $a -Hash) @('sub\*'))
    if ($diff.Count -ne 0) { throw "selftest: an allowed name was still reported: $diff" }
    Write-Utf8 (Join-Path $a 'MU-other.txt') 'MU-other'
    $diff = @(Compare-Listing $before (Get-Listing $a -Hash) @('sub\*'))
    if ($diff.Count -ne 1 -or $diff[0] -ne 'added: MU-other.txt') { throw "selftest: allowing one name hid another: $diff" }
    & $ok 'an allowed name is left out and nothing else is'
    [System.IO.File]::Delete((Join-Path $a 'MU-other.txt'))

    $refused = $false
    try { Assert-Listing @{} $a 'the made-up folder' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: an empty listing of a folder that holds files was accepted' }
    Assert-Listing $before $a 'the made-up folder'
    & $ok 'an empty listing of a folder that holds files is refused'

    $refused = $false
    try { Assert-Unchanged $before (Get-Listing $a -Hash) 'the made-up folder' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: Assert-Unchanged passed a folder that changed' }
    & $ok 'Assert-Unchanged fails on a change'

    # A foreign folder that starts with a petalock.exe: the check that the program was not put there must pass when that very
    # file is untouched (the first version failed on correct behaviour), and fail when it changes or appears.
    $foreign = Join-Path $root 'MU-foreign'
    Write-Utf8 (Join-Path $foreign 'petalock.exe') 'MU-not the program'
    $programFile = Join-Path $foreign 'petalock.exe'
    $beforeProgram = Get-ProgramState $programFile
    if (-not [System.IO.File]::Exists($programFile)) { throw 'selftest: the fixture has no petalock.exe' }
    Assert-ProgramUnchanged $beforeProgram (Get-ProgramState $programFile) 'a refused install'
    & $ok 'a foreign petalock.exe left untouched is not a failure'
    Write-Utf8 $programFile 'MU-replaced by the installer'
    $refused = $false
    try { Assert-ProgramUnchanged $beforeProgram (Get-ProgramState $programFile) 'a refused install' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: a replaced program file was not reported' }
    & $ok 'a foreign petalock.exe that changed is a failure'
    $none = Get-ProgramState (Join-Path $root 'MU-no-folder\petalock.exe')
    if ($none -ne 'absent') { throw 'selftest: a missing program file did not read as absent' }
    $refused = $false
    try { Assert-ProgramUnchanged $none (Get-ProgramState $programFile) 'a refused install' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: a program file that appeared was not reported' }
    & $ok 'a program file that appeared where none was is a failure'

    $refused = $false
    try { Assert-NamesNothing 'removing MU-held.txt failed' @('MU-held.txt') 'the log' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: text that names a file passed' }
    Assert-NamesNothing 'Some opened copies are still in use.' @('MU-held.txt') 'the log'
    & $ok 'text that names a file fails, and text that names none passes'

    # A link is listed and never entered; and Remove-Safely removes the link, not what it leads to.
    New-Junction (Join-Path $a 'MU-link') $outside
    $withLink = Get-Listing $a -Hash
    if ($withLink['MU-link'] -ne 'link') { throw 'selftest: a junction was not listed as a link' }
    if ($withLink.ContainsKey('MU-link\MU-sentinel.txt')) { throw 'selftest: the listing went through a junction' }
    & $ok 'a junction is listed as a link and not entered'
    Remove-Safely $a
    if ([System.IO.Directory]::Exists($a)) { throw 'selftest: the folder was not removed' }
    if (-not [System.IO.File]::Exists((Join-Path $outside 'MU-sentinel.txt'))) { throw 'selftest: removing a folder followed its junction' }
    & $ok 'removing a folder with a junction in it leaves what the junction led to'

    $b = Join-Path $root 'b'
    New-Junction $b $outside
    Remove-Safely $b
    if ([System.IO.Directory]::Exists($b)) { throw 'selftest: a junction was not removed' }
    if (-not [System.IO.File]::Exists((Join-Path $outside 'MU-sentinel.txt'))) { throw 'selftest: removing a junction removed its target' }
    & $ok 'removing a junction removes only the junction'

    # The access-denied fixture really denies (a deny that did nothing would make the checks that use it pass on nothing).
    $denyDir = Join-Path $root 'MU-deny'
    Write-Utf8 (Join-Path $denyDir 'MU-x.txt') 'MU-x'
    Set-Deny $denyDir 'RD'
    $denied = $false
    try {
      try { [void]@([System.IO.Directory]::EnumerateFileSystemEntries($denyDir)) } catch { $denied = $true }
    } finally {
      Clear-Deny $denyDir
    }
    if (-not $denied) { throw 'selftest: the access-denied fixture did not deny listing' }
    if (@([System.IO.Directory]::EnumerateFileSystemEntries($denyDir)).Count -ne 1) { throw 'selftest: clearing the deny did not give the access back' }
    & $ok 'the access-denied fixture denies listing, and clearing it gives the access back'

    # The installed notices against the build's: the same file passes; a changed, a cut, an absent and an empty copy fail, and a
    # build file that is itself empty or cut fails even when the installed copy is just the same (two equal empty files must
    # not pass).
    $notices = Join-Path $root 'notices'
    $whole = "Petalock: third-party notices`n`n" + ('MU-line of made-up licence text' * 1000) + "`nEnd of third-party notices: 3 Rust libraries, 2 page packages.`n"
    $built = Join-Path $notices 'built.txt'
    Write-Utf8 $built $whole
    Write-Utf8 (Join-Path $notices 'same.txt') $whole
    Assert-NoticesInstalled (Join-Path $notices 'same.txt') $built
    & $ok 'an installed notices file that is the build''s passes'
    $mustFail = {
      param($installedText, $builtText, $what)
      $i = Join-Path $notices 'case-installed.txt'
      $b = Join-Path $notices 'case-built.txt'
      if ($null -ne $installedText) { Write-Utf8 $i $installedText } elseif ([System.IO.File]::Exists($i)) { [System.IO.File]::Delete($i) }
      Write-Utf8 $b $builtText
      $refused = $false
      try { Assert-NoticesInstalled $i $b } catch { $refused = $true }
      if (-not $refused) { throw "selftest: $what was accepted" }
    }
    & $mustFail ($whole.Replace('MU-line', 'MU-LINE')) $whole 'a changed copy'
    & $mustFail $whole.Substring(0, 25000) $whole 'a cut copy'
    & $mustFail $null $whole 'an absent copy'
    & $mustFail '' $whole 'an empty copy'
    & $mustFail '' '' 'two empty files'
    $cut = $whole.Substring(0, 25000)
    & $mustFail $cut $cut 'two equal files that are cut'
    $refused = $false
    try { Assert-NoticesInstalled (Join-Path $notices 'same.txt') '' } catch { $refused = $true }
    if (-not $refused) { throw 'selftest: a missing build file was accepted' }
    & $ok 'a changed, cut, absent or empty installed copy fails, and so does a build file that is empty, cut or missing'

    # The status line's texts: words with an outcome pass; a handle, nothing read and no outcome each fail.
    $outcomes = @('Microsoft WebView2', 'Petalock is installed for this Windows account')
    if (@(Get-StatusProblems @('Getting ready', 'Petalock is installed for this Windows account', 'Adding it to the Start menu') $outcomes).Count -ne 0) { throw 'selftest: words with a completed step were refused' }
    if (@(Get-StatusProblems @('Getting ready', '1511578', 'Petalock is installed for this Windows account') $outcomes).Count -ne 1) { throw 'selftest: a window handle in the status line was not found' }
    if (@(Get-StatusProblems @() $outcomes).Count -ne 1) { throw 'selftest: a status line that was never read was accepted' }
    if (@(Get-StatusProblems @('Getting ready', 'Copying Petalock files') $outcomes).Count -ne 1) { throw 'selftest: a run with no completed step was accepted' }
    & $ok 'the status line check passes words with an outcome, and fails a handle, nothing read and no outcome'
  } finally {
    Remove-Safely $root
  }
  Write-Output "selftest: $($script:passed) checks passed"
}

# ---------------------------------------------------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------------------------------------------------

function Stop-WithCode([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine($Message)
  Write-Output $Message
  exit $Code
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}
if ([string]::IsNullOrEmpty($Installer)) { Stop-WithCode 2 'installer-smoke: -Installer is required' }
if (-not [System.IO.File]::Exists($Installer)) { Stop-WithCode 2 'installer-smoke: -Installer is not a file that exists' }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
if ([string]::IsNullOrEmpty($Upgrade)) { $Upgrade = $Installer }
elseif (-not [System.IO.File]::Exists($Upgrade)) { Stop-WithCode 2 'installer-smoke: -Upgrade is not a file that exists' }
else { $Upgrade = (Resolve-Path -LiteralPath $Upgrade).Path }
if (-not [string]::IsNullOrEmpty($Notices)) {
  if (-not [System.IO.File]::Exists($Notices)) { Stop-WithCode 2 'installer-smoke: -Notices is not a file that exists' }
  $Notices = (Resolve-Path -LiteralPath $Notices).Path
}
$TwoVersions = ($Upgrade -ne $Installer)
$Known = @($AllTests) + @($UpgradeTests)
$selected = if ($TwoVersions) { @($Known) } else { @($AllTests) }
if ($Only -and $Only.Count -gt 0) {
  # A comma-separated list arrives as one string when the script is started by -File from cmd: split it here.
  $Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($name in $Only) {
    if ($Known -notcontains $name) { Stop-WithCode 2 "installer-smoke: unknown test: $name" }
  }
  $selected = @($Known | Where-Object { $Only -contains $_ })
}
# One installer cannot show an upgrade: a two-version check run without a second one could only pass by checking nothing.
if (-not $TwoVersions -and @($selected | Where-Object { $UpgradeTests -contains $_ }).Count -gt 0) {
  Stop-WithCode 2 'installer-smoke: the two-version checks need -Upgrade, a later version of the same code in another file; nothing was done'
}
if ($DryRun) {
  foreach ($name in $selected) { Write-Output "would run: $name" }
  exit 0
}
if (-not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_TEMP)) {
  Stop-WithCode 3 'installer-smoke: this runs only on a GitHub-hosted runner (it installs and removes Petalock and its settings for the current user); nothing was done'
}
# The notices check can't pass without the file to compare with: say so before the first real step, not after the other
# checks have reset the state and installed again (-DryRun, which only lists, left above).
if ($selected -contains 'installed_copy_has_the_notices_file' -and [string]::IsNullOrEmpty($Notices)) {
  Stop-WithCode 2 'installer-smoke: -Notices is required when installed_copy_has_the_notices_file is selected; nothing was done'
}

# ---------------------------------------------------------------------------------------------------------------------
# From here on: the runner only.
# ---------------------------------------------------------------------------------------------------------------------

$Id = 'io.github.sumguywhowantstobuild.petalock'
$LocalApp = [Environment]::GetFolderPath('LocalApplicationData')
$RoamApp = [Environment]::GetFolderPath('ApplicationData')
$Profile_ = [Environment]::GetFolderPath('UserProfile')
$State = Join-Path $LocalApp 'Petalock'
$IdLocal = Join-Path $LocalApp $Id
$IdRoam = Join-Path $RoamApp $Id
$DefaultDir = Join-Path $LocalApp 'Programs\Petalock'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartPrograms = [Environment]::GetFolderPath('Programs')
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalock'
# Tauri's second key is not written any more (the remembered location is the uninstall key's InstallLocation): nothing of
# Petalock's is allowed under HKCU\Software\Petalock, and a made-up value planted there must survive an uninstall.
$OldKey = 'HKCU:\Software\Petalock'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$Work = Join-Path $env:RUNNER_TEMP 'petalock-smoke'
if ([string]::IsNullOrEmpty($LogPath)) { $LogPath = Join-Path $env:RUNNER_TEMP 'installer-smoke\smoke.log' }
$LogDir = [System.IO.Path]::GetDirectoryName($LogPath)
[void][System.IO.Directory]::CreateDirectory($LogDir)
[System.IO.File]::WriteAllText($LogPath, '')

function Write-Log([string]$Text) {
  Write-Host $Text
  [System.IO.File]::AppendAllText($LogPath, $Text + "`r`n")
}

# --- the windows of an installer or uninstaller, driven by messages (the way e2e/lib/folderbox.ps1 drives a dialog) -----

if (-not ('SmokeDlg' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr d, int id);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public int left; public int top; public int right; public int bottom;
  }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  // The window that has the keyboard focus in the thread that owns window h (0 when it cannot be read).
  public static IntPtr FocusOf(IntPtr h) {
    uint pid;
    uint thread = GetWindowThreadProcessId(h, out pid);
    var info = new GuiThreadInfo();
    info.cbSize = Marshal.SizeOf(typeof(GuiThreadInfo));
    if (!GetGUIThreadInfo(thread, ref info)) return IntPtr.Zero;
    return info.hwndFocus;
  }
  public static List<IntPtr> Tops() { var r = new List<IntPtr>(); EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<IntPtr> Kids(IntPtr p) { var r = new List<IntPtr>(); EnumChildWindows(p, (h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Caption(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Text(IntPtr h) { var s = new StringBuilder(4096); SendMessage(h, 0x000D, (IntPtr)4096, s); return s.ToString(); }
  public static int Id(IntPtr h) { return GetDlgCtrlID(h); }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
  public static bool Enabled(IntPtr h) { return IsWindowEnabled(h); }
  public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  // A wizard button pressed as NSIS handles it: WM_COMMAND (the button's id, BN_CLICKED = 0) posted to the outer dialog,
  // which is what Enter sends. Not BM_CLICK: the finished install page's Next press opens the Finish page inside its own
  // handling, Finish is the same button, and a button ignores a BM_CLICK while it is still inside one (runner trial 3).
  // Posted, never sent: a sent IDOK would not return while the next page is up. 0 when queued, else the Win32 error.
  public static int Press(IntPtr dlg, IntPtr button) {
    int id = GetDlgCtrlID(button);
    if (!PostMessage(dlg, 0x0111, (IntPtr)id, button)) return Marshal.GetLastWin32Error();
    return 0;
  }
  public static IntPtr Item(IntPtr d, int id) { return GetDlgItem(d, id); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  // The window that owns h (GW_OWNER, 4): a dialog a program opens over its own window is owned by it.
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  // The text of the visible control with this id anywhere inside dlg; null when there is none (a page that has gone, or not yet made).
  public static string StatusText(IntPtr dlg, int id) {
    foreach (IntPtr k in Kids(dlg)) {
      if (GetDlgCtrlID(k) == id && IsWindowVisible(k)) return Text(k);
    }
    return null;
  }
  // Characters typed into a control one by one, as the keyboard delivers them (WM_CHAR), a tree's incremental search among them:
  // typing a folder's name selects that folder when it is one of the items shown.
  public static void TypeChars(IntPtr h, string s) {
    foreach (char c in s) {
      PostMessage(h, 0x0102, (IntPtr)(int)c, (IntPtr)1);
      System.Threading.Thread.Sleep(60);
    }
  }
  public static void SetCheck(IntPtr h, bool on) { SendMessage(h, 0x00F1, (IntPtr)(on ? 1 : 0), IntPtr.Zero); }
  public static int GetCheck(IntPtr h) { return (int)SendMessage(h, 0x00F0, IntPtr.Zero, IntPtr.Zero); }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendText(IntPtr h, uint m, IntPtr w, string l);
  // WM_SETTEXT (0xC) crosses processes (Windows copies the string), so another program's edit box can be filled.
  public static void SetText(IntPtr h, string s) { SendText(h, 0x000C, IntPtr.Zero, s); }
  // A key pressed and released as the keyboard does, delivered to the control that has the focus in the dialog's thread:
  // the dialog's own message loop (IsDialogMessage) then handles Tab and Enter, which is the point.
  public static void Key(IntPtr dlg, int vk) {
    IntPtr target = FocusOf(dlg);
    if (target == IntPtr.Zero) target = dlg;
    PostMessage(target, 0x0100, (IntPtr)vk, (IntPtr)1);
    PostMessage(target, 0x0101, (IntPtr)vk, unchecked((IntPtr)(int)0xC0000001));
  }
}
"@
}

# One visible dialog window of the installer or uninstaller: its handle and everything in it. With -Owned, only the windows
# of the processes in -Pids (the program this run started), so a window left by another run is never driven; an empty or
# missing -Pids then matches no window (PowerShell turns an empty result into $null, which must not mean "any").
function Get-Dialogs([int[]]$Pids = $null, [switch]$Owned) {
  $found = @()
  foreach ($h in [SmokeDlg]::Tops()) {
    if (-not [SmokeDlg]::Visible($h)) { continue }
    if ([SmokeDlg]::Cls($h) -ne '#32770') { continue }
    if ($Owned -and ($null -eq $Pids -or $Pids -notcontains [int][SmokeDlg]::Pid($h))) { continue }
    $caption = [SmokeDlg]::Caption($h)
    if ($caption -notlike '*Petalock*') { continue }
    $kids = @()
    foreach ($k in [SmokeDlg]::Kids($h)) {
      $kids += [pscustomobject]@{ Handle = $k; Class = [SmokeDlg]::Cls($k); Text = ([SmokeDlg]::Text($k) -replace '&', ''); Id = [SmokeDlg]::Id($k); Enabled = [SmokeDlg]::Enabled($k); Visible = [SmokeDlg]::Visible($k) }
    }
    $found += [pscustomobject]@{ Handle = $h; Caption = $caption; Kids = $kids }
  }
  return $found
}

function Find-Button($Dialog, [string]$Text) {
  return @($Dialog.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Text -eq $Text })[0]
}

# The words a dialog shows: every static control's text, in one string.
function Get-DialogText($Dialog) {
  return (($Dialog.Kids | Where-Object { $_.Class -eq 'Static' -and $_.Text }) | ForEach-Object { $_.Text }) -join "`n"
}

# Waits for a message box with a button of that text; returns it.
function Wait-Box([string]$Button, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($d in (Get-Dialogs)) {
      if (Find-Button $d $Button) { return $d }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "no message box with a '$Button' button appeared within $Seconds s"
}

# Review fix round, finding 22: Tab or Enter sent through the real dialog (to the control that has the focus), then a pause for the
# dialog to act.
function Send-Key($Dialog, [int]$Vk) {
  [SmokeDlg]::Key($Dialog.Handle, $Vk)
  Start-Sleep -Milliseconds 400
}

# The text of the control that has the keyboard focus in a dialog ('' when it cannot be read).
function Get-FocusedText($Dialog) {
  $f = [SmokeDlg]::FocusOf($Dialog.Handle)
  if ($f -eq [IntPtr]::Zero) { return '' }
  return ([SmokeDlg]::Text($f) -replace '&', '')
}

# Review fix round, finding 19, rewritten for runner trial 3: the system's folder dialog opened by Browse is the tree-style "Browse For
# Folder" (SHBrowseForFolder: a tree, OK, Cancel, no Folder box, no fixed caption), driven for real. It is found by what it is: a
# dialog of Setup's own process that Setup's window owns (the outer dialog $Owner or a page inside it) and that holds a tree view;
# nothing is assumed of its caption or its language. The dialog opens with the folder Setup offered selected, so typing the name of a
# folder that sits beside it (WM_CHAR into the tree: its incremental search) selects that one, and OK is pressed by its control id
# (1). Throws when no such dialog appears.
function Choose-Folder([string]$Typed, [int]$Pid_, [IntPtr]$Owner) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    foreach ($h in [SmokeDlg]::Tops()) {
      if (-not [SmokeDlg]::Visible($h) -or [SmokeDlg]::Cls($h) -ne '#32770' -or [int][SmokeDlg]::Pid($h) -ne $Pid_ -or $h -eq $Owner) { continue }
      $tree = @([SmokeDlg]::Kids($h) | Where-Object { [SmokeDlg]::Cls($_) -eq 'SysTreeView32' })[0]
      if (-not $tree) { continue }
      $own = [SmokeDlg]::Owner($h)
      if ($own -ne $Owner -and @([SmokeDlg]::Kids($Owner)) -notcontains $own) { Write-Log "  (a folder dialog of Setup's process is not owned by its window: owner $own)"; continue }
      $ok = [SmokeDlg]::Item($h, 1)
      if ($ok -eq [IntPtr]::Zero) { continue }
      # The tree selects the folder Setup offered a moment after it appears: the typing waits for that.
      Start-Sleep -Milliseconds 1500
      [SmokeDlg]::TypeChars($tree, $Typed)
      Start-Sleep -Milliseconds 700
      [SmokeDlg]::Click($ok)
      Start-Sleep -Milliseconds 800
      return
    }
    Start-Sleep -Milliseconds 250
  }
  Save-Screen 'no-folder-dialog'
  throw 'the folder dialog never appeared (a dialog of Setup, owned by its window, holding a tree)'
}

# The window of an installer this run started ($Process) whose words match -Like, waited for (bounded).
function Wait-PageText($Process, [string]$Like, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($d in @(Get-Dialogs @([int]$Process.Id) -Owned)) { if ((Get-DialogText $d) -like $Like) { return $d } }
    Start-Sleep -Milliseconds 250
  }
  Save-Screen 'no-page'
  throw "the installer window never showed words like: $Like"
}

# Plan 5, Task 9e: the window of an installer this run started ($Process), with Petalock running. The page says so only after
# its default button is pressed (the checks run then), so the first page is waited for, its default button pressed once, and
# the window that then says "Close Petalock, then try again." is returned (its default button is Retry, its other one Cancel).
function Wait-RunningPage($Process, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $pressed = $false
  while ((Get-Date) -lt $deadline) {
    foreach ($d in @(Get-Dialogs @([int]$Process.Id) -Owned)) {
      $text = Get-DialogText $d
      if ($text -like '*Close Petalock, then try again*') { return $d }
      if (-not $pressed -and $text -like '*What Setup will do*') {
        $next = [SmokeDlg]::Item($d.Handle, 1)
        if ($next -ne [IntPtr]::Zero -and [SmokeDlg]::Enabled($next)) { Start-Sleep -Milliseconds 1000; [void][SmokeDlg]::Press($d.Handle, $next); $pressed = $true }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'the installer window never said "Close Petalock, then try again."'
}

function Save-Screen([string]$Name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $path = Join-Path $LogDir ("screen-" + ($Name -replace '[^A-Za-z0-9_-]', '_') + '.png')
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    Write-Log "  (screen saved: $path)"
  } catch { Write-Log "  (no screen picture: $($_.Exception.Message))" }
}

# --- running the installer and the uninstaller --------------------------------------------------------------------------

# Runs a program and waits for it; its exit code. A program that does not end in time is stopped and the check fails.
function Invoke-Program([string]$Exe, [string[]]$ArgList, [int]$Seconds = 240) {
  $p = Start-Tracked $Exe $ArgList
  if (-not $p.WaitForExit($Seconds * 1000)) {
    try { $p.Kill() } catch { }
    throw "$([System.IO.Path]::GetFileName($Exe)) did not finish within $Seconds s"
  }
  return Get-ExitCode $p
}

# The exit code of a process that has ended. Windows PowerShell leaves ExitCode empty for a process started with
# -PassThru unless its handle was taken while it ran (-RedirectStandardOutput made it empty in the first runner trial), so
# the handle is taken by Start-Tracked, and an empty code is an error here and never a pass.
function Get-ExitCode($Process) {
  $code = $Process.ExitCode
  if ($null -eq $code -or "$code" -eq '') { throw "the exit code of $($Process.ProcessName) could not be read" }
  return [int]$code
}

# Start-Process with -PassThru that keeps the process handle, so the exit code can be read later.
function Start-Tracked([string]$Exe, [string[]]$ArgList, [hashtable]$Extra = @{}) {
  if ($ArgList -and $ArgList.Count -gt 0) { $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -PassThru @Extra }
  else { $p = Start-Process -FilePath $Exe -PassThru @Extra }
  $null = $p.Handle
  return $p
}

# The installer, silent, into -Dir (or the default folder, or the remembered one, when -Dir is empty).
function Install-Silent([string]$Exe, [string]$Dir) {
  if ($Dir) { return Invoke-Program $Exe @('/S', "/D=$Dir") }
  return Invoke-Program $Exe @('/S')
}

# The uninstaller run in place (so its exit code is seen); it leaves its own uninstall.exe and the folder, which the caller
# removes as the installer does after an upgrade.
function Uninstall-InPlace([string]$Dir, [bool]$Silent = $true) {
  $args_ = @('/S', "_?=$Dir")
  return Invoke-Program (Join-Path $Dir 'uninstall.exe') $args_
}

# The uninstaller as Windows starts it (it copies itself to the temporary folder and runs from there): waits until the
# copy has finished. No exit code is seen.
function Uninstall-AsWindowsDoes([string]$Dir, [string[]]$ArgList = @('/S')) {
  $p = Start-Process -FilePath (Join-Path $Dir 'uninstall.exe') -ArgumentList $ArgList -PassThru
  [void]$p.WaitForExit(60000)
  Wait-Until { -not (Get-UninstallerCopies) } 120 'the uninstaller copy did not end'
}

# The copy of itself an uninstaller runs from: NSIS starts it as $TEMP\~nsuN.tmp\<name>.exe (Source/exehead/Main.c:369-403 in
# NSIS 3.13), so it is found by that folder and not by a name.
function Get-UninstallerCopies {
  $found = @()
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $p.Path } catch { }
    if ($path -and $path -like '*\~nsu*.tmp\*') { $found += $p }
  }
  return $found
}

# The processes a program started itself: the installer's "uninstall first" runs the old version's uninstaller in place
# (`_?=`), as its own process with its own window (runner trial 4), and that window belongs to this run too. WMI through
# .NET, not a module cmdlet (a PowerShell 7 parent's module path can hide those).
function Get-ChildIds([int]$ParentId) {
  $ids = @()
  try {
    foreach ($p in ([wmisearcher]"SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = $ParentId").Get()) { $ids += [int]$p.ProcessId }
  } catch { }
  return $ids
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Message) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 300
  }
  throw $Message
}

# Drives an installer or uninstaller window by window until its process is gone: -Tick true or false sets the uninstall
# box; -Texts collects the text of every page it passes; the "Run Petalock" box of the finish page is cleared. Returns the
# texts. A message box with Retry or Cancel is answered with -OnBox ('Cancel' or 'Retry'), once; another one is a failure.
# Only the windows of the program this run started are driven. Each page (the inner dialog NSIS makes for it) gets one
# press of its Next (or Finish), as NSIS handles a press ([SmokeDlg]::Press); a press is posted again only when it could not
# be queued, so a delayed press is never delivered to the following page before its choices are set. A page that does not
# move is described in the log after 30 s and the run fails at the time limit.
function Drive-Wizard($Process, [string]$Kind, [bool]$Tick = $false, [string]$OnBox = '', [scriptblock]$BeforeRetry = $null, [int]$Seconds = 240, [bool]$UninstallFirst = $false, [scriptblock]$OnPage = $null) {
  $texts = New-Object System.Collections.ArrayList
  $answered = $false
  $chosen = $false
  $radioTries = 0
  $seen = $false
  $pageSince = Get-Date
  $pageKey = $null
  $pageWnd = [IntPtr]::Zero
  $pageWndSince = Get-Date
  $pageQueued = $false
  $pagePresses = 0
  $allPresses = 0
  $lastPress = [DateTime]::MinValue
  $lastPressError = 0
  $stuckLogged = $false
  $deadline = (Get-Date).AddSeconds($Seconds)
  $lastClick = [DateTime]::MinValue
  while ((Get-Date) -lt $deadline) {
    $alive = if ($Process) { -not $Process.HasExited } else { [bool](Get-UninstallerCopies) }
    $pids = if ($Process) { @([int]$Process.Id) + @(Get-ChildIds ([int]$Process.Id)) } else { @(Get-UninstallerCopies | ForEach-Object { [int]$_.Id }) }
    $dialogs = @(Get-Dialogs $pids -Owned)
    if ($dialogs.Count -gt 0) { $seen = $true }
    # Done when a window has been seen and the program is gone with none left. A program that has not yet shown anything
    # is waited for (the uninstaller copies itself first).
    if ($seen -and -not $alive -and $dialogs.Count -eq 0) {
      if ($UninstallFirst -and -not $chosen) { throw "the $Kind ended without the reinstall page's uninstall-first choice being made" }
      Write-Log "  ($Kind window: $($texts.Count) pages, $allPresses presses)"
      return ,$texts
    }
    foreach ($d in $dialogs) {
      $retry = Find-Button $d 'Retry'
      if ($retry) {
        [void]$texts.Add((Get-DialogText $d))
        if ($answered -or -not $OnBox) { throw "an unexpected message box: $(Get-DialogText $d)" }
        $answered = $true
        if ($OnBox -eq 'Retry') {
          if ($BeforeRetry) { & $BeforeRetry }
          [SmokeDlg]::Click($retry.Handle)
        } else {
          [SmokeDlg]::Click((Find-Button $d 'Cancel').Handle)
        }
        Start-Sleep -Milliseconds 800
        continue
      }
      # The outer dialog's own Next (or Finish) button, by its id on the outer dialog: never a page's control of the same id.
      $next = [SmokeDlg]::Item($d.Handle, 1)
      if ($next -eq [IntPtr]::Zero -or -not [SmokeDlg]::Visible($next)) { continue }
      $text = Get-DialogText $d
      if ($text -and ($texts.Count -eq 0 -or $texts[$texts.Count - 1] -ne $text)) { [void]$texts.Add($text) }
      if ($text -ne $pageKey) { $pageKey = $text; $pageSince = Get-Date; $stuckLogged = $false }
      # The page itself: the visible inner dialog NSIS makes for each page (a new window per page).
      $inner = @($d.Kids | Where-Object { $_.Class -eq '#32770' -and $_.Visible })[0]
      $innerWnd = if ($inner) { $inner.Handle } else { [IntPtr]::Zero }
      # Between pages no inner dialog may be visible: then nothing is pressed and the last page's state is kept, so the
      # same page coming back never gets a second press. Only a different page resets it.
      if ($innerWnd -eq [IntPtr]::Zero) { continue }
      if ($innerWnd -ne $pageWnd) {
        $pageWnd = $innerWnd; $pageWndSince = Get-Date; $pageQueued = $false; $pagePresses = 0
        # Each new page is shown to -OnPage once, before anything on it is set or pressed (Task 4 reads the reinstall page).
        if ($OnPage) { & $OnPage $d }
      }
      # After an Abort the page says so, its Next button stays off, and Cancel is what closes it.
      if ($text -match 'Aborted') {
        $close = [SmokeDlg]::Item($d.Handle, 2)
        if ($close -ne [IntPtr]::Zero -and [SmokeDlg]::Enabled($d.Handle) -and [SmokeDlg]::Visible($close) -and [SmokeDlg]::Enabled($close) -and ((Get-Date) - $lastClick).TotalMilliseconds -gt 1500) {
          $lastPressError = [SmokeDlg]::Press($d.Handle, $close); $lastClick = Get-Date; $allPresses++
          if ($lastPressError -ne 0) { Write-Log "  (the $Kind window's Cancel press was not queued: Win32 error $lastPressError)" }
        }
        continue
      }
      # A page that has not changed for 30 s is described in the log, so a stuck wizard can be read without a rerun.
      if (-not $stuckLogged -and ((Get-Date) - $pageSince).TotalSeconds -gt 30) {
        $stuckLogged = $true
        $state = ($d.Kids | Where-Object { $_.Class -eq 'Button' } | ForEach-Object { "[$($_.Id) '$($_.Text)' enabled=$($_.Enabled) visible=$($_.Visible)]" }) -join ' '
        $responding = if ($Process) { "responding=$($Process.Responding) exited=$($Process.HasExited)" } else { 'no process handle' }
        # The window in front, by process only (another program's title is never written to the log).
        $front = [SmokeDlg]::Foreground()
        $frontText = if ($front -eq [IntPtr]::Zero) { 'none' } else { $fp = [int][SmokeDlg]::Pid($front); "pid $fp ($(if ($pids -contains $fp) { 'this program' } else { 'another program' }))" }
        Write-Log "  (the $Kind page has not changed for 30 s: $responding; outer enabled=$([SmokeDlg]::Enabled($d.Handle)) pid $([SmokeDlg]::Pid($d.Handle)); in front: $frontText; $pagePresses presses on this page as WM_COMMAND, last error $lastPressError; buttons $state)"
      }
      # Nothing is pressed while the outer dialog is off (a message box is up) or its Next is off (the install is running).
      if (-not [SmokeDlg]::Enabled($d.Handle) -or -not [SmokeDlg]::Enabled($next)) { continue }
      # The main page's other way (-UninstallFirst), a real click each time: on the same version the link "Uninstall Petalock
      # instead..." (a full uninstall: the existing uninstaller opens, and Setup ends when it has finished); on an update, the link
      # "Other choices" and then its check box "Remove ... before installing ..." (the page reads the box, so a choice that did not
      # take would silently install over), which must read as ticked before Install is pressed.
      if ($UninstallFirst -and -not $chosen) {
        $uninstallLink = @($d.Kids | Where-Object { $_.Visible -and $_.Text -like 'Uninstall Petalock instead*' })[0]
        if ($uninstallLink) { [SmokeDlg]::Click($uninstallLink.Handle); $chosen = $true; Start-Sleep -Milliseconds 800; continue }
        $remove = @($d.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Remove*before installing*' })[0]
        $other = @($d.Kids | Where-Object { $_.Visible -and $_.Text -eq 'Other choices' })[0]
        if ($remove) {
          if ([SmokeDlg]::GetCheck($remove.Handle) -eq 1) { $chosen = $true }
          elseif ($radioTries -ge 3) { throw "the main page's choice '$($remove.Text)' did not take after $radioTries clicks" }
          else { [SmokeDlg]::Click($remove.Handle); $radioTries++; Start-Sleep -Milliseconds 800; continue }
        } elseif ($other) {
          if ($radioTries -ge 3) { throw "the main page's 'Other choices' did not open its choice after $radioTries clicks" }
          [SmokeDlg]::Click($other.Handle); $radioTries++; Start-Sleep -Milliseconds 800; continue
        }
      }
      $box = @($d.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Text -like 'Delete the application data*' })[0]
      if ($box -and $Kind -eq 'uninstall') { [SmokeDlg]::SetCheck($box.Handle, $Tick) }
      # The last page's box is cleared: nothing is started by the window ("Open Petalock", or the older "Run Petalock").
      foreach ($run in @($d.Kids | Where-Object { $_.Class -eq 'Button' -and ($_.Text -like 'Open Petalock*' -or $_.Text -like 'Run Petalock*' -or $_.Text -like 'Create desktop shortcut*') })) { [SmokeDlg]::SetCheck($run.Handle, $false) }
      # One press per page, once the page has stood for 1 s (its boxes exist and are set before it is left); posted again
      # only after a press that could not be queued.
      if (-not $pageQueued -and ((Get-Date) - $pageWndSince).TotalMilliseconds -gt 1000 -and ((Get-Date) - $lastPress).TotalMilliseconds -gt 1500) {
        $lastPressError = [SmokeDlg]::Press($d.Handle, $next)
        $lastPress = Get-Date; $pagePresses++; $allPresses++
        if ($lastPressError -eq 0) { $pageQueued = $true }
        else { Write-Log "  (the $Kind window's Next press was not queued: Win32 error $lastPressError)" }
      }
    }
    Start-Sleep -Milliseconds 400
  }
  $last = if ($texts.Count -gt 0) { $texts[$texts.Count - 1] } else { '(no page was seen)' }
  throw "the $Kind did not finish within $Seconds s; last page: $last"
}

# The installer or uninstaller with its windows, run to the end; the texts of the pages and the exit code if it is the process.
function Install-Interactive([string]$Exe, [string]$Dir, [string]$OnBox = '', [scriptblock]$BeforeRetry = $null) {
  # A typed empty list, never the output of an `if` (which is $null for an empty branch, and fails `.Count` under strict mode).
  [string[]]$argList = @()
  if ($Dir) { $argList = @("/D=$Dir") }
  $p = Start-Tracked $Exe $argList
  $texts = Drive-Wizard $p 'install' $false $OnBox $BeforeRetry
  return [pscustomobject]@{ Texts = $texts; Exit = (Get-ExitCode $p) }
}

function Uninstall-Interactive([string]$Dir, [bool]$Tick, [string]$OnBox = '', [scriptblock]$BeforeRetry = $null) {
  $p = Start-Process -FilePath (Join-Path $Dir 'uninstall.exe') -PassThru
  [void]$p.WaitForExit(2000)
  $texts = Drive-Wizard $null 'uninstall' $Tick $OnBox $BeforeRetry
  Wait-Until { -not (Get-UninstallerCopies) } 120 'the uninstaller copy did not end'
  return [pscustomobject]@{ Texts = $texts }
}

# --- the world the checks start from ---------------------------------------------------------------------------------------

function Stop-Petalock {
  foreach ($p in @(Get-Process -Name 'petalock' -ErrorAction SilentlyContinue)) {
    try { $p.Kill(); [void]$p.WaitForExit(15000) } catch { }
  }
}

# Back to a clean per-user setup: no program, no entry, no state, no shortcut, no folder of ours. Only the places this
# script plants or the installer writes are touched, on the runner.
function Reset-World {
  Stop-Petalock
  # A window left open by a check that failed holds the install folder as its working folder: it goes first.
  foreach ($p in @(Get-UninstallerCopies)) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch { } }
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $p.Path } catch { }
    # The installers, and anything running from a folder under test (an uninstaller run in place by "uninstall first" holds
    # its own uninstall.exe, and every later check's clean-up failed on it in runner trial 4).
    $underTest = $path -and ($path.StartsWith($Work + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($DefaultDir + '\', [System.StringComparison]::OrdinalIgnoreCase))
    if ($path -and ($path -eq $Installer -or $path -eq $Upgrade -or $underTest)) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch { } }
  }
  foreach ($path in @($DefaultDir, $State, $IdLocal, $IdRoam, $Work,
      (Join-Path $Desktop 'Petalock.lnk'), (Join-Path $StartPrograms 'Petalock.lnk'))) {
    Remove-Safely $path
  }
  Remove-Item -LiteralPath 'HKCU:\Software\Petalock' -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -ErrorAction SilentlyContinue
  [void][System.IO.Directory]::CreateDirectory($Work)
}

function Get-RegValue([string]$Path, [string]$Name) {
  try { return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name } catch { return $null }
}

function Get-UninstallValue([string]$Name) { return Get-RegValue $UninstallKey $Name }

function Test-Installed([string]$Dir) {
  return ([System.IO.File]::Exists((Join-Path $Dir 'petalock.exe')) -and [System.IO.File]::Exists((Join-Path $Dir 'uninstall.exe')))
}

# What an installed program is: the files of the install folder (hashed) and the entry in the registry.
function Get-InstallState([string]$Dir) {
  $listing = Get-Listing $Dir -Hash
  Assert-Listing $listing $Dir 'the install folder'
  $entry = [string](Get-UninstallValue 'DisplayVersion') + '|' + [string](Get-UninstallValue 'InstallLocation') + '|' + [string](Get-UninstallValue 'UninstallString')
  $run = [string](Get-RegValue $RunKey 'Petalock')
  $listing['<registry>'] = "entry:$entry|run:$run"
  return $listing
}

function Install-Good([string]$Dir) {
  $code = Install-Silent $Installer $Dir
  if ($code -ne 0) { throw "the silent install into a safe folder exited $code" }
  if (-not (Test-Installed $(if ($Dir) { $Dir } else { $DefaultDir }))) { throw 'the install left no program and uninstaller' }
  # A scanner may hold a new program for a moment; the next step must not be taken for a running Petalock.
  Start-Sleep -Seconds 2
}

# Planted state: the state folder as the app leaves it, with made-up contents. Returns the hashes of everything but open\.
function New-StateFixture {
  $files = @{
    'vaults.json' = '{"version":2,"list":1,"last_id":1,"vaults":[]} MU-vaults'
    'settings.json' = '{"version":1} MU-settings'
    'restore-journal.json' = '{"version":1} MU-journal'
    'pending-outputs.json' = '{"version":1} MU-outputs'
    'vault-state.json' = '{"version":1} MU-vault-state'
    'MU-unknown.json' = '{"MU":"unknown"}'
  }
  foreach ($name in $files.Keys) { Write-Utf8 (Join-Path $State $name) $files[$name] }
  Write-Utf8 (Join-Path $State 'open\MU-copy.txt') 'MU-copy of an opened file'
  Write-Utf8 (Join-Path $State 'open\0123456789abcdef0123456789abcdef\MU-copy2.txt') 'MU-copy two'
  return (Get-Listing $State -Hash)
}

function Without-Open($Listing) {
  $copy = @{}
  foreach ($k in $Listing.Keys) { if ($k -ne 'open' -and -not $k.StartsWith('open\')) { $copy[$k] = $Listing[$k] } }
  return $copy
}

function Set-RunValue {
  Set-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -Value '"C:\MU-made-up\petalock.exe" --hidden'
}

# Plan 5, Task 4: versions. The version a file carries in its Windows version resource (the installer's and the program's
# ProductVersion), as x.y.z; anything else is an error, never an empty answer that two files could share.
function Get-EmbeddedVersion([string]$Path) {
  $text = [string]([System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion)
  $m = [regex]::Match($text, '^\s*(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { throw "the version resource of $([System.IO.Path]::GetFileName($Path)) holds no x.y.z version ('$text')" }
  return "$($m.Groups[1].Value).$($m.Groups[2].Value).$($m.Groups[3].Value)"
}

# The two installers' versions, read back: plain x.y.z (decision 4a, no "rc" text), and -Installer's earlier than -Upgrade's.
# Sets $FromVersion and $ToVersion for the checks.
function Assert-VersionPair {
  $script:FromVersion = Get-EmbeddedVersion $Installer
  $script:ToVersion = Get-EmbeddedVersion $Upgrade
  foreach ($v in @($script:FromVersion, $script:ToVersion)) {
    if ($v -notmatch '^\d+\.\d+\.\d+$') { throw "a candidate version is not a plain x.y.z: $v" }
  }
  if ([version]$script:FromVersion -ge [version]$script:ToVersion) {
    throw "-Installer carries $($script:FromVersion) and -Upgrade $($script:ToVersion): the second must be the later version"
  }
  Write-Log "  versions: -Installer $($script:FromVersion), -Upgrade $($script:ToVersion)"
}

# Exactly one installation, in -Dir, at -Version: one program folder under Programs, one uninstall entry for Petalock (and its
# version), and the installed program's own version resource.
function Assert-OneInstallation([string]$Dir, [string]$Version) {
  if (-not (Test-Installed $Dir)) { throw "no program and uninstaller in the install folder (expected version $Version)" }
  $registered = [string](Get-UninstallValue 'DisplayVersion')
  if ($registered -ne $Version) { throw "the uninstall entry says version '$registered', not $Version" }
  $location = ([string](Get-UninstallValue 'InstallLocation')).Trim('"')
  if ($location -ne $Dir) { throw 'the uninstall entry names another install folder' }
  $program = Get-EmbeddedVersion (Join-Path $Dir 'petalock.exe')
  if ($program -ne $Version) { throw "the installed program carries version $program, not $Version" }
  $entries = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.GetValue('DisplayName') -like 'Petalock*' })
  if ($entries.Count -ne 1) { throw "there are $($entries.Count) uninstall entries for Petalock, not one" }
  $programs = Join-Path $LocalApp 'Programs'
  $folders = @(Get-ChildItem -LiteralPath $programs -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Installed $_.FullName })
  $elsewhere = @(Get-ChildItem -LiteralPath $Work -Directory -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { Test-Installed $_.FullName })
  if (($folders.Count + $elsewhere.Count) -ne 1) { throw "there are $($folders.Count + $elsewhere.Count) folders holding a Petalock program, not one" }
}

# Runs the installer -Exe through its window to the end (Drive-Wizard, taking each page's default) and reads its first page on the
# way (Plan 5, Task 9e: the one page that says what Setup will do, whatever is installed): its words, the words on its default
# button (Install, Update, Reinstall, Replace or Downgrade), the links it offers, and (after "Other choices" is opened) the check
# box "Remove ... before installing ..." with whether it can be chosen and whether it is ticked; and the installer's exit code.
function Read-MainPage([string]$Exe, [string[]]$ExtraArgs = @()) {
  # Filled by the page reader below, which Drive-Wizard calls from its own scope: found by name through the caller's scope.
  $MainFound = @{}
  $reader = {
    param($d)
    if ($MainFound.Count -gt 0) { return }
    if ((Get-DialogText $d) -notlike '*What Setup will do*') { return }
    $MainFound['Text'] = (Get-DialogText $d) -replace '\s+', ' '
    $MainFound['Next'] = [SmokeDlg]::Text([SmokeDlg]::Item($d.Handle, 1)) -replace '&', ''
    # (The script is plain ASCII: the ellipsis after "instead" is matched with a wildcard, and the link is named without it.)
    $MainFound['Links'] = @($d.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and ($_.Text -in @('Options', 'Other choices', 'Licence (MIT)') -or $_.Text -like 'Uninstall Petalock instead*') } |
      ForEach-Object { if ($_.Text -like 'Uninstall Petalock instead*') { 'Uninstall Petalock instead' } else { $_.Text } })
    # Open "Other choices" (an update, a newer or an unknown version) and read the box that appears.
    $other = @($d.Kids | Where-Object { $_.Visible -and $_.Text -eq 'Other choices' })[0]
    $MainFound['Choices'] = @()
    if ($other) {
      [SmokeDlg]::Click($other.Handle)
      Start-Sleep -Milliseconds 1000
      $now = @(Get-Dialogs | Where-Object { $_.Handle -eq $d.Handle })[0]
      if ($now) {
        $MainFound['Choices'] = @($now.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Remove*before installing*' } |
          ForEach-Object { [pscustomobject]@{ Text = $_.Text; Enabled = [bool]$_.Enabled; Checked = ([SmokeDlg]::GetCheck($_.Handle) -eq 1) } })
      }
    }
  }
  $p = Start-Tracked $Exe $ExtraArgs
  [void](Drive-Wizard $p 'install' $false '' $null 240 $false $reader)
  $exit = Get-ExitCode $p
  if ($MainFound.Count -eq 0) { Save-Screen 'no-main-page'; throw 'the window went through no page that says what Setup will do' }
  Write-Log "  main page: $($MainFound['Text']) | button: $($MainFound['Next']) | links: $($MainFound['Links'] -join ', ') | choices: $(($MainFound['Choices'] | ForEach-Object { "'$($_.Text)' enabled=$($_.Enabled) ticked=$($_.Checked)" }) -join '; ') | exit $exit"
  return [pscustomobject]@{ Text = $MainFound['Text']; Next = $MainFound['Next']; Links = $MainFound['Links']; Choices = $MainFound['Choices']; Exit = $exit }
}

# Plan 5, Task 4b (kept by Task 9e). A page read by Read-MainPage, on an upgrade or a downgrade: its default action installs over
# ('Update', or 'Downgrade' / 'Replace'), and the other way, 'Remove ... before installing ...', is offered under 'Other choices'
# (enabled, not ticked). Each part must be found: a reader that found none must fail.
function Assert-InstallOverDefault($Page, [string]$What) {
  if ($Page.Next -notin @('Update', 'Downgrade', 'Replace')) { throw "the main page on $What does not offer to install over ('$($Page.Next)')" }
  if ($Page.Links -notcontains 'Other choices') { throw "the main page on $What does not offer 'Other choices'" }
  $remove = @($Page.Choices | Where-Object { $_.Text -like 'Remove*before installing*' })[0]
  if (-not $remove) { throw "the main page on $What does not offer 'Remove ... before installing ...' under 'Other choices'" }
  if (-not $remove.Enabled) { throw "the main page on $What shows a choice that cannot be chosen" }
  if ($remove.Checked) { throw "the main page on $What opens with 'Remove ... before installing ...' ticked" }
}

# The same version: 'Reinstall' is the action, and 'Uninstall Petalock instead' (with its ellipsis) is the way to the full uninstall;
# no check box.
function Assert-ReinstallPage($Page) {
  if ($Page.Next -ne 'Reinstall') { throw "the same-version page's action is '$($Page.Next)', not 'Reinstall'" }
  if ($Page.Links -notcontains 'Uninstall Petalock instead') { throw "the same-version page does not offer 'Uninstall Petalock instead'" }
  if (@($Page.Choices).Count -ne 0) { throw 'the same-version page offers a remove-first box' }
}

# Plan 5, Task 4b fix round (review finding 3). A page reader for Drive-Wizard's -OnPage that notes the uninstaller's confirm page
# (the page whose own Next button reads 'Uninstall') and whether it offers the "Delete the application data" box. It fills the
# hashtable $ConfirmPage the caller made (found by name through the caller's scope, as Read-ReinstallPage's reader does).
function New-ConfirmPageReader {
  return {
    param($d)
    $next = [SmokeDlg]::Item($d.Handle, 1)
    if ($next -eq [IntPtr]::Zero) { return }
    if (([SmokeDlg]::Text($next) -replace '&', '') -ne 'Uninstall') { return }
    $ConfirmPage.Seen++
    if (@($d.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Text -like 'Delete the application data*' }).Count -gt 0) { $ConfirmPage.Box++ }
  }
}

# The confirm page was seen exactly once (a reader that saw none must fail, not pass), with the app-data box (-WithBox, a full
# uninstall) or without it (the old uninstaller an upgrade runs with /UPDATE, where the box would do nothing).
function Assert-ConfirmPageBox($Seen, [bool]$WithBox, [string]$What) {
  if ($Seen.Seen -ne 1) { throw "$What : the uninstaller's confirm page was seen $($Seen.Seen) times, not once" }
  if ($WithBox -and $Seen.Box -ne 1) { throw "$What : the full uninstall's confirm page does not offer 'Delete the application data'" }
  if (-not $WithBox -and $Seen.Box -ne 0) { throw "$What : the uninstaller run with /UPDATE offers 'Delete the application data', which it would ignore" }
}

# Plan 5, Task 4b. -First installed silently (the caller has reset the world), with the made-up state, made-up files in the
# two identifier folders, and the Run value the app writes (pointing at the installed program); then -Exe run through its own
# window, with the reinstall page's default choice or, with -UninstallFirst, its uninstall choice ('Uninstall before
# installing', or 'Uninstall Petalock' for the same version). Its exit code must be 0. Returns what was planted.
function Invoke-WindowOver([string]$First, [string]$Exe, [bool]$UninstallFirst, [scriptblock]$OnPage = $null) {
  $code = Install-Silent $First ''
  if ($code -ne 0) { throw "the silent install of the first version exited $code" }
  Start-Sleep -Seconds 2
  $planted = New-StateFixture
  Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
  Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
  $others = @{}
  foreach ($path in @($IdRoam, $IdLocal)) {
    $others[$path] = Get-Listing $path -Hash
    Assert-Listing $others[$path] $path "the folder $([System.IO.Path]::GetFileName($path))"
  }
  $run = '"' + (Join-Path $DefaultDir 'petalock.exe') + '" --hidden'
  Set-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -Value $run
  $p = Start-Tracked $Exe @()
  [void](Drive-Wizard $p 'install' $false '' $null 240 $UninstallFirst $OnPage)
  $exit = Get-ExitCode $p
  if ($exit -ne 0) { throw "the window ended with exit $exit" }
  Start-Sleep -Seconds 2
  return [pscustomobject]@{ Planted = $planted; Run = $run; Others = $others }
}

# What a run of Invoke-WindowOver must leave: the state folder byte for byte, the identifier folders too, and open\ either
# untouched (the default installs over: no uninstaller runs) or gone (the old uninstaller ran, with /UPDATE, and cleans it).
function Assert-WindowKept($r, [bool]$UninstallFirst, [string]$What) {
  $now = Get-Listing $State -Hash
  if ($UninstallFirst) {
    if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw "$What : the old uninstaller did not run (open\ is still there)" }
    Assert-Unchanged (Without-Open $r.Planted) (Without-Open $now) "the state folder after $What (open\ aside)"
  } else {
    Assert-Unchanged $r.Planted $now "the state folder after $What (open\ included: no uninstaller runs)"
  }
  foreach ($path in $r.Others.Keys) {
    Assert-Unchanged $r.Others[$path] (Get-Listing $path -Hash) "the folder $([System.IO.Path]::GetFileName($path)) after $What"
  }
}

function Start-PetalockHidden([string]$Dir) {
  $p = Start-Process -FilePath (Join-Path $Dir 'petalock.exe') -ArgumentList '--hidden' -PassThru
  $name = "Local\$Id.instance"
  $deadline = (Get-Date).AddSeconds(90)
  $seen = $false
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { Save-Screen 'petalock-exited'; throw 'petalock.exe exited early' }
    $m = $null
    try { if ([System.Threading.Mutex]::TryOpenExisting($name, [ref]$m)) { $m.Dispose(); $seen = $true; break } } catch { }
    Start-Sleep -Milliseconds 250
  }
  if (-not $seen) { Save-Screen 'petalock-no-lock'; throw "petalock.exe never took its instance lock ($name)" }
  # Its launch work (restore, sweeps) runs before its window is built: give it time.
  Start-Sleep -Seconds 5
  if ($p.HasExited) { throw 'petalock.exe exited after starting' }
  return $p
}

# --- snapshots of the places the installer may write --------------------------------------------------------------------------

function Get-RegistrySnapshot($Base, [string]$Path, [string[]]$Skip = @()) {
  $result = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($Path)
  while ($stack.Count -gt 0) {
    $sub = $stack.Pop()
    $skipThis = $false
    foreach ($s in $Skip) { if ($sub -like "$s*") { $skipThis = $true } }
    if ($skipThis) { continue }
    $key = $null
    try { $key = $Base.OpenSubKey($sub) } catch { continue }
    if (-not $key) { continue }
    try {
      $result["$sub|"] = 'key'
      foreach ($name in $key.GetValueNames()) {
        $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $text = if ($value -is [byte[]]) { [Convert]::ToBase64String($value) } elseif ($value -is [string[]]) { $value -join "`n" } else { [string]$value }
        $result["$sub|$name"] = $text
      }
      foreach ($child in $key.GetSubKeyNames()) { $stack.Push($sub + '\' + $child) }
    } finally { $key.Dispose() }
  }
  return $result
}

function Get-PlacesSnapshot {
  $s = @{}
  $folders = [ordered]@{
    'Profile' = @($Profile_, 1); 'Desktop' = @($Desktop, 1); 'Documents' = @([Environment]::GetFolderPath('MyDocuments'), 1)
    'AppData' = @($RoamApp, 1); 'LocalAppData' = @($LocalApp, 1); 'LocalPrograms' = @((Join-Path $LocalApp 'Programs'), 3)
    'StartPrograms' = @($StartPrograms, 2)
  }
  foreach ($label in $folders.Keys) {
    $listing = Get-Listing $folders[$label][0] $folders[$label][1] -Names
    foreach ($k in $listing.Keys) { $s["$label\$k"] = $listing[$k] }
  }
  # Shell bookkeeping Windows writes by itself (recent items, bags, user assist) is not the installer's.
  $skip = @('Software\Microsoft\Windows\CurrentVersion\Explorer', 'Software\Microsoft\Windows\Shell', 'Software\Microsoft\Internet Explorer',
    'Software\Classes\Local Settings', 'Software\Microsoft\Windows\CurrentVersion\Search')
  $cu = Get-RegistrySnapshot ([Microsoft.Win32.Registry]::CurrentUser) 'Software' $skip
  foreach ($k in $cu.Keys) { $s["HKCU\$k"] = $cu[$k] }
  foreach ($p in @('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'SOFTWARE\Petalock',
      'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'SOFTWARE\WOW6432Node\Petalock')) {
    $lm = Get-RegistrySnapshot ([Microsoft.Win32.Registry]::LocalMachine) $p
    foreach ($k in $lm.Keys) { $s["HKLM\$k"] = $lm[$k] }
  }
  return $s
}

# --- the checks -----------------------------------------------------------------------------------------------------------

$Checks = @{}

$Checks["install_folder_is_programs_petalock_by_default"] = {
  Reset-World
  $code = Install-Silent $Installer ''
  if ($code -ne 0) { throw "the silent install with no folder given exited $code" }
  if (-not (Test-Installed $DefaultDir)) { throw "no program and uninstaller in $DefaultDir" }
  $location = [string](Get-UninstallValue 'InstallLocation')
  if ($location.Trim('"') -ne $DefaultDir) { throw "the uninstall entry says the install location is not the default (entry differs from LocalAppData\Programs\Petalock)" }
  if ([System.IO.Directory]::Exists($State)) { throw 'the install made the state folder (LocalAppData\Petalock)' }
  if ([System.IO.Directory]::Exists($IdLocal) -or [System.IO.Directory]::Exists($IdRoam)) { throw 'the install made an identifier folder' }
  # The program inside carries the installer's own version (Task 4 review: a build folder kept from a candidate build could
  # otherwise put a program of another version inside this installer, and nothing else would see it).
  $want = Get-EmbeddedVersion $Installer
  $got = Get-EmbeddedVersion (Join-Path $DefaultDir 'petalock.exe')
  if ($got -ne $want) { throw "the installed program carries version $got, but the installer $want" }
}

$Checks["install_refuses_an_unsafe_folder"] = {
  Reset-World
  # First, a fresh profile: the protected folders are still absent. A spelling Windows would normalise (a name ending in a
  # period or a space) is refused before anything is compared, and refusing makes nothing.
  $absent = [ordered]@{
    'the state folder spelled with a trailing period' = "$State."
    'the state folder spelled with a trailing space' = "$State "
    'a folder inside the state folder, behind a name with a trailing period' = (Join-Path "$State." 'MU-inside')
    'the Local identifier folder with a trailing period' = "$IdLocal."
    'the Roaming identifier folder with a trailing period' = "$IdRoam."
    'a folder inside the Roaming identifier folder, behind a name with a trailing space' = (Join-Path "$IdRoam " 'MU-inside')
  }
  foreach ($label in $absent.Keys) {
    $code = Install-Silent $Installer $absent[$label]
    if ($code -eq 0) { throw "the silent install into $label exited 0" }
    foreach ($made in @($State, $IdLocal, $IdRoam, (Join-Path $LocalApp 'Programs\Petalock'))) {
      if ([System.IO.Directory]::Exists($made)) { throw "the install into $label made a folder: $([System.IO.Path]::GetFileName($made))" }
    }
    if (Get-UninstallValue 'DisplayName') { throw "the install into $label left an uninstall entry" }
    Write-Log "  refused while the folders are absent: $label (exit $code)"
  }
  $vault = Join-Path $Work 'MU-vault'
  Write-Utf8 (Join-Path $vault 'vault.json') '{"MU":"header"}'
  Write-Utf8 (Join-Path $vault 'MU-data.bin') 'MU-vault data'
  $own = Join-Path $Work 'MU-own'
  Write-Utf8 (Join-Path $own 'MU-own.txt') 'MU-someone elses file'
  # Someone else's folder that has both of the installer's file names in it: two names are not proof of an installation.
  $both = Join-Path $Work 'MU-both-names'
  Write-Utf8 (Join-Path $both 'petalock.exe') 'MU-not the program'
  Write-Utf8 (Join-Path $both 'uninstall.exe') 'MU-not the uninstaller'
  Write-Utf8 (Join-Path $both 'MU-own.txt') 'MU-someone elses file'
  # A folder that cannot be listed: whether it is empty cannot be told, so it is not used.
  $nolist = Join-Path $Work 'MU-nolist\inner'
  Write-Utf8 (Join-Path $nolist 'MU-x.txt') 'MU-x'
  Write-Utf8 (Join-Path $State 'MU-state.txt') 'MU-state'
  Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
  Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
  New-Junction (Join-Path $Work 'MU-link') $State
  $cases = [ordered]@{
    'the state folder' = $State
    'a folder inside the state folder' = (Join-Path $State 'MU-inside')
    'the Roaming identifier folder' = $IdRoam
    'a folder inside the Local identifier folder' = (Join-Path $IdLocal 'MU-inside')
    'a vault folder' = $vault
    'a folder inside a vault folder' = (Join-Path $vault 'Petalock')
    'a folder holding someone else''s file' = $own
    'a folder holding both of the installer''s file names and someone else''s file' = $both
    'a folder that cannot be listed' = $nolist
    'a folder reached through a junction into the state folder' = (Join-Path $Work 'MU-link\MU-inside')
    'a path with a .. in it' = (Join-Path $Work 'MU-x\..\MU-y')
  }
  $watched = @($State, $IdRoam, $IdLocal, $vault, $own, $both)
  $before = @{}
  foreach ($w in $watched) { $before[$w] = Get-Listing $w -Hash; Assert-Listing $before[$w] $w "the folder $([System.IO.Path]::GetFileName($w))" }
  $count = 0
  Set-Deny $nolist 'RD'
  try {
  foreach ($label in $cases.Keys) {
    $dir = $cases[$label]
    $existed = [System.IO.Directory]::Exists($dir)
    $programBefore = Get-ProgramState (Join-Path $dir 'petalock.exe')
    $code = Install-Silent $Installer $dir
    if ($code -eq 0) { throw "the silent install into $label exited 0" }
    if (Get-UninstallValue 'DisplayName') { throw "the install into $label left an uninstall entry" }
    if (Test-Path -LiteralPath 'HKCU:\Software\Petalock') { throw "the install into $label left a registry key" }
    foreach ($w in $watched) { Assert-Unchanged $before[$w] (Get-Listing $w -Hash) "a folder after the install into $label" }
    if ([System.IO.Directory]::Exists($dir) -ne $existed) { throw "the install into $label changed whether that folder exists" }
    # Compared with what was there before: a folder that already held a petalock.exe (the foreign one) must still hold that
    # very file, and a folder that held none must still hold none.
    Assert-ProgramUnchanged $programBefore (Get-ProgramState (Join-Path $dir 'petalock.exe')) "the install into $label"
    if (Test-Path -LiteralPath (Join-Path $Work 'MU-y')) { throw 'the install made a folder through a .. path' }
    if (Test-Path -LiteralPath (Join-Path $Work 'MU-x')) { throw 'the install made a folder through a .. path' }
    Write-Log "  refused: $label (exit $code)"
    $count++
  }
  } finally {
    Clear-Deny $nolist
  }
  if ($count -ne $cases.Count) { throw "only $count of $($cases.Count) refusals were checked" }

  # An upgrade whose remembered location (the uninstall key's InstallLocation, the only place the installer records it)
  # was replaced by an unsafe one. A recorded folder that holds no uninstaller and is not empty is someone else's.
  $good = Join-Path $Work 'MU-good\Petalock'
  Install-Good $good
  $goodBefore = Get-InstallState $good
  $unsafe = [ordered]@{ 'the state folder' = $State; 'a vault folder' = $vault; 'a folder holding someone else''s file' = $own }
  foreach ($label in $unsafe.Keys) {
    Set-ItemProperty -LiteralPath $UninstallKey -Name 'InstallLocation' -Value ('"' + $unsafe[$label] + '"')
    $code = Install-Silent $Upgrade ''
    if ($code -eq 0) { throw "an upgrade remembering $label exited 0" }
    Set-ItemProperty -LiteralPath $UninstallKey -Name 'InstallLocation' -Value ('"' + $good + '"')
    Assert-Unchanged $goodBefore (Get-InstallState $good) "the installed program after an upgrade that remembered $label"
    foreach ($w in $watched) { Assert-Unchanged $before[$w] (Get-Listing $w -Hash) "a folder after an upgrade that remembered $label" }
    Write-Log "  refused: an upgrade remembering $label (exit $code)"
  }
}

$Checks["files_added_after_install_survive_upgrade_and_uninstall"] = {
  Reset-World
  $dir = Join-Path $Work 'MU-keep\Petalock'
  Install-Good $dir
  $later = Join-Path $dir 'MU-later.txt'
  Write-Utf8 $later 'MU-later: added after the install'
  $laterHash = Get-Sha256 $later
  # A value an earlier Tauri setup kept in the uninstall key ("MainBinaryName") names no file setup may delete: planted
  # with the name of a file added after the install, and with a wildcard, an upgrade must leave that file alone.
  $beside = Join-Path (Split-Path $dir) 'MU-beside.txt'
  Write-Utf8 $beside 'MU-beside: next to the install folder, not in it'
  foreach ($planted in @('MU-later.txt', '*.txt', '..\MU-beside.txt')) {
    Set-ItemProperty -LiteralPath $UninstallKey -Name 'MainBinaryName' -Value $planted
    $code = Install-Silent $Upgrade ''
    if ($code -ne 0) { throw "the upgrade with MainBinaryName '$planted' exited $code" }
    if (-not [System.IO.File]::Exists($later) -or (Get-Sha256 $later) -ne $laterHash) { throw "an upgrade deleted or changed a file that the registry value '$planted' named" }
    if (-not [System.IO.File]::Exists($beside)) { throw "an upgrade deleted a file outside the install folder that the registry value '$planted' named" }
  }
  Remove-ItemProperty -LiteralPath $UninstallKey -Name 'MainBinaryName' -ErrorAction SilentlyContinue
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the upgrade over the install exited $code" }
  if (-not (Test-Installed $dir)) { throw 'the upgrade left no program in the folder' }
  if ((Get-Sha256 $later) -ne $laterHash) { throw 'the upgrade changed the file added after the install' }
  Start-Sleep -Seconds 2
  Uninstall-AsWindowsDoes $dir
  if ([System.IO.File]::Exists((Join-Path $dir 'petalock.exe')) -or [System.IO.File]::Exists((Join-Path $dir 'uninstall.exe'))) { throw 'the uninstall left the installer''s own files' }
  if (-not [System.IO.File]::Exists($later) -or (Get-Sha256 $later) -ne $laterHash) { throw 'the uninstall removed or changed the file added after the install' }
  if (Get-UninstallValue 'DisplayName') { throw 'the uninstall left its registry entry' }

  # The install folder made a junction after the install: an upgrade and an uninstall refuse before any change.
  Reset-World
  $dir = Join-Path $Work 'MU-keep2\Petalock'
  Install-Good $dir
  $real = "$dir.real"
  [System.IO.Directory]::Move($dir, $real)
  New-Junction $dir $real
  $before = Get-InstallState $real
  $code = Install-Silent $Upgrade ''
  if ($code -eq 0) { throw 'an upgrade into a folder that had become a junction exited 0' }
  Assert-Unchanged $before (Get-InstallState $real) 'the program after an upgrade into a junction'
  $code = Uninstall-InPlace $dir
  if ($code -eq 0) { throw 'an uninstall of a folder that had become a junction exited 0' }
  Assert-Unchanged $before (Get-InstallState $real) 'the program after an uninstall through a junction'
  [System.IO.Directory]::Delete($dir)

  # A registered installation whose program is gone (an antivirus quarantined the unsigned file): an upgrade still works,
  # bound to the recorded folder, and puts the program back.
  Reset-World
  $dir = Join-Path $Work 'MU-quarantine\Petalock'
  Install-Good $dir
  Write-Utf8 (Join-Path $dir 'MU-later.txt') 'MU-later'
  [System.IO.File]::Delete((Join-Path $dir 'petalock.exe'))
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "an upgrade over a registered installation whose program was missing exited $code" }
  if (-not (Test-Installed $dir)) { throw 'the upgrade did not put the program back' }

  # An upgrade that uninstalls first (Task 9e: "Other choices", then "Remove ... before installing ..." on the main page; on the same
  # version, the link "Uninstall Petalock instead", a full uninstall that ends Setup) runs the uninstaller in the recorded
  # folder, built from that folder: a command planted in the uninstall key's UninstallString is never run.
  Reset-World
  $dir = Join-Path $Work 'MU-first\Petalock'
  Install-Good $dir
  $marker = Join-Path $Work 'MU-decoy-ran.txt'
  $decoy = Join-Path $Work 'MU-decoy.cmd'
  Write-Utf8 $decoy ("@echo off`r`necho MU > `"$marker`"`r`n")
  Set-ItemProperty -LiteralPath $UninstallKey -Name 'UninstallString' -Value ('"' + $decoy + '"')
  # Proof the old uninstaller really ran (Task 1 re-check new 6): only it cleans the opened copies in open\.
  $proof = Join-Path $State 'open\MU-proof.txt'
  Write-Utf8 (Join-Path $State 'open\MU-proof.txt') 'MU-proof: an opened copy only the uninstaller removes'
  $p = Start-Tracked $Upgrade @()
  [void](Drive-Wizard $p 'install' $false '' $null 240 $true)
  if ([System.IO.File]::Exists($marker)) { throw 'the command planted in UninstallString was run' }
  if ([System.IO.File]::Exists($proof)) { throw 'the old uninstaller did not run (the opened copy planted in open\ is still there)' }
  if ((Get-ExitCode $p) -ne 0) { throw 'the interactive upgrade that uninstalls first did not end with exit 0' }
  if ((Get-EmbeddedVersion $Installer) -eq (Get-EmbeddedVersion $Upgrade)) {
    # The same version: the page's way is the full uninstall, which ends Setup (nothing is installed after it).
    if (Test-Installed $dir) { throw "the same version's 'Uninstall Petalock instead' left the program installed" }
    if (Get-UninstallValue 'DisplayName') { throw "the same version's 'Uninstall Petalock instead' left the uninstall entry" }
  } else {
    if (-not (Test-Installed $dir)) { throw 'the upgrade that uninstalls first left no program' }
    if ([string](Get-UninstallValue 'UninstallString') -ne ('"' + (Join-Path $dir 'uninstall.exe') + '"')) { throw 'the uninstall command was not written back as the recorded folder''s own uninstaller' }
  }
}

$Checks["install_writes_only_its_own_places"] = {
  Reset-World
  $before = Get-PlacesSnapshot
  if ($before.Count -lt 50) { throw "the snapshot of the user's places holds only $($before.Count) entries: it would pass on nothing" }
  $code = Install-Silent $Installer ''
  if ($code -ne 0) { throw "the silent install exited $code" }
  Start-Sleep -Seconds 2
  $after = Get-PlacesSnapshot
  # Its own places: the program folder, two shortcuts, and the uninstall key. Nothing under HKCU\Software\Petalock (Tauri's
  # second key, which this installer no longer writes), and nothing in the machine's registry.
  $allowed = @('Desktop\Petalock.lnk', 'StartPrograms\Petalock.lnk', 'LocalPrograms', 'LocalPrograms\Petalock', 'LocalPrograms\Petalock\*', 'LocalAppData\Programs',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalock|*',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalock\*')
  # One value of Windows' own is let through, and only as a change: the Start menu rewrites its Config value when a new
  # Start menu shortcut appears (runner trial 5). Every other value under that key, and any add or removal, still counts.
  $startConfig = 'changed: HKCU\Software\Microsoft\Windows\CurrentVersion\Start|Config'
  $diff = @(Compare-Listing $before $after $allowed | Where-Object { $_ -ne $startConfig })
  if ($diff.Count -ne 0) { throw ('the install changed places that are not its own: ' + ($diff -join '; ')) }
  if (Test-Path -LiteralPath $OldKey) { throw 'the install wrote HKCU\Software\Petalock' }
  # The check itself must be able to see that key: a made-up write there, as a second snapshot, is a difference it reports.
  $planted = @{} + $after
  $planted['HKCU\Software\Petalock|MU-planted'] = 'MU'
  # Through the same filter as above, so Windows' own Config rewrite never counts here either: the planted write is the
  # one difference, by name.
  $plantedDiff = @(Compare-Listing $before $planted $allowed | Where-Object { $_ -ne $startConfig })
  if ($plantedDiff.Count -ne 1 -or $plantedDiff[0] -ne 'added: HKCU\Software\Petalock|MU-planted') { throw 'the allow-list would let a write to HKCU\Software\Petalock through' }
  # What it should have written is there (the comparison above proves nothing if the install wrote nothing).
  $wrote = @(Compare-Listing $before $after @())
  foreach ($need in @('added: LocalPrograms\Petalock\petalock.exe', 'added: LocalPrograms\Petalock\uninstall.exe', 'added: HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalock|DisplayName')) {
    if ($wrote -notcontains $need) { throw "the install did not write what it must: $need" }
  }
  foreach ($k in $wrote) { if ($k -like '*HKLM*') { throw "the install wrote to the machine's registry: $k" } }
}

$Checks["uninstall_removes_open_copies_and_nothing_else"] = {
  Reset-World
  Install-Good $DefaultDir
  $planted = New-StateFixture
  $vault = Join-Path $Work 'MU-vault'
  Write-Utf8 (Join-Path $vault 'vault.json') '{"MU":"header"}'
  Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
  Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
  Set-RunValue
  # Someone else's value under HKCU\Software\Petalock: the uninstall deletes no key it did not make.
  New-Item -Path $OldKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $OldKey -Name 'MU-unrelated' -Value 'MU-keep'
  $others = @{}
  foreach ($path in @($vault, $IdRoam, $IdLocal)) { $others[$path] = Get-Listing $path -Hash; Assert-Listing $others[$path] $path "the folder $([System.IO.Path]::GetFileName($path))" }
  $keep = Without-Open $planted
  if ($keep.Count -lt 6) { throw "the planted state holds only $($keep.Count) entries" }

  # An uninstaller that is not in the recorded installation's folder (a copy of uninstall.exe put in another folder, or run
  # from an empty one) removes nothing: not the entry, not the opened copies, not the program.
  $elsewhere = Join-Path $Work 'MU-elsewhere'
  [void][System.IO.Directory]::CreateDirectory($elsewhere)
  [System.IO.File]::Copy((Join-Path $DefaultDir 'uninstall.exe'), (Join-Path $elsewhere 'uninstall.exe'))
  $installed = Get-InstallState $DefaultDir
  $stateBefore = Get-Listing $State -Hash
  $code = Uninstall-InPlace $elsewhere
  if ($code -eq 0) { throw 'an uninstaller run from a folder that is not the recorded installation exited 0' }
  Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the installation after an uninstaller ran from another folder'
  Assert-Unchanged $stateBefore (Get-Listing $State -Hash) 'the state after an uninstaller ran from another folder'
  Write-Log '  an uninstaller run from another folder: refused, nothing touched'

  # A registered installation whose program is gone (quarantined): the uninstall still cleans the opened copies and finishes.
  [System.IO.File]::Delete((Join-Path $DefaultDir 'petalock.exe'))
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "the uninstall of a registered installation whose program was missing exited $code" }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there after the uninstall of an installation with no program' }
  if (Get-UninstallValue 'DisplayName') { throw 'the uninstall entry is still there after the uninstall of an installation with no program' }
  Write-Log '  a registered installation with no program: opened copies cleaned, entry removed'

  # And the ordinary one, as Windows runs it.
  Reset-World
  Install-Good $DefaultDir
  $planted = New-StateFixture
  Write-Utf8 (Join-Path $vault 'vault.json') '{"MU":"header"}'
  Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
  Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
  Set-RunValue
  New-Item -Path $OldKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $OldKey -Name 'MU-unrelated' -Value 'MU-keep'
  $others = @{}
  foreach ($path in @($vault, $IdRoam, $IdLocal)) { $others[$path] = Get-Listing $path -Hash; Assert-Listing $others[$path] $path "the folder $([System.IO.Path]::GetFileName($path))" }
  $keep = Without-Open $planted
  Uninstall-AsWindowsDoes $DefaultDir
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'the install folder is still there' }
  if (Get-UninstallValue 'DisplayName') { throw 'the uninstall entry is still there' }
  if ($null -ne (Get-RegValue $RunKey 'Petalock')) { throw 'the Run\Petalock value is still there' }
  if ((Get-RegValue $OldKey 'MU-unrelated') -ne 'MU-keep') { throw 'the uninstall removed a value under HKCU\Software\Petalock that it did not make' }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there' }
  Assert-Unchanged $keep (Get-Listing $State -Hash) 'the state folder (everything but open\)'
  foreach ($path in $others.Keys) { Assert-Unchanged $others[$path] (Get-Listing $path -Hash) "the folder $([System.IO.Path]::GetFileName($path))" }
}

$Checks["the_app_data_box_removes_exactly_the_identifier_folders"] = {
  $plant = {
    Reset-World
    Install-Good $DefaultDir
    $script:statePlanted = New-StateFixture
    $script:outside = Join-Path $Work 'MU-outside'
    Write-Utf8 (Join-Path $outside 'MU-sentinel.txt') 'MU-sentinel'
    Write-Utf8 (Join-Path $RoamApp 'MU-outside-roaming.txt') 'MU-outside roaming'
    Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
    Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
    Write-Utf8 (Join-Path $IdLocal 'sub\MU-deep.txt') 'MU-deep'
    New-Junction (Join-Path $IdLocal 'MU-link') $outside
    New-Junction (Join-Path $IdLocal 'sub\MU-link2') $outside
    $script:idListings = @{ roam = (Get-Listing $IdRoam -Hash); local = (Get-Listing $IdLocal -Hash) }
    $script:outsideListing = Get-Listing $outside -Hash
  }
  $assertOutside = {
    Assert-Unchanged $outsideListing (Get-Listing $outside -Hash) 'the folder the junctions led to'
    if (-not [System.IO.File]::Exists((Join-Path $RoamApp 'MU-outside-roaming.txt'))) { throw 'a file outside the identifier folders was removed' }
    Assert-Unchanged (Without-Open $statePlanted) (Get-Listing $State -Hash) 'the state folder (everything but open\)'
  }
  # Ticked: exactly the two identifier folders go.
  & $plant
  [void](Uninstall-Interactive $DefaultDir $true)
  if ([System.IO.Directory]::Exists($IdRoam)) { throw 'ticked: the Roaming identifier folder is still there' }
  if ([System.IO.Directory]::Exists($IdLocal)) { throw 'ticked: the Local identifier folder is still there' }
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'ticked: the install folder is still there' }
  & $assertOutside
  Write-Log '  ticked: both identifier folders removed, junctions not followed'
  # Unticked: both stay.
  & $plant
  [void](Uninstall-Interactive $DefaultDir $false)
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'unticked: the install folder is still there' }
  Assert-Unchanged $idListings.roam (Get-Listing $IdRoam -Hash) 'unticked: the Roaming identifier folder'
  Assert-Unchanged $idListings.local (Get-Listing $IdLocal -Hash) 'unticked: the Local identifier folder'
  & $assertOutside
  Write-Log '  unticked: both identifier folders kept'
  # Silent: both stay (the box exists only in the window).
  & $plant
  Uninstall-AsWindowsDoes $DefaultDir
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'silent: the install folder is still there' }
  Assert-Unchanged $idListings.roam (Get-Listing $IdRoam -Hash) 'silent: the Roaming identifier folder'
  Assert-Unchanged $idListings.local (Get-Listing $IdLocal -Hash) 'silent: the Local identifier folder'
  & $assertOutside
  Write-Log '  silent: both identifier folders kept'
}

$Checks["uninstall_never_follows_a_junction"] = {
  $outsideSentinel = {
    $script:outside = Join-Path $Work 'MU-outside'
    Write-Utf8 (Join-Path $outside 'MU-sentinel.txt') 'MU-sentinel'
    Write-Utf8 (Join-Path $outside 'MU-copy.txt') 'MU-looks like a copy'
    $script:outsideBefore = Get-Listing $outside -Hash
  }
  $assertSentinel = { param($what) Assert-Unchanged $outsideBefore (Get-Listing $outside -Hash) "the folder the junction led to ($what)" }

  # 1. open\ is a junction to a folder outside.
  Reset-World
  Install-Good $DefaultDir
  & $outsideSentinel
  Write-Utf8 (Join-Path $State 'vaults.json') 'MU-vaults'
  New-Junction (Join-Path $State 'open') $outside
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "an uninstall with open\ as a junction exited $code" }
  & $assertSentinel 'open\ was the junction'
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'the junction at open\ is still there' }
  if ([System.IO.File]::Exists((Join-Path $DefaultDir 'petalock.exe'))) { throw 'the program was not removed' }
  if (-not [System.IO.File]::Exists((Join-Path $State 'vaults.json'))) { throw 'the vault list was removed' }
  Write-Log '  open\ as a junction: removed itself, target kept'

  # 2. a junction inside open\.
  Reset-World
  Install-Good $DefaultDir
  & $outsideSentinel
  Write-Utf8 (Join-Path $State 'open\MU-x\MU-copy.txt') 'MU-copy'
  New-Junction (Join-Path $State 'open\MU-x\MU-link') $outside
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "an uninstall with a junction inside open\ exited $code" }
  & $assertSentinel 'a junction inside open\'
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there' }
  Write-Log '  a junction inside open\: removed itself, target kept'

  # 3. the state folder itself is a junction: nothing behind it is touched, and the uninstall says it could not finish.
  Reset-World
  Install-Good $DefaultDir
  & $outsideSentinel
  $target = Join-Path $Work 'MU-state-target'
  Write-Utf8 (Join-Path $target 'open\MU-copy.txt') 'MU-copy'
  Write-Utf8 (Join-Path $target 'vaults.json') 'MU-vaults'
  New-Junction $State $target
  $targetBefore = Get-Listing $target -Hash
  $installed = Get-InstallState $DefaultDir
  $code = Uninstall-InPlace $DefaultDir
  if ($code -eq 0) { throw 'an uninstall with the state folder as a junction exited 0' }
  Assert-Unchanged $targetBefore (Get-Listing $target -Hash) 'the folder the state folder''s junction led to'
  & $assertSentinel 'the state folder was the junction'
  Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the program after the refused uninstall'
  Write-Log '  the state folder as a junction: uninstall stopped, nothing touched'
  [System.IO.Directory]::Delete($State)
}

$Checks["a_held_or_read_only_copy_is_reported_not_left_silently"] = {
  # A read-only copy is removed.
  Reset-World
  Install-Good $DefaultDir
  $copy = Join-Path $State 'open\MU-readonly.txt'
  Write-Utf8 $copy 'MU-read only copy'
  [System.IO.File]::SetAttributes($copy, [System.IO.FileAttributes]::ReadOnly)
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "an uninstall with a read-only copy exited $code" }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'the read-only copy was not removed' }
  Write-Log '  a read-only copy: removed'

  # A copy that cannot be read (access denied, which is not "not found"): the uninstall stops with everything in place, and
  # once the access is back it finishes.
  Reset-World
  Install-Good $DefaultDir
  $denied = Join-Path $State 'open\MU-denied-folder'
  Write-Utf8 (Join-Path $denied 'MU-copy.txt') 'MU-copy in a folder that cannot be listed'
  $installed = Get-InstallState $DefaultDir
  Set-Deny $denied 'RD'
  try {
    $code = Uninstall-InPlace $DefaultDir
    if ($code -eq 0) { throw 'an uninstall with an unreadable folder in open\ exited 0' }
    Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the program after the uninstall that could not read open\'
    if (-not [System.IO.Directory]::Exists($denied)) { throw 'the unreadable folder was reported removed' }
  } finally {
    Clear-Deny $denied
  }
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "the uninstall after the access was back exited $code" }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there after the access was back' }
  Write-Log '  an unreadable folder in open\: the uninstall stopped, and finished once it could read it'

  # A copy held open by another process: silent stops first, interactive offers Retry and Cancel.
  Reset-World
  Install-Good $DefaultDir
  $held = Join-Path $State 'open\MU-held.txt'
  Write-Utf8 $held 'MU-held copy'
  $handle = [System.IO.File]::Open($held, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $installed = Get-InstallState $DefaultDir
    $logFile = Join-Path $LogDir 'uninstall-held-output.txt'
    $errFile = Join-Path $LogDir 'uninstall-held-error.txt'
    $p = Start-Tracked (Join-Path $DefaultDir 'uninstall.exe') @('/S', "_?=$DefaultDir") @{ RedirectStandardOutput = $logFile; RedirectStandardError = $errFile }
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch { }; throw 'the silent uninstall with a held copy did not finish' }
    $heldCode = Get-ExitCode $p
    if ($heldCode -eq 0) { throw 'the silent uninstall with a held copy exited 0' }
    Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the program after the silent uninstall that stopped'
    $said = ''
    foreach ($f in @($logFile, $errFile)) { if ([System.IO.File]::Exists($f)) { $said += [System.IO.File]::ReadAllText($f) } }
    Assert-NamesNothing $said @('MU-held', 'MU-copy', $State) 'the silent uninstall''s output'
    if ($said.Length -eq 0) { throw 'the silent uninstall with a held copy said nothing: the check that it names no file would pass on nothing' }
    Write-Log "  silent, a held copy: exit $heldCode, nothing removed, output of $($said.Length) characters names no file"

    # The same with /UPDATE (the switch an upgrade gives the old uninstaller): the plaintext is never skipped, and the
    # program and its entry survive the refusal.
    $p = Start-Tracked (Join-Path $DefaultDir 'uninstall.exe') @('/S', '/UPDATE', "_?=$DefaultDir")
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch { }; throw 'the silent uninstall with /UPDATE and a held copy did not finish' }
    $updateCode = Get-ExitCode $p
    if ($updateCode -eq 0) { throw 'the silent uninstall with /UPDATE and a held copy exited 0' }
    Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the program after the /UPDATE uninstall that stopped'
    Write-Log "  silent with /UPDATE, a held copy: exit $updateCode, nothing removed"

    # Interactive: the box says copies are in use, with Retry and Cancel; Cancel leaves the program and its uninstaller intact.
    $result = Uninstall-Interactive $DefaultDir $false 'Cancel'
    $words = ($result.Texts | Where-Object { $_ -like '*still in use*' }) -join "`n"
    if (-not $words) { Save-Screen 'held-no-box'; throw "the interactive uninstall with a held copy showed no box that says copies are still in use; it showed: $($result.Texts -join ' | ')" }
    Assert-NamesNothing $words @('MU-held', $State) 'the box'
    Assert-Unchanged $installed (Get-InstallState $DefaultDir) 'the program after Cancel'
    Write-Log '  interactive, a held copy: the box said so, Cancel left everything'
  } finally {
    $handle.Dispose()
  }
  # The handle closed: the uninstaller run again removes open\ and finishes.
  $code = Uninstall-InPlace $DefaultDir
  if ($code -ne 0) { throw "the uninstall after the copy was closed exited $code" }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there after the copy was closed' }
  if ([System.IO.File]::Exists((Join-Path $DefaultDir 'petalock.exe'))) { throw 'the program is still there after the copy was closed' }
  Write-Log '  after the handle was closed: removed and finished'
}

$Checks["running_petalock_is_never_ended_and_silent_refuses_first"] = {
  $stand = {
    # A stand-in for the tray's Quit, which no script can press: the harness ends the process it started, never the installer.
    Stop-Petalock
    Wait-Until { -not (Get-Process -Name 'petalock' -ErrorAction SilentlyContinue) } 30 'petalock.exe did not end'
    Start-Sleep -Seconds 1
  }
  Reset-World
  Install-Good $DefaultDir
  Set-RunValue
  $app = Start-PetalockHidden $DefaultDir
  $baseline = Get-InstallState $DefaultDir
  $stateBefore = Get-Listing $State -Hash
  $refuse = {
    param($label, $exe, $argList)
    $code = Invoke-Program $exe $argList
    if ($code -eq 0) { throw "the silent $label with Petalock running exited 0" }
    if ($app.HasExited) { throw "the silent $label ended Petalock" }
    Assert-Unchanged $baseline (Get-InstallState $DefaultDir) "the program after the silent $label"
    Assert-Unchanged $stateBefore (Get-Listing $State -Hash) "the state after the silent $label"
    Write-Log "  silent $label with Petalock running: exit $code, nothing changed, Petalock still running"
  }
  & $refuse 'install' $Installer @('/S')
  & $refuse 'upgrade' $Upgrade @('/S', "/D=$DefaultDir")
  & $refuse 'uninstall' (Join-Path $DefaultDir 'uninstall.exe') @('/S', "_?=$DefaultDir")

  # The running copy is found by the app's own instance lock, not by the chosen folder: a new, empty destination somewhere
  # else (the installed copy is the one that is running) is refused too, and nothing is made there.
  $other = Join-Path $Work 'MU-other\Petalock'
  $code = Invoke-Program $Installer @('/S', "/D=$other")
  if ($code -eq 0) { throw 'a silent install into another, empty folder with Petalock running exited 0' }
  if ($app.HasExited) { throw 'the silent install into another folder ended Petalock' }
  if ([System.IO.Directory]::Exists($other)) { throw 'the install into another folder made it while Petalock was running' }
  Assert-Unchanged $baseline (Get-InstallState $DefaultDir) 'the program after the silent install into another folder'
  Assert-Unchanged $stateBefore (Get-Listing $State -Hash) 'the state after the silent install into another folder'
  Write-Log "  silent install into another folder with Petalock running: exit $code, nothing made, nothing changed"

  # Interactive: Cancel leaves the baseline and the state; Retry after Quit goes on.
  foreach ($kind in @('install', 'upgrade')) {
    $exe = if ($kind -eq 'install') { $Installer } else { $Upgrade }
    $p = Start-Tracked $exe @()
    # Plan 5, Task 9e: in the window (not a message box): its words, Retry as its default button, and the keyboard route in words.
    $box = Wait-RunningPage $p
    if ((Get-DialogText $box) -notlike '*Quit it from its icon near the clock*') { throw "the $kind window does not say how to quit Petalock: $(Get-DialogText $box)" }
    if ((Get-DialogText $box) -notlike '*press Windows+B*') { throw "the $kind window gives no keyboard route to Quit: $(Get-DialogText $box)" }
    if (-not (Find-Button $box 'Retry')) { throw "the $kind window has no Retry button" }
    [void][SmokeDlg]::Press($box.Handle, [SmokeDlg]::Item($box.Handle, 2))
    if (-not $p.WaitForExit(60000)) { throw "the $kind did not end after Cancel" }
    if ($app.HasExited) { throw "Cancel in the $kind ended Petalock" }
    Assert-Unchanged $baseline (Get-InstallState $DefaultDir) "the program after Cancel in the $kind"
    Assert-Unchanged $stateBefore (Get-Listing $State -Hash) "the state after Cancel in the $kind"
    Write-Log "  interactive $kind, Cancel: nothing changed"
  }
  $p = Start-Process -FilePath (Join-Path $DefaultDir 'uninstall.exe') -PassThru
  [void]$p.WaitForExit(2000)
  $box = Wait-Box 'Retry'
  if ((Get-DialogText $box) -notlike '*Petalock is running*') { throw "the uninstall box does not say Petalock is running: $(Get-DialogText $box)" }
  [SmokeDlg]::Click((Find-Button $box 'Cancel').Handle)
  Wait-Until { -not (Get-UninstallerCopies) } 60 'the uninstaller did not end after Cancel'
  if ($app.HasExited) { throw 'Cancel in the uninstall ended Petalock' }
  Assert-Unchanged $baseline (Get-InstallState $DefaultDir) 'the program after Cancel in the uninstall'
  Assert-Unchanged $stateBefore (Get-Listing $State -Hash) 'the state after Cancel in the uninstall'
  Write-Log '  interactive uninstall, Cancel: nothing changed'

  # After Quit, each succeeds. Retry is pressed once Petalock has been ended, and the installer must then really install:
  # it exits 0, and a value it writes (NoModify, put back to 0 here) is written again. Both installer inputs.
  & $stand
  $result = Install-Silent $Installer ''
  if ($result -ne 0) { throw "the silent install after Quit exited $result" }
  $result = Install-Silent $Upgrade ''
  if ($result -ne 0) { throw "the silent upgrade after Quit exited $result" }
  foreach ($kind in @('install', 'upgrade')) {
    $exe = if ($kind -eq 'install') { $Installer } else { $Upgrade }
    Start-Sleep -Seconds 2
    $app = Start-PetalockHidden $DefaultDir
    Set-ItemProperty -LiteralPath $UninstallKey -Name 'NoModify' -Value 0 -Type DWord
    $p = Start-Tracked $exe @()
    $box = Wait-RunningPage $p
    & $stand
    [void][SmokeDlg]::Press($box.Handle, [SmokeDlg]::Item($box.Handle, 1))
    # The Retry press leaves the page, which then installs: give it a moment, so the driver never sees the page that was left.
    Start-Sleep -Seconds 3
    $texts = Drive-Wizard $p 'install'
    $exit = Get-ExitCode $p
    if ($exit -ne 0) { throw "the interactive $kind after Retry ended with exit $exit" }
    if ([int](Get-UninstallValue 'NoModify') -ne 1) { throw "the interactive $kind after Retry did not write the uninstall entry again (it closed without doing the work)" }
    if (-not (Test-Installed $DefaultDir)) { throw "the interactive $kind after Retry left no program" }
    Write-Log "  interactive $kind, Retry after Quit: finished through $($texts.Count) pages, exit $exit, the entry written again"
  }
  Start-Sleep -Seconds 2
  $app = Start-PetalockHidden $DefaultDir
  $p = Start-Process -FilePath (Join-Path $DefaultDir 'uninstall.exe') -PassThru
  [void]$p.WaitForExit(2000)
  $box = Wait-Box 'Retry'
  & $stand
  [SmokeDlg]::Click((Find-Button $box 'Retry').Handle)
  [void](Drive-Wizard $null 'uninstall' $false)
  Wait-Until { -not (Get-UninstallerCopies) } 120 'the uninstaller copy did not end'
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'the interactive uninstall after Retry left the install folder' }
  if (Get-UninstallValue 'DisplayName') { throw 'the interactive uninstall after Retry left its entry' }
  Write-Log '  interactive uninstall, Retry after Quit: finished'
}

$Checks["uninstall_says_where_vaults_stay"] = {
  Reset-World
  Install-Good $DefaultDir
  $result = Uninstall-Interactive $DefaultDir $false
  $all = ($result.Texts -join "`n")
  $normal = $all -replace '\s+', ' '
  if ($normal -notlike "*$Sentence*") { throw "the finish page does not say where vaults stay; the pages said: $normal" }
  Write-Log '  the finish page says where vaults stay'
}

# Plan 5, Task 3: the open-source licence texts ship in the installer. The installed file is read and compared with the one the
# build made (and checked as a whole file first), and the uninstall takes it away with the program, by its own list.
$Checks["installed_copy_has_the_notices_file"] = {
  Reset-World
  Install-Good $DefaultDir
  $installed = Join-Path $DefaultDir 'THIRD-PARTY-NOTICES.txt'
  Assert-NoticesInstalled $installed $Notices
  Write-Log "  the installed notices file is the build's own ($((Get-Item -LiteralPath $installed).Length) bytes)"
  Uninstall-AsWindowsDoes $DefaultDir
  if ([System.IO.File]::Exists($installed)) { throw 'the uninstall left THIRD-PARTY-NOTICES.txt in the install folder' }

  # An upgrade writes the notices file again. With a hard link or a symbolic link in its place, to a file outside the install
  # folder, the write would go through to that file: the installer refuses before writing, and the file outside is as it was.
  # (Under the work folder, so the file outside is on the same volume as the install folder: a hard link needs that.)
  Reset-World
  $dir = Join-Path $Work 'MU-notices\Petalock'
  Install-Good $dir
  $installed = Join-Path $dir 'THIRD-PARTY-NOTICES.txt'
  Assert-NoticesInstalled $installed $Notices
  $outside = Join-Path $Work 'MU-outside-notices.txt'
  Write-Utf8 $outside 'MU-outside: a file of the person that is not Petalock''s'
  $outsideHash = Get-Sha256 $outside
  foreach ($case in @(@{ Name = 'hard link'; Kind = 'HardLink' }, @{ Name = 'symbolic link'; Kind = 'SymbolicLink' })) {
    [System.IO.File]::Delete($installed)
    if ($case.Kind -eq 'HardLink') { New-Item -ItemType HardLink -Path $installed -Target $outside | Out-Null }
    else { New-Item -ItemType SymbolicLink -Path $installed -Target $outside | Out-Null }
    if (-not [System.IO.File]::Exists($installed)) { throw "the fixture did not make the $($case.Name)" }
    $code = Install-Silent $Upgrade ''
    if ($code -eq 0) { throw "an upgrade over a notices file that was a $($case.Name) exited 0" }
    if ((Get-Sha256 $outside) -ne $outsideHash) { throw "the upgrade wrote through the $($case.Name) to the file outside the install folder" }
    Write-Log "  the upgrade over a notices file that is a $($case.Name) was refused, and the file outside is as it was"
  }
  # With the link gone the same upgrade works, and the file is the build's again.
  [System.IO.File]::Delete($installed)
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the upgrade after the link was removed exited $code" }
  Assert-NoticesInstalled $installed $Notices
  Uninstall-AsWindowsDoes $dir
  if ([System.IO.File]::Exists($installed)) { throw 'the uninstall left THIRD-PARTY-NOTICES.txt in the install folder' }
  if ((Get-Sha256 $outside) -ne $outsideHash) { throw 'the uninstall changed the file outside the install folder' }
}

# --- Plan 5, Task 4: two versions of the same code (-Installer the earlier, -Upgrade the later) ----------------------------

# Installing a later version over an earlier one keeps everything of the person's: the state folder byte for byte (open\
# included: installing over runs no uninstaller), the one installation in its folder, and the Run value the app wrote.
$Checks["upgrade_keeps_vaults_list_settings_and_state"] = {
  Reset-World
  Assert-VersionPair
  Install-Good $DefaultDir
  Assert-OneInstallation $DefaultDir $FromVersion
  $planted = New-StateFixture
  $run = '"' + (Join-Path $DefaultDir 'petalock.exe') + '" --hidden'
  Set-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -Value $run
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent upgrade to $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  Assert-Unchanged $planted (Get-Listing $State -Hash) 'the state folder after the upgrade (open\ included)'
  Assert-OneInstallation $DefaultDir $ToVersion
  if ((Get-RegValue $RunKey 'Petalock') -ne $run) { throw 'the upgrade changed or removed the Run\Petalock value' }
  Write-Log "  $FromVersion to $ToVersion, silent: state, the one installation and the Run value kept"
}

# Each candidate carries its own version, and the later one is taken as an upgrade on both paths: silent, and through the
# window, whose reinstall page calls the installed version older.
$Checks["candidate_versions_upgrade_in_order"] = {
  Reset-World
  Assert-VersionPair
  Install-Good $DefaultDir
  Assert-OneInstallation $DefaultDir $FromVersion
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent upgrade from $FromVersion to $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $ToVersion
  Write-Log "  silent: $FromVersion then $ToVersion, registered and embedded versions read back"

  Reset-World
  Install-Good $DefaultDir
  # The page's default choice is taken (Task 4b: installs over); this check asserts the page's words and the result.
  $page = Read-MainPage $Upgrade
  if ($page.Text -notlike "*Petalock $FromVersion is on this PC. This updates it to $ToVersion.*") { throw "the main page does not say that Petalock $FromVersion is installed and will be updated to ${ToVersion}: $($page.Text)" }
  if ($page.Exit -ne 0) { throw "the upgrade through the window ended with exit $($page.Exit)" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $ToVersion
  Write-Log "  through the window: the page said $FromVersion is installed and updates to $ToVersion, and $ToVersion is installed"
}

# Specified here (Task 4): downgrades are allowed (Tauri's allowDowngrades, left at its default true; the page links older
# versions for anyone who needs to go back). Silent: the earlier version installs over the later one and the state is kept
# byte for byte. Through the window: the page says a newer version is installed and offers both choices, and the earlier
# version ends up installed with the state kept (open\ aside: an uninstall-first run cleans the opened copies).
$Checks["downgrade_behaviour_is_the_specified_one"] = {
  Reset-World
  Assert-VersionPair
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent install of $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  $planted = New-StateFixture
  $code = Install-Silent $Installer ''
  if ($code -ne 0) { throw "the silent downgrade to $FromVersion exited $code (specified: it installs over)" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $FromVersion
  Assert-Unchanged $planted (Get-Listing $State -Hash) 'the state folder after the silent downgrade (open\ included)'
  Write-Log "  silent: $ToVersion then $FromVersion installs over, state kept"

  Reset-World
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent install of $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  $planted = New-StateFixture
  # The page's default action is taken (Cancel is the default button on this screen, Enter cancels; the harness presses the
  # Downgrade button itself); Downgrade and the other way ('Remove ... before installing ...' under 'Other choices') must both be offered.
  $page = Read-MainPage $Installer
  if ($page.Text -notlike "*A newer Petalock, $ToVersion, is on this PC.*") { throw "the main page does not say a newer version is installed: $($page.Text)" }
  if ($page.Next -ne 'Downgrade') { throw "the main page on a downgrade offers '$($page.Next)', not 'Downgrade'" }
  $remove = @($page.Choices | Where-Object { $_.Text -like 'Remove*before installing*' })[0]
  if (-not $remove) { throw "the main page on a downgrade does not offer 'Remove ... before installing ...'" }
  if (-not $remove.Enabled) { throw "the main page on a downgrade shows 'Remove ... before installing ...' but it cannot be chosen" }
  if ($page.Exit -ne 0) { throw "the downgrade through the window ended with exit $($page.Exit)" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $FromVersion
  Assert-Unchanged (Without-Open $planted) (Without-Open (Get-Listing $State -Hash)) 'the state folder after the downgrade through the window (open\ aside)'
  Write-Log "  through the window: the page said a newer version is installed, both ways offered, $FromVersion installed, state kept"
}

# Task 1's uninstall checks after an upgrade: the program, its entry, the Run value and open\ go; every other planted file,
# the vault, the identifier folders and values Petalock did not make (under HKCU\Software\Petalock and its former child key
# HKCU\Software\Petalock\Petalock, Task 1 re-check new 8) stay.
$Checks["uninstall_after_upgrade_is_clean"] = {
  Reset-World
  Assert-VersionPair
  Install-Good $DefaultDir
  $planted = New-StateFixture
  $vault = Join-Path $Work 'MU-vault'
  Write-Utf8 (Join-Path $vault 'vault.json') '{"MU":"header"}'
  Write-Utf8 (Join-Path $IdRoam 'MU-roaming.txt') 'MU-roaming'
  Write-Utf8 (Join-Path $IdLocal 'MU-local.txt') 'MU-local'
  Set-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -Value ('"' + (Join-Path $DefaultDir 'petalock.exe') + '" --hidden')
  New-Item -Path $OldKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $OldKey -Name 'MU-unrelated' -Value 'MU-keep'
  $child = 'HKCU:\Software\Petalock\Petalock'
  New-Item -Path $child -Force | Out-Null
  Set-ItemProperty -LiteralPath $child -Name 'MU-child' -Value 'MU-keep'
  $others = @{}
  foreach ($path in @($vault, $IdRoam, $IdLocal)) { $others[$path] = Get-Listing $path -Hash; Assert-Listing $others[$path] $path "the folder $([System.IO.Path]::GetFileName($path))" }
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent upgrade to $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $ToVersion
  Uninstall-AsWindowsDoes $DefaultDir
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'the install folder is still there after the upgrade and uninstall' }
  if (Get-UninstallValue 'DisplayName') { throw 'the uninstall entry is still there after the upgrade and uninstall' }
  if ($null -ne (Get-RegValue $RunKey 'Petalock')) { throw 'the Run\Petalock value is still there after the upgrade and uninstall' }
  if ((Get-RegValue $OldKey 'MU-unrelated') -ne 'MU-keep') { throw 'the uninstall removed a value under HKCU\Software\Petalock that it did not make' }
  if ((Get-RegValue $child 'MU-child') -ne 'MU-keep') { throw 'the uninstall removed a value under HKCU\Software\Petalock\Petalock that it did not make' }
  if ([System.IO.Directory]::Exists((Join-Path $State 'open'))) { throw 'open\ is still there after the upgrade and uninstall' }
  Assert-Unchanged (Without-Open $planted) (Get-Listing $State -Hash) 'the state folder (everything but open\) after the upgrade and uninstall'
  foreach ($path in $others.Keys) { Assert-Unchanged $others[$path] (Get-Listing $path -Hash) "the folder $([System.IO.Path]::GetFileName($path))" }
  Write-Log "  $FromVersion to $ToVersion, then uninstall: only the program, its entry, the Run value and open\ went"
}

# --- Plan 5, Task 4b: an upgrade keeps "start with Windows" ----------------------------------------------------------------

# An upgrade through the window keeps the Run value the app wrote, whichever choice the reinstall page is left on: its default
# (install over: no uninstaller runs) and 'Uninstall before installing' (the old uninstaller runs with /UPDATE: it still cleans
# open\, which is the proof it ran, and keeps the Run value and everything else). The same holds for a downgrade. The control is
# the same version, whose 'Uninstall Petalock' is the person asking for a full uninstall: the Run value goes.
$Checks["interactive_upgrade_keeps_start_with_windows"] = {
  Assert-VersionPair
  # The confirm page of the old uninstaller is read on each uninstall-first run (review finding 3): under /UPDATE it must not offer
  # 'Delete the application data' (it would ignore the box), and the planted app-data folders survive; the same-version full
  # uninstall is the control that does offer it (a reader that finds no box where one is must fail).
  $confirmReader = New-ConfirmPageReader
  foreach ($uninstallFirst in @($false, $true)) {
    $what = if ($uninstallFirst) { "the upgrade from $FromVersion to $ToVersion that uninstalls first" } else { "the upgrade from $FromVersion to $ToVersion with the page's default choice" }
    Reset-World
    $ConfirmPage = @{ Seen = 0; Box = 0 }
    $r = Invoke-WindowOver $Installer $Upgrade $uninstallFirst $confirmReader
    Assert-OneInstallation $DefaultDir $ToVersion
    if ((Get-RegValue $RunKey 'Petalock') -ne $r.Run) { throw "$what changed or removed the Run\Petalock value" }
    Assert-WindowKept $r $uninstallFirst $what
    if ($uninstallFirst) { Assert-ConfirmPageBox $ConfirmPage $false $what }
    elseif ($ConfirmPage.Seen -ne 0) { throw "$what : an uninstaller's confirm page was shown, so something uninstalled" }
    Write-Log "  ${what}: the Run value, state and app data kept"
  }
  Reset-World
  $ConfirmPage = @{ Seen = 0; Box = 0 }
  $r = Invoke-WindowOver $Upgrade $Installer $true $confirmReader
  Assert-OneInstallation $DefaultDir $FromVersion
  $what = "the downgrade from $ToVersion to $FromVersion that uninstalls first"
  if ((Get-RegValue $RunKey 'Petalock') -ne $r.Run) { throw "$what changed or removed the Run\Petalock value" }
  Assert-WindowKept $r $true $what
  Assert-ConfirmPageBox $ConfirmPage $false $what
  Write-Log "  ${what}: the Run value, state and app data kept, no app-data box offered"
  Reset-World
  $ConfirmPage = @{ Seen = 0; Box = 0 }
  $r = Invoke-WindowOver $Installer $Installer $true $confirmReader
  # Plan 5, Task 9e: the same version's link "Uninstall Petalock instead" opens the existing uninstaller and Setup ends when it has
  # finished: nothing is installed afterwards (the earlier page uninstalled and then went on to install again).
  # Each file on its own (Test-Installed is false as soon as EITHER is gone, which would hide a program left behind).
  if ([System.IO.File]::Exists((Join-Path $DefaultDir 'petalock.exe'))) { throw "the same-version 'Uninstall Petalock instead' left petalock.exe" }
  if ([System.IO.File]::Exists((Join-Path $DefaultDir 'uninstall.exe'))) { throw "the same-version 'Uninstall Petalock instead' left uninstall.exe" }
  if (Get-UninstallValue 'DisplayName') { throw "the same-version 'Uninstall Petalock instead' left the uninstall entry" }
  if ($null -ne (Get-RegValue $RunKey 'Petalock')) { throw "the same-version 'Uninstall Petalock instead' left the Run\Petalock value: a full uninstall removes it" }
  Assert-ConfirmPageBox $ConfirmPage $true "the same-version 'Uninstall Petalock instead'"
  Write-Log "  the same version's 'Uninstall Petalock instead' is a full uninstall that ends Setup (the Run value went, the app-data box was offered)"
}

# The main page's default action installs over when the installed version is older or newer, and 'Remove ... before installing ...'
# stays offered under 'Other choices'; the same version's page offers Reinstall and a link to the full uninstall. Each is read
# through the window, which then installs.
$Checks["upgrade_page_defaults_to_install_over"] = {
  Assert-VersionPair
  Reset-World
  Install-Good $DefaultDir
  $page = Read-MainPage $Upgrade
  Assert-InstallOverDefault $page "an upgrade from $FromVersion to $ToVersion"
  if ($page.Exit -ne 0) { throw "the upgrade through the window ended with exit $($page.Exit)" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $ToVersion

  Reset-World
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent install of $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  $page = Read-MainPage $Installer
  Assert-InstallOverDefault $page "a downgrade from $ToVersion to $FromVersion"
  if ($page.Exit -ne 0) { throw "the downgrade through the window ended with exit $($page.Exit)" }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $FromVersion

  Reset-World
  Install-Good $DefaultDir
  $page = Read-MainPage $Installer
  Assert-ReinstallPage $page
  if ($page.Exit -ne 0) { throw "the reinstall of the same version through the window ended with exit $($page.Exit)" }
  Write-Log "  upgrade and downgrade install over by default with 'Remove ... before installing ...' offered under 'Other choices'; the same version offers Reinstall and a link to the full uninstall"
}

# --- Plan 5, Task 9e: the one screen in Petalock's look --------------------------------------------------------------------------

# A new install through the window with the default folder: the page says what Setup will do (the three lines, in words), the
# progress becomes the same three lines, the last page is the receipt, and the program is not started (the box on the last page
# is cleared by the driver, as it is on every run).
$Checks["quick_install_default_folder_and_receipt"] = {
  Reset-World
  $result = Install-Interactive $Installer ''
  if ($result.Exit -ne 0) { throw "the interactive install ended with exit $($result.Exit)" }
  $all = ($result.Texts -join "`n") -replace '\s+', ' '
  foreach ($sentence in @(
      'What Setup will do', 'Check for Microsoft WebView2', 'Install Petalock for this Windows account', 'Add it to the Start menu and to Installed apps',
      'What Setup did', 'Petalock is installed for this Windows account', 'Added to the Start menu and to Installed apps')) {
    if ($all -notlike "*$sentence*") { throw "the window never said: $sentence; it said: $all" }
  }
  # Row 1 on the receipt says what really happened to WebView2.
  if ($all -notlike '*Already installed*' -and $all -notlike '*Installed by Setup*') { throw "the receipt does not say what happened to WebView2: $all" }
  $want = Get-EmbeddedVersion $Installer
  if ($all -notlike "*Version $want*") { throw "the window does not show the build's version ($want): $all" }
  if (-not (Test-Installed $DefaultDir)) { throw "no program and uninstaller in $DefaultDir" }
  Assert-OneInstallation $DefaultDir $want
  if (Get-Process -Name 'petalock' -ErrorAction SilentlyContinue) { throw 'Petalock was started by the installer window (its box was cleared)' }
  Write-Log "  the page said what Setup will do, the receipt said what it did, version $want, the program installed and not started"
}

# Browse: a new install with NO /D= opens Options and presses Browse. The system's folder dialog (the tree-style "Browse For Folder",
# runner trial 3) opens on the folder Setup offers when it exists, so the default folder is made, empty, and a folder beside it
# (MU-picked-folder) is made for the dialog to choose by typing its name into the tree. The page must then show the chosen folder
# (Petalock's own name added), the program lands there and nowhere else (the default folder stays empty), the entry records it,
# and the uninstall takes the program, the uninstaller and the entry away. A picker that left the default fails the folder checks.
$Checks["quick_install_folder_from_options"] = {
  Reset-World
  $pickName = 'MU-picked-folder'
  $picked = Join-Path ([System.IO.Path]::GetDirectoryName($DefaultDir)) $pickName
  $chosen = Join-Path $picked 'Petalock'
  $optionsObs = @{}
  $reader = {
    param($d)
    if ($optionsObs.Count -gt 0) { return }
    if ((Get-DialogText $d) -notlike '*What Setup will do*') { return }
    $options = @($d.Kids | Where-Object { $_.Visible -and $_.Text -eq 'Options' })[0]
    if (-not $options) { throw 'the new-install page has no Options link' }
    [SmokeDlg]::Click($options.Handle)
    Start-Sleep -Milliseconds 1000
    $now = @(Get-Dialogs | Where-Object { $_.Handle -eq $d.Handle })[0]
    $browse = @($now.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Browse*' })[0]
    if (-not $browse) { throw 'Options shows no Browse button' }
    $optionsObs['Before'] = (@($now.Kids | Where-Object { $_.Class -eq 'Edit' -and $_.Visible })[0]).Text
    [SmokeDlg]::Click($browse.Handle)
    Choose-Folder $pickName ([int][SmokeDlg]::Pid($d.Handle)) $d.Handle
    $after = @(Get-Dialogs | Where-Object { $_.Handle -eq $d.Handle })[0]
    $optionsObs['Field'] = (@($after.Kids | Where-Object { $_.Class -eq 'Edit' -and $_.Visible })[0]).Text
  }
  [void](New-Item -ItemType Directory -Force $DefaultDir)
  [void](New-Item -ItemType Directory -Force $picked)
  try {
    $p = Start-Tracked $Installer @()
    [void](Drive-Wizard $p 'install' $false '' $null 240 $false $reader)
    $exit = Get-ExitCode $p
    if ($exit -ne 0) { throw "the install into the browsed folder ended with exit $exit" }
    if ($optionsObs.Count -eq 0) { Save-Screen 'no-options'; throw 'the reader never saw the new-install page' }
    if ($optionsObs['Before'] -ne $DefaultDir) { throw "Options first showed '$($optionsObs['Before'])', not the default folder" }
    if ($optionsObs['Field'] -eq $DefaultDir) { throw 'after Browse the page still shows the default folder (the dialog chose nothing else)' }
    if ($optionsObs['Field'] -ne $chosen) { throw "after Browse the page shows '$($optionsObs['Field'])', not the folder chosen ($chosen)" }
    if (-not (Test-Installed $chosen)) { throw "no program and uninstaller in the browsed folder $chosen" }
    if (@([System.IO.Directory]::EnumerateFileSystemEntries($DefaultDir)).Count -ne 0) { throw 'the install also wrote into the default folder' }
    $location = [string](Get-UninstallValue 'InstallLocation')
    if ($location.Trim('"') -ne $chosen) { throw "the uninstall entry records $location, not the browsed folder" }
    Uninstall-AsWindowsDoes $chosen
    if ([System.IO.File]::Exists((Join-Path $chosen 'petalock.exe'))) { throw 'the uninstall left the program in the browsed folder' }
    if ([System.IO.File]::Exists((Join-Path $chosen 'uninstall.exe'))) { throw 'the uninstall left its own uninstaller in the browsed folder' }
    if ($null -ne (Get-UninstallValue 'DisplayName')) { throw 'the uninstall left the entry in Installed apps' }
    Write-Log "  Browse chose $chosen, the page showed it, the program landed there only, the entry records it, and the uninstall took the program, the uninstaller and the entry away"
  } finally {
    Remove-Safely $picked
  }
}

# The same, with the folder given on the command line (/D=): the page keeps it and shows it in its read-only field once Options is open.
$Checks["quick_install_folder_from_d"] = {
  Reset-World
  $chosen = Join-Path $Work 'MU-options\Petalock'
  $dObs = @{}
  $reader = {
    param($d)
    if ($dObs.Count -gt 0) { return }
    if ((Get-DialogText $d) -notlike '*What Setup will do*') { return }
    $options = @($d.Kids | Where-Object { $_.Visible -and $_.Text -eq 'Options' })[0]
    if (-not $options) { throw 'the new-install page has no Options link' }
    [SmokeDlg]::Click($options.Handle)
    Start-Sleep -Milliseconds 1000
    $now = @(Get-Dialogs | Where-Object { $_.Handle -eq $d.Handle })[0]
    $dObs['Field'] = (@($now.Kids | Where-Object { $_.Class -eq 'Edit' -and $_.Visible })[0]).Text
  }
  $p = Start-Tracked $Installer @("/D=$chosen")
  [void](Drive-Wizard $p 'install' $false '' $null 240 $false $reader)
  if ((Get-ExitCode $p) -ne 0) { throw 'the install into the folder given with /D ended with an error' }
  if ($dObs.Count -eq 0) { Save-Screen 'no-options-d'; throw 'the reader never saw the new-install page' }
  if ($dObs['Field'] -ne $chosen) { throw "Options shows '$($dObs['Field'])', not the folder given ($chosen)" }
  if (-not (Test-Installed $chosen)) { throw "no program and uninstaller in the chosen folder $chosen" }
  if ([System.IO.Directory]::Exists($DefaultDir)) { throw 'the install also made the default folder' }
  Uninstall-AsWindowsDoes $chosen
  Write-Log "  /D kept: Options showed $chosen and the program landed there only"
}

# /P shows progress and ends by itself (no Finish click) with exit 0; /S shows no window and starts nothing; both end with an error
# code when they fail (a folder that is refused, with no window at all).
$Checks["quiet_installs_return_exit_codes_and_launch_nothing"] = {
  Reset-World
  # /P: a visible progress bar belonging to the process is seen while it runs (a /P that shows no window at all would fail), the
  # wait is bounded, and it ends by itself with no input.
  $p = Start-Tracked $Installer @('/P')
  $deadline = (Get-Date).AddSeconds(240)
  $progress = $false
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    foreach ($d in @(Get-Dialogs @([int]$p.Id) -Owned)) {
      if (@($d.Kids | Where-Object { $_.Class -eq 'msctls_progress32' -and $_.Visible }).Count -gt 0) { $progress = $true }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $p.HasExited) { try { $p.Kill() } catch { }; throw 'the /P install did not end by itself (it waits for a click)' }
  $code = Get-ExitCode $p
  if ($code -ne 0) { throw "the /P install exited $code" }
  if (-not $progress) { throw 'the /P install never showed a progress bar' }
  if (-not (Test-Installed $DefaultDir)) { throw 'the /P install left no program' }
  if (Get-Process -Name 'petalock' -ErrorAction SilentlyContinue) { throw 'the /P install started Petalock' }
  Write-Log '  /P: progress seen, no click, exit 0, nothing started'
  # /S (with /R, which must launch nothing in a silent run either): no visible window, the wait bounded.
  Reset-World
  $shown = $false
  $p = Start-Tracked $Installer @('/S', '/R')
  $deadline = (Get-Date).AddSeconds(240)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    if (@(Get-Dialogs @([int]$p.Id) -Owned).Count -gt 0) { $shown = $true }
    Start-Sleep -Milliseconds 100
  }
  if (-not $p.HasExited) { try { $p.Kill() } catch { }; throw 'the /S install did not end within 240 s (it waits for input)' }
  $code = Get-ExitCode $p
  if ($code -ne 0) { throw "the /S install exited $code" }
  if ($shown) { throw 'the /S install showed a window' }
  if (-not (Test-Installed $DefaultDir)) { throw 'the /S install left no program' }
  Start-Sleep -Seconds 2
  if (Get-Process -Name 'petalock' -ErrorAction SilentlyContinue) { throw 'the /S /R install started Petalock' }
  Write-Log '  /S /R: no window, exit 0, nothing started'
  # Failure: a folder that is refused (the state folder), quiet and passive, ends with an error code and no click.
  foreach ($flags in @(@('/S'), @('/P'))) {
    $before = Get-InstallState $DefaultDir
    $p = Start-Tracked $Installer ($flags + @("/D=$State"))
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch { }; throw "the $($flags[0]) install into the state folder did not end by itself" }
    $code = Get-ExitCode $p
    if ($code -eq 0) { throw "the $($flags[0]) install into the state folder exited 0" }
    Assert-Unchanged $before (Get-InstallState $DefaultDir) "the program after the refused $($flags[0]) install"
    Write-Log "  $($flags[0]) into the state folder: refused with exit $code, nothing changed"
  }
}

# --- Plan 5, Task 9e review fix round ---------------------------------------------------------------------------------------------

# Finding 5: a program file that cannot be written ends a silent install with an error (and not with a receipt); the old install is
# left as the failed run found it, and once the permission is restored the same install works.
$Checks["a_write_that_is_denied_is_a_failure_not_a_receipt"] = {
  Reset-World
  Install-Good $DefaultDir
  $exe = Join-Path $DefaultDir 'petalock.exe'
  Set-Deny $exe 'W'
  $code = $null
  try { $code = Install-Silent $Installer '' } finally { Clear-Deny $exe }
  if ($code -eq 0) { throw 'a silent install over a program file that could not be written exited 0' }
  Write-Log "  a denied write: exit $code, no success"
  $code = Install-Silent $Installer ''
  if ($code -ne 0) { throw "the install with the permission restored exited $code" }
  if (-not (Test-Installed $DefaultDir)) { throw 'the install with the permission restored left no program' }
}

# Finding 3: with /UPDATE and a window, an existing installation is offered no uninstall at all (no "Other choices", no "Uninstall
# Petalock instead"), the planted start-with-Windows entry and the opened copy are still there afterwards, and it installs over.
$Checks["interactive_update_mode_offers_no_uninstall_choice"] = {
  Reset-World
  Install-Good $DefaultDir
  $planted = New-StateFixture
  Set-RunValue
  $run = Get-RegValue $RunKey 'Petalock'
  $page = Read-MainPage $Installer @('/UPDATE')
  if ($page.Links -contains 'Other choices') { throw "the /UPDATE page offers 'Other choices'" }
  if ($page.Links -contains 'Uninstall Petalock instead') { throw "the /UPDATE page offers 'Uninstall Petalock instead'" }
  if ($page.Exit -ne 0) { throw "the /UPDATE install through the window ended with exit $($page.Exit)" }
  if ((Get-RegValue $RunKey 'Petalock') -ne $run) { throw 'the /UPDATE run changed or removed the Run\Petalock value' }
  Assert-Unchanged $planted (Get-Listing $State -Hash) 'the state folder after the /UPDATE run (open\ included)'
  Write-Log '  /UPDATE through the window: no uninstall offered, the Run value and the state kept'
}

# Second fix round, re-check finding 6: after a step completes, the status line (the control with id 1950) says the step's outcome in
# words. A real install is run through its window; the status control is read on every turn of a tight loop and every text it shows is
# kept. None may be only digits (a window handle took the outcome's place), and at least one must be a completed step's own sentence
# (the read goes on until the progress page is over, so the last step's sentence, which stays while the receipt is made, is among them).
$Checks["a_completed_step_puts_words_in_the_status_line"] = {
  Reset-World
  $p = Start-Tracked $Installer @()
  $d = Wait-PageText $p '*What Setup will do*'
  Start-Sleep -Seconds 1
  $statuses = New-Object System.Collections.ArrayList
  [void][SmokeDlg]::Press($d.Handle, [SmokeDlg]::Item($d.Handle, 1))
  $deadline = (Get-Date).AddSeconds(120)
  $last = $null
  $gone = $null
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    $t = [SmokeDlg]::StatusText($d.Handle, 1950)
    if ($null -ne $t) {
      $gone = $null
      if ($t -ne $last) { [void]$statuses.Add($t); $last = $t }
    } elseif ($statuses.Count -gt 0) {
      # The progress page is over (the receipt is next): a second and a half of no status line ends the reading.
      if ($null -eq $gone) { $gone = Get-Date } elseif (((Get-Date) - $gone).TotalMilliseconds -gt 1500) { break }
    }
    Start-Sleep -Milliseconds 5
  }
  if (-not $p.HasExited) { [void](Drive-Wizard $p 'install' $false '' $null 120) }
  $exit = Get-ExitCode $p
  Write-Log "  status line texts seen: $(@($statuses) -join ' | ')"
  if ($statuses.Count -eq 0) { Save-Screen 'no-status'; throw 'the status line was never read' }
  $outcomes = @('Microsoft WebView2', 'Petalock is installed for this Windows account', 'Added to the Start menu and to Installed apps')
  $problems = @(Get-StatusProblems @($statuses) $outcomes)
  if ($problems.Count -gt 0) { Save-Screen 'status-line'; throw ($problems -join '; ') }
  if ($exit -ne 0) { throw "the install ended with exit $exit" }
  if (-not (Test-Installed $DefaultDir)) { throw 'the install left no program' }
  Write-Log "  the status line said, after completed steps: $((@(@($statuses) | Where-Object { $outcomes -contains $_ })) -join ' | ')"
}

# Second fix round, re-check finding 1: Windows refuses the installer's entry in Installed apps (this account is denied the right,
# on the real registry of the runner, in a try with the right given back in the finally). No advice ever says to delete a folder, and
# what the installer does is checked here.
#  - A fresh attempt (a made-up folder, with a made-up file beside it, and the planted state folder, which is also named Petalock):
#    the install ends with an error, only the files that attempt wrote are gone (the folder it made is left, empty), the file
#    beside it and the state folder are unchanged, no entry exists, and once the right is back the same install works (it is not
#    refused for a folder that holds files and no entry).
#  - An update in place (the default folder holds an install and a made-up added file): the update ends with an error, the program,
#    its uninstaller, the added file and the earlier entry are all still there, and once the right is back the same update works.
$Checks["a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote"] = {
  Reset-World
  $UninstallParent = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  [void][Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall').Close()
  $want = Get-EmbeddedVersion $Installer

  $parent = Join-Path $Work 'MU-fresh'
  $dir = Join-Path $parent 'Petalock'
  $sentinel = Join-Path $parent 'MU-sentinel.txt'
  Write-Utf8 $sentinel 'MU-sentinel'
  $planted = New-StateFixture
  $code = $null
  Set-RegDeny $UninstallParent 'CreateSubKey'
  try { $code = Install-Silent $Installer $dir } finally { Clear-RegDeny $UninstallParent 'CreateSubKey' }
  if ($code -eq 0) { throw 'a fresh install whose entry in Installed apps was refused exited 0' }
  foreach ($name in @('petalock.exe', 'uninstall.exe')) {
    if ([System.IO.File]::Exists((Join-Path $dir $name))) { throw "the refused fresh attempt left $name in its folder" }
  }
  if ([System.IO.Directory]::Exists($dir) -and @([System.IO.Directory]::EnumerateFileSystemEntries($dir)).Count -ne 0) { throw 'the refused fresh attempt left files in its folder' }
  if (-not [System.IO.File]::Exists($sentinel) -or [System.IO.File]::ReadAllText($sentinel) -ne 'MU-sentinel') { throw 'the refused fresh attempt touched the file beside its folder' }
  Assert-Unchanged $planted (Get-Listing $State -Hash) 'the state folder after the refused fresh attempt'
  if ($null -ne (Get-UninstallValue 'DisplayName')) { throw 'an entry in Installed apps exists after the refused fresh attempt' }
  Write-Log "  fresh attempt, entry refused: exit $code, its own files gone, the file beside it and the state folder unchanged"
  $code = Install-Silent $Installer $dir
  if ($code -ne 0) { throw "the same install with the right restored exited $code (the folder must not be refused)" }
  Assert-OneInstallation $dir $want
  if ([System.IO.File]::ReadAllText($sentinel) -ne 'MU-sentinel') { throw 'the retry touched the file beside the folder' }
  Write-Log '  fresh attempt, retried with the right back: installed'

  Reset-World
  Install-Good $DefaultDir
  $added = Join-Path $DefaultDir 'MU-added.txt'
  Write-Utf8 $added 'MU-added'
  Set-RegDeny $UninstallKey 'SetValue'
  try { $code = Install-Silent $Installer '' } finally { Clear-RegDeny $UninstallKey 'SetValue' }
  if ($code -eq 0) { throw 'an update in place whose entry could not be written exited 0' }
  if (-not (Test-Installed $DefaultDir)) { throw 'the refused update removed the program or its uninstaller' }
  if (-not [System.IO.File]::Exists($added) -or [System.IO.File]::ReadAllText($added) -ne 'MU-added') { throw 'the refused update removed or changed the added file' }
  Assert-OneInstallation $DefaultDir $want
  Write-Log "  update in place, entry refused: exit $code, the program, the uninstaller, the added file and the earlier entry all still there"
  $code = Install-Silent $Installer ''
  if ($code -ne 0) { throw "the same update with the right restored exited $code" }
  Assert-OneInstallation $DefaultDir $want
  if (-not [System.IO.File]::Exists($added)) { throw 'the retried update removed the added file' }
  Write-Log '  update in place, retried with the right back: done'
}

# Finding 4: remove-first with an added file in the program folder is refused while the working install is intact (the page says so
# and nothing is removed), instead of removing the program and then refusing the folder.
$Checks["remove_first_with_an_added_file_leaves_the_install_intact"] = {
  Assert-VersionPair
  Reset-World
  Install-Good $DefaultDir
  $added = Join-Path $DefaultDir 'MU-added.txt'
  Write-Utf8 $added 'MU-added'
  Write-Utf8 (Join-Path $State 'open\MU-proof.txt') 'MU-proof'
  $p = Start-Tracked $Upgrade @()
  $d = Wait-PageText $p '*What Setup will do*'
  Start-Sleep -Seconds 1
  $other = @($d.Kids | Where-Object { $_.Visible -and $_.Text -eq 'Other choices' })[0]
  if (-not $other) { throw 'the update page has no Other choices' }
  [SmokeDlg]::Click($other.Handle); Start-Sleep -Milliseconds 800
  $now = @(Get-Dialogs @([int]$p.Id) -Owned)[0]
  $box = @($now.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Remove*before installing*' })[0]
  if (-not $box) { throw 'no remove-first box under Other choices' }
  [SmokeDlg]::Click($box.Handle); Start-Sleep -Milliseconds 800
  [void][SmokeDlg]::Press($now.Handle, [SmokeDlg]::Item($now.Handle, 1))
  $stopped = Wait-PageText $p '*be removed first*'
  if (-not (Test-Installed $DefaultDir)) { throw 'the program was removed before the added file was noticed' }
  if (-not [System.IO.File]::Exists($added)) { throw 'the added file is gone' }
  if (-not [System.IO.File]::Exists((Join-Path $State 'open\MU-proof.txt'))) { throw 'the old uninstaller ran (the opened copy is gone)' }
  Assert-OneInstallation $DefaultDir $FromVersion
  # Second fix round (re-check finding 4): the refusal keeps the box ticked and in view; unticking it takes the choice back, the
  # refusal leaves the page, and the same window goes on through an update in place that keeps the added file and the opened copy.
  $now = @(Get-Dialogs @([int]$p.Id) -Owned)[0]
  $box = @($now.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Remove*before installing*' })[0]
  if (-not $box) { throw 'the refusal shows no remove-first box to untick' }
  if ([SmokeDlg]::GetCheck($box.Handle) -ne 1) { throw 'the refusal page does not keep the box ticked' }
  [SmokeDlg]::Click($box.Handle); Start-Sleep -Milliseconds 800
  $now = @(Get-Dialogs @([int]$p.Id) -Owned)[0]
  if ((Get-DialogText $now) -like '*be removed first*') { throw 'the refusal was still on the page after the box was unticked' }
  [void](Drive-Wizard $p 'install' $false '' $null 240)
  if ((Get-ExitCode $p) -ne 0) { throw 'the update in place after the refusal ended with an error' }
  Start-Sleep -Seconds 2
  Assert-OneInstallation $DefaultDir $ToVersion
  if (-not [System.IO.File]::Exists($added)) { throw 'the update in place removed the added file' }
  if (-not [System.IO.File]::Exists((Join-Path $State 'open\MU-proof.txt'))) { throw 'the update in place removed the opened copy' }
  Write-Log '  remove-first with an added file: refused on the page, the install intact, then updated in place once the box was unticked'
}

# Finding 22: Tab and Enter through the real dialog. On a new install Tab visits Options, Licence, Install and Cancel in that order
# (hidden controls skipped); on the newer-version screen Cancel has the focus and is the default, so Enter ends Setup and the
# installed (later) version is left alone.
$Checks["keyboard_tab_order_and_default_buttons_on_the_real_dialog"] = {
  Assert-VersionPair
  Reset-World
  $p = Start-Tracked $Installer @()
  $d = Wait-PageText $p '*What Setup will do*'
  Start-Sleep -Seconds 2
  $seenFocus = @()
  for ($i = 0; $i -lt 10; $i++) { $seenFocus += (Get-FocusedText $d); Send-Key $d 0x09 }
  Write-Log "  Tab walk on the new-install page: $($seenFocus -join ' > ')"
  $at = -1
  foreach ($want in @('Options', 'Licence (MIT)', 'Install', 'Cancel')) {
    $next = [array]::IndexOf($seenFocus, $want, $at + 1)
    if ($next -lt 0) { throw "Tab never reached '$want' after the earlier stops: $($seenFocus -join ' > ')" }
    $at = $next
  }
  [void][SmokeDlg]::Press($d.Handle, [SmokeDlg]::Item($d.Handle, 2))
  if (-not $p.WaitForExit(60000)) { throw 'the installer did not end after Cancel' }
  Reset-World
  $code = Install-Silent $Upgrade ''
  if ($code -ne 0) { throw "the silent install of $ToVersion exited $code" }
  Start-Sleep -Seconds 2
  $p = Start-Tracked $Installer @()
  $d = Wait-PageText $p "*A newer Petalock, $ToVersion*"
  Start-Sleep -Seconds 2
  Send-Key $d 0x0D
  if (-not $p.WaitForExit(60000)) { Save-Screen 'enter-did-not-cancel'; try { $p.Kill() } catch { }; throw 'Enter on the newer-version screen did not end Setup (it is not Cancel)' }
  Assert-OneInstallation $DefaultDir $ToVersion
  Write-Log "  Enter on the newer-version screen cancelled; $ToVersion is still installed"
}

# ---------------------------------------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------------------------------------

Write-Log "installer-smoke: installer $([System.IO.Path]::GetFileName($Installer)), $($selected.Count) checks, log $LogPath"
Write-Log ("installer-smoke: installer SHA-256 " + (Get-Sha256 $Installer))
$failed = 0
$ran = 0
foreach ($name in $selected) {
  $started = Get-Date
  try {
    & $Checks[$name]
    $ran++
    Write-Log ("PASS $name ({0:N1} s)" -f ((Get-Date) - $started).TotalSeconds)
  } catch {
    $ran++
    $failed++
    Write-Log "FAIL ${name}: $($_.Exception.Message)"
    Write-Log ("  at " + $_.InvocationInfo.PositionMessage.Replace("`r`n", ' '))
    Save-Screen $name
  }
}
try { Reset-World } catch { Write-Log "(clean-up failed: $($_.Exception.Message))" }
if ($ran -ne $selected.Count -or $ran -eq 0) { Write-Log "installer-smoke: ran $ran of $($selected.Count) checks"; exit 1 }
if ($failed -ne 0) { Write-Log "installer-smoke: $failed of $ran checks FAILED"; exit 1 }
Write-Log "installer-smoke: all $ran checks passed"
exit 0
