; Petalock's installer screen, included by hooks.nsh (which installer.nsi includes). Plan 5, Task 9e: design D, "Plain terms".
;
; One custom page says in three lines what Setup will do; the stock progress page turns the same three lines into Done / Now /
; Next while it runs; a custom last page keeps them as the receipt (or, when a step failed, shows where Setup stopped). A thin
; engraved band sits at the top. Everything is a plain Windows control: the colours are painted with SetCtlColors (skipped
; under a high-contrast theme, which then draws everything in the system's own colours), and sizes are in design pixels at
; 100 % scaled by the window's DPI.
;
; Rules this file keeps (each is pinned by a test in scripts/installer-ui.test.mjs):
;   - The decisions (which case this is, whether the folder, the free space, the write access and a running Petalock allow a
;     start) are made by PetalockDecide and PetalockCheckAll, which touch no page control and show no box, so a silent or
;     passive run uses them exactly as the window does. The folder guard of Task 1 (PetalockGuardFolder) is one of them, and
;     the sections of the template run PetalockPreflight again before each operation.
;   - The three lines come from one table (PetalockRowOf and the words below); a row is marked Done only by the step that
;     finished it (PETALOCK_DONE), after the operation, and the receipt is built from what really happened.
;   - Cancel, Esc and the title-bar close stay available through the checks and go off together (PetalockLockCancel) before
;     the first step Setup can't safely stop: the old uninstaller, the WebView2 bootstrapper, the first file. They come back
;     on with a failure (PetalockFailed).
;   - Petalock is never ended by Setup; the folder is never written to by a check.

!include nsDialogs.nsh

; ---------------------------------------------------------------------------------------------------------------------
; State
; ---------------------------------------------------------------------------------------------------------------------
Var PetalockDpi
Var PetalockHC          ; 1 under a high-contrast theme: no colour is painted
Var PetalockFBody
Var PetalockFBold
Var PetalockFSent
Var PetalockFSentB
Var PetalockFHead
Var PetalockFName
Var PetalockInner       ; the inner dialog of the page being shown

; The case and the choices (set before any page; PetalockDecide)
Var PetalockCase        ; new | update | reinstall | newer | unknown
Var PetalockOldVer
Var PetalockName
Var PetalockNoDown     ; 1 when the build forbids a downgrade in place
Var PetalockRemoveFirst ; 1: the old uninstaller runs first (only a person's choice, in a window)
Var PetalockLayout      ; 1 normal; 2 remove-first
Var PetalockOptionsOpen
Var PetalockOtherOpen

; The checks (PetalockCheckAll)
Var PetalockProblem     ; "" | folder | running | space | write
Var PetalockDrive
Var PetalockNeed
Var PetalockFree

; What happened (the receipt and the failure page are built from these)
Var PetalockStep        ; the step a macro or a helper is talking about
Var PetalockWv          ; had | got
Var PetalockWvMissing   ; 1 once WebView2 was found missing
Var PetalockSc          ; added | kept | skipped | failed
Var PetalockFailStep    ; "" or the step that failed
Var PetalockDetail      ; the failure's details (shown, and copied by Copy details)
Var PetalockLocked
Var PetalockRolledBack  ; 1 when a fresh attempt's files were taken out again after a file failure or a refused entry (installer.nsi)
Var PetalockOutcome     ; a finished step's words, kept apart from $PetalockA, which the repaint reuses for window handles
Var PetalockTW          ; a row's words' width, and its state word's column (SW) and left edge (TX), in design pixels (PETALOCK_PAINT)
Var PetalockSW
Var PetalockTX
Var PetalockRY2         ; row 2's top and WebView2's second line's top in the layout being painted (PetalockPaintRows)
Var PetalockRYD

; The three lines: text, state (next | now | done | failed | ns | ""), the state's word, and the labels' handles
Var PetalockT1
Var PetalockT2
Var PetalockT3
Var PetalockD1
Var PetalockS1
Var PetalockS2
Var PetalockS3
Var PetalockW1
Var PetalockW2
Var PetalockW3
Var PetalockHN1
Var PetalockHN2
Var PetalockHN3
Var PetalockHT1
Var PetalockHT2
Var PetalockHT3
Var PetalockHS1
Var PetalockHS2
Var PetalockHS3
Var PetalockHD1

; The page's other controls
Var PetalockHSent
Var PetalockHLab
Var PetalockHSlot1
Var PetalockHSlot2
Var PetalockHFLab
Var PetalockHOptions
Var PetalockHField
Var PetalockHBrowse
Var PetalockHOther
Var PetalockHUninst
Var PetalockHCheck
Var PetalockHLicence
Var PetalockHVer
Var PetalockHBar
Var PetalockHStat
Var PetalockHOpen
Var PetalockHCopy
Var PetalockHBand
Var PetalockHLine
Var PetalockHBmp

; ---------------------------------------------------------------------------------------------------------------------
; Words (the design's own; the version is the build's)
; ---------------------------------------------------------------------------------------------------------------------
!define PL_SUB "A local password manager and encrypted file vault."
!define PL_PLAN_WV "Check for Microsoft WebView2"
!define PL_PLAN_WV_D "If it’s missing, Setup downloads it from Microsoft and needs internet."
!define PL_KEEP "Setup leaves your vault files in place."
!define PL_NOTHING "Nothing was changed."

; Layout, in design pixels at 100 % (the window's client area is 500 x 358)
!define PL_ROW1 142
!define PL_ROW2 180
!define PL_ROW3 202
; WebView2's second line sits under row 1 (at 160) in a normal run. In remove-first row 1 is the removal and WebView2 is row 2, so the
; rows are 20 apart with nothing empty between them: the removal at 142, WebView2 at 162, its second line at 182, the install at 202.
!define PL_DETAIL 160
!define PL_L2_ROW2 162
!define PL_L2_DETAIL 182
; A row's words run from x 44 to 476 (432 wide) and the state word sits at the right in a column of its own: the words get what the
; column and the gap leave, so a long row (a bold one, or one beside "Not started") is never cut with dots, and the words and the state
; never share a rectangle. Each column is its word measured at every scale (scripts/installer-render.test.mjs) and a few pixels over.
; Row 3 has two lines (its box is 34 high, down to where the slot below it starts, 236), because the words of its Failed state are the
; longest the window says.
!define PL_GAP 10
!define PL_SW_DONE 34
!define PL_SW_NOW 38
!define PL_SW_NEXT 34
!define PL_SW_FAILED 44
!define PL_SW_REMOVED 58
!define PL_SW_NOTSTARTED 66
; The status line's control id (set after it is made), so the smoke check on the runner can read what it says
!define PL_ID_STATUS 1950

; Pixels at 100 % to the window's DPI: OUT = IN * dpi / 96
!macro PETALOCK_PX OUT IN
  IntOp ${OUT} ${IN} * $PetalockDpi
  IntOp ${OUT} ${OUT} / 96
!macroend

; The same, rounded up (a box's height: two lines of text fit the box at every scale, where rounding down cut a pixel at 175 %)
!macro PETALOCK_PXU OUT IN
  IntOp ${OUT} ${IN} * $PetalockDpi
  IntOp ${OUT} ${OUT} + 95
  IntOp ${OUT} ${OUT} / 96
!macroend

; A font, made once: SIZE is the em height in pixels at 100 % and WEIGHT 400 or 600. The size is scaled here, by PETALOCK_PX, and the
; font is made from that pixel height (negative: an em, not a cell) by CreateFontW itself. NSIS's own CreateFont is not used: it takes
; points and scales them by the screen's resolution again (exec.c, EW_CREATEFONT: lfHeight = -MulDiv(size, LOGPIXELSY, 72)), so handing
; it a size already scaled made the text grow by the scale squared above 100 % (Task 9e's pictures at 125 to 175 %).
!macro PETALOCK_FONT OUT SIZE WEIGHT
  !insertmacro PETALOCK_PX $R6 ${SIZE}
  IntOp $R6 0 - $R6
  System::Call 'gdi32::CreateFontW(i r16, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 0, i 0, w "Segoe UI") p .s'
  Pop ${OUT}
!macroend

; A plain label on the parent window. The handle is left in OUT. FLAGS: 0x54000080 left, 0x54000082 right (a child that
; clips its siblings, so the stacking order decides what is seen).
!macro PETALOCK_LABEL OUT PARENT X Y W H FLAGS FONT TEXT
  !insertmacro PETALOCK_PX $R6 ${X}
  !insertmacro PETALOCK_PX $R7 ${Y}
  !insertmacro PETALOCK_PX $R8 ${W}
  !insertmacro PETALOCK_PX $R9 ${H}
  ; r16 to r19 are $R6 to $R9 in the System plugin
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${FLAGS}, i r16, i r17, i r18, i r19, p ${PARENT}, i 0, p 0, p 0) p .s'
  Pop ${OUT}
  SendMessage ${OUT} ${WM_SETFONT} ${FONT} 1
!macroend

; Moves a control by design pixels.
!macro PETALOCK_MOVE HWND X Y W H
  !insertmacro PETALOCK_PX $R6 ${X}
  !insertmacro PETALOCK_PX $R7 ${Y}
  !insertmacro PETALOCK_PX $R8 ${W}
  !insertmacro PETALOCK_PX $R9 ${H}
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i r16, i r17, i r18, i r19, i 0x14)'
!macroend

; The same, with the height rounded up (PETALOCK_PXU): a row's words' box.
!macro PETALOCK_MOVEU HWND X Y W H
  !insertmacro PETALOCK_PX $R6 ${X}
  !insertmacro PETALOCK_PX $R7 ${Y}
  !insertmacro PETALOCK_PX $R8 ${W}
  !insertmacro PETALOCK_PXU $R9 ${H}
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i r16, i r17, i r18, i r19, i 0x14)'
!macroend

; ---------------------------------------------------------------------------------------------------------------------
; Colours: every colour goes through these two helpers, which paint nothing under a high-contrast theme.
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockColour
  ; In: $PetalockA the control, $PetalockB its text ("ink", "dim", "green", "red" or "link") and $PetalockR its ground ("white"
  ; or "band"). NSIS reads SetCtlColors' colours when it compiles, so each pair the design uses is spelled out here.
  ${If} $PetalockHC = 1
    Return
  ${EndIf}
  ${If} $PetalockR == "band"
    ${If} $PetalockB == "link"
      SetCtlColors $PetalockA 0F5BB5 F3F3F3
    ${Else}
      SetCtlColors $PetalockA 5B626D F3F3F3
    ${EndIf}
  ${ElseIf} $PetalockB == "dim"
    SetCtlColors $PetalockA 5B626D FFFFFF
  ${ElseIf} $PetalockB == "green"
    SetCtlColors $PetalockA 0F7B2F FFFFFF
  ${ElseIf} $PetalockB == "red"
    SetCtlColors $PetalockA A3200C FFFFFF
  ${ElseIf} $PetalockB == "link"
    SetCtlColors $PetalockA 0F5BB5 FFFFFF
  ${Else}
    SetCtlColors $PetalockA 262931 FFFFFF
  ${EndIf}
FunctionEnd

Function PetalockBand
  ; The page's own ground and the command band (the strip behind the wizard's buttons, a non-focusable label). In:
  ; $PetalockInner.
  ${If} $PetalockHC = 1
    Return
  ${EndIf}
  SetCtlColors $PetalockInner "" "FFFFFF"
  !insertmacro PETALOCK_LABEL $PetalockHBand $PetalockInner 0 306 500 52 0x54000080 $PetalockFBody ""
  SetCtlColors $PetalockHBand "" "F3F3F3"
  !insertmacro PETALOCK_LABEL $PetalockHLine $PetalockInner 0 306 500 1 0x54000080 $PetalockFBody ""
  SetCtlColors $PetalockHLine "" "E5E5E5"
FunctionEnd

Function PetalockSink
  ; The picture, the band's rule and the band itself are the ground of the page: sent to the bottom of the page's stack once
  ; every control is made, the picture first and the band last, so every label and link made on them is in front (a control
  ; made later sits BELOW the ones made before it here, which a first test showed), and the page's own painting no longer
  ; covers the wizard's buttons above it.
  System::Call 'user32::GetWindowLongW(p $PetalockInner, i -16) i .r1'
  IntOp $1 $1 | 0x04000000
  System::Call 'user32::SetWindowLongW(p $PetalockInner, i -16, i r1)'
  ${If} $PetalockHC = 0
    System::Call 'user32::SetWindowPos(p $PetalockHBmp, p 1, i 0, i 0, i 0, i 0, i 0x13)'
    System::Call 'user32::SetWindowPos(p $PetalockHLine, p 1, i 0, i 0, i 0, i 0, i 0x13)'
    System::Call 'user32::SetWindowPos(p $PetalockHBand, p 1, i 0, i 0, i 0, i 0, i 0x13)'
  ${EndIf}
FunctionEnd

!macro PETALOCK_INK HWND
  StrCpy $PetalockA ${HWND}
  StrCpy $PetalockB "ink"
  StrCpy $PetalockR "white"
  Call PetalockColour
!macroend
!macro PETALOCK_DIM HWND
  StrCpy $PetalockA ${HWND}
  StrCpy $PetalockB "dim"
  StrCpy $PetalockR "white"
  Call PetalockColour
!macroend
!macro PETALOCK_LINK HWND GROUND
  StrCpy $PetalockA ${HWND}
  StrCpy $PetalockB "link"
  StrCpy $PetalockR "${GROUND}"
  Call PetalockColour
!macroend

; ---------------------------------------------------------------------------------------------------------------------
; The decisions (no page control, no box)
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockDecide
  ; Out: $PetalockCase from the installed and the bundled versions, $PetalockOldVer, $PetalockNoDown and no remove-first.
  Push $0
  Push $1
  StrCpy $PetalockCase "new"
  StrCpy $PetalockOldVer ""
  StrCpy $PetalockNoDown 0
  StrCpy $PetalockRemoveFirst 0
  ReadRegStr $0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$0$1" != ""
    ReadRegStr $PetalockOldVer SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${If} $PetalockOldVer == ""
      StrCpy $PetalockCase "unknown"
    ${Else}
      nsis_tauri_utils::SemverCompare "${VERSION}" $PetalockOldVer
      Pop $0
      ${If} $0 = 0
        StrCpy $PetalockCase "reinstall"
      ${ElseIf} $0 = 1
        StrCpy $PetalockCase "update"
      ${ElseIf} $0 = -1
        StrCpy $PetalockCase "newer"
      ${Else}
        StrCpy $PetalockCase "unknown"
      ${EndIf}
    ${EndIf}
    ; The build's downgrade policy (Tauri's default allows it): a build that forbids it offers no in-place downgrade, and an
    ; unknown version is treated the same way.
    !if "${ALLOWDOWNGRADES}" == "false"
      ${If} $PetalockCase == "newer"
      ${OrIf} $PetalockCase == "unknown"
        StrCpy $PetalockNoDown 1
      ${EndIf}
    !endif
  ${EndIf}
  ; Update mode (/UPDATE) offers and runs no uninstall at all, whatever else is chosen.
  ${If} $UpdateMode = 1
    StrCpy $PetalockRemoveFirst 0
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function PetalockHasAddedFiles
  ; Out: $PetalockR is 1 when the folder in $INSTDIR holds anything but what Setup installs (the program, the uninstaller and the
  ; notices), or cannot be listed. The old uninstaller keeps such a file and the next section then refuses the folder as not empty.
  Push $0
  Push $1
  StrCpy $PetalockR 0
  FindFirst $0 $1 "$INSTDIR\*.*"
  ${If} $1 == ""
    FindClose $0
    StrCpy $PetalockR 1
    Goto added_done
  ${EndIf}
  added_next:
    ${If} $1 == ""
      Goto added_end
    ${EndIf}
    ${If} $1 != "."
    ${AndIf} $1 != ".."
    ${AndIf} $1 != "${MAINBINARYNAME}.exe"
    ${AndIf} $1 != "uninstall.exe"
    ${AndIf} $1 != "THIRD-PARTY-NOTICES.txt"
      StrCpy $PetalockR 1
      Goto added_end
    ${EndIf}
    FindNext $0 $1
    Goto added_next
  added_end:
  FindClose $0
  added_done:
  Pop $1
  Pop $0
