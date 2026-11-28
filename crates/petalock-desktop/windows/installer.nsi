; Petalock's installer template. Copyright 2019-2024 Tauri Programme within The Commons Conservancy,
; SPDX-License-Identifier: Apache-2.0 OR MIT: this is Tauri's NSIS template (tauri-bundler 2.10.5,
; src/bundle/windows/nsis/installer.nsi, SHA-256 d00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d, the
; file the pinned tauri-cli 2.12.5 carries), with the changes below. Each change is marked "Petalock:" where it is made;
; the logic they call is in hooks.nsh. A hook alone could not do this: .onInit has no hook, `SetOutPath $INSTDIR` (which
; makes the folder) and the WebView2 section run before NSIS_HOOK_PREINSTALL, the old uninstaller an upgrade runs is
; started before any hook, the default folder is fixed here, and CheckIfAppIsRunning offers to kill the program and
; kills it without asking when silent.
;   1. The default folder is %LOCALAPPDATA%\Programs\Petalock (Tauri's own, %LOCALAPPDATA%\Petalock, is the state folder).
;   2. The folder in force (folder page, /D, remembered location, upgrade) is checked before each operation: .onInit, the
;      folder page, the old uninstaller an upgrade runs, the first lines of both install sections, un.onInit, and
;      Section Uninstall. Nothing is written first: the check is the first thing each of them does.
;   3. CheckIfAppIsRunning (which ends the program) is not used; PetalockEnsureNotRunning never ends it.
;   4. The uninstaller first cleans open\ (un.PetalockCleanOpen), stops before removing anything if a copy is left, and
;      removes the two identifier folders (when the box is ticked) with un.PetalockRemoveTree, which never follows a
;      junction (NSIS's RMDir /r does).
;   5. Tauri's second registry key (HKCU\Software\<publisher>\<product>: remembered location, installer language) is not
;      written, read or deleted; the remembered location is the uninstall key's InstallLocation.
;   6. The uninstaller has a finish page that says where vaults stay.
;   7. hooks.nsh is included after the variables and defines it uses.
;   8. WiX (MSI) discovery and its machine-wide uninstall branch are removed; the old uninstaller an upgrade runs is the one
;      in the recorded install folder, run by a command built from that folder (not read from the registry).
;   9. Tauri's "remove the old main binary named by a registry value" and its shortcut migration are removed.
;  10. The WebView2 bootstrapper's path is quoted when it is run.
;  11. Plan 5, Task 9e (design D, "Plain terms"): the welcome, licence, install-mode, reinstall (the one that offered "Do not
;      uninstall"), folder and start-menu pages and the finish page are replaced by one custom page (PetalockMainShow, in
;      setup-ui.nsh) that says in three lines what Setup will do, the stock progress page restyled as the same three lines
;      (Done / Now / Next), and a custom last page (the receipt, or where Setup stopped). An update installs over by default
;      (the same policy as before: nothing is uninstalled first unless the person ticks "Remove ... before installing" under
;      "Other choices"); the keyboard focus and the tab order follow the design's notes. The installer's /D, remembered folder
;      and per-user default are unchanged, and no Nullsoft line is shown (BrandingText " ").
;  12. The old uninstaller an update runs (the remove-first choice, now the first section) gets /UPDATE, so it keeps the
;      Run\Petalock value (the app keeps no other copy of "start with Windows"), the shortcuts and the app data; it still
;      cleans open\ first. The same version's "Uninstall Petalock instead" link is a full uninstall that ends Setup. Under
;      /UPDATE the uninstaller's "Delete the application data" box is not offered (the uninstall ignores it there); a full
;      uninstall keeps it, with words that say what it removes and that the vaults stay.
;  13. The additional plugin folder is added before hooks.nsh is included (setup-ui.nsh calls nsis_tauri_utils), and the
;      installer's band picture is the build's header image (bundle.windows.nsis.headerImage), unpacked to $PLUGINSDIR; the
;      Licence link opens bundle.licenseFile from there.
Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
; Petalock (review fix round, finding 17): `ManifestDPIAwareness PerMonitorV2` is not set. NSIS has no per-monitor re-layout (a window
; made at one scale keeps its pixel sizes when it is dragged to a screen with another), so the installer is system-DPI aware (the
; line above): its layout is worked out once from the system's scale and the message font's size (larger Windows text included),
; and when the window is moved to a screen with a different scale Windows scales the whole window itself, which stays correct
; but is slightly blurred there.

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
; Petalock: StrFunc's StrCase and StrLoc were only used by the WiX discovery, which is removed.

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode

; Petalock: the additional plugins (nsis_tauri_utils) are added before the hooks, which call one of them.
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Petalock: included here (Tauri includes it at the top) because it uses the variables and defines above.
{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

Name "${PRODUCTNAME}"
; Petalock: no "Nullsoft Install System" line at the bottom of the window (a space: an empty string brings NSIS's own back).
BrandingText " "
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Petalock: the installer's header image (bundle.windows.nsis.headerImage) is the engraved band of the one screen (a 952 x 104
; bitmap, shown at 476 x 52 and scaled with the window), unpacked by PetalockGuiInit; it is not the stock header's picture, which
; this installer never shows. The uninstaller's header image (none is configured) is as Tauri has it.
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Petalock: Tauri defined a registry key here to store the installer language (HKCU\Software\<publisher>\<product>). Petalock
; has one language and writes nothing but its uninstall key, so the key, and every read, write and delete of it, are gone.

; Installer pages, must be ordered as they appear
; Petalock: 1. the one custom page (setup-ui.nsh): what Setup will do, Options, the update's choices and every blocked state.
!define MUI_CUSTOMFUNCTION_GUIINIT PetalockGuiInit
Page custom PetalockMainShow PetalockMainLeave

; Petalock: Tauri's discovery of an earlier WiX (MSI) install, and its machine-wide uninstall branch, are removed (no MSI
; was ever shipped, and the branch ran an HKLM uninstall string outside every check): FindWixInstall and $WixMode are gone.

; 2. Start menu shortcut page (never shown: STARTMENUFOLDER is empty, so it is skipped, as Tauri's template skips it)
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!endif
; Petalock: the one screen has no start-menu page, so it is always skipped (Tauri's template shows it when a folder is set).
!define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 3. Installation page: the stock page, restyled as the same three lines (Done / Now / Next).
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PetalockProgressShow
!insertmacro MUI_PAGE_INSTFILES

; 4. Petalock: the last page, the receipt (or where Setup stopped). A window goes to it when the sections are done (they set
; SetAutoClose), and /P skips it: nobody clicks Finish.
Page custom PetalockEndShow PetalockEndLeave

; Petalock: the page's own first work (the band's picture and the licence unpacked from the installer; the window's size, fonts
; and colours) runs when the window is made.
Function PetalockGuiInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\band.bmp" "${HEADERIMAGE}"
  !if "${LICENSE}" != ""
    File "/oname=$PLUGINSDIR\LICENSE.txt" "${LICENSE}"
  !endif
  Call PetalockGuiSetup
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; Petalock: under /UPDATE (the old uninstaller an upgrade or a downgrade runs) the "Delete the application data" box is not
  ; offered: the uninstall section ignores it in update mode, so a ticked box would say something that does not happen.
  ${If} $UpdateMode = 1
    Return
  ${EndIf}
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 64 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  ; Petalock: the box's words say what it removes (the two folders named after Petalock's identifier, one in Local and one in
  ; Roaming app data, which hold the window's cache) and what it never does. The first words are Tauri's own ("Delete the
  ; application data"); the room is four lines, so larger Windows text still shows all of it.
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "Delete the application data. This removes Petalock’s window cache from your Local and Roaming app data folders. Your vaults, the vault list and your settings are never deleted.", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  ; Petalock: no box was made under /UPDATE, so there is nothing to read.
  ${If} $UpdateMode = 1
    Return
  ${EndIf}
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

; 3. Petalock: a finish page that says where the vaults stay (a vault is never removed by the uninstall).
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!define MUI_FINISHPAGE_TITLE "Petalock was uninstalled"
!define MUI_FINISHPAGE_TEXT "Your vaults stay where they are. Petalock keeps them in the folders you chose, by default Petalock Vaults in your user folder."
!insertmacro MUI_UNPAGE_FINISH

;Languages
; PageReinstall reads the misspelled `choowHowToInstall` as a fallback, and makensis warns
; about a language string that is read but never set, so default it to an empty string for
; every language. This runs before the language files are included, so a custom language
; file that only defines the old spelling overrides the default and the fallback shows its
; text. `0` as the language id means the language inserted right above.
; TODO: remove the `choowHowToInstall` fallback in a future major version
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
LangString choowHowToInstall 0 ""
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      ; Petalock: %LOCALAPPDATA%\Programs\Petalock, never %LOCALAPPDATA%\Petalock, which is the state folder.
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; Petalock: what is installed decides the words and the choices (PetalockDecide touches no page control, so a silent run
  ; has it too: it never removes first, which only a person ticking a box in the window can ask for).
  Call PetalockDecide

  ; Petalock: the folder in force, from /D, a remembered location or the default, is checked before anything is done, and
  ; Petalock must not be running. A silent or passive run that fails here exits with an error before any change; a window has
  ; no box here: its page shows the same checks (PetalockCheckAll) with their way out, and every section checks again.
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    Call PetalockPreflight
  ${EndIf}
  ; Petalock: the same control-independent checks in every mode, once the folder is settled and before anything is unpacked or
  ; shown: the folder's rules, a running Petalock, the free space and the write access. A window keeps the answer for its first page
  ; (the blocked state, with Retry); a silent or passive run that fails exits with an error before any change.
  Call PetalockCheckAll
  Call PetalockQuietChecks

  ; Abort downgrades if they are disabled, in the modes that skip the page's choice:
  ; silent, passive and update
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    ; Compare with the same installation the reinstall page would
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R0
    ; If downgrading
    ${If} $R0 = -1
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 <> 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
      ${Else}
        MessageBox MB_ICONSTOP "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
FunctionEnd

; Petalock: the first section removes the earlier version first, only when the person ticked "Remove ... before installing" under
; "Other choices" in the window ($PetalockRemoveFirst: a silent, passive or /UPDATE run never has it). The old uninstaller is the
; one in the folder the uninstall key records, its command built and checked by PetalockBeforeOldUninstaller, and it runs before
; WebView2 and before any file (the order the three lines say). Cancel, Esc and the close button go off before it starts.
Section PetalockRemoveOld
  Call PetalockPreflight
  ${If} $PetalockFailStep != ""
    Return
  ${EndIf}
  ; Petalock: never in update mode (/UPDATE keeps the Run value, the shortcuts and the opened copies of an install in place).
  ${If} $PetalockRemoveFirst = 1
  ${AndIf} $UpdateMode <> 1
    ; Files someone added to the program folder are kept by the old uninstaller, which would leave the folder non-empty and
    ; refused by the next section, after the working program had gone: refused here, while the install is intact.
    Call PetalockHasAddedFiles
    ${If} $PetalockR = 1
      !insertmacro PETALOCK_FAILED remove_old "The program folder holds files Setup did not install, so removing first would leave neither version."
      Return
    ${EndIf}
    !insertmacro PETALOCK_BEGIN remove_old
    Call PetalockLockCancel
    Call PetalockBeforeOldUninstaller
    ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|}
    ; /UPDATE for an update that removes first (the installed version is older, newer or unknown: not the same), so the old
    ; uninstaller keeps the Run\Petalock value, the shortcuts and the app data (it still cleans open\ first). It goes before
    ; `_?=`, which must stay last.
    ${IfThen} $PetalockCase != "reinstall" ${|} StrCpy $R1 "$R1 /UPDATE" ${|}
    ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|}
    StrCpy $R1 "$R1 _?=$4"
    HideWindow
    ClearErrors
    ExecWait '$R1' $0
    BringToFront
    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}
    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; cancelled in its window, or it failed: Setup stops here, and says the old version was not removed
      !insertmacro PETALOCK_FAILED remove_old "The earlier version was not removed."
      Return
    ${EndIf}
    ; The NSIS uninstaller was run in place (`_?=`), so it cannot delete itself and the install directory: clean them up here
    ; once the uninstall succeeded
    ; https://nsis.sourceforge.io/Docs/Chapter3.html#:~:text=path%20contains%20spaces.-,3.2.3%20Examples,-installer.exe%20/NCRC
    ${If} $4 != ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
    ${EndIf}
    !insertmacro PETALOCK_DONE remove_old
  ${EndIf}
SectionEnd

Section WebView2
  ; Petalock: the first thing the section does, before WebView2's own installer can run or anything is written.
  Call PetalockPreflight
  ${If} $PetalockFailStep != ""
    Return
  ${EndIf}
  !insertmacro PETALOCK_BEGIN webview2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      ; Petalock: the bootstrapper is kept in Setup's own private folder ($PLUGINSDIR, removed when Setup ends), never under a fixed
      ; name in the person's temporary folder (where a download of theirs could be deleted, or replaced before Retry runs it).
      InitPluginsDir
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        File "/oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; Petalock: the bootstrapper can't be stopped safely, so Cancel, Esc and the close button go off, and the row says
        ; Setup is getting WebView2 (the bar moves without a percentage: the download reports none).
        Call PetalockLockCancel
        Call PetalockWebviewMissing
        PetalockWebviewTry:
        ; $6 holds the path to the webview2 installer
        ; Petalock: the program's path is quoted, so a space in the temporary folder's path cannot pick another program.
        ; Petalock: if the bootstrapper cannot be started at all, ExecWait leaves its output undefined and sets the error flag: that
        ; is a failure with a code of its own (-1), never read as the 0 of success.
        ClearErrors
        ExecWait '"$6" ${WEBVIEW2INSTALLERARGS} /install' $1
        ${If} ${Errors}
          StrCpy $1 -1
        ${EndIf}
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
          StrCpy $PetalockWv "got"
          !insertmacro PETALOCK_DONE webview2
        ${Else}
          DetailPrint "$(webview2InstallError)"
          StrCpy $PetalockDetail $1
          Call PetalockWebviewReason
          ${If} ${Silent}
          ${OrIf} $PassiveMode = 1
            !insertmacro PETALOCK_FAILED_AS_IS webview2
          ${EndIf}
          ; A window: the error layout behind, and Retry runs this step again and carries on (Cancel ends Setup here: nothing
          ; of Petalock was installed).
          Call PetalockWebviewShowError
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Setup couldn’t get Microsoft WebView2. Petalock needs it to show its screens.$\r$\n$\r$\nConnect to the internet, then choose Retry. Cancel ends Setup; nothing of Petalock was installed." IDCANCEL PetalockWebviewGiveUp
          Call PetalockLockCancel
          Call PetalockWebviewMissing
          Goto PetalockWebviewTry
          PetalockWebviewGiveUp:
          !insertmacro PETALOCK_FAILED_AS_IS webview2
          Return
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
  ; Petalock: "Already installed" only for a runtime that was found; an update does not fetch a missing one, and says so.
  ${If} $PetalockWv == ""
    ${If} $4 != ""
      StrCpy $PetalockWv "had"
    ${Else}
      StrCpy $PetalockWv "missing"
    ${EndIf}
    !insertmacro PETALOCK_DONE webview2
  ${EndIf}
SectionEnd

Section Install
  ; Petalock: checked again before SetOutPath, which makes the folder; and CheckIfAppIsRunning (which ends the program)
  ; is not used.
  Call PetalockPreflight
  ${If} $PetalockFailStep != ""
    Return
  ${EndIf}
  !insertmacro PETALOCK_BEGIN files
  ; the first file: Cancel, Esc and the close button are off (if the WebView2 step did not already turn them off)
  Call PetalockLockCancel

  ; Petalock: an error in the file stage (the output folder, a payload file, the uninstaller) is caught below, before the files row
  ; can be Done: the flag is cleared here and read after WriteUninstaller.
  ClearErrors
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0" "Open with ${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; Petalock: a denied write, a full volume or a locked file left the error flag set: the row says Failed, with the words of a
  ; file failure, and no receipt follows.
  ${If} ${Errors}
    !insertmacro PETALOCK_FAILED files "Setup could not write one of Petalock’s files."
    Return
  ${EndIf}
  ; Petalock: the files are in place (the program, the resources and the uninstaller were written): the second line is Done
  ; only now, and the third one begins.
  !insertmacro PETALOCK_DONE files
  !insertmacro PETALOCK_BEGIN entries
  ClearErrors

  ; Petalock: the install location is kept only in the uninstall key's InstallLocation (below); Tauri's second key
  ; (HKCU\Software\<publisher>\<product>) is not written. Tauri's removal of an "old main binary" named by a registry value
  ; is gone too (nothing to migrate: no earlier public binary name), and so is the MainBinaryName value it read.

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"
  ; Petalock: Windows refused the Installed apps entry: the receipt must not say it was made.
  ${If} ${Errors}
    !insertmacro PETALOCK_FAILED entries "Windows would not take Petalock’s entry in Installed apps."
    Return
  ${EndIf}

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Petalock: every step has finished: the entries are Done, and the window goes straight on to the receipt (a passive run
  ; closes: it has no last page).
  !insertmacro PETALOCK_DONE entries
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ; Petalock: a silent install (/S) launches nothing, whatever else is on its command line.
  ${If} $PassiveMode = 1
  ${AndIfNot} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; Petalock: the folder the uninstaller works in is checked before anything is removed, and Petalock must not be running.
  Call un.PetalockPreflight
FunctionEnd

Section Uninstall
  ; Petalock: checked again, then the folders the app made for opened files are cleaned first, so that if a copy cannot
  ; be removed the uninstall stops with the program and its uninstaller still there. CheckIfAppIsRunning (which ends the
  ; program) is not used.
  Call un.PetalockPreflight
  Call un.PetalockCleanOpen

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Petalock: Tauri's second key (HKCU\Software\<publisher>\<product>) and its recursive delete are gone: Petalock never
  ; writes it, and a recursive delete of a key it did not make could remove other data.

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ; Petalock: exactly the two identifier folders, by un.PetalockRemoveTree, which never follows a junction or a link
  ; (NSIS's `RMDir /r` does, at the folder and inside it). What cannot be removed is counted, never named.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    StrCpy $PetalockStuck 0
    Push "$APPDATA\${BUNDLEID}"
    Call un.PetalockRemoveTree
    Push "$LOCALAPPDATA\${BUNDLEID}"
    Call un.PetalockRemoveTree
    ${If} $PetalockStuck <> 0
      DetailPrint "Some application data could not be removed (still in use)."
    ${EndIf}
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

; Petalock: the remembered location is the uninstall key's InstallLocation (written quoted), the only place the installer
; records where it installed. Whatever it holds is only a candidate: PetalockPreflight checks the folder it names.
Function RestorePreviousInstallLocation
  Call PetalockRecordedLocation
  ${If} $PetalockA != ""
    StrCpy $INSTDIR $PetalockA
  ${EndIf}
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; Petalock: Tauri's migration of shortcuts that pointed at an earlier binary name is gone (nothing to migrate).

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; Petalock: what happened is kept for the receipt ($PetalockSc): skipped, kept (it was there, and is written again), added,
  ; or failed (Windows would not make it; the Installed apps entry is a separate step and may have worked).
  ${If} $UpdateMode = 1
  ${OrIf} $NoShortcutMode = 1
    StrCpy $PetalockSc "skipped"
    Return
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    ${If} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      StrCpy $PetalockSc "kept"
    ${Else}
      StrCpy $PetalockSc "added"
    ${EndIf}
    ClearErrors
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} ${Errors}
      StrCpy $PetalockSc "failed"
    ${EndIf}
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      StrCpy $PetalockSc "kept"
    ${Else}
      StrCpy $PetalockSc "added"
    ${EndIf}
    ClearErrors
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} ${Errors}
      StrCpy $PetalockSc "failed"
    ${EndIf}
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; Petalock: Tauri's migration of shortcuts that pointed at an earlier binary name is gone (nothing to migrate).

  ; Skip creating shortcut if in update mode or no shortcut mode
  ${If} $UpdateMode = 1
  ${OrIf} $NoShortcutMode = 1
    Return
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
