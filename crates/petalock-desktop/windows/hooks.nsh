; Petalock's installer logic, included by installer.nsi (Tauri's NSIS template, with the changes listed at its top).
; Plan 5, Task 1. Every folder the installer or the uninstaller touches is checked here first, and everything the
; uninstaller removes outside its own files is removed here, by name, never following a junction or a symbolic link.
;
; Rules this file keeps (each is pinned by a test in scripts/installer-smoke.test.mjs, and run on the real installer in
; scripts/installer-smoke.ps1):
;   - The install folder is never the state folder (%LOCALAPPDATA%\Petalock), inside it, one of the two identifier
;     folders (Roaming and Local, named by the bundle identifier), inside one, inside a vault folder (one holding
;     vault.json), or a link. "Where it really is" is asked of Windows, so a redirected parent does not hide it, and a
;     spelling Windows would normalise (a name ending in a period or a space, "." and ".." segments) is refused before
;     anything is compared.
;   - A FRESH install (any folder that is not the one the uninstall key's InstallLocation records) needs a folder that is
;     provably empty, or none. MAINTENANCE (an upgrade, or an uninstall) is bound to the recorded installation: it works
;     on that folder only, and still works when the program in it is missing (a quarantined file), so the opened copies
;     can always be cleaned. The three files setup overwrites there (the program, the uninstaller and the licence notices)
;     must be plain files with one link.
;   - A failed read is not an absence: only "not found" counts as nothing there. Anything else (access denied, an I/O
;     error) refuses an install and stops an uninstall before it removes anything (Retry or Cancel).
;   - A running Petalock is never ended: it is found by the app's own instance lock, whatever folder is chosen, and an
;     indeterminate answer refuses. A silent or passive run exits with an error before changing anything; an interactive
;     one asks the person to quit it from its tray icon, and offers Retry and Cancel.
;   - NSIS's own `RMDir /r` follows junctions (NSIS 3.13, Source/exehead/util.c:229-234), so it is not used anywhere:
;     un.PetalockRemoveTree tests every item for a link before it lists it.
;   - Nothing read from the registry is executed: the old uninstaller is "<recorded folder>\uninstall.exe", built here.
;   - No message or console line names a file or a folder.

!include LogicLib.nsh

Var PetalockA   ; an argument and a result, for the helpers below that are not recursive
Var PetalockB   ; a second argument
Var PetalockR   ; a result (1 or 0, a number, or a word)
Var PetalockWhy ; why a folder is refused: "" when it is fine
Var PetalockMode ; "fresh" or "maint": what the folder being checked is for
Var PetalockStuck ; how many items un.PetalockRemoveTree could not remove

; Writes one line to the console that started a silent or passive run, if there is one. Names nothing.
!macro PETALOCK_CONSOLE TEXT
  Push $0
  System::Call 'kernel32::AttachConsole(i -1) i .r0'
  ${If} $0 <> 0
    System::Call 'kernel32::GetStdHandle(i -11) i .r0'
    FileWrite $0 "${TEXT}$\r$\n"
  ${EndIf}
  Pop $0
!macroend

; Refuses, in $PetalockWhy, when $1 (the folder as it really is) is inside the place PATH (resolved the same way).
!macro PETALOCK_NOT_INSIDE UN PATH WHY
  StrCpy $PetalockA "${PATH}"
  Call ${UN}PetalockResolve
  ${If} $PetalockA == ""
    StrCpy $PetalockWhy "unresolved"
    Goto guard_done
  ${EndIf}
  StrCpy $PetalockB $PetalockA
  StrCpy $PetalockA $1
  Call ${UN}PetalockIsWithin
  ${If} $PetalockR = 1
    StrCpy $PetalockWhy "${WHY}"
    Goto guard_done
  ${EndIf}
!macroend

; Refuses when the vault header file NAME is in the folder $4 (ends with a backslash), or when that cannot be told.
!macro PETALOCK_MARKER UN NAME
  StrCpy $PetalockA "$4${NAME}"
  Call ${UN}PetalockAttr
  ${If} $PetalockR == "error"
    StrCpy $PetalockWhy "unknown"
    Goto guard_done
  ${EndIf}
  ${If} $PetalockR != "absent"
    StrCpy $PetalockWhy "vault"
    Goto guard_done
  ${EndIf}
!macroend

; A file setup overwrites in the folder $0: absent, or a plain file with one link (not a link, not a folder, not a hard link
; to something else). Anything unreadable refuses.
!macro PETALOCK_PLAIN_FILE UN NAME
  StrCpy $PetalockA "$0\${NAME}"
  Call ${UN}PetalockAttr
  ${If} $PetalockR == "error"
    StrCpy $PetalockWhy "unknown"
    Goto guard_done
  ${EndIf}
  ${If} $PetalockR != "absent"
    IntOp $3 $PetalockR & 0x400
    ${If} $3 <> 0
      StrCpy $PetalockWhy "link"
      Goto guard_done
    ${EndIf}
    IntOp $3 $PetalockR & 0x10
    ${If} $3 <> 0
      StrCpy $PetalockWhy "others"
      Goto guard_done
    ${EndIf}
    StrCpy $PetalockA "$0\${NAME}"
    Call ${UN}PetalockLinkCount
    ${If} $PetalockR == "error"
      StrCpy $PetalockWhy "unknown"
      Goto guard_done
    ${EndIf}
    ${If} $PetalockR > 1
      StrCpy $PetalockWhy "link"
      Goto guard_done
    ${EndIf}
  ${EndIf}
!macroend

; The helpers the installer and the uninstaller both use: UN is "" for the installer's copy and "un." for the uninstaller's.
!macro PETALOCK_COMMON UN

Function ${UN}PetalockParent
  ; In: $PetalockA, a path. Out: $PetalockA, its parent folder (a drive's root keeps its backslash), and $PetalockR, the
  ; last name with its backslash in front. $PetalockA is "" when there is no parent (a drive's root).
  Push $0
  Push $1
  Push $2
  StrLen $0 $PetalockA
  StrCpy $PetalockR ""
  ${If} $0 <= 3
    StrCpy $PetalockA ""
    Goto parent_done
  ${EndIf}
  StrCpy $1 $0
  parent_scan:
    IntOp $1 $1 - 1
    ${If} $1 < 2
      StrCpy $PetalockA ""
      Goto parent_done
    ${EndIf}
    StrCpy $2 $PetalockA 1 $1
    StrCmp $2 "\" 0 parent_scan
  StrCpy $PetalockR $PetalockA "" $1
  ${If} $1 = 2
    StrCpy $PetalockA $PetalockA 3
  ${Else}
    StrCpy $PetalockA $PetalockA $1
  ${EndIf}
  parent_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockAttr
  ; In: $PetalockA, a path. Out: $PetalockR is its attribute number, or "absent" when Windows says the path is not there
  ; (file or path not found, and only those), or "error" for any other failure (access denied, an I/O error): a failed read
  ; is never taken for an absence. A link is described by its own attributes, not its target's.
  Push $0
  Push $1
  System::Call 'kernel32::GetFileAttributesW(w "$PetalockA") i .r0 ?e'
  Pop $1
  ${If} $0 = -1
    ${If} $1 = 2
    ${OrIf} $1 = 3
      StrCpy $PetalockR "absent"
    ${Else}
      StrCpy $PetalockR "error"
    ${EndIf}
  ${Else}
    StrCpy $PetalockR $0
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockLinkCount
  ; In: $PetalockA, a file. Out: $PetalockR, how many names the file has (1 for a plain file), or "error".
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $PetalockR "error"
  ; FILE_FLAG_OPEN_REPARSE_POINT (0x00200000): a link is looked at, not followed; access 0, sharing everything
  System::Call 'kernel32::CreateFileW(w "$PetalockA", i 0, i 7, p 0, i 3, i 0x00200000, p 0) p .r0'
  ${If} $0 = -1
  ${OrIf} $0 = 0
    Goto links_done
  ${EndIf}
  System::Alloc 64
  Pop $1
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i .r2'
  ${If} $2 <> 0
    ; BY_HANDLE_FILE_INFORMATION: nNumberOfLinks is the DWORD at byte 40
    IntOp $3 $1 + 40
    System::Call 'kernel32::RtlMoveMemory(*i .r2, i r3, i 4)'
    StrCpy $PetalockR $2
  ${EndIf}
  System::Free $1
  System::Call 'kernel32::CloseHandle(p r0)'
  links_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockResolve
  ; In: $PetalockA, an absolute path. Out: $PetalockA, the same place as Windows sees it: the nearest folder on the way
  ; that exists, followed through every junction and link, with the names that do not exist yet put back after it.
  ; "" when that cannot be told, or when a read fails for any reason but "not found" (the caller refuses then).
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $0 $PetalockA
  StrCpy $1 ""
  StrCpy $4 0
  resolve_up:
    StrCpy $PetalockA $0
    Call ${UN}PetalockAttr
    ${If} $PetalockR == "error"
      Goto resolve_fail
    ${EndIf}
    ${If} $PetalockR != "absent"
      Goto resolve_here
    ${EndIf}
    IntOp $4 $4 + 1
    ${If} $4 > 64
      Goto resolve_fail
    ${EndIf}
    StrCpy $PetalockA $0
    Call ${UN}PetalockParent
    ${If} $PetalockA == ""
      Goto resolve_fail
    ${EndIf}
    StrCpy $1 "$PetalockR$1"
    StrCpy $0 $PetalockA
    Goto resolve_up
  resolve_here:
    ; FILE_FLAG_BACKUP_SEMANTICS (0x02000000) opens a folder; access 0 only asks, and shares everything
    System::Call 'kernel32::CreateFileW(w r0, i 0, i 7, p 0, i 3, i 0x02000000, p 0) p .r2'
    ${If} $2 = -1
    ${OrIf} $2 = 0
      Goto resolve_fail
    ${EndIf}
    System::Call 'kernel32::GetFinalPathNameByHandleW(p r2, w .r3, i ${NSIS_MAX_STRLEN}, i 0) i .r4'
    System::Call 'kernel32::CloseHandle(p r2)'
    ${If} $4 = 0
    ${OrIf} $4 >= ${NSIS_MAX_STRLEN}
      Goto resolve_fail
    ${EndIf}
    ; "\\?\C:\..." becomes "C:\..."; a network path (\\?\UNC\...) is not a place Petalock goes
    StrCpy $2 $3 4
    ${If} $2 != "\\?\"
      Goto resolve_fail
    ${EndIf}
    StrCpy $3 $3 "" 4
    StrCpy $2 $3 4
    ${If} $2 == "UNC\"
      Goto resolve_fail
    ${EndIf}
    StrCpy $2 $3 1 -1
    ${If} $2 == "\"
      StrCpy $3 $3 -1
    ${EndIf}
    StrCpy $PetalockA "$3$1"
    Goto resolve_end
  resolve_fail:
    StrCpy $PetalockA ""
  resolve_end:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockIsWithin
  ; In: $PetalockA, a path; $PetalockB, a folder. Out: $PetalockR is 1 when the path is that folder or inside it (names
  ; compared as Windows does, without regard to case), else 0.
  Push $0
  Push $1
  StrCpy $PetalockR 0
  StrLen $0 $PetalockB
  ${If} $0 > 0
    StrCpy $1 $PetalockA $0
    ${If} $1 == $PetalockB
      StrCpy $1 $PetalockA 1 $0
      ${If} $1 == ""
      ${OrIf} $1 == "\"
        StrCpy $PetalockR 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockRecordedLocation
  ; Out: $PetalockA, the install folder the uninstall key's InstallLocation records (the installer writes it quoted: the
  ; quotes and any trailing backslashes are taken off), "" when there is none. The only place the installer records where it
  ; installed; whatever it holds is a candidate until the guard has checked it.
  Push $0
  Push $1
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "InstallLocation"
  StrCpy $1 $0 1
  ${If} $1 == '"'
    StrCpy $0 $0 "" 1
    StrCpy $1 $0 1 -1
    ${If} $1 == '"'
      StrCpy $0 $0 -1
    ${EndIf}
  ${EndIf}
  recorded_trim:
    StrLen $1 $0
    ${If} $1 > 3
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrCpy $0 $0 -1
        Goto recorded_trim
      ${EndIf}
    ${EndIf}
  StrCpy $PetalockA $0
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockSetMode
  ; In: $INSTDIR. Out: $PetalockMode, "maint" when it is the folder the uninstall key records, "fresh" when it is not.
  Push $0
  Push $1
  StrCpy $0 $INSTDIR
  mode_trim:
    StrLen $1 $0
    ${If} $1 > 3
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrCpy $0 $0 -1
        Goto mode_trim
      ${EndIf}
    ${EndIf}
  Call ${UN}PetalockRecordedLocation
  ${If} $PetalockA != ""
  ${AndIf} $PetalockA == $0
    StrCpy $PetalockMode "maint"
  ${Else}
    StrCpy $PetalockMode "fresh"
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockGuardFolder
  ; In: $PetalockA, the folder that would be installed into or taken out of, and $PetalockMode ("fresh" or "maint").
  ; Out: $PetalockWhy is "" when it may be used, else a short word for the refusal (the messages shown are fixed text and
  ; name nothing).
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  StrCpy $PetalockWhy ""
  StrCpy $0 $PetalockA
  ; Trailing backslashes go (a drive's root keeps its own).
  guard_trim:
    StrLen $1 $0
    ${If} $1 > 3
      StrCpy $2 $0 1 -1
      ${If} $2 == "\"
        StrCpy $0 $0 -1
        Goto guard_trim
      ${EndIf}
    ${EndIf}
  ; The shape: a drive letter, a colon and a backslash, more than a bare drive, nothing long, and no character, segment or
  ; name that Windows would read as another place: no "/", no empty segment, no segment of "." or "..", and no name that
  ; ends in a period or a space (Windows drops those, so the spelling compared would not be the folder made).
  ${If} $1 <= 3
  ${OrIf} $1 > 600
    StrCpy $PetalockWhy "shape"
    Goto guard_done
  ${EndIf}
  StrCpy $2 $0 1 1
  StrCpy $3 $0 1 2
  ${If} $2 != ":"
  ${OrIf} $3 != "\"
    StrCpy $PetalockWhy "shape"
    Goto guard_done
  ${EndIf}
  StrCpy $4 0
  guard_shape:
    ${If} $4 >= $1
      Goto guard_shaped
    ${EndIf}
    StrCpy $5 $0 1 $4
    ${If} $5 == "/"
    ${OrIf} $5 == "?"
    ${OrIf} $5 == "*"
    ${OrIf} $5 == "<"
    ${OrIf} $5 == ">"
    ${OrIf} $5 == "|"
    ${OrIf} $5 == '"'
      StrCpy $PetalockWhy "shape"
      Goto guard_done
    ${EndIf}
    ${If} $5 == ":"
    ${AndIf} $4 <> 1
      StrCpy $PetalockWhy "shape"
      Goto guard_done
    ${EndIf}
    ; the end of a name: what came before the backslash
    ${If} $5 == "\"
    ${AndIf} $4 > 2
      IntOp $7 $4 - 1
      StrCpy $7 $0 1 $7
      ${If} $7 == "."
      ${OrIf} $7 == " "
      ${OrIf} $7 == "\"
        StrCpy $PetalockWhy "shape"
        Goto guard_done
      ${EndIf}
    ${EndIf}
    StrCpy $6 $0 3 $4
    ${If} $6 == "\.."
    ${OrIf} $6 == "\.\"
      StrCpy $PetalockWhy "shape"
      Goto guard_done
    ${EndIf}
    IntOp $4 $4 + 1
    Goto guard_shape
  guard_shaped:
  StrCpy $6 $0 1 -1
  ${If} $6 == "."
  ${OrIf} $6 == " "
    StrCpy $PetalockWhy "shape"
    Goto guard_done
  ${EndIf}
  StrCpy $6 $0 2 -2
  ${If} $6 == "\."
    StrCpy $PetalockWhy "shape"
    Goto guard_done
  ${EndIf}

  ; The folder itself: not a link (a junction made after the install is refused here), a folder, and readable.
  StrCpy $PetalockA $0
  Call ${UN}PetalockAttr
  StrCpy $7 $PetalockR
  ${If} $7 == "error"
    StrCpy $PetalockWhy "unknown"
    Goto guard_done
  ${EndIf}
  ${If} $7 != "absent"
    IntOp $3 $7 & 0x400
    ${If} $3 <> 0
      StrCpy $PetalockWhy "link"
      Goto guard_done
    ${EndIf}
    IntOp $3 $7 & 0x10
    ${If} $3 = 0
      StrCpy $PetalockWhy "file"
      Goto guard_done
    ${EndIf}
  ${EndIf}

  ; Where it really is, through any redirected parent.
  StrCpy $PetalockA $0
  Call ${UN}PetalockResolve
  StrCpy $1 $PetalockA
  ${If} $1 == ""
    StrCpy $PetalockWhy "unresolved"
    Goto guard_done
  ${EndIf}

  ; Never Petalock's own data: the state folder, the two identifier folders (and inside any of them).
  !insertmacro PETALOCK_NOT_INSIDE "${UN}" "$LOCALAPPDATA\Petalock" "state"
  !insertmacro PETALOCK_NOT_INSIDE "${UN}" "$APPDATA\${BUNDLEID}" "appdata"
  !insertmacro PETALOCK_NOT_INSIDE "${UN}" "$LOCALAPPDATA\${BUNDLEID}" "appdata"

  ; Never in a vault folder, nor in one inside it: the folder and each folder above it must hold no vault header.
  StrCpy $2 $1
  guard_vault:
    StrCpy $3 $2 1 -1
    ${If} $3 == "\"
      StrCpy $4 "$2"
    ${Else}
      StrCpy $4 "$2\"
    ${EndIf}
    !insertmacro PETALOCK_MARKER "${UN}" "vault.json"
    !insertmacro PETALOCK_MARKER "${UN}" "vault.json.bak"
    StrCpy $PetalockA $2
    Call ${UN}PetalockParent
    ${If} $PetalockA != ""
      StrCpy $2 $PetalockA
      Goto guard_vault
    ${EndIf}

  ; A folder that exists. MAINTENANCE: it is the recorded installation (the caller chose the mode by that), and the files
  ; setup overwrites in it (program, uninstaller, licence notices) must be plain files with one link; the program being absent is fine. FRESH: it must be provably
  ; empty: both "." and ".." listed, then nothing else, and nothing listed at all is a folder that could not be read.
  ${If} $7 != "absent"
    StrCpy $6 "scan"
    ${If} $PetalockMode == "maint"
      !insertmacro PETALOCK_PLAIN_FILE "${UN}" "${MAINBINARYNAME}.exe"
      !insertmacro PETALOCK_PLAIN_FILE "${UN}" "uninstall.exe"
      ; The licence notices (Plan 5, Task 3) are written and removed by the installer too: a link in their place would send the
      ; write to another file.
      !insertmacro PETALOCK_PLAIN_FILE "${UN}" "THIRD-PARTY-NOTICES.txt"
      ; An installation has its uninstaller. A recorded folder that holds neither it nor nothing at all is someone else's
      ; folder (the record was changed): it is read like a fresh one, and refused unless it is provably empty.
      StrCpy $PetalockA "$0\uninstall.exe"
      Call ${UN}PetalockAttr
      ${If} $PetalockR != "absent"
        StrCpy $6 "skip"
      ${EndIf}
    ${EndIf}
    ${If} $6 == "scan"
      FindFirst $3 $4 "$1\*.*"
      StrCpy $5 0
      ${If} $4 == ""
        FindClose $3
        StrCpy $PetalockWhy "unknown"
        Goto guard_done
      ${EndIf}
      guard_look:
        StrCmp $4 "" guard_end
        StrCmp $4 "." guard_dot
        StrCmp $4 ".." guard_dotdot
        FindClose $3
        StrCpy $PetalockWhy "others"
        Goto guard_done
      guard_dot:
        IntOp $5 $5 | 1
        Goto guard_next
      guard_dotdot:
        IntOp $5 $5 | 2
      guard_next:
        FindNext $3 $4
        Goto guard_look
      guard_end:
        FindClose $3
        ${If} $5 <> 3
          StrCpy $PetalockWhy "unknown"
        ${EndIf}
    ${EndIf}
  ${EndIf}
  guard_done:
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockIsRunning
  ; In: $PetalockA, a folder. Out: $PetalockR is 1 when Petalock is running, or when that cannot be told, and 0 when it is
  ; not. The app takes a named lock, "Local\<identifier>.instance", as the first thing it does (os/win.rs INSTANCE_NAME):
  ; that is asked whatever folder was chosen. The lock being absent is "file not found" and only that; any other answer
  ; (it exists, access is denied, anything) counts as running. Then the program's own file in the folder is asked: a
  ; running program's file cannot be opened for writing (a sharing violation), three times, half a second apart, so a
  ; scanner that holds the file for a moment is not taken for the program.
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $PetalockR 0
  ; SYNCHRONIZE (0x00100000), not inheritable; ?e leaves GetLastError on the stack
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\${BUNDLEID}.instance") p .r0 ?e'
  Pop $1
  ${If} $0 <> 0
    System::Call 'kernel32::CloseHandle(p r0)'
    StrCpy $PetalockR 1
    Goto running_done
  ${EndIf}
  ${If} $1 <> 2
    StrCpy $PetalockR 1
    Goto running_done
  ${EndIf}
  StrCpy $3 $PetalockA
  StrCpy $PetalockA "$3\${MAINBINARYNAME}.exe"
  Call ${UN}PetalockAttr
  StrCpy $PetalockA $3
  ${If} $PetalockR == "absent"
    StrCpy $PetalockR 0
    Goto running_done
  ${EndIf}
  ${If} $PetalockR == "error"
    StrCpy $PetalockR 1
    Goto running_done
  ${EndIf}
  StrCpy $PetalockR 0
  StrCpy $2 0
  running_try:
    ; GENERIC_WRITE (0x40000000), no sharing, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL
    System::Call 'kernel32::CreateFileW(w "$PetalockA\${MAINBINARYNAME}.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p .r0 ?e'
    Pop $1
    ${If} $0 = -1
    ${AndIf} $1 = 32
      IntOp $2 $2 + 1
      ${If} $2 < 3
        Sleep 500
        Goto running_try
      ${EndIf}
      StrCpy $PetalockR 1
    ${ElseIf} $0 <> -1
      System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
  running_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${UN}PetalockEnsureNotRunning
  ; In: $PetalockA, a folder. Petalock is never ended by the installer. Silent and passive: say so and stop, before any
  ; change. Interactive: ask the person to quit it from its icon near the clock, with Retry and Cancel; Cancel stops
  ; with nothing changed.
  running_again:
  Call ${UN}PetalockIsRunning
  ${If} $PetalockR = 1
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      !insertmacro PETALOCK_CONSOLE "Petalock is running. Quit it from its icon near the clock, then run this again. Nothing was changed."
      Abort
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Petalock is running.$\r$\n$\r$\nQuit it from its icon near the clock (right-click the icon, then choose Quit), then choose Retry. Cancel stops here and changes nothing." IDRETRY running_again
    Abort
  ${EndIf}
FunctionEnd

Function ${UN}PetalockRefuseFolder
  ; The folder in $PetalockWhy is not one Petalock may be installed in or removed from. Fixed words, no path.
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    !insertmacro PETALOCK_CONSOLE "Petalock cannot use this folder. Nothing was changed."
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "Petalock cannot be installed in or removed from this folder: it is part of Petalock's own data, a vault, a link, it is not empty, it could not be read, or it is not the folder Petalock is installed in.$\r$\n$\r$\nNothing was changed. Choose another folder."
  ${EndIf}
  Abort
FunctionEnd

Function ${UN}PetalockPreflight
  ; Before anything is written or removed: the effective folder ($INSTDIR, from the folder page, /D, a remembered
  ; location or an upgrade) is checked, and Petalock must not be running. A folder that is not the recorded installation
  ; is a fresh install, which the uninstaller never is: an uninstaller whose folder is not the recorded installation stops.
  Call ${UN}PetalockSetMode
  !if "${UN}" == "un."
    ${If} $PetalockMode != "maint"
      StrCpy $PetalockWhy "unregistered"
      Call ${UN}PetalockRefuseFolder
    ${EndIf}
  !endif
  StrCpy $PetalockA $INSTDIR
  Call ${UN}PetalockGuardFolder
  ${If} $PetalockWhy != ""
    Call ${UN}PetalockRefuseFolder
  ${EndIf}
  StrCpy $PetalockA $INSTDIR
  Call ${UN}PetalockEnsureNotRunning
FunctionEnd

!macroend

!insertmacro PETALOCK_COMMON ""
!insertmacro PETALOCK_COMMON "un."

; The installer's folder page: the folder chosen is checked when the person leaves the page, and the page stays when it
; is refused.
Function PetalockLeaveDirectory
  Call PetalockSetMode
  StrCpy $PetalockA $INSTDIR
  Call PetalockGuardFolder
  ${If} $PetalockWhy != ""
    MessageBox MB_OK|MB_ICONSTOP "Petalock cannot be installed in this folder: it is part of Petalock's own data, a vault, a link, it is not empty, or it could not be read.$\r$\n$\r$\nChoose another folder."
    Abort
  ${EndIf}
FunctionEnd

; Before the installer runs the uninstaller of an earlier install. Out: $4, the recorded install folder, and $R1, the command:
; "<that folder>\uninstall.exe", built here from the folder and the fixed file name. The folder is the uninstall key's
; InstallLocation, checked as a maintenance folder; that the uninstaller is really there is checked; Petalock must not be
; running. Nothing read from the registry is executed.
Function PetalockBeforeOldUninstaller
  Call PetalockRecordedLocation
  StrCpy $4 $PetalockA
  StrCpy $R1 ""
  StrCpy $PetalockWhy ""
  ${If} $4 == ""
    StrCpy $PetalockWhy "unregistered"
  ${Else}
    StrCpy $PetalockMode "maint"
    StrCpy $PetalockA $4
    Call PetalockGuardFolder
  ${EndIf}
  ${If} $PetalockWhy == ""
    StrCpy $PetalockA "$4\uninstall.exe"
    Call PetalockAttr
    ${If} $PetalockR == "absent"
    ${OrIf} $PetalockR == "error"
      StrCpy $PetalockWhy "command"
    ${EndIf}
  ${EndIf}
  ${If} $PetalockWhy != ""
    Call PetalockRefuseFolder
  ${EndIf}
  StrCpy $PetalockA $4
  Call PetalockEnsureNotRunning
  StrCpy $R1 '"$4\uninstall.exe"'
FunctionEnd

; The uninstaller's first clean-up: the folders the app made for opened files (open\ in the state folder), before the
; program or its entry is removed, on every uninstall (an /UPDATE one too: an upgrade starts the old uninstaller only after
; the running check passed, and a standalone uninstall must never skip the plaintext). If any copy is left (held open, no
; permission, a read that failed), the uninstall stops with the program and its uninstaller intact, so it can be run
; again: silent and passive runs stop with an error; an interactive run asks with Retry and Cancel. Only a state folder
; that Windows says is not there is nothing to clean; one that cannot be read is not.
Function un.PetalockCleanOpen
  Push $0
  clean_again:
  StrCpy $PetalockStuck 0
  StrCpy $PetalockA "$LOCALAPPDATA\Petalock"
  Call un.PetalockAttr
  ${If} $PetalockR == "error"
    ; The state folder cannot be read: whether opened copies are in it cannot be told.
    StrCpy $PetalockStuck 1
  ${ElseIf} $PetalockR != "absent"
    IntOp $0 $PetalockR & 0x400
    ${If} $0 <> 0
      ; The state folder is a link: what is behind it is not Petalock's to clean.
      StrCpy $PetalockStuck 1
    ${Else}
      Push "$LOCALAPPDATA\Petalock\open"
      Call un.PetalockRemoveTree
      ; Whatever the removal said, open\ must now be confirmed gone.
      StrCpy $PetalockA "$LOCALAPPDATA\Petalock\open"
      Call un.PetalockAttr
      ${If} $PetalockR != "absent"
        IntOp $PetalockStuck $PetalockStuck + 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $PetalockStuck <> 0
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      !insertmacro PETALOCK_CONSOLE "Some opened copies are still in use or could not be removed. Petalock was not removed. Close whatever holds them and run the uninstall again."
      Pop $0
      Abort
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Some opened copies of your files are still in use, or could not be removed.$\r$\n$\r$\nClose whatever holds them, then choose Retry. Cancel stops here and leaves Petalock installed." IDRETRY clean_again
    Pop $0
    Abort
  ${EndIf}
  Pop $0
FunctionEnd

; Removes a file or a folder and everything in it, and never follows a junction or a symbolic link: an item that is a
; link (a reparse point) is removed itself, never listed or entered, whatever it points to. A file's read-only mark is
; cleared first. What could not be removed, or could not be read (anything but "not found"), is counted in $PetalockStuck,
; never named. In: the path, on the stack.
Function un.PetalockRemoveTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $PetalockA $0
  Call un.PetalockAttr
  StrCpy $1 $PetalockR
  ${If} $1 == "absent"
    Goto remove_done
  ${EndIf}
  ${If} $1 == "error"
    IntOp $PetalockStuck $PetalockStuck + 1
    Goto remove_done
  ${EndIf}
  IntOp $4 $1 & 0x400
  ${If} $4 <> 0
    ; A link: only the link goes. A folder link is removed as a folder (RemoveDirectoryW takes the link, not its target).
    IntOp $4 $1 & 0x10
    ${If} $4 <> 0
      System::Call 'kernel32::RemoveDirectoryW(w r0) i .r4'
    ${Else}
      System::Call 'kernel32::SetFileAttributesW(w r0, i 0x80) i .r4'
      System::Call 'kernel32::DeleteFileW(w r0) i .r4'
    ${EndIf}
    ${If} $4 = 0
      IntOp $PetalockStuck $PetalockStuck + 1
    ${EndIf}
    Goto remove_done
  ${EndIf}
  IntOp $4 $1 & 0x10
  ${If} $4 = 0
    ; A file: made removable (FILE_ATTRIBUTE_NORMAL), then removed.
    System::Call 'kernel32::SetFileAttributesW(w r0, i 0x80) i .r4'
    System::Call 'kernel32::DeleteFileW(w r0) i .r4'
    ${If} $4 = 0
      IntOp $PetalockStuck $PetalockStuck + 1
    ${EndIf}
    Goto remove_done
  ${EndIf}
  ; A plain folder: each item in it is dealt with the same way (each tested for a link again), then the folder. A readable
  ; folder always lists "." first: a listing that gives nothing at all is a folder that could not be read.
  FindFirst $2 $3 "$0\*.*"
  ${If} $3 == ""
    FindClose $2
    IntOp $PetalockStuck $PetalockStuck + 1
    Goto remove_done
  ${EndIf}
  remove_next:
    StrCmp $3 "" remove_listed
    StrCmp $3 "." remove_skip
    StrCmp $3 ".." remove_skip
    Push "$0\$3"
    Call un.PetalockRemoveTree
    remove_skip:
    FindNext $2 $3
    Goto remove_next
  remove_listed:
  FindClose $2
  System::Call 'kernel32::SetFileAttributesW(w r0, i 0x10) i .r4'
  System::Call 'kernel32::RemoveDirectoryW(w r0) i .r4'
  ${If} $4 = 0
    IntOp $PetalockStuck $PetalockStuck + 1
  ${EndIf}
  remove_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