FunctionEnd

Function PetalockQuietChecks
  ; A silent or passive run that PetalockCheckAll stopped (the folder, a running Petalock, the space, the write access) says so on
  ; its console and ends with an error before any change. A window shows the same result on its first page instead.
  ${If} $PetalockProblem == ""
    Return
  ${EndIf}
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    SetErrorLevel 2
    !insertmacro PETALOCK_CONSOLE "Setup cannot start: the folder, the free space, the write access or a running Petalock stops it. Nothing was changed."
    Abort
  ${EndIf}
FunctionEnd

Function PetalockCanWrite
  ; In: $PetalockA, the folder Setup would use. Out: $PetalockR is 1 when the nearest folder that exists on its way can be
  ; added to (files and folders), asked of Windows without writing anything; 0 when not.
  Push $0
  Push $1
  StrCpy $1 0
  can_up:
    IntOp $1 $1 + 1
    ${If} $1 > 64
      StrCpy $PetalockR 0
      Goto can_done
    ${EndIf}
    Call PetalockAttr
    ${If} $PetalockR == "error"
      StrCpy $PetalockR 0
      Goto can_done
    ${EndIf}
    ${If} $PetalockR != "absent"
      ; FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY, everything shared, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS (opens a folder)
      System::Call 'kernel32::CreateFileW(w "$PetalockA", i 0x6, i 7, p 0, i 3, i 0x02000000, p 0) p .r0'
      ${If} $0 = -1
      ${OrIf} $0 = 0
        StrCpy $PetalockR 0
      ${Else}
        System::Call 'kernel32::CloseHandle(p r0)'
        StrCpy $PetalockR 1
      ${EndIf}
      Goto can_done
    ${EndIf}
    Call PetalockParent
    ${If} $PetalockA == ""
      StrCpy $PetalockR 0
      Goto can_done
    ${EndIf}
    Goto can_up
  can_done:
  Pop $1
  Pop $0
FunctionEnd

Function PetalockCheckAll
  ; The folder's rules, a running Petalock, the free space and the write access, in that order, for the folder in $INSTDIR.
  ; Out: $PetalockProblem ("" when all is well), and for "space" the drive, the MB needed and the MB free. Nothing is written
  ; and nothing is shown.
  Push $0
  Push $1
  Push $2
  StrCpy $PetalockProblem ""
  Call PetalockSetMode
  StrCpy $PetalockA $INSTDIR
  Call PetalockGuardFolder
  ${If} $PetalockWhy != ""
    StrCpy $PetalockProblem "folder"
    Goto check_done
  ${EndIf}
  ; Removing first leaves files someone added to the program folder where they are, and the install after it would then refuse the
  ; folder: refused now, while the working install is intact.
  ${If} $PetalockRemoveFirst = 1
    Call PetalockHasAddedFiles
    ${If} $PetalockR = 1
      StrCpy $PetalockProblem "added"
      Goto check_done
    ${EndIf}
  ${EndIf}
  StrCpy $PetalockA $INSTDIR
  Call PetalockIsRunning
  ${If} $PetalockR = 1
    StrCpy $PetalockProblem "running"
    Goto check_done
  ${EndIf}
  ; Space: the drive's root (the guard has shown the folder starts with a drive letter), the MB the install needs (the
  ; build's own estimate, in KB, and a margin), and the MB free there.
  StrCpy $PetalockDrive $INSTDIR 2
  StrCpy $0 $INSTDIR 3
  IntOp $PetalockNeed ${ESTIMATEDSIZE} / 1024
  IntOp $PetalockNeed $PetalockNeed + 3
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$0", *l .r1, *l, *l) i .r2'
  ${If} $2 <> 0
    System::Int64Op $1 / 1048576
    Pop $PetalockFree
    ${If} $PetalockFree < $PetalockNeed
      StrCpy $PetalockProblem "space"
      Goto check_done
    ${EndIf}
  ${EndIf}
  StrCpy $PetalockA $INSTDIR
  Call PetalockCanWrite
  ${If} $PetalockR = 0
    StrCpy $PetalockProblem "write"
    Goto check_done
  ${EndIf}
  check_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The three lines: one table (which row a step is on, in each layout) and the words
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockRowOf
  ; In: $PetalockStep. Out: $0, the row (1 to 3) that step is on, in the order the steps run (D-amendments, "Settled in the build": state
  ; 14's rows follow it, so Now and Next never run backwards). Remove-first (layout 2) runs the old uninstaller, then WebView2, then the
  ; files and the entries, which share the last row. WebView2's second line sits under its own row (PetalockPaintRows).
  StrCpy $0 3
  ${If} $PetalockLayout = 2
    ${If} $PetalockStep == "remove_old"
      StrCpy $0 1
    ${ElseIf} $PetalockStep == "webview2"
      StrCpy $0 2
    ${EndIf}
  ${Else}
    ${If} $PetalockStep == "webview2"
      StrCpy $0 1
    ${ElseIf} $PetalockStep == "files"
      StrCpy $0 2
    ${EndIf}
  ${EndIf}
FunctionEnd

Function PetalockOldName
  ; Out: $PetalockA and $PetalockName, "Petalock 0.1.0" or, when the version is unknown, "Petalock".
  ${If} $PetalockOldVer == ""
    StrCpy $PetalockA "Petalock"
  ${Else}
    StrCpy $PetalockA "Petalock $PetalockOldVer"
  ${EndIf}
  StrCpy $PetalockName $PetalockA
FunctionEnd

Function PetalockPlanRows
  ; The plan, before anything runs: the words only (no state). Nothing here is Done.
  StrCpy $PetalockS1 ""
  StrCpy $PetalockS2 ""
  StrCpy $PetalockS3 ""
  StrCpy $PetalockD1 ""
  ${If} $PetalockRemoveFirst = 1
    StrCpy $PetalockLayout 2
  ${Else}
    StrCpy $PetalockLayout 1
  ${EndIf}
  Call PetalockOldName
  ; WebView2's second line is in every layout. Remove-first puts the removal on row 1, WebView2 (with its second line under it, in the
  ; place the removal left empty) on row 2 and the install on row 3, the order they run in.
  StrCpy $PetalockD1 "${PL_PLAN_WV_D}"
  ${If} $PetalockLayout = 2
    StrCpy $PetalockT1 "Remove $PetalockA first, with its temporary copies of opened files"
    StrCpy $PetalockT2 "${PL_PLAN_WV}"
    StrCpy $PetalockT3 "Install ${VERSION} in the same folder; keep its Start menu shortcut"
    Return
  ${EndIf}
  StrCpy $PetalockT1 "${PL_PLAN_WV}"
  ${If} $PetalockCase == "new"
    StrCpy $PetalockT2 "Install Petalock for this Windows account"
    StrCpy $PetalockT3 "Add it to the Start menu and to Installed apps"
  ${ElseIf} $PetalockCase == "update"
    StrCpy $PetalockT2 "Replace $PetalockA with ${VERSION} in its folder"
    StrCpy $PetalockT3 "Keep its Start menu shortcut; Installed apps shows ${VERSION}"
  ${ElseIf} $PetalockCase == "newer"
    StrCpy $PetalockT2 "Replace $PetalockOldVer with the older ${VERSION} in its folder"
    StrCpy $PetalockT3 "Keep its Start menu shortcut; Installed apps shows ${VERSION}"
  ${ElseIf} $PetalockCase == "reinstall"
    StrCpy $PetalockT2 "Copy Petalock ${VERSION} into its folder again"
    StrCpy $PetalockT3 "Keep its Start menu shortcut and Installed apps entry"
  ${Else}
    StrCpy $PetalockT2 "Replace it with ${VERSION} in its folder"
    StrCpy $PetalockT3 "Keep its Start menu shortcut; Installed apps shows ${VERSION}"
  ${EndIf}
FunctionEnd

Function PetalockStepText
  ; In: $PetalockStep and the state in $PetalockB (now | done | failed). Out: $PetalockA the row's words, $PetalockR its second
  ; line (row 1 only). Done words come from what really happened ($PetalockWv, $PetalockSc), never from the plan.
  StrCpy $PetalockR ""
  Push $0
  Call PetalockOldName
  ${If} $PetalockStep == "remove_old"
    ${If} $PetalockB == "now"
      StrCpy $PetalockA "Removing $PetalockA…"
    ${ElseIf} $PetalockB == "done"
      StrCpy $PetalockA "$PetalockA was removed"
    ${Else}
      StrCpy $PetalockA "Remove $PetalockA first"
    ${EndIf}
  ${ElseIf} $PetalockStep == "webview2"
    ${If} $PetalockB == "now"
      ${If} $PetalockWvMissing = 1
        StrCpy $PetalockA "Getting Microsoft WebView2…"
        StrCpy $PetalockR "It was missing, so Setup is downloading it from Microsoft."
      ${Else}
        StrCpy $PetalockA "Checking for Microsoft WebView2…"
        StrCpy $PetalockR "If it’s missing, Setup downloads it from Microsoft and needs internet."
      ${EndIf}
    ${ElseIf} $PetalockB == "done"
      StrCpy $PetalockA "Microsoft WebView2"
      ${If} $PetalockWv == "got"
        StrCpy $PetalockR "Installed by Setup"
      ${ElseIf} $PetalockWv == "missing"
        StrCpy $PetalockR "Not found: an update does not get it, so Petalock may not open"
      ${Else}
        StrCpy $PetalockR "Already installed"
      ${EndIf}
    ${Else}
      StrCpy $PetalockA "Get Microsoft WebView2"
      StrCpy $PetalockR "$PetalockDetail"
    ${EndIf}
  ${ElseIf} $PetalockStep == "files"
    ${If} $PetalockB == "now"
      ${If} $PetalockCase == "new"
        StrCpy $PetalockA "Installing Petalock for this Windows account"
      ${ElseIf} $PetalockCase == "reinstall"
        StrCpy $PetalockA "Copying Petalock ${VERSION} into its folder again"
      ${ElseIf} $PetalockLayout = 2
        StrCpy $PetalockA "Installing ${VERSION} in the same folder"
      ${Else}
        StrCpy $PetalockA "Replacing $PetalockA with ${VERSION}"
      ${EndIf}
    ${ElseIf} $PetalockB == "done"
      ${If} $PetalockCase == "new"
        StrCpy $PetalockA "Petalock is installed for this Windows account"
      ${ElseIf} $PetalockCase == "reinstall"
        StrCpy $PetalockA "Petalock ${VERSION} was copied into its folder again"
      ${ElseIf} $PetalockLayout = 2
        StrCpy $PetalockA "Petalock ${VERSION} is installed in the same folder"
      ${Else}
        StrCpy $PetalockA "Petalock ${VERSION} replaced $PetalockOldVer in its folder"
      ${EndIf}
    ${Else}
      ${If} $PetalockCase == "new"
        StrCpy $PetalockA "Install Petalock for this Windows account"
      ${Else}
        StrCpy $PetalockA "Install Petalock ${VERSION} in its folder"
      ${EndIf}
    ${EndIf}
  ${Else}
    ; entries: the Start menu shortcut and the Installed apps entry
    ${If} $PetalockB == "done"
      ${If} $PetalockSc == "skipped"
        StrCpy $PetalockA "The Start menu shortcut was skipped; Installed apps lists Petalock"
      ${ElseIf} $PetalockSc == "failed"
        StrCpy $PetalockA "The Start menu shortcut couldn’t be made; Installed apps lists Petalock"
      ${ElseIf} $PetalockCase == "new"
        StrCpy $PetalockA "Added to the Start menu and to Installed apps"
      ${ElseIf} $PetalockSc == "kept"
        StrCpy $PetalockA "Start menu shortcut kept; Installed apps shows ${VERSION}"
      ${Else}
        StrCpy $PetalockA "Start menu shortcut added; Installed apps shows ${VERSION}"
      ${EndIf}
    ${ElseIf} $PetalockCase == "new"
      StrCpy $PetalockA "Add it to the Start menu and to Installed apps"
    ${Else}
      StrCpy $PetalockA "Keep its Start menu shortcut; Installed apps shows ${VERSION}"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; Paints one row (N = 1, 2, 3; its top Y and its box's height H in design pixels) from $PetalockT<N>, $PetalockS<N>: the words, the
; state's word, the fonts and colours.
!macro PETALOCK_PAINT N Y H
  ${If} $PetalockHT${N} != ""
    StrCpy $PetalockW${N} ""
    StrCpy $PetalockB "ink"
    StrCpy $PetalockSW 0
    ${If} $PetalockS${N} == "done"
      StrCpy $PetalockW${N} "Done"
      StrCpy $PetalockB "green"
      StrCpy $PetalockSW ${PL_SW_DONE}
    ${ElseIf} $PetalockS${N} == "now"
      StrCpy $PetalockW${N} "Now"
      StrCpy $PetalockSW ${PL_SW_NOW}
    ${ElseIf} $PetalockS${N} == "next"
      StrCpy $PetalockW${N} "Next"
      StrCpy $PetalockB "dim"
      StrCpy $PetalockSW ${PL_SW_NEXT}
    ${ElseIf} $PetalockS${N} == "failed"
      StrCpy $PetalockW${N} "Failed"
      StrCpy $PetalockB "red"
      StrCpy $PetalockSW ${PL_SW_FAILED}
    ${ElseIf} $PetalockS${N} == "undone"
      StrCpy $PetalockW${N} "Removed"
      StrCpy $PetalockSW ${PL_SW_REMOVED}
    ${ElseIf} $PetalockS${N} == "ns"
      StrCpy $PetalockW${N} "Not started"
      StrCpy $PetalockB "dim"
      StrCpy $PetalockSW ${PL_SW_NOTSTARTED}
    ${EndIf}
    SendMessage $PetalockHT${N} ${WM_SETTEXT} 0 "STR:$PetalockT${N}"
    SendMessage $PetalockHS${N} ${WM_SETTEXT} 0 "STR:$PetalockW${N}"
    ; The state's word sits at the right in a column of its own width; the row's words get the rest of the 432 less the gap, so the
    ; words and the state never share a rectangle and the words are not cut (with none, the plan, they run the whole width).
    Push $R6
    Push $R7
    Push $R8
    Push $R9
    ${If} $PetalockW${N} == ""
      ShowWindow $PetalockHS${N} ${SW_HIDE}
      !insertmacro PETALOCK_MOVEU $PetalockHT${N} 44 ${Y} 432 ${H}
    ${Else}
      ShowWindow $PetalockHS${N} ${SW_SHOW}
      IntOp $PetalockTW 432 - $PetalockSW
      IntOp $PetalockTW $PetalockTW - ${PL_GAP}
      IntOp $PetalockTX 476 - $PetalockSW
      !insertmacro PETALOCK_MOVEU $PetalockHT${N} 44 ${Y} $PetalockTW ${H}
      !insertmacro PETALOCK_MOVE $PetalockHS${N} $PetalockTX ${Y} $PetalockSW 20
    ${EndIf}
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    StrCpy $PetalockR "white"
    StrCpy $PetalockA $PetalockHS${N}
    Call PetalockColour
    ${If} $PetalockS${N} == "now"
    ${OrIf} $PetalockS${N} == "failed"
      SendMessage $PetalockHT${N} ${WM_SETFONT} $PetalockFBold 1
      SendMessage $PetalockHS${N} ${WM_SETFONT} $PetalockFBold 1
    ${Else}
      SendMessage $PetalockHT${N} ${WM_SETFONT} $PetalockFBody 1
      SendMessage $PetalockHS${N} ${WM_SETFONT} $PetalockFBody 1
    ${EndIf}
    ${If} $PetalockS${N} == "next"
    ${OrIf} $PetalockS${N} == "ns"
      !insertmacro PETALOCK_DIM $PetalockHT${N}
      !insertmacro PETALOCK_DIM $PetalockHN${N}
    ${Else}
      !insertmacro PETALOCK_INK $PetalockHT${N}
      !insertmacro PETALOCK_INK $PetalockHN${N}
    ${EndIf}
    ; SetCtlColors only stores the colours a static is drawn with (exec.c, EW_SETCTLCOLORS); it does not repaint. The text and the font
    ; were set above, before the colours, and the number's words never change, so a row painted Next (grey) and then as the plan again
    ; (ink, after a refused Install, Update or Retry) went on showing the grey one. Each control is repainted now, colours set.
    System::Call 'user32::InvalidateRect(p $PetalockHT${N}, p 0, i 1)'
    System::Call 'user32::InvalidateRect(p $PetalockHN${N}, p 0, i 1)'
    System::Call 'user32::InvalidateRect(p $PetalockHS${N}, p 0, i 1)'
  ${EndIf}
!macroend

Function PetalockPaintRows
  ; Row 2 and WebView2's second line move with the layout: a normal run has WebView2 on row 1 with its line under it and row 2 at 180;
  ; remove-first has the removal on row 1 and WebView2 on row 2, rows 20 apart, its line under it and the install at 202.
  ${If} $PetalockLayout = 2
    StrCpy $PetalockRY2 ${PL_L2_ROW2}
    StrCpy $PetalockRYD ${PL_L2_DETAIL}
  ${Else}
    StrCpy $PetalockRY2 ${PL_ROW2}
    StrCpy $PetalockRYD ${PL_DETAIL}
  ${EndIf}
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ${If} $PetalockHN2 != ""
    !insertmacro PETALOCK_MOVE $PetalockHN2 24 $PetalockRY2 14 20
  ${EndIf}
  ${If} $PetalockHD1 != ""
    !insertmacro PETALOCK_MOVE $PetalockHD1 44 $PetalockRYD 446 20
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  !insertmacro PETALOCK_PAINT 1 ${PL_ROW1} 20
  !insertmacro PETALOCK_PAINT 2 $PetalockRY2 20
  !insertmacro PETALOCK_PAINT 3 ${PL_ROW3} 34
  ${If} $PetalockHD1 != ""
    SendMessage $PetalockHD1 ${WM_SETTEXT} 0 "STR:$PetalockD1"
  ${EndIf}
FunctionEnd

Function PetalockBuildRows
  ; The three rows' labels on $PetalockInner: number, words, state (right-aligned), and row 1's second line.
  !insertmacro PETALOCK_LABEL $PetalockHN1 $PetalockInner 24 ${PL_ROW1} 14 20 0x54000080 $PetalockFBold "1"
  !insertmacro PETALOCK_LABEL $PetalockHN2 $PetalockInner 24 ${PL_ROW2} 14 20 0x54000080 $PetalockFBold "2"
  !insertmacro PETALOCK_LABEL $PetalockHN3 $PetalockInner 24 ${PL_ROW3} 14 20 0x54000080 $PetalockFBold "3"
  ; Words that do not fit wrap (row 3 has two lines) and are never cut with dots (the old 0x4000, SS_ENDELLIPSIS, ended a long row in "...").
  !insertmacro PETALOCK_LABEL $PetalockHT1 $PetalockInner 44 ${PL_ROW1} 432 20 0x54000080 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHT2 $PetalockInner 44 ${PL_ROW2} 432 20 0x54000080 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHT3 $PetalockInner 44 ${PL_ROW3} 432 34 0x54000080 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHS1 $PetalockInner 380 ${PL_ROW1} 96 20 0x54000082 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHS2 $PetalockInner 380 ${PL_ROW2} 96 20 0x54000082 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHS3 $PetalockInner 380 ${PL_ROW3} 96 20 0x54000082 $PetalockFBody ""
  !insertmacro PETALOCK_LABEL $PetalockHD1 $PetalockInner 44 160 446 20 0x54000080 $PetalockFBody ""
  StrCpy $PetalockA $PetalockHD1
  StrCpy $PetalockB "dim"
  StrCpy $PetalockR "white"
  Call PetalockColour
FunctionEnd

; A step begins / finishes (called by the sections, between operations). Rows are painted only when there is a window.
Function PetalockStepBegin
  Push $0
  Call PetalockRowOf
  StrCpy $PetalockB "now"
  Call PetalockStepText
  ${If} $0 = 1
    StrCpy $PetalockT1 $PetalockA
    StrCpy $PetalockS1 "now"
  ${ElseIf} $0 = 2
    StrCpy $PetalockT2 $PetalockA
    StrCpy $PetalockS2 "now"
  ${Else}
    StrCpy $PetalockT3 $PetalockA
    StrCpy $PetalockS3 "now"
  ${EndIf}
  ; only WebView2 has a second line (under its own row, whichever row that is)
  ${If} $PetalockStep == "webview2"
    StrCpy $PetalockD1 $PetalockR
  ${EndIf}
  Call PetalockPaintRows
  ; Copying the files shows a percentage: the bar stops moving without one (the checks, the old uninstaller and WebView2 had no).
  ${If} $PetalockStep == "files"
    Call PetalockBarNormal
  ${EndIf}
  ; One status line says what is really happening, and is announced (review fix round, finding 16).
  Call PetalockSetStatus
  StrCpy $PetalockA $PetalockHStat
  Call PetalockAnnounce
  Pop $0
FunctionEnd

Function PetalockSetStatus
  ; In: $PetalockStep. The status line under the bar, from the step that is running; never a file name.
  ${If} $PetalockHStat == ""
    Return
  ${EndIf}
  ${If} $PetalockStep == "remove_old"
    SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Removing the earlier version…"
  ${ElseIf} $PetalockStep == "webview2"
    ${If} $PetalockWvMissing = 1
      SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Downloading from Microsoft. This needs internet."
    ${Else}
      SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Checking for Microsoft WebView2…"
    ${EndIf}
  ${ElseIf} $PetalockStep == "files"
    SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Copying Petalock files…"
  ${Else}
    SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Adding it to the Start menu and to Installed apps…"
  ${EndIf}
FunctionEnd

Function PetalockBarNormal
  ${If} $PetalockHBar == ""
    Return
  ${EndIf}
  Push $1
  SendMessage $PetalockHBar 0x40A 0 0
  System::Call 'user32::GetWindowLongW(p $PetalockHBar, i -16) i .r1'
  IntOp $1 $1 & 0xFFFFFFF7
  System::Call 'user32::SetWindowLongW(p $PetalockHBar, i -16, i r1)'
  Pop $1
FunctionEnd

Function PetalockStepDone
  Push $0
  Call PetalockRowOf
  ; Remove-first has one row for the files and the entries: it is Done when the entries are.
  ${If} $PetalockLayout = 2
  ${AndIf} $PetalockStep == "files"
    Pop $0
    Return
  ${EndIf}
  StrCpy $PetalockB "done"
  Call PetalockStepText
  ${If} $0 = 1
    StrCpy $PetalockT1 $PetalockA
    StrCpy $PetalockS1 "done"
  ${ElseIf} $0 = 2
    StrCpy $PetalockT2 $PetalockA
    StrCpy $PetalockS2 "done"
  ${Else}
    StrCpy $PetalockT3 $PetalockA
    ${If} $PetalockSc == "failed"
      StrCpy $PetalockS3 "failed"
    ${Else}
      StrCpy $PetalockS3 "done"
    ${EndIf}
  ${EndIf}
  ; only WebView2 has a second line (under its own row, whichever row that is)
  ${If} $PetalockStep == "webview2"
    StrCpy $PetalockD1 $PetalockR
  ${EndIf}
  ; The words are kept in a variable of their own: the repaint puts window handles in $PetalockA (second fix round, re-check
  ; finding 6: the status line and the announcement showed a number).
  StrCpy $PetalockOutcome $PetalockA
  ; The WebView2 row's words are the product alone; its result ("Already installed", "Installed by Setup" or the update's missing
  ; wording) is its second line in $PetalockR, so the status line and the announcement say both, as the receipt's remove-first row does.
  ${If} $PetalockStep == "webview2"
    StrCpy $PetalockOutcome "$PetalockA: $PetalockR"
  ${EndIf}
  ; The next row, if any, is now Next... the step that follows says "Now" itself when it starts.
  Call PetalockPaintRows
  ${If} $PetalockHStat != ""
    SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:$PetalockOutcome"
    StrCpy $PetalockA $PetalockHStat
    Call PetalockAnnounce
  ${EndIf}
  Pop $0
FunctionEnd

Function PetalockNameStatus
  ; The status line gets a fixed control id (GWL_ID, -12; this installer is 32-bit, so the plain call is the right one).
  System::Call 'user32::SetWindowLongW(p $PetalockHStat, i -12, i ${PL_ID_STATUS})'
FunctionEnd

!macro PETALOCK_BEGIN STEP
  StrCpy $PetalockStep "${STEP}"
  Call PetalockStepBegin
!macroend
!macro PETALOCK_DONE STEP
  StrCpy $PetalockStep "${STEP}"
  Call PetalockStepDone
!macroend
; A step failed: DETAIL is fixed text (never a file name), kept for the failure page and for Copy details.
!macro PETALOCK_FAILED STEP DETAIL
  StrCpy $PetalockStep "${STEP}"
  StrCpy $PetalockDetail "${DETAIL}"
  Call PetalockFailed
!macroend
; The same, when $PetalockDetail was already set (the WebView2 step's reason).
!macro PETALOCK_FAILED_AS_IS STEP
  StrCpy $PetalockStep "${STEP}"
  Call PetalockFailed
!macroend

Function PetalockRowAs
  ; In: $PetalockStep and $PetalockB (done or failed). Puts that step's words, in that state, on the row the table gives it, and
  ; WebView2's second line (only it has one) with them.
  Push $0
  Call PetalockRowOf
  Call PetalockStepText
  ${If} $0 = 1
    StrCpy $PetalockT1 $PetalockA
    StrCpy $PetalockS1 $PetalockB
  ${ElseIf} $0 = 2
    StrCpy $PetalockT2 $PetalockA
    StrCpy $PetalockS2 $PetalockB
  ${Else}
    StrCpy $PetalockT3 $PetalockA
    StrCpy $PetalockS3 $PetalockB
  ${EndIf}
  ${If} $PetalockStep == "webview2"
    StrCpy $PetalockD1 $PetalockR
  ${EndIf}
  Pop $0
FunctionEnd

Function PetalockReceiptRows
  ; The receipt, from what happened: every row Done (a shortcut that could not be made is Failed beside a good entry). Each step is on
  ; its row by the table (PetalockRowOf), WebView2's result on its second line, under its own row, in both layouts.
  StrCpy $PetalockB "done"
  StrCpy $PetalockStep "webview2"
  Call PetalockRowAs
  ${If} $PetalockLayout = 2
    StrCpy $PetalockStep "remove_old"
  ${Else}
    StrCpy $PetalockStep "files"
  ${EndIf}
  Call PetalockRowAs
  StrCpy $PetalockStep "entries"
  Call PetalockRowAs
  ${If} $PetalockSc == "failed"
    StrCpy $PetalockS3 "failed"
  ${EndIf}
FunctionEnd

Function PetalockFailRows
  ; Where Setup stopped: the failed step Failed, the ones that ran before it Done (in the words of what happened), the ones after it
  ; Not started. The steps run in this order: the old uninstaller (remove-first only), WebView2, the files, the entries; each is put on
  ; its own row by the table, so a step before the failed one is Done wherever its row is. Out: the rows' words and states (painted by
  ; the caller).
  Push $0
  Call PetalockPlanRows
  StrCpy $PetalockS1 "ns"
  StrCpy $PetalockS2 "ns"
  StrCpy $PetalockS3 "ns"
  StrCpy $PetalockB "done"
  ${If} $PetalockLayout = 2
  ${AndIf} $PetalockFailStep != "remove_old"
    StrCpy $PetalockStep "remove_old"
    Call PetalockRowAs
  ${EndIf}
  ${If} $PetalockFailStep == "files"
  ${OrIf} $PetalockFailStep == "entries"
    StrCpy $PetalockStep "webview2"
    Call PetalockRowAs
  ${EndIf}
  ${If} $PetalockFailStep == "entries"
    StrCpy $PetalockStep "files"
    Call PetalockRowAs
    ; the files were copied and then taken out again (a fresh attempt whose entry Windows refused): the row does not say they are there
    ${If} $PetalockRolledBack = 1
    ${AndIf} $PetalockLayout = 1
      StrCpy $PetalockT2 "Petalock’s files were copied, then removed again"
      StrCpy $PetalockS2 "undone"
    ${EndIf}
  ${EndIf}
  StrCpy $PetalockStep $PetalockFailStep
  StrCpy $PetalockB "failed"
  Call PetalockRowAs
  Pop $0
FunctionEnd

Function PetalockGuiSetup
  ; The window just made: its DPI, the theme, the fonts, the size and the wizard's own parts, once (see PetalockGuiInit).
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $PetalockDpi $0
  ; The layout scale is the message font's real size, not the DPI alone: 12 px is 96, so a display at 125 % (15 px) and larger
  ; Windows text both grow the whole window (the design is 500 x 358 at 12 px). SPI_GETNONCLIENTMETRICS (0x29) is 504 bytes in this
  ; 32-bit installer, and lfMessageFont's height is the int at byte 408.
  System::Alloc 504
  Pop $1
  System::Call '*$1(i 504)'
  System::Call 'user32::SystemParametersInfoForDpi(i 0x29, i 504, p r1, i 0, i r0) i .r2'
  ${If} $2 <> 0
    IntOp $3 $1 + 408
    System::Call 'kernel32::RtlMoveMemory(*i .r4, i r3, i 4)'
    ${If} $4 < 0
      IntOp $4 0 - $4
    ${EndIf}
    ${If} $4 >= 12
    ${AndIf} $4 <= 48
      IntOp $PetalockDpi $4 * 8
    ${EndIf}
  ${EndIf}
  System::Free $1
  ; never taller than the screen can show (the window is 358 high at 96, plus its title bar and frame)
  System::Call 'user32::GetSystemMetrics(i 1) i .r5'
  IntOp $5 $5 - 80
  IntOp $5 $5 * 96
  IntOp $5 $5 / 358
  ${If} $PetalockDpi > $5
    StrCpy $PetalockDpi $5
  ${EndIf}
  ${If} $PetalockDpi < 96
    StrCpy $PetalockDpi 96
  ${EndIf}
  Call PetalockProbeHC
  Call PetalockMakeFonts
  Call PetalockSizeWindow
  Call PetalockHideChrome
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The window: fonts, size, the wizard's own parts, the buttons
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockProbeHC
  ; SPI_GETHIGHCONTRAST (0x42): HIGHCONTRAST is 12 bytes in this 32-bit installer; HCF_HIGHCONTRASTON is bit 0 of dwFlags.
  StrCpy $PetalockHC 0
  Push $1
  Push $2
  Push $3
  System::Alloc 12
  Pop $1
  System::Call '*$1(i 12, i 0, p 0)'
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r1, i 0) i .r2'
  System::Call '*$1(i, i .r3)'
  System::Free $1
  ${If} $2 <> 0
    IntOp $3 $3 & 1
    StrCpy $PetalockHC $3
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

Function PetalockMakeFonts
  ; Every font is made once, from its pixel height at 100 % (PETALOCK_FONT scales it by the window's scale and makes it).
  Push $R6
  !insertmacro PETALOCK_FONT $PetalockFBody 12 400
  !insertmacro PETALOCK_FONT $PetalockFBold 12 600
  !insertmacro PETALOCK_FONT $PetalockFSent 15 400
  !insertmacro PETALOCK_FONT $PetalockFSentB 15 600
  !insertmacro PETALOCK_FONT $PetalockFHead 20 600
  ; the name beside the mark: Segoe UI Semibold a little under the design's 21 px Geist (Segoe UI's letters are wider)
  !insertmacro PETALOCK_FONT $PetalockFName 19 600
  Pop $R6
FunctionEnd

Function PetalockSizeWindow
  ; The client area is 500 x 358 at 100 %: the window grows or shrinks to it (its frame and title bar stay), is centred, and
  ; the inner page's rectangle (control 1018, which every page is made in) covers all of it.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  !insertmacro PETALOCK_PX $5 500
  !insertmacro PETALOCK_PX $6 358
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i, i, i .r2, i .r3)'
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i .r7, i .r8, i .r4, i .r0)'
  System::Free $1
  IntOp $4 $4 - $7
  IntOp $0 $0 - $8
  IntOp $4 $4 - $2
  IntOp $0 $0 - $3
  IntOp $4 $4 + $5
  IntOp $0 $0 + $6
  System::Call 'user32::GetSystemMetrics(i 0) i .r7'
  System::Call 'user32::GetSystemMetrics(i 1) i .r8'
  IntOp $7 $7 - $4
  IntOp $7 $7 / 2
  IntOp $8 $8 - $0
  IntOp $8 $8 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r7, i r8, i r4, i r0, i 0x14)'
  GetDlgItem $1 $HWNDPARENT 1018
  System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i r5, i r6, i 0x14)'
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function PetalockHideChrome
  ; The wizard's header, its bottom line and its branding line are not part of this design: every control of the outer window
  ; that is not a button or the page's own rectangle is hidden, and so is Back. Run for every page (the stock pages show
  ; their header again).
  Push $0
  Push $1
  Push $2
  Push $3
  System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p .r1'
  chrome_next:
    ${If} $1 = 0
      Goto chrome_end
    ${EndIf}
    System::Call 'user32::GetClassNameW(p r1, w .r2, i 64)'
    System::Call 'user32::GetDlgCtrlID(p r1) i .r3'
    ${If} $2 != "Button"
    ${AndIf} $2 != "#32770"
    ${AndIf} $3 <> 1018
      ShowWindow $1 ${SW_HIDE}
    ${EndIf}
    System::Call 'user32::GetWindow(p r1, i 2) p .r1'
    Goto chrome_next
  chrome_end:
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function PetalockFrame
  ; Every page: the chrome hidden, the two wizard buttons where the design has them (Install / Cancel on the band, 75 x 23)
  ; and raised above the page, which covers the whole client area.
  Call PetalockHideChrome
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro PETALOCK_MOVE $0 318 320 75 23
  System::Call 'user32::SetWindowPos(p $0, p 0, i 0, i 0, i 0, i 0, i 0x13)'
  GetDlgItem $0 $HWNDPARENT 2
  !insertmacro PETALOCK_MOVE $0 401 320 75 23
  System::Call 'user32::SetWindowPos(p $0, p 0, i 0, i 0, i 0, i 0, i 0x13)'
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  EnableWindow $0 1
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
FunctionEnd

Function PetalockSetButton
  ; In: $PetalockA the button's id (1 Next, 2 Cancel), $PetalockB its words.
  GetDlgItem $0 $HWNDPARENT $PetalockA
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$PetalockB"
FunctionEnd

Function PetalockCancelDefault
  ; The newer-version screen: Cancel is the default (Enter cancels); an action only by choice.
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $HWNDPARENT 0x401 2 0
  SendMessage $0 0xF4 1 0
  ; and the keyboard focus is on Cancel itself (WM_NEXTDLGCTL, to the control), so Enter cancels whatever the first Tab stop is
  SendMessage $HWNDPARENT 0x28 $0 1
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 0xF4 0 0
FunctionEnd

Function PetalockChrome
  ; The band at the top, on $PetalockInner: the engraved picture (a bitmap shipped at twice its size and scaled to the
  ; control; a static, never focused), then the name. Not interactive, so every page can have it.
  Call PetalockBand
  !insertmacro PETALOCK_PX $R6 24
  !insertmacro PETALOCK_PX $R7 22
  !insertmacro PETALOCK_PX $R8 476
  !insertmacro PETALOCK_PX $R9 52
  ; Review fix round, finding 18: under a high-contrast theme the fixed blue-on-white picture is not drawn at all (the name stays,
  ; in the system's colours). SS_BITMAP | SS_REALSIZECONTROL: the picture is stretched to the control.
  ${If} $PetalockHC = 0
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5400004E, i r16, i r17, i r18, i r19, p $PetalockInner, i 0, p 0, p 0) p .r0'
    StrCpy $PetalockHBmp $0
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\band.bmp", i 0, i 0, i 0, i 0x10) p .r1'
    ${If} $1 <> 0
      SendMessage $0 0x172 0 $1
    ${EndIf}
  ${EndIf}
  ; the name beside the mark, in Segoe UI (the picture holds no text: no font is rasterised in the build)
  !insertmacro PETALOCK_LABEL $0 $PetalockInner 54 34 94 30 0x54000080 $PetalockFName "Petalock"
  !insertmacro PETALOCK_INK $0
FunctionEnd

Function PetalockAnnounce
  ; In: $PetalockA, a label whose words just changed. A screen reader is told, so a step change, an error or the end is read
  ; without moving the focus (EVENT_OBJECT_NAMECHANGE on the client object).
  System::Call 'user32::NotifyWinEvent(i 0x800C, p $PetalockA, i -4, i 0)'
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The Cancel boundary
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockLockCancel
  ; Cancel, Esc and the title-bar close go off together. Done once.
  ${If} $PetalockLocked = 1
    Return
  ${EndIf}
  StrCpy $PetalockLocked 1
  Push $0
  Push $1
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0) p .r1'
  System::Call 'user32::EnableMenuItem(p r1, i 0xF060, i 0x1)'
  Pop $1
  Pop $0
FunctionEnd

Function PetalockUnlockCancel
  StrCpy $PetalockLocked 0
  Push $0
  Push $1
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
  System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0) p .r1'
  System::Call 'user32::EnableMenuItem(p r1, i 0xF060, i 0x0)'
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; A failed step
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockFailed
  ; In: $PetalockStep (the step that failed) and $PetalockDetail (fixed words). A quiet run says so on its console and ends
  ; with an error (exit code 2): /S stops with Abort, /P (which has no page to stop on) quits. A window is sent on to the last
  ; page, which shows where Setup stopped (never a success receipt), with Cancel and the close button back on.
  StrCpy $PetalockFailStep $PetalockStep
  SetErrorLevel 2
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    !insertmacro PETALOCK_CONSOLE "Petalock could not be fully installed. Setup stopped before it finished."
    ${If} $PassiveMode = 1
      Quit
    ${EndIf}
    Abort
  ${EndIf}
  Call PetalockUnlockCancel
  SetAutoClose true
FunctionEnd

Function PetalockWebviewReason
  ; In: $PetalockDetail holds the bootstrapper's exit code as a number. Out: $PetalockDetail, why, in words: the offline
  ; reason only when the machine itself says it is offline (InternetGetConnectedState), else the code.
  Push $0
  Push $1
  Push $2
  StrCpy $2 $PetalockDetail
  System::Call 'wininet::InternetGetConnectedState(*i .r1, i 0) i .r0'
  ${If} $0 = 0
    StrCpy $PetalockDetail "Microsoft couldn’t be reached: this PC seems to be offline."
  ${Else}
    StrCpy $PetalockDetail "Microsoft’s installer didn’t finish (exit code $2)."
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function PetalockWebviewShowError
  ; Before the Retry box: the window says what failed, in the error layout, while the box asks.
  ${If} $PetalockHT1 == ""
    Return
  ${EndIf}
  StrCpy $PetalockFailStep "webview2"
  Call PetalockFailRows
  Call PetalockPaintRows
  Call PetalockUnlockCancel
  SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Setup couldn’t get Microsoft WebView2."
  StrCpy $PetalockA $PetalockHStat
  Call PetalockAnnounce
  StrCpy $PetalockFailStep ""
FunctionEnd

Function PetalockWebviewMissing
  ; WebView2 is missing: the row says Setup is getting it, and the bar moves without a percentage (the download reports none).
  StrCpy $PetalockWvMissing 1
  StrCpy $PetalockStep "webview2"
  Call PetalockSetStatus
  !insertmacro PETALOCK_BEGIN webview2
  Call PetalockMarquee
FunctionEnd

Function PetalockMarquee
  ${If} $PetalockHBar == ""
    Return
  ${EndIf}
  Push $1
  ; PBS_MARQUEE (0x8) on the bar, then PBM_SETMARQUEE (0x40A) on
  System::Call 'user32::GetWindowLongW(p $PetalockHBar, i -16) i .r1'
  IntOp $1 $1 | 8
  System::Call 'user32::SetWindowLongW(p $PetalockHBar, i -16, i r1)'
  SendMessage $PetalockHBar 0x40A 1 30
  Pop $1
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The main page
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockRender
  ; Sets every word and every control of the main page from the case, the options and the problem found. Nothing is created.
  Call PetalockPlanRows
  Call PetalockOldName
  ; the sentence
  StrCpy $PetalockR $PetalockFSent
  ${If} $PetalockProblem == "space"
    StrCpy $PetalockB "Not enough space on drive $PetalockDrive"
    StrCpy $PetalockR $PetalockFSentB
  ${ElseIf} $PetalockProblem == "running"
    StrCpy $PetalockB "Close Petalock, then try again."
    StrCpy $PetalockR $PetalockFSentB
  ${ElseIf} $PetalockProblem == "added"
    StrCpy $PetalockB "Petalock can’t be removed first"
    StrCpy $PetalockR $PetalockFSentB
  ${ElseIf} $PetalockProblem != ""
  ${AndIf} $PetalockCase != "new"
    StrCpy $PetalockB "Setup can’t write to Petalock’s folder"
    StrCpy $PetalockR $PetalockFSentB
  ${ElseIf} $PetalockCase == "update"
    StrCpy $PetalockB "$PetalockName is on this PC. This updates it to ${VERSION}."
  ${ElseIf} $PetalockCase == "reinstall"
    StrCpy $PetalockB "Petalock ${VERSION} is already on this PC."
  ${ElseIf} $PetalockCase == "newer"
    StrCpy $PetalockB "A newer Petalock, $PetalockOldVer, is on this PC."
  ${ElseIf} $PetalockCase == "unknown"
    StrCpy $PetalockB "Petalock is on this PC, but Setup can’t tell which version."
  ${Else}
    StrCpy $PetalockB "${PL_SUB}"
  ${EndIf}
  SendMessage $PetalockHSent ${WM_SETFONT} $PetalockR 1
  SendMessage $PetalockHSent ${WM_SETTEXT} 0 "STR:$PetalockB"
  Call PetalockPaintRows
  ; the slot below the rows: one place for what the state needs
  ShowWindow $PetalockHSlot1 ${SW_HIDE}
  ShowWindow $PetalockHSlot2 ${SW_HIDE}
  ShowWindow $PetalockHFLab ${SW_HIDE}
  ShowWindow $PetalockHOptions ${SW_HIDE}
  ShowWindow $PetalockHField ${SW_HIDE}
  ShowWindow $PetalockHBrowse ${SW_HIDE}
  ShowWindow $PetalockHOther ${SW_HIDE}
  ShowWindow $PetalockHUninst ${SW_HIDE}
  ShowWindow $PetalockHCheck ${SW_HIDE}
  ShowWindow $PetalockHBar ${SW_HIDE}
  ShowWindow $PetalockHStat ${SW_HIDE}
  StrCpy $PetalockB "Install"
  ${If} $PetalockCase == "update"
    StrCpy $PetalockB "Update"
  ${ElseIf} $PetalockCase == "reinstall"
    StrCpy $PetalockB "Reinstall"
  ${ElseIf} $PetalockCase == "newer"
    StrCpy $PetalockB "Downgrade"
  ${ElseIf} $PetalockCase == "unknown"
    StrCpy $PetalockB "Replace"
  ${EndIf}
  ${If} $PetalockProblem == "space"
  ${OrIf} $PetalockProblem == "running"
  ${OrIf} $PetalockProblem == "write"
    StrCpy $PetalockB "Retry"
  ${ElseIf} $PetalockProblem == "folder"
  ${AndIf} $PetalockCase != "new"
    StrCpy $PetalockB "Retry"
  ${EndIf}
  StrCpy $PetalockA 1
  Call PetalockSetButton
  ; a new install: Options and the folder (an error opens it); an update has no folder to choose
  ${If} $PetalockCase == "new"
    ${If} $PetalockProblem == "folder"
    ${OrIf} $PetalockProblem == "write"
      StrCpy $PetalockOptionsOpen 1
    ${EndIf}
    ${If} $PetalockProblem != "space"
    ${AndIf} $PetalockProblem != "running"
      ShowWindow $PetalockHOptions ${SW_SHOW}
      ${If} $PetalockOptionsOpen = 1
        SendMessage $PetalockHOptions ${WM_SETTEXT} 0 "STR:Hide options"
        SendMessage $PetalockHField ${WM_SETTEXT} 0 "STR:$INSTDIR"
        ShowWindow $PetalockHFLab ${SW_SHOW}
        ShowWindow $PetalockHField ${SW_SHOW}
        ShowWindow $PetalockHBrowse ${SW_SHOW}
        ${If} $PetalockProblem == "folder"
        ${OrIf} $PetalockProblem == "write"
          SendMessage $PetalockHFLab ${WM_SETTEXT} 0 "STR:Setup can’t write to this folder. Choose another one."
          StrCpy $PetalockA $PetalockHFLab
          StrCpy $PetalockB "red"
          StrCpy $PetalockR "white"
          Call PetalockColour
          SendMessage $PetalockHFLab ${WM_SETFONT} $PetalockFBold 1
        ${Else}
          SendMessage $PetalockHFLab ${WM_SETTEXT} 0 "STR:Install folder"
          !insertmacro PETALOCK_DIM $PetalockHFLab
          SendMessage $PetalockHFLab ${WM_SETFONT} $PetalockFBody 1
        ${EndIf}
      ${Else}
        SendMessage $PetalockHOptions ${WM_SETTEXT} 0 "STR:Options"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; the slot's words. The first words and the box go back to where they were made; a state that needs less room says so below, so
  ; that no control shares a rectangle with another (second fix round, re-check finding 4).
  !insertmacro PETALOCK_MOVE $PetalockHSlot1 24 236 452 48
  !insertmacro PETALOCK_MOVE $PetalockHCheck 24 280 452 20
  ${If} $PetalockProblem == "space"
    SendMessage $PetalockHSlot1 ${WM_SETTEXT} 0 "STR:Petalock needs $PetalockNeed MB on drive $PetalockDrive and $PetalockFree MB is free. Free some space, then choose Retry."
    SendMessage $PetalockHSlot2 ${WM_SETTEXT} 0 "STR:${PL_NOTHING}"
    ShowWindow $PetalockHSlot1 ${SW_SHOW}
    ShowWindow $PetalockHSlot2 ${SW_SHOW}
  ${ElseIf} $PetalockProblem == "running"
    ; The bold words run to four lines at 100 to 150 % and three at 175 and 200 % (Windows measured 60 px at 100 %, 80 at 125 %, 100 at
    ; 150 %, 90 at 175 % and 96 at 200 %, a line being 15, 20, 25, 30 and 32 px): the first words get 70 design pixels (236 to 306, where
    ; the band starts, 70, 87, 105, 122 and 140 px), which holds even four lines (60, 80, 100, 120 and 128 px) at every scale, and the second line, which has no room left above the band, is not shown (nothing runs: the sentence
    ; above says Petalock must be closed first).
    !insertmacro PETALOCK_MOVE $PetalockHSlot1 24 236 452 70
    SendMessage $PetalockHSlot1 ${WM_SETTEXT} 0 "STR:Petalock is open. Quit it from its icon near the clock (right-click it, then Quit), then choose Retry. Setup never closes it for you. From the keyboard: press Windows+B, move to Petalock’s icon, press the Menu key, then choose Quit."
    ShowWindow $PetalockHSlot1 ${SW_SHOW}
  ${ElseIf} $PetalockProblem == "added"
    ; The refusal has its own room: the explanation is two lines (236 to 272: two bold lines are 30, 40, 50, 60 and 64 px at the five
    ; scales, and 36 design pixels hold them) and the box follows below it, so neither "Other choices" nor the second line is shown (the
    ; explanation already says nothing was changed, and unticking the box is the way out).
    !insertmacro PETALOCK_MOVE $PetalockHSlot1 24 236 452 36
    !insertmacro PETALOCK_MOVE $PetalockHCheck 24 272 452 20
    SendMessage $PetalockHSlot1 ${WM_SETTEXT} 0 "STR:Petalock’s folder holds files Setup didn’t install. Untick the box below to update in place instead; nothing was changed."
    SendMessage $PetalockHCheck ${WM_SETTEXT} 0 "STR:Remove $PetalockName before installing ${VERSION}"
    StrCpy $PetalockOtherOpen 1
    ShowWindow $PetalockHSlot1 ${SW_SHOW}
    ShowWindow $PetalockHCheck ${SW_SHOW}
  ${ElseIf} $PetalockProblem != ""
  ${AndIf} $PetalockCase != "new"
    ; two bold lines (60 px at 175 %): 38 design pixels, down to the folder field at 275
    !insertmacro PETALOCK_MOVE $PetalockHSlot1 24 236 452 38
    SendMessage $PetalockHSlot1 ${WM_SETTEXT} 0 "STR:$PetalockName is installed here. Make sure Setup has write access to this folder, then choose Retry. ${PL_NOTHING}"
    SendMessage $PetalockHField ${WM_SETTEXT} 0 "STR:$INSTDIR"
    ShowWindow $PetalockHSlot1 ${SW_SHOW}
    ShowWindow $PetalockHField ${SW_SHOW}
  ${ElseIf} $PetalockCase != "new"
    !insertmacro PETALOCK_MOVE $PetalockHSlot1 24 236 452 20
    SendMessage $PetalockHSlot1 ${WM_SETTEXT} 0 "STR:${PL_KEEP}"
    ShowWindow $PetalockHSlot1 ${SW_SHOW}
    ; update mode (/UPDATE) offers no uninstall: neither the link nor the box is shown
    ${If} $UpdateMode <> 1
      ${If} $PetalockCase == "reinstall"
        ShowWindow $PetalockHUninst ${SW_SHOW}
      ${Else}
        ShowWindow $PetalockHOther ${SW_SHOW}
        ${If} $PetalockOtherOpen = 1
          SendMessage $PetalockHOther ${WM_SETTEXT} 0 "STR:Hide other choices"
          SendMessage $PetalockHCheck ${WM_SETTEXT} 0 "STR:Remove $PetalockName before installing ${VERSION}"
          ShowWindow $PetalockHCheck ${SW_SHOW}
        ${Else}
          SendMessage $PetalockHOther ${WM_SETTEXT} 0 "STR:Other choices"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; a build that forbids a downgrade in place offers no Install button until the other choice is ticked
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $PetalockNoDown = 1
  ${AndIf} $PetalockRemoveFirst = 0
    EnableWindow $0 0
  ${Else}
    EnableWindow $0 1
  ${EndIf}
  StrCpy $PetalockA $PetalockHSent
  Call PetalockAnnounce
FunctionEnd

Function PetalockMainShow
  ; A window only: /S has no page, and /P goes straight to the progress page.
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $PetalockInner
  ${If} $PetalockInner == error
    Abort
  ${EndIf}
  ; the frame after the page exists: the page covers the whole client area, so the wizard's buttons are raised above it
  Call PetalockFrame
  Call PetalockChrome
  ; what the person sees first: the answer of the checks .onInit ran (PetalockCheckAll), kept in $PetalockProblem: the plan's rows when
  ; it found none, and the blocked state (PetalockRender, below) when it found one
  ${If} $PetalockProblem == ""
    Call PetalockPlanRows
  ${EndIf}
  !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 88 452 24 0x54000080 $PetalockFSent ""
  !insertmacro PETALOCK_INK $PetalockHSent
  !insertmacro PETALOCK_LABEL $PetalockHLab $PetalockInner 24 122 300 20 0x54000080 $PetalockFBold "What Setup will do"
  !insertmacro PETALOCK_DIM $PetalockHLab
  Call PetalockBuildRows
  ; the slot's own words (set by PetalockRender)
  !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 48 0x54000080 $PetalockFBold ""
  !insertmacro PETALOCK_INK $PetalockHSlot1
  !insertmacro PETALOCK_LABEL $PetalockHSlot2 $PetalockInner 24 288 452 18 0x54000080 $PetalockFBody ""
  !insertmacro PETALOCK_DIM $PetalockHSlot2
  ; 257 to 275, where the folder field starts: a line of this font is 15, 20, 25, 30 and 32 px at the five scales and 18 design pixels hold
  ; it at all of them (16 cut a pixel at 150 and 175 %)
  !insertmacro PETALOCK_LABEL $PetalockHFLab $PetalockInner 24 257 452 18 0x54000080 $PetalockFBody "Install folder"
  !insertmacro PETALOCK_DIM $PetalockHFLab
  ; The controls a person can reach, created in tab order: Options, the folder field, Browse, Other choices (or Uninstall
  ; instead), its box, then Licence; the wizard's own Install and Cancel come after them.
  !insertmacro PETALOCK_PX $R6 24
  !insertmacro PETALOCK_PX $R7 236
  !insertmacro PETALOCK_PX $R8 160
  !insertmacro PETALOCK_PX $R9 20
  ${NSD_CreateLink} $R6 $R7 $R8 $R9 "Options"
  Pop $PetalockHOptions
  SendMessage $PetalockHOptions ${WM_SETFONT} $PetalockFBody 1
  ${NSD_OnClick} $PetalockHOptions PetalockOnOptions
  !insertmacro PETALOCK_PX $R7 275
  !insertmacro PETALOCK_PX $R8 364
  !insertmacro PETALOCK_PX $R9 23
  ${NSD_CreateText} $R6 $R7 $R8 $R9 "$INSTDIR"
  Pop $PetalockHField
  SendMessage $PetalockHField ${WM_SETFONT} $PetalockFBody 1
  SendMessage $PetalockHField ${EM_SETREADONLY} 1 0
  !insertmacro PETALOCK_PX $R6 396
  !insertmacro PETALOCK_PX $R8 80
  ${NSD_CreateButton} $R6 $R7 $R8 $R9 "Browse…"
  Pop $PetalockHBrowse
  SendMessage $PetalockHBrowse ${WM_SETFONT} $PetalockFBody 1
  ${NSD_OnClick} $PetalockHBrowse PetalockOnBrowse
  !insertmacro PETALOCK_PX $R6 24
  !insertmacro PETALOCK_PX $R7 258
  !insertmacro PETALOCK_PX $R8 260
  !insertmacro PETALOCK_PX $R9 20
  ${NSD_CreateLink} $R6 $R7 $R8 $R9 "Other choices"
  Pop $PetalockHOther
  SendMessage $PetalockHOther ${WM_SETFONT} $PetalockFBody 1
  ${NSD_OnClick} $PetalockHOther PetalockOnOther
  ${NSD_CreateLink} $R6 $R7 $R8 $R9 "Uninstall Petalock instead…"
  Pop $PetalockHUninst
  SendMessage $PetalockHUninst ${WM_SETFONT} $PetalockFBody 1
  ${NSD_OnClick} $PetalockHUninst PetalockOnUninstallInstead
  !insertmacro PETALOCK_PX $R7 280
  !insertmacro PETALOCK_PX $R8 452
  ${NSD_CreateCheckBox} $R6 $R7 $R8 $R9 "Remove $PetalockOldVer before installing ${VERSION}"
  Pop $PetalockHCheck
  SendMessage $PetalockHCheck ${WM_SETFONT} $PetalockFBody 1
  !insertmacro PETALOCK_INK $PetalockHCheck
  ${NSD_OnClick} $PetalockHCheck PetalockOnCheck
  ; The Licence link and the build's version sit on the band, in front of its label, each in a rectangle of its own: the link from x 24
  ; (80 wide, its words are 72 at 100 %), the version from x 112 to 310, short of the Install button, which starts at 318 (its words
  ; are 176 at 100 % with a seven-character version; scripts/installer-render.test.mjs measures both at every scale).
  !insertmacro PETALOCK_PX $R6 24
  !insertmacro PETALOCK_PX $R7 324
  !insertmacro PETALOCK_PX $R8 80
  !insertmacro PETALOCK_PX $R9 20
  ${NSD_CreateLink} $R6 $R7 $R8 $R9 "Licence (MIT)"
  Pop $PetalockHLicence
  SendMessage $PetalockHLicence ${WM_SETFONT} $PetalockFBody 1
  ${NSD_OnClick} $PetalockHLicence PetalockOnLicence
  !insertmacro PETALOCK_LABEL $PetalockHVer $PetalockInner 112 324 198 20 0x54000080 $PetalockFBody "Version ${VERSION} · Public preview"
  StrCpy $PetalockA $PetalockHVer
  StrCpy $PetalockB "dim"
  StrCpy $PetalockR "band"
  Call PetalockColour
  !insertmacro PETALOCK_LINK $PetalockHLicence band
  !insertmacro PETALOCK_LINK $PetalockHOptions white
  !insertmacro PETALOCK_LINK $PetalockHOther white
  !insertmacro PETALOCK_LINK $PetalockHUninst white
  ; the progress bar and the status line, for the moment the checks run
  !insertmacro PETALOCK_PX $R6 24
  !insertmacro PETALOCK_PX $R7 238
  !insertmacro PETALOCK_PX $R8 452
  !insertmacro PETALOCK_PX $R9 14
  System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i 0x54000008, i r16, i r17, i r18, i r19, p $PetalockInner, i 0, p 0, p 0) p .s'
  Pop $PetalockHBar
  !insertmacro PETALOCK_LABEL $PetalockHStat $PetalockInner 24 260 452 20 0x54000080 $PetalockFBody ""
  Call PetalockNameStatus
  !insertmacro PETALOCK_DIM $PetalockHStat
  Call PetalockRender
  ${If} $PetalockCase == "newer"
    Call PetalockCancelDefault
  ${EndIf}
  ${If} $PetalockOptionsOpen = 1
  ${AndIf} $PetalockProblem != ""
    ${NSD_SetFocus} $PetalockHBrowse
  ${EndIf}
  Call PetalockSink
  nsDialogs::Show
FunctionEnd

Function PetalockOnOptions
  ${If} $PetalockOptionsOpen = 1
    StrCpy $PetalockOptionsOpen 0
  ${Else}
    StrCpy $PetalockOptionsOpen 1
  ${EndIf}
  Call PetalockRender
FunctionEnd

Function PetalockOnOther
  ${If} $PetalockOtherOpen = 1
    StrCpy $PetalockOtherOpen 0
    StrCpy $PetalockRemoveFirst 0
    ${NSD_SetState} $PetalockHCheck ${BST_UNCHECKED}
    ; the refusal was about the choice just taken back: it is not shown any longer
    ${If} $PetalockProblem == "added"
      StrCpy $PetalockProblem ""
    ${EndIf}
  ${Else}
    StrCpy $PetalockOtherOpen 1
  ${EndIf}
  Call PetalockRender
FunctionEnd

Function PetalockOnCheck
  ${NSD_GetState} $PetalockHCheck $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $PetalockRemoveFirst 1
  ${Else}
    StrCpy $PetalockRemoveFirst 0
    ; unticking the box takes the choice back, so the refusal that was about it goes (it would otherwise stay until the next press)
    ${If} $PetalockProblem == "added"
      StrCpy $PetalockProblem ""
    ${EndIf}
  ${EndIf}
  Call PetalockRender
FunctionEnd

Function PetalockOnBrowse
  ; The folder the person picks becomes the install folder, with Petalock's own name added unless the folder already ends in
  ; it (as the stock folder page did): a fresh folder must be empty, and the Documents folder is not.
  nsDialogs::SelectFolderDialog "Choose a folder for Petalock" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    StrLen $2 "\${PRODUCTNAME}"
    IntOp $2 0 - $2
    StrCpy $1 $0 "" $2
    ${If} $1 != "\${PRODUCTNAME}"
      StrCpy $INSTDIR "$0\${PRODUCTNAME}"
    ${Else}
      StrCpy $INSTDIR $0
    ${EndIf}
    StrCpy $PetalockProblem ""
    Call PetalockRender
  ${EndIf}
FunctionEnd

Function PetalockOnLicence
  ; Petalock's own licence (MIT), the file the build was given (bundle.licenseFile), opened in the person's text viewer from
  ; the folder Setup unpacked it to (the others are in the notices file the installer carries).
  !if "${LICENSE}" != ""
    ExecShell "open" "$PLUGINSDIR\LICENSE.txt"
  !endif
FunctionEnd

Function PetalockOnUninstallInstead
  ; The same version is installed: this opens the existing uninstaller (a full uninstall, never the update's /UPDATE one) and,
  ; when it has finished, ends Setup, but only after the program and the entry are proved gone (the child's zero exit is not taken
  ; as proof either: the uninstaller stops, with the entry kept, when it cannot delete the program, but what Setup ends on is what
  ; is really there). Cancelled or failed, the window stays as it was.
  ${If} $UpdateMode = 1
    Return
  ${EndIf}
  Call PetalockBeforeOldUninstaller
  StrCpy $R1 "$R1 _?=$4"
  HideWindow
  ClearErrors
  ExecWait '$R1' $0
  BringToFront
  ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}
  ${If} $0 = 0
    StrCpy $PetalockA "$4\${MAINBINARYNAME}.exe"
    Call PetalockAttr
    StrCpy $2 $PetalockR
    ReadRegStr $1 SHCTX "${UNINSTKEY}" "DisplayName"
    ${If} $2 == "absent"
    ${AndIf} $1 == ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
      SetErrorLevel 0
      Quit
    ${EndIf}
    ; Still installed (or it cannot be told): its uninstaller is left where it is, so it can be run again.
    MessageBox MB_OK|MB_ICONEXCLAMATION "Petalock was not fully removed: its program or its entry in Installed apps is still there. Its uninstaller was left in place, so you can run it again from Installed apps."
  ${EndIf}
FunctionEnd

Function PetalockMainLeave
  ; Install / Update / Reinstall / Replace / Downgrade / Retry: the checks run first, and the page stays when any of them
  ; stops the start (the page says which, and Retry asks again). Nothing is written by a check.
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $PetalockHSlot1 ${SW_HIDE}
  ShowWindow $PetalockHSlot2 ${SW_HIDE}
  ShowWindow $PetalockHFLab ${SW_HIDE}
  ShowWindow $PetalockHOptions ${SW_HIDE}
  ShowWindow $PetalockHField ${SW_HIDE}
  ShowWindow $PetalockHBrowse ${SW_HIDE}
  ShowWindow $PetalockHOther ${SW_HIDE}
  ShowWindow $PetalockHUninst ${SW_HIDE}
  ShowWindow $PetalockHCheck ${SW_HIDE}
  ; State 6, "Checking this PC": the three lines still say Next, and the bar moves
  SendMessage $PetalockHSent ${WM_SETTEXT} 0 "STR:Installing Petalock"
  SendMessage $PetalockHLab ${WM_SETTEXT} 0 "STR:What Setup is doing"
  StrCpy $PetalockS1 "next"
  StrCpy $PetalockS2 "next"
  StrCpy $PetalockS3 "next"
  Call PetalockPaintRows
  SendMessage $PetalockHStat ${WM_SETTEXT} 0 "STR:Checking the folder, the free space and that Petalock isn’t open…"
  ShowWindow $PetalockHBar ${SW_SHOW}
  ShowWindow $PetalockHStat ${SW_SHOW}
  Call PetalockMarquee
  System::Call 'user32::UpdateWindow(p $PetalockInner)'
  Call PetalockCheckAll
  SendMessage $PetalockHLab ${WM_SETTEXT} 0 "STR:What Setup will do"
  ${If} $PetalockProblem != ""
    Call PetalockRender
    Abort
  ${EndIf}
  Return
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The progress page (the stock page, restyled): the three lines become Done / Now / Next
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockFillClient
  ; In: $PetalockInner, the page's own dialog. A stock page is only placed by NSIS, never sized (Ui.c, where it makes a page: SetWindowPos
  ; with SWP_NOSIZE), so it keeps its template's size in dialog units; the pages made with nsDialogs::Create 1018 are sized to the
  ; placeholder, which PetalockSizeWindow made the whole client area. This gives a stock page the same area (500 x 358 at 100 %), at the
  ; origin, so the band, the rows, the bar and the status line are laid out in the same rectangle as on the other pages.
  Push $R5
  Push $R6
  !insertmacro PETALOCK_PX $R5 500
  !insertmacro PETALOCK_PX $R6 358
  System::Call 'user32::SetWindowPos(p $PetalockInner, p 0, i 0, i 0, i r15, i r16, i 0x14)'
  Pop $R6
  Pop $R5
FunctionEnd

Function PetalockProgressShow
  Call PetalockFrame
  FindWindow $PetalockInner "#32770" "" $HWNDPARENT
  Call PetalockFillClient
  ; The stock details list, the status line and the "show details" button are not part of this design: all hidden but the bar.
  System::Call 'user32::GetWindow(p $PetalockInner, i 5) p .r1'
  prog_next:
    ${If} $1 = 0
      Goto prog_end
    ${EndIf}
    System::Call 'user32::GetDlgCtrlID(p r1) i .r3'
    ${If} $3 = 1004
      StrCpy $PetalockHBar $1
    ${Else}
      ShowWindow $1 ${SW_HIDE}
    ${EndIf}
    System::Call 'user32::GetWindow(p r1, i 2) p .r1'
    Goto prog_next
  prog_end:
  Call PetalockChrome
  ; The bar under the rows; the status line says what is happening, never a file name
  !insertmacro PETALOCK_MOVE $PetalockHBar 24 238 452 14
  ShowWindow $PetalockHBar ${SW_SHOW}
  ${If} $PetalockCase == "update"
  ${OrIf} $PetalockCase == "newer"
  ${OrIf} $PetalockCase == "unknown"
    !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 88 452 24 0x54000080 $PetalockFSent "Updating Petalock"
  ${Else}
    !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 88 452 24 0x54000080 $PetalockFSent "Installing Petalock"
  ${EndIf}
  !insertmacro PETALOCK_INK $PetalockHSent
  !insertmacro PETALOCK_LABEL $PetalockHLab $PetalockInner 24 122 300 20 0x54000080 $PetalockFBold "What Setup is doing"
  !insertmacro PETALOCK_DIM $PetalockHLab
  Call PetalockBuildRows
  !insertmacro PETALOCK_LABEL $PetalockHStat $PetalockInner 24 260 452 20 0x54000080 $PetalockFBody "Getting ready…"
  Call PetalockNameStatus
  !insertmacro PETALOCK_DIM $PetalockHStat
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  Call PetalockPlanRows
  StrCpy $PetalockS1 "next"
  StrCpy $PetalockS2 "next"
  StrCpy $PetalockS3 "next"
  Call PetalockPaintRows
  Call PetalockMarquee
  Call PetalockSink
FunctionEnd

; ---------------------------------------------------------------------------------------------------------------------
; The last page: the receipt, or where Setup stopped
; ---------------------------------------------------------------------------------------------------------------------
Function PetalockEndShow
  ; A window only: /P has no Finish to click and /S has no page.
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $PetalockInner
  ${If} $PetalockInner == error
    Abort
  ${EndIf}
  Call PetalockFrame
  Call PetalockChrome
  ; one button on the band: Finish (or Close), and Cancel is gone
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro PETALOCK_MOVE $0 401 320 75 23
  ${If} $PetalockFailStep != ""
    ; The error layout: the problem as the sentence, the rows showing where Setup stopped, what changed, the details.
    Call PetalockFailRows
    !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 88 452 24 0x54000080 $PetalockFSentB "Petalock isn’t fully installed"
    ${If} $PetalockFailStep == "webview2"
      SendMessage $PetalockHSent ${WM_SETTEXT} 0 "STR:Setup couldn’t get Microsoft WebView2"
    ${EndIf}
    !insertmacro PETALOCK_INK $PetalockHSent
    !insertmacro PETALOCK_LABEL $PetalockHLab $PetalockInner 24 122 300 20 0x54000080 $PetalockFBold "Where Setup stopped"
    !insertmacro PETALOCK_DIM $PetalockHLab
    Call PetalockBuildRows
    Call PetalockPaintRows
    ${If} $PetalockFailStep == "webview2"
      !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Connect to the internet, then run Setup again. Petalock needs WebView2 to show its screens. Nothing of Petalock was installed."
    ${ElseIf} $PetalockFailStep == "remove_old"
      !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "The earlier version could not be removed, so Setup stopped before installing. Run Setup again once nothing is using it."
    ${ElseIf} $PetalockFailStep == "entries"
      ; Not a file failure: the files are copied, but Windows would not take the entry. Nothing here ever tells anyone to delete a
      ; folder (the state folder is also named Petalock, and an update's folder holds the person's own files). A fresh attempt took
      ; its own files out again (installer.nsi), so running Setup again is not refused; when one could not be taken out, another
      ; folder is the way; an update changed nothing but the files it replaced, its folder and earlier entry stay, and it can be run again.
      ${If} $PetalockRolledBack = 1
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Windows would not take Petalock’s entry in Installed apps, so Setup removed the files it had just copied. Run Setup again to try once more."
      ${ElseIf} $PetalockMode == "fresh"
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Windows refused Petalock’s entry in Installed apps, and Setup could not remove every file it copied. Run Setup again and choose another folder under Options."
      ${Else}
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Petalock’s files were updated, but Windows would not take the new entry in Installed apps. Setup removed nothing. Run Setup again to try once more."
      ${EndIf}
    ${Else}
      ; A file failure: a fresh attempt took out the files it had written (installer.nsi), so running Setup again is not refused;
      ; when one could not be taken out, another folder is the way; an update's folder is the recorded installation, and running
      ; Setup again replaces its files.
      ${If} $PetalockRolledBack = 1
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Setup couldn’t write one of Petalock’s files, so it removed the files it had just copied. Run Setup again to try once more."
      ${ElseIf} $PetalockMode == "fresh"
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Setup couldn’t write one of Petalock’s files, and could not remove every file it copied. Run Setup again and choose another folder under Options."
      ${Else}
        !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 38 0x54000080 $PetalockFBody "Setup couldn’t write one of Petalock’s files. Some files were already copied to its folder; running Setup again replaces them."
      ${EndIf}
    ${EndIf}
    !insertmacro PETALOCK_INK $PetalockHSlot1
    ; the details: selectable, so they can be read and copied
    !insertmacro PETALOCK_PX $R6 24
    !insertmacro PETALOCK_PX $R7 275
    !insertmacro PETALOCK_PX $R8 452
    !insertmacro PETALOCK_PX $R9 23
    ${NSD_CreateText} $R6 $R7 $R8 $R9 "$PetalockDetail"
    Pop $PetalockHField
    SendMessage $PetalockHField ${WM_SETFONT} $PetalockFBody 1
    SendMessage $PetalockHField ${EM_SETREADONLY} 1 0
    !insertmacro PETALOCK_PX $R6 305
    !insertmacro PETALOCK_PX $R7 320
    !insertmacro PETALOCK_PX $R8 88
    ${NSD_CreateButton} $R6 $R7 $R8 $R9 "Copy details"
    Pop $PetalockHCopy
    SendMessage $PetalockHCopy ${WM_SETFONT} $PetalockFBody 1
    ${NSD_OnClick} $PetalockHCopy PetalockOnCopy
    StrCpy $PetalockA 1
    StrCpy $PetalockB "Close"
    Call PetalockSetButton
    StrCpy $PetalockA $PetalockHSent
    Call PetalockAnnounce
  ${Else}
    ; The receipt, from what happened
    Call PetalockReceiptRows
    ${If} $PetalockCase == "new"
    ${OrIf} $PetalockCase == "reinstall"
      !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 84 452 28 0x54000080 $PetalockFHead "Petalock is installed"
    ${Else}
      !insertmacro PETALOCK_LABEL $PetalockHSent $PetalockInner 24 84 452 28 0x54000080 $PetalockFHead "Petalock was updated"
    ${EndIf}
    !insertmacro PETALOCK_INK $PetalockHSent
    !insertmacro PETALOCK_LABEL $PetalockHLab $PetalockInner 24 122 300 20 0x54000080 $PetalockFBold "What Setup did"
    !insertmacro PETALOCK_DIM $PetalockHLab
    Call PetalockBuildRows
    Call PetalockPaintRows
    ${If} $PetalockCase == "new"
      !insertmacro PETALOCK_PX $R7 238
    ${Else}
      !insertmacro PETALOCK_LABEL $PetalockHSlot1 $PetalockInner 24 236 452 20 0x54000080 $PetalockFBold "Setup left your vault files in place."
      !insertmacro PETALOCK_INK $PetalockHSlot1
      !insertmacro PETALOCK_PX $R7 262
    ${EndIf}
    ; Open Petalock: checked by default, and it starts only from Finish
    !insertmacro PETALOCK_PX $R6 24
    !insertmacro PETALOCK_PX $R8 300
    !insertmacro PETALOCK_PX $R9 18
    ${NSD_CreateCheckBox} $R6 $R7 $R8 $R9 "Open Petalock"
    Pop $PetalockHOpen
    SendMessage $PetalockHOpen ${WM_SETFONT} $PetalockFBody 1
    !insertmacro PETALOCK_INK $PetalockHOpen
    SendMessage $PetalockHOpen ${BM_SETCHECK} 1 0
    StrCpy $PetalockA 1
    StrCpy $PetalockB "Finish"
    Call PetalockSetButton
    StrCpy $PetalockA $PetalockHSent
    Call PetalockAnnounce
  ${EndIf}
  Call PetalockSink
  nsDialogs::Show
FunctionEnd

Function PetalockOnCopy
  ; Copy details: the kept words go to the clipboard as text. The text is prepared first; only then is the clipboard opened (with this
  ; window as its owner, which SetClipboardData needs after EmptyClipboard), and every result is checked: the previous contents are
  ; emptied only when there is something ready to put in their place, and a failure is said.
  StrCpy $5 0
  StrLen $1 "$PetalockDetail"
  IntOp $1 $1 + 1
  IntOp $2 $1 * 2
  System::Call 'kernel32::GlobalAlloc(i 0x42, p r2) p .r3'
  ${If} $3 <> 0
    System::Call 'kernel32::GlobalLock(p r3) p .r4'
    ${If} $4 <> 0
      System::Call 'kernel32::lstrcpyW(p r4, w "$PetalockDetail")'
      System::Call 'kernel32::GlobalUnlock(p r3)'
      System::Call 'user32::OpenClipboard(p $HWNDPARENT) i .r0'
      ${If} $0 <> 0
        System::Call 'user32::EmptyClipboard()'
        System::Call 'user32::SetClipboardData(i 13, p r3) p .r5'
        ; the clipboard owns the memory once it was taken: it is verified by reading the text format back
        System::Call 'user32::GetClipboardData(i 13) p .r6'
        System::Call 'user32::CloseClipboard()'
        ${If} $5 <> 0
        ${AndIf} $6 <> 0
          Return
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $5 = 0
  ${AndIf} $3 <> 0
    System::Call 'kernel32::GlobalFree(p r3)'
  ${EndIf}
  MessageBox MB_OK|MB_ICONEXCLAMATION "Copy details did not work. Select the text in the box and press Ctrl+C instead."
FunctionEnd

Function PetalockEndLeave
  ; Finish: Petalock starts only now, only when it succeeded and the box is still checked. Closing the window another way
  ; never starts it (this function is not run then).
  ${If} $PetalockFailStep == ""
    ${NSD_GetState} $PetalockHOpen $0
    ${If} $0 = ${BST_CHECKED}
      Call RunMainBinary
    ${EndIf}
  ${EndIf}
FunctionEnd
