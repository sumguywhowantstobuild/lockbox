//! Direct Windows and WebView2 calls: WebView2's file-drop setting, the hidden window that hears Windows lock,
//! sleep, sign-out, shutdown and drive removal ([`spawn`]), and the real [`Os`]: volumes, known folders, file
//! dialogs and opening links. Every `unsafe` block of the crate is here, each with a `// SAFETY:` comment.
#![allow(unsafe_code)]

use std::cell::{Cell, OnceCell};
use std::ffi::{OsStr, OsString};
use std::io;
use std::mem::offset_of;
use std::num::NonZeroU32;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::{ptr, slice};

use lockbox_core::blob::CancelToken;
use tauri::{AppHandle, Manager, Runtime};
use zeroize::{Zeroize, Zeroizing};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PRINT_STATUS, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED, ICoreWebView2_2,
    ICoreWebView2_7, ICoreWebView2_16, ICoreWebView2Controller, ICoreWebView2Controller4,
    ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2PrintSettings2,
    ICoreWebView2Settings3,
};
use webview2_com::{PrintCompletedHandler, PrintToPdfCompletedHandler};
use windows_core::{BOOL, Interface, PCWSTR};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_HOTKEY_ALREADY_REGISTERED, ERROR_INSUFFICIENT_BUFFER,
    ERROR_MORE_DATA, GetLastError, GlobalFree, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT,
    LocalFree, MAX_PATH, TRUE, WPARAM,
};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows_sys::Win32::Graphics::Printing::{
    EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_2W,
};
#[cfg(test)]
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::Storage::CloudFilters::{
    CF_SYNC_ROOT_INFO_PROVIDER, CF_SYNC_ROOT_PROVIDER_INFO, CfGetSyncRootInfoByPath,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo, GetDriveTypeW,
    GetFileAttributesW, GetFileInformationByHandleEx, GetVolumeInformationW, GetVolumePathNameW,
    INVALID_FILE_ATTRIBUTES, SetFileAttributesW,
};
use windows_sys::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows_sys::Win32::System::DataExchange::{GetClipboardData, SetClipboardData};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, HPOWERNOTIFY, RegisterSuspendResumeNotification,
    SetThreadExecutionState, UnregisterSuspendResumeNotification,
};
use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, LASTINPUTINFO, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey,
    UnregisterHotKey,
};
use windows_sys::Win32::UI::Shell::{
    AssocIsDangerous, FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_RoamingAppData,
    KF_FLAG_DEFAULT, SHGetKnownFolderPath, ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DBT_DEVTYP_VOLUME, DEV_BROADCAST_HDR, DEV_BROADCAST_VOLUME,
    DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, MSG,
    PostMessageW, PostQuitMessage, RegisterClassW, SMTO_ABORTIFHUNG, SMTO_BLOCK, SW_SHOWNORMAL,
    SendMessageTimeoutW, UnregisterClassW, WM_APP, WM_CLOSE, WM_DESTROY, WM_HOTKEY, WM_NULL,
    WNDCLASSW, WS_OVERLAPPED,
};
use windows_sys::core::PWSTR;

use super::signals::{DeviceHeader, HOTKEY_IDS, classify, wants_device_header};
use super::{
    CLIPBOARD_FAILED, ClipboardCalls, ClipboardSteps, Dialogs, DriveType, Env, HotkeyTaken,
    IdleSource, InstalledPrinter, InstalledPrinters, KnownFolder, Launcher, MainWindow, Os,
    OsSignal, PRINTERS_UNREADABLE, Power, PrintCalls, PrintDone, PrintFailed, PrintSteps, Shortcut,
    SystemClock, ThreadTimer, Volumes,
};
use crate::error::ShellResult;
use crate::{lock, window};

#[cfg(test)]
use std::cell::RefCell;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;

/// Turns off WebView2's external drop (files dragged in from outside the app), then reads the setting back.
/// Returns `true` only when WebView2 confirms drops are off.
///
/// With Tauri's drag-and-drop handler off, wry leaves this on (it turns it off only for Tauri's own handler), and the
/// page could then read a dropped file through `event.dataTransfer.files` (spec §4.2).
pub fn turn_off_external_drop(controller: &ICoreWebView2Controller) -> bool {
    // A WebView2 runtime too old for `ICoreWebView2Controller4` cannot turn drops off: that counts as failure.
    let Ok(controller) = controller.cast::<ICoreWebView2Controller4>() else {
        return false;
    };
    let mut allowed = BOOL::from(true);
    // SAFETY: `controller` is a live COM interface, obtained by `cast` (QueryInterface) from the webview's own
    // controller, which Tauri hands us on the thread that owns the webview (`with_webview`). Both calls are plain
    // property accessors; `allowed` is a valid, writable `BOOL` for the getter.
    let confirmed = unsafe {
        controller.SetAllowExternalDrop(false).is_ok()
            && controller.AllowExternalDrop(&mut allowed).is_ok()
    };
    confirmed && !allowed.as_bool()
}

/// Turns off WebView2's browser accelerator keys (Ctrl+P, F12, Ctrl+Shift+I, F5, Ctrl+R, Ctrl+U and the rest) and its
/// default context menu, then reads both settings back. Returns `true` only when WebView2 confirms both are off.
///
/// Wry's defaults leave both on (`browser_accelerator_keys` and `default_context_menus` are true "as WebView2's
/// default"), and Tauri 2.12.5 offers no setting for either, so they are turned off here, after the window exists
/// (security risk 3: Ctrl+P on a revealed password would reach the print spooler).
pub fn turn_off_browser_keys(controller: &ICoreWebView2Controller) -> bool {
    // SAFETY: `controller` is a live COM interface that Tauri hands us on the thread that owns the webview
    // (`with_webview`); the getter only returns a new reference to the webview it owns.
    let Ok(webview) = (unsafe { controller.CoreWebView2() }) else {
        return false;
    };
    // SAFETY: as above, on the webview just obtained.
    let Ok(settings) = (unsafe { webview.Settings() }) else {
        return false;
    };
    // A WebView2 runtime too old for `ICoreWebView2Settings3` cannot turn the keys off: that counts as failure.
    let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
        return false;
    };
    let (mut menus, mut keys) = (BOOL::from(true), BOOL::from(true));
    // SAFETY: `settings` and `settings3` are live COM interfaces on the thread that owns the webview. The four calls
    // are plain property accessors; `menus` and `keys` are valid, writable `BOOL`s for the getters.
    let confirmed = unsafe {
        settings.SetAreDefaultContextMenusEnabled(false).is_ok()
            && settings3.SetAreBrowserAcceleratorKeysEnabled(false).is_ok()
            && settings.AreDefaultContextMenusEnabled(&mut menus).is_ok()
            && settings3
                .AreBrowserAcceleratorKeysEnabled(&mut keys)
                .is_ok()
    };
    confirmed && !menus.as_bool() && !keys.as_bool()
}

/// The real printer's call: WebView2's own print-to-PDF of the main window's page (`ICoreWebView2_7::PrintToPdf`), with
/// its default print settings.
pub struct WinPrint<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> PrintCalls for WinPrint<R> {
    fn start(&self, path: &Path, cancel: CancelToken, done: PrintDone) -> Result<(), PrintFailed> {
        let not_started = PrintFailed::NotStarted { code: 0 };
        let wide = wide_path(path).map_err(|_| not_started)?;
        let window = self
            .app
            .get_webview_window(window::MAIN)
            .ok_or(not_started)?;
        // WebView2 is called on the thread that owns it. If the call cannot be queued, the closure (and `done` in it) is
        // dropped, and the caller is told by this return instead.
        window
            .with_webview(move |webview| print_page(&webview.controller(), &wide, &cancel, done))
            .map_err(|_| not_started)
    }

    fn start_on_printer(
        &self,
        printer: &str,
        cancel: CancelToken,
        done: PrintDone,
    ) -> Result<(), PrintFailed> {
        let not_started = PrintFailed::NotStarted { code: 0 };
        let wide = wide_text(OsStr::new(printer)).map_err(|_| not_started)?;
        let window = self
            .app
            .get_webview_window(window::MAIN)
            .ok_or(not_started)?;
        // As for `start`: on the webview's own thread, and a call that cannot be queued drops `done` and is told by this
        // return instead.
        window
            .with_webview(move |webview| {
                print_page_to_printer(&webview.controller(), &wide, &cancel, done)
            })
            .map_err(|_| not_started)
    }

    fn installed_printers(&self) -> ShellResult<InstalledPrinters> {
        installed_printers()
    }
}

/// Prints the page straight to the printer named `printer` (a NUL-terminated UTF-16 name) on the webview's own thread:
/// print settings made by the webview's environment (`ICoreWebView2Environment6::CreatePrintSettings`), named for the
/// printer (`ICoreWebView2PrintSettings2::SetPrinterName`) with backgrounds off, handed to `ICoreWebView2_16::Print`,
/// which opens no Windows window. `done` goes to WebView2's completion handler or, when the call is refused, is called
/// with why.
fn print_page_to_printer(
    controller: &ICoreWebView2Controller,
    printer: &[u16],
    cancel: &CancelToken,
    done: PrintDone,
) {
    // Whichever of the handler and the refusal below comes first takes it.
    let done = Rc::new(Cell::new(Some(done)));
    let started = (|| -> windows_core::Result<()> {
        // SAFETY: `controller` is a live COM interface on the thread that owns the webview (`with_webview`).
        let webview = unsafe { controller.CoreWebView2() }?;
        // SAFETY: `webview` is a live COM interface on that same thread; the getter returns a new reference.
        let environment = unsafe { webview.cast::<ICoreWebView2_2>()?.Environment() }?;
        // SAFETY: `environment` is a live COM interface on that thread; the call returns new print settings.
        let settings = unsafe {
            environment
                .cast::<ICoreWebView2Environment6>()?
                .CreatePrintSettings()
        }?;
        let named = settings.cast::<ICoreWebView2PrintSettings2>()?;
        // SAFETY: `printer` is a NUL-terminated UTF-16 string (from `wide_text`) that outlives the call, which copies
        // it; both settings are live COM interfaces of the one settings object, on the webview's thread.
        unsafe {
            named.SetPrinterName(PCWSTR(printer.as_ptr()))?;
            settings.SetShouldPrintBackgrounds(false)?;
        }
        let handler = {
            let done = Rc::clone(&done);
            PrintCompletedHandler::create(Box::new(move |error, status| {
                if let Some(done) = done.take() {
                    done(printer_job_answer(error, status));
                }
                Ok(())
            }))
        };
        let webview = webview.cast::<ICoreWebView2_16>()?;
        // The last look before WebView2 is asked: a session that locked while this was queued is not printed.
        if revoked(cancel, &done) {
            return Ok(());
        }
        // SAFETY: `webview` and `settings` are live COM interfaces on the webview's thread; `handler` is a live COM
        // object, which WebView2 holds its own reference to for as long as it needs it.
        unsafe { webview.Print(&settings, &handler) }
    })();
    if let Err(error) = started
        && let Some(done) = done.take()
    {
        done(Err(PrintFailed::NotStarted {
            code: error.code().0,
        }));
    }
}

/// The check that stands right before WebView2's `Print` or `PrintToPdf`, on the webview's thread: when `cancel` is
/// cancelled (the session locked while the job was queued), the job ends here with [`PrintFailed::Revoked`] through the
/// `done` it holds and `true` is returned, so WebView2 is never called. A submitted print cannot be recalled, so this is
/// the last point where a lock still stops one.
fn revoked(cancel: &CancelToken, done: &Rc<Cell<Option<PrintDone>>>) -> bool {
    if !cancel.is_cancelled() {
        return false;
    }
    if let Some(done) = done.take() {
        done(Err(PrintFailed::Revoked));
    }
    true
}

/// How a print to a printer ended, from what WebView2's completion handler was given: sent only when there was no
/// error and the status is "succeeded". "Printer unavailable" and every other status are the same answer (the shell
/// tells the person one thing for all of them), with the `HRESULT` kept as a number when there was one.
fn printer_job_answer(
    error: windows_core::Result<()>,
    status: COREWEBVIEW2_PRINT_STATUS,
) -> Result<(), PrintFailed> {
    match error {
        Err(error) => Err(PrintFailed::NotWritten {
            code: error.code().0,
        }),
        Ok(()) if status != COREWEBVIEW2_PRINT_STATUS_SUCCEEDED => {
            Err(PrintFailed::NotWritten { code: 0 })
        }
        Ok(()) => Ok(()),
    }
}

/// The printers Windows has for this user (`EnumPrintersW` at level 2, the local ones and the connections) and its
/// default (`GetDefaultPrinterW`). A name that is not valid UTF-16 cannot go to the page and back, so its printer is
/// left out. Fixed errors only: never a name or Windows' message.
fn installed_printers() -> ShellResult<InstalledPrinters> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    // The bytes of the answer, in `u64`s so the structures in them are 8-aligned. A printer added between the two calls
    // makes the first size too small: asked again, a few times.
    let mut buffer: Vec<u64> = Vec::new();
    for _ in 0..4 {
        let capacity = buffer.len() * size_of::<u64>();
        let Ok(capacity_u32) = u32::try_from(capacity) else {
            return Err(PRINTERS_UNREADABLE);
        };
        let (mut needed, mut returned) = (0u32, 0u32);
        let target = if capacity == 0 {
            ptr::null_mut()
        } else {
            buffer.as_mut_ptr().cast::<u8>()
        };
        // SAFETY: `target` is null with a size of 0, or points to `capacity` writable bytes (the buffer, 8-aligned) that
        // outlive the call; `needed` and `returned` are writable; no name is given, so the local ones are listed.
        let done = unsafe {
            EnumPrintersW(
                flags,
                ptr::null(),
                2,
                target,
                capacity_u32,
                &mut needed,
                &mut returned,
            )
        };
        if done != 0 {
            // SAFETY: the buffer's `capacity` bytes are initialised (zero-filled, then written by Windows), and the view
            // ends where the buffer does.
            let bytes = unsafe { slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), capacity) };
            return Ok(InstalledPrinters {
                printers: printers_in(bytes, returned as usize)?,
                default: default_printer(),
            });
        }
        // SAFETY: reads the calling thread's last error, straight after the call that failed.
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(PRINTERS_UNREADABLE);
        }
        buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
    }
    Err(PRINTERS_UNREADABLE)
}

/// The `count` `PRINTER_INFO_2W` structures at the start of `bytes` (8-aligned, as `EnumPrintersW` filled them), with
/// the strings they point to, which lie later in the same bytes. A pointer outside `bytes`, or a string with no
/// terminator before the end, is `PRINTERS_UNREADABLE`: nothing is read from beyond what Windows filled in.
fn printers_in(bytes: &[u8], count: usize) -> ShellResult<Vec<InstalledPrinter>> {
    let size = size_of::<PRINTER_INFO_2W>();
    if count
        .checked_mul(size)
        .is_none_or(|total| total > bytes.len())
    {
        return Err(PRINTERS_UNREADABLE);
    }
    let base = bytes.as_ptr() as usize;
    // A string at `pointer`: empty for NULL, else the UTF-16 units up to the terminator, all inside `bytes`.
    let text_at = |pointer: *mut u16| -> ShellResult<Vec<u16>> {
        if pointer.is_null() {
            return Ok(Vec::new());
        }
        let start = (pointer as usize)
            .checked_sub(base)
            .filter(|start| start % align_of::<u16>() == 0 && *start < bytes.len())
            .ok_or(PRINTERS_UNREADABLE)?;
        let (pairs, _) = bytes[start..].as_chunks::<{ size_of::<u16>() }>();
        let units: Vec<u16> = pairs
            .iter()
            .map(|pair| u16::from_ne_bytes(*pair))
            .take_while(|&unit| unit != 0)
            .collect();
        // Ended by a terminator, not by the end of the bytes.
        let end = start + (units.len() + 1) * size_of::<u16>();
        if end > bytes.len() {
            return Err(PRINTERS_UNREADABLE);
        }
        Ok(units)
    };
    let mut printers = Vec::with_capacity(count);
    for index in 0..count {
        // SAFETY: the check above makes `count * size` bytes of `bytes` readable; the bytes start 8-aligned (a `Vec<u64>`
        // in the caller), as `PRINTER_INFO_2W` needs, and every field is plain data that Windows filled in.
        let info = unsafe {
            bytes
                .as_ptr()
                .add(index * size)
                .cast::<PRINTER_INFO_2W>()
                .read()
        };
        let Ok(name) = String::from_utf16(&text_at(info.pPrinterName)?) else {
            continue;
        };
        printers.push(InstalledPrinter {
            name,
            port: String::from_utf16_lossy(&text_at(info.pPortName)?),
            driver: String::from_utf16_lossy(&text_at(info.pDriverName)?),
            attributes: info.Attributes,
        });
    }
    Ok(printers)
}

/// The name of the default printer (`GetDefaultPrinterW`), or `None` when there is none or Windows will not say.
fn default_printer() -> Option<String> {
    let mut len = 0u32;
    // SAFETY: a null buffer with a length of 0 only asks for the size, which is written to `len`, a writable `u32`.
    let asked = unsafe { GetDefaultPrinterW(ptr::null_mut(), &mut len) };
    // SAFETY: reads the calling thread's last error, straight after the call.
    if asked != 0 || len == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }
    let mut buffer = vec![0u16; len as usize];
    // SAFETY: `buffer` has `len` writable UTF-16 units, and `len` says so.
    if unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut len) } == 0 {
        return None;
    }
    let end = buffer.iter().position(|&unit| unit == 0)?;
    String::from_utf16(&buffer[..end]).ok()
}

/// Starts the print on the webview's own thread and hands `done` to WebView2's completion handler, or, when the call
/// is refused, calls it with why.
fn print_page(
    controller: &ICoreWebView2Controller,
    path: &[u16],
    cancel: &CancelToken,
    done: PrintDone,
) {
    // Whichever of the handler and the refusal below comes first takes it.
    let done = Rc::new(Cell::new(Some(done)));
    let started = (|| {
        // SAFETY: `controller` is a live COM interface on the thread that owns the webview (`with_webview`).
        let webview = unsafe { controller.CoreWebView2() }?;
        let webview = webview.cast::<ICoreWebView2_7>()?;
        let handler = {
            let done = Rc::clone(&done);
            PrintToPdfCompletedHandler::create(Box::new(move |error, successful| {
                if let Some(done) = done.take() {
                    done(print_answer(error, successful));
                }
                Ok(())
            }))
        };
        // The last look before WebView2 is asked: a session that locked while this was queued is not printed.
        if revoked(cancel, &done) {
            return Ok(());
        }
        // SAFETY: `path` is a NUL-terminated UTF-16 string (from `wide_path`) that outlives the call; `handler` is a
        // live COM object, which WebView2 holds its own reference to for as long as it needs it; no print settings
        // are given, which WebView2 reads as its defaults.
        unsafe {
            webview.PrintToPdf(
                PCWSTR(path.as_ptr()),
                None::<&ICoreWebView2PrintSettings>,
                &handler,
            )
        }
    })();
    if let Err(error) = started
        && let Some(done) = done.take()
    {
        done(Err(PrintFailed::NotStarted {
            code: error.code().0,
        }));
    }
}

/// How a finished print job ended, from what WebView2's completion handler was given: a PDF only when there was no
/// error and WebView2 says it succeeded. The `HRESULT` is kept as a number.
fn print_answer(error: windows_core::Result<()>, successful: bool) -> Result<(), PrintFailed> {
    match error {
        Err(error) => Err(PrintFailed::NotWritten {
            code: error.code().0,
        }),
        Ok(()) if !successful => Err(PrintFailed::NotWritten { code: 0 }),
        Ok(()) => Ok(()),
    }
}

/// Adds the hidden attribute to the file or folder at `path`; every other attribute stays. The recovery key's PDF is
/// printed into a new hidden folder (the design's results table: WebView2 refuses an existing hidden file), which this
/// hides.
pub fn set_hidden(path: &Path) -> io::Result<()> {
    let wide = wide_path(path)?;
    // SAFETY: `wide` is a live NUL-terminated UTF-16 path; the call only reads it.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the same `wide` path; the new attributes are passed by value.
    if unsafe { SetFileAttributesW(wide.as_ptr(), attributes | FILE_ATTRIBUTE_HIDDEN) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Whether `a` and `b` are equal as Windows compares file names: ordinal, ignoring case (`CompareStringOrdinal`,
/// which uppercases each UTF-16 unit with the system's table, the same per-unit rule NTFS applies to names).
pub fn equal_ignoring_case(a: &OsStr, b: &OsStr) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_wide().collect(), b.encode_wide().collect());
    let (Ok(a_len), Ok(b_len)) = (i32::try_from(a.len()), i32::try_from(b.len())) else {
        return false;
    };
    // SAFETY: each pointer is to a live buffer of exactly the number of UTF-16 units passed with it (explicit lengths,
    // so no terminator is read), and the function only reads them. It answers 0 on failure, which is "not equal".
    unsafe { CompareStringOrdinal(a.as_ptr(), a_len, b.as_ptr(), b_len, TRUE) == CSTR_EQUAL }
}

impl Os {
    /// The real OS calls; the dialogs open over the app's main window.
    pub fn windows<R: Runtime>(app: AppHandle<R>) -> Os {
        Os {
            volumes: Arc::new(WinVolumes),
            env: Arc::new(WinEnv),
            dialogs: Arc::new(WinDialogs { app: app.clone() }),
            printer: Arc::new(PrintSteps::new(Arc::new(WinPrint { app: app.clone() }))),
            launcher: Arc::new(WinLauncher),
            idle: Arc::new(WinIdle),
            window: Arc::new(WinMainWindow { app: app.clone() }),
            power: Arc::new(WinPower { app }),
            clock: Arc::new(SystemClock),
            clipboard: Arc::new(ClipboardSteps::new(
                Arc::new(WinClipboard),
                Arc::new(SystemClock),
            )),
            timer: Arc::new(ThreadTimer::default()),
        }
    }
}

/// The clipboard's single steps: through `clipboard-win` 5.4.3 for opening, emptying and reading, and our own
/// [`Block`] for every value written (the text, the tag and the marks), so a block Windows refuses is wiped before it
/// is freed and every block starts zero-filled. The clipboard is opened with no owner window, as
/// `clipboard_win::Clipboard::new` does.
pub struct WinClipboard;

/// `CF_UNICODETEXT` (winuser.h), named here rather than pulling in `Win32_System_Ole` for one constant.
const CF_UNICODETEXT: u32 = 13;

/// The clipboard opened by [`WinClipboard`]: `clipboard_win::Clipboard`, which closes it when dropped.
pub struct WinOpened(#[allow(dead_code)] clipboard_win::Clipboard);

#[cfg(test)]
impl Drop for WinOpened {
    /// Tests only: the close, as a step (the clipboard itself closes when the field drops, right after this).
    fn drop(&mut self) {
        clipboard_step("close");
    }
}

impl ClipboardCalls for WinClipboard {
    type Opened = WinOpened;

    fn register_format(&self, name: &str) -> Option<NonZeroU32> {
        clipboard_win::raw::register_format(name)
    }

    fn open(&self) -> Option<WinOpened> {
        let opened = clipboard_win::Clipboard::new().ok().map(WinOpened);
        #[cfg(test)]
        if opened.is_some() {
            clipboard_step("open");
        }
        opened
    }

    fn empty(&self) -> bool {
        #[cfg(test)]
        clipboard_step("empty");
        clipboard_win::raw::empty().is_ok()
    }

    fn set_text(&self, text: &str) -> bool {
        // UTF-16 units plus the terminating NUL, which the zero-filled block already holds.
        let Some(len) = text
            .encode_utf16()
            .count()
            .checked_add(1)
            .and_then(|units| units.checked_mul(size_of::<u16>()))
        else {
            return false;
        };
        let Some(mut block) = Block::new(len) else {
            return false;
        };
        for (slot, unit) in block
            .bytes()
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .zip(text.encode_utf16())
        {
            *slot = unit.to_ne_bytes();
        }
        block.give(CF_UNICODETEXT)
    }

    fn set_bytes(&self, format: NonZeroU32, bytes: &[u8]) -> bool {
        let Some(mut block) = Block::new(bytes.len()) else {
            return false;
        };
        block.bytes().copy_from_slice(bytes);
        block.give(format.get())
    }

    fn read_bytes(&self, format: NonZeroU32) -> ShellResult<Option<Vec<u8>>> {
        #[cfg(test)]
        clipboard_step("read");
        // Absent only when Windows says so; a format that is there but cannot be read is an error, never "gone".
        if !clipboard_win::raw::is_format_avail(format.get()) {
            return Ok(None);
        }
        let mut held = Vec::new();
        clipboard_win::raw::get_vec(format.get(), &mut held).map_err(|_| CLIPBOARD_FAILED)?;
        Ok(Some(held))
    }

    fn text_size(&self) -> ShellResult<Option<usize>> {
        #[cfg(test)]
        clipboard_step("text size");
        // `Ok(None)` only when Windows says there is no text (it also offers text for plain ANSI and OEM text).
        if !clipboard_win::raw::is_format_avail(CF_UNICODETEXT) {
            return Ok(None);
        }
        // SAFETY: only inside an opening on this thread (`ClipboardSteps`); the handle is the clipboard's own block,
        // read here for its size only and never freed or kept. Windows says the handle is good only until the
        // clipboard is emptied or closed. Lockbox's own threads cannot do either meanwhile (`ClipboardSteps` gives
        // one opening at a time), and a program with an owner window is refused by Windows while this opening is
        // open. A third program that also opens with no owner window is let in by Windows, and could empty the
        // clipboard: Lockbox cannot stop that.
        let block = unsafe { GetClipboardData(CF_UNICODETEXT) };
        if block.is_null() {
            return Err(CLIPBOARD_FAILED);
        }
        // SAFETY: `block` is the global block the call above returned, good for as long as the clipboard is neither
        // emptied nor closed (see above for who can and cannot do that during this opening).
        match unsafe { GlobalSize(block) } {
            0 => Err(CLIPBOARD_FAILED),
            size => Ok(Some(size)),
        }
    }

    fn copy_text(&self) -> ShellResult<Option<Zeroizing<String>>> {
        #[cfg(test)]
        clipboard_step("read text");
        if !clipboard_win::raw::is_format_avail(CF_UNICODETEXT) {
            return Ok(None);
        }
        // SAFETY: as in `text_size`.
        let block = unsafe { GetClipboardData(CF_UNICODETEXT) };
        if block.is_null() {
            return Err(CLIPBOARD_FAILED);
        }
        // SAFETY: as in `text_size`.
        let size = unsafe { GlobalSize(block) };
        // SAFETY: `block` is the clipboard's global block, valid as described in `text_size`; locked here and unlocked
        // below, before anything else.
        let at = unsafe { GlobalLock(block) }.cast::<u16>().cast_const();
        if at.is_null() || size == 0 {
            if !at.is_null() {
                // SAFETY: undoes the lock just taken.
                unsafe { GlobalUnlock(block) };
            }
            return Err(CLIPBOARD_FAILED);
        }
        // Read unit by unit straight from the block (no alignment assumed, and no copy of the units): the text is
        // built once, in a string made the right size first, so it never moves and leaves an unwiped part behind.
        let units = (0..size / size_of::<u16>()).map(|index| {
            // SAFETY: the block is locked and `size` bytes long, so the `size / 2` units from `at` are readable, and
            // `index` is below that. The block stays as long as the clipboard is neither emptied nor closed, which
            // Lockbox's own threads and programs with an owner window cannot do during this opening; a third program
            // opening with no owner window could (see `text_size`).
            unsafe { at.add(index).read_unaligned() }
        });
        let text = utf8_from_utf16(units);
        // SAFETY: undoes the lock taken above; `at` is not used after it.
        unsafe { GlobalUnlock(block) };
        Ok(Some(text))
    }
}

/// The text in `units` (UTF-16) up to its first NUL, as UTF-8. The string is made exactly as long as the text first, so
/// it never grows (a growing string leaves its old, unwiped buffer behind), and it is wiped when dropped. A unit that
/// is half of a surrogate pair with no other half becomes U+FFFD.
fn utf8_from_utf16(units: impl Iterator<Item = u16> + Clone) -> Zeroizing<String> {
    let units = units.take_while(|&unit| unit != 0);
    let letters = |units| {
        char::decode_utf16(units).map(|letter| letter.unwrap_or(char::REPLACEMENT_CHARACTER))
    };
    let len = letters(units.clone()).map(char::len_utf8).sum();
    let mut text = Zeroizing::new(String::with_capacity(len));
    text.extend(letters(units));
    text
}

/// A movable, zero-filled global block (`GHND`), locked from its allocation until it is given to the clipboard or
/// freed. The same pointer it is filled through wipes it if the clipboard refuses it, so a refused block is never
/// freed unwiped (no second `GlobalLock`, which could fail).
///
/// Microsoft's rules followed (learn.microsoft.com, `SetClipboardData`, `GlobalLock`, `GlobalUnlock`): on success the
/// system owns the block; the application must not write to or free it, but may keep it locked to read until
/// `CloseClipboard`, and must unlock it before the clipboard is closed. So [`give`](Self::give) calls
/// `SetClipboardData` with the block still locked (nothing is written through the pointer after that call), then, on
/// success, `GlobalUnlock` once, all inside the caller's opening. On refusal the block is still ours: wiped through
/// the pointer, unlocked, then `GlobalFree`.
struct Block {
    handle: HGLOBAL,
    /// The block's address while locked, valid for `len` bytes (a movable block does not move while locked).
    at: *mut u8,
    len: usize,
}

impl Block {
    /// A zero-filled block of `len` bytes (at least one), locked. `None` if it cannot be made or locked; nothing has
    /// been written to it then.
    fn new(len: usize) -> Option<Block> {
        // SAFETY: a plain allocation; a null handle is checked below.
        let handle = unsafe { GlobalAlloc(GHND, len.max(1)) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: `handle` is a live movable block of ours; locked here, unlocked in `give` or `drop`.
        let at = unsafe { GlobalLock(handle) }.cast::<u8>();
        if at.is_null() {
            // Never locked, never written: only zeros to free.
            // SAFETY: `handle` is ours, unlocked, and freed once.
            unsafe { GlobalFree(handle) };
            return None;
        }
        Some(Block { handle, at, len })
    }

    /// The block's first `len` bytes, to fill.
    fn bytes(&mut self) -> &mut [u8] {
        // SAFETY: `at` is the locked block's address with at least `len` writable bytes (the block was allocated with
        // that size); `&mut self` keeps any other use of the pointer out while the slice lives.
        unsafe { slice::from_raw_parts_mut(self.at, self.len) }
    }

    /// Gives the block to the clipboard as `format`: true when the clipboard took it. Only inside an opening.
    fn give(self, format: u32) -> bool {
        // SAFETY: `handle` is a live global block holding the format's data. `ClipboardSteps` calls this only while
        // the clipboard is open on this thread (if it is not, Windows refuses). Keeping it locked through the call is
        // allowed: it must only be unlocked before the clipboard closes, which happens just below.
        let taken = !unsafe { SetClipboardData(format, self.handle) }.is_null();
        if !taken {
            // Dropped: wiped through `at`, unlocked, freed.
            return false;
        }
        // SAFETY: the system owns the block now; undoing this code's lock (reading-only rights remain until close) is
        // what Microsoft requires before the clipboard is closed. The block is never touched again.
        unsafe { GlobalUnlock(self.handle) };
        std::mem::forget(self);
        true
    }
}

impl Drop for Block {
    /// A block the clipboard did not take: wiped (volatile writes, not optimised away) through the pointer it was
    /// filled through, then unlocked and freed.
    fn drop(&mut self) {
        self.bytes().zeroize();
        #[cfg(test)]
        refused_block_seen(self.bytes());
        // SAFETY: undoes the lock taken in `new`; `at` is not used after it.
        unsafe { GlobalUnlock(self.handle) };
        // SAFETY: the block is still ours (never given), unlocked, and freed once.
        unsafe { GlobalFree(self.handle) };
    }
}

#[cfg(test)]
thread_local! {
    /// Tests only: the bytes of the last block refused on this thread, as they were right before it was freed.
    static REFUSED: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// Tests only: the real clipboard steps this thread took (`open`, `read`, `empty`, `close`), and the test's own.
    static CLIPBOARD_STEPS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Tests only: records one clipboard step on this thread.
#[cfg(test)]
fn clipboard_step(step: &'static str) {
    CLIPBOARD_STEPS.with_borrow_mut(|steps| steps.push(step));
}

/// Tests only: records what a refused block held right before it was freed.
#[cfg(test)]
fn refused_block_seen(bytes: &[u8]) {
    REFUSED.set(Some(bytes.to_vec()));
}

/// Idle time from `GetLastInputInfo`: the tick count of the session's last keyboard or mouse input, against
/// `GetTickCount` now. Both wrap after 49.7 days, so the difference is taken wrapping.
pub struct WinIdle;

impl IdleSource for WinIdle {
    fn since_last_input(&self) -> Duration {
        let mut info = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a writable LASTINPUTINFO whose `cbSize` is its own size, as the call requires.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            // Fails only for a wrong `cbSize`. Fail closed: a vault never stays unlocked because idle time is unknown.
            return Duration::MAX;
        }
        // SAFETY: takes no arguments.
        let now = unsafe { GetTickCount() };
        Duration::from_millis(u64::from(now.wrapping_sub(info.dwTime)))
    }
}

/// Keeps the PC awake through the signal window's thread ([`SignalThread::keep_awake`]), which the app keeps in its
/// state from before the shell is made. Without it (never, once the app runs) nothing changes.
pub struct WinPower<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> Power for WinPower<R> {
    fn keep_awake(&self, on: bool) {
        if let Some(signal_thread) = self.app.try_state::<SignalThread>() {
            signal_thread.keep_awake(on);
        }
    }
}

/// The main window, hidden to the tray by Tauri's own call (no `unsafe` here).
pub struct WinMainWindow<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> MainWindow for WinMainWindow<R> {
    fn hide(&self) {
        if let Some(main) = self.app.get_webview_window(window::MAIN) {
            let _ = main.hide();
        }
    }
}

/// Opens web links and decrypted copies with `ShellExecuteW`, verb `open`: the user's default browser or app.
pub struct WinLauncher;

impl Launcher for WinLauncher {
    fn open_url(&self, url: &tauri::Url) -> io::Result<()> {
        let link = wide_text(OsStr::new(url.as_str()))?;
        match shell_open(&link, None) {
            true => Ok(()),
            false => Err(io::Error::other("link not opened")),
        }
    }

    fn open_file(&self, file: &Path) -> io::Result<()> {
        let Some(folder) = file.parent() else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        let (file, folder) = (wide_path(file)?, wide_path(folder)?);
        match shell_open(&file, Some(&folder)) {
            true => Ok(()),
            false => Err(io::Error::other("file not opened")),
        }
    }
}

/// `ShellExecuteW`, verb `open`, on `target`, with `directory` as the working directory if given (both NUL-terminated
/// UTF-16): whether it launched. Only that crosses, never Windows' error code or the target.
fn shell_open(target: &[u16], directory: Option<&[u16]>) -> bool {
    let Ok(verb) = wide_text(OsStr::new("open")) else {
        return false;
    };
    // COM first, as `ShellExecuteW` asks of its caller (it may hand the target to a shell extension): the
    // single-threaded apartment, which rfd's dialogs also use on these blocking-pool threads, undone below. A thread
    // already in the multithreaded apartment (`RPC_E_CHANGED_MODE`, a failure) keeps it and is not undone.
    // SAFETY: the reserved pointer is null and the flags are valid `COINIT` values.
    let com = unsafe {
        CoInitializeEx(
            ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    // SAFETY: `verb`, `target` and `directory` are NUL-terminated UTF-16 strings that live through the call; no owner
    // window or parameters (null), and a null working directory when none is given, which the call accepts.
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            directory.map_or(ptr::null(), <[u16]>::as_ptr),
            SW_SHOWNORMAL,
        )
    };
    if com >= 0 {
        // SAFETY: balances the successful `CoInitializeEx` above (`S_OK` or `S_FALSE`) on this same thread.
        unsafe { CoUninitialize() };
    }
    // Greater than 32 means it launched; the rest are error codes.
    result as isize > 32
}

/// Whether Windows rates the file type `extension` (with its dot) as dangerous to open (`AssocIsDangerous`). A type
/// that cannot be asked about counts as dangerous.
pub fn is_dangerous_type(extension: &str) -> bool {
    let Ok(extension) = wide_text(OsStr::new(extension)) else {
        return true;
    };
    // SAFETY: `extension` is a NUL-terminated UTF-16 string that lives through the call, which only reads it.
    unsafe { AssocIsDangerous(extension.as_ptr()) != 0 }
}

/// The current user's SID, as text (`S-1-5-..`): the user of this process's token.
fn current_user_sid() -> io::Result<OsString> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: the current process's pseudo handle needs no closing; `token` is a writable handle the call fills.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call succeeded, so `token` is a handle of ours to close, owned from here on.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut needed = 0;
    // SAFETY: a null buffer of size 0 only asks for the size needed, written to `needed`; this first call fails by
    // design, and the next call's result says whether the answer was usable.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    // In `usize`s, so the buffer is aligned for the `TOKEN_USER` at its start.
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    // SAFETY: `buffer` is writable and at least `needed` bytes long.
    let read = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success the buffer starts with a `TOKEN_USER`, aligned as above; its SID pointer points further into
    // the buffer, which outlives this use.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_text(user.User.Sid)
}

/// `sid` as text.
fn sid_text(sid: PSID) -> io::Result<OsString> {
    let mut text: PWSTR = ptr::null_mut();
    // SAFETY: the callers pass a valid SID; `text` is a writable pointer the call fills with a buffer it allocates.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success `text` is a NUL-terminated UTF-16 string, read before it is freed below.
    let sid = unsafe { wide_until_nul(text) };
    // SAFETY: the call allocated the buffer with `LocalAlloc`, for the caller to free; nothing reads it afterwards.
    unsafe { LocalFree(text.cast()) };
    Ok(sid)
}

/// Makes the new folder `path` with permissions for the current user alone, from the moment it exists: a protected
/// DACL (nothing inherited from above) with one entry, full access for the user, passed on to everything inside it
/// (`D:P(A;OICI;FA;;;<SID>)`). Fails if anything is already at `path`.
pub fn create_private_folder(path: &Path) -> io::Result<()> {
    let folder = wide_path(path)?;
    let mut sddl = OsString::from("D:P(A;OICI;FA;;;");
    sddl.push(current_user_sid()?);
    sddl.push(")");
    let sddl = wide_text(&sddl)?;
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `sddl` is a NUL-terminated UTF-16 string that lives through the call; `descriptor` is a writable pointer
    // the call fills with a buffer it allocates; the size is not asked for (null).
    let built = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if built == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: `folder` is a NUL-terminated UTF-16 string, and `attributes` and the descriptor it points to are valid,
    // all living through the call, which only reads them.
    let made = unsafe { CreateDirectoryW(folder.as_ptr(), &attributes) };
    // Read before the free below can change it.
    let error = io::Error::last_os_error();
    // SAFETY: the conversion allocated the descriptor with `LocalAlloc`, for the caller to free; nothing uses it now.
    unsafe { LocalFree(descriptor) };
    match made != 0 {
        true => Ok(()),
        false => Err(error),
    }
}

/// Tests only: one entry of a DACL.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub struct AclEntry {
    pub allow: bool,
    pub flags: u32,
    pub mask: u32,
    pub sid: OsString,
}

/// Tests only: whether `path`'s DACL is protected, and its entries (`GetNamedSecurityInfoW`).
#[cfg(test)]
pub fn read_dacl(path: &Path) -> io::Result<(bool, Vec<AclEntry>)> {
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        SE_DACL_PROTECTED,
    };

    /// `ACCESS_ALLOWED_ACE_TYPE` (WinNT.h): windows-sys keeps it under a feature pulled in for this number alone.
    const ACCESS_ALLOWED: u8 = 0;

    let name = wide_path(path)?;
    let (mut dacl, mut descriptor): (*mut ACL, PSECURITY_DESCRIPTOR) =
        (ptr::null_mut(), ptr::null_mut());
    // SAFETY: `name` is a NUL-terminated UTF-16 string; `dacl` and `descriptor` are writable pointers the call fills;
    // the parts not asked for are null.
    let error = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let (mut control, mut revision) = (0, 0);
    // SAFETY: `descriptor` is the descriptor the call above returned; both outputs are writable.
    assert_ne!(
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
        0
    );
    let mut size = ACL_SIZE_INFORMATION {
        AceCount: 0,
        AclBytesInUse: 0,
        AclBytesFree: 0,
    };
    // SAFETY: `dacl` points into `descriptor`, still live; `size` is the class's writable struct, of the size passed.
    assert_ne!(
        unsafe {
            GetAclInformation(
                dacl,
                (&raw mut size).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        },
        0
    );
    let mut entries = Vec::new();
    for index in 0..size.AceCount {
        let mut ace = ptr::null_mut();
        // SAFETY: `index` is below the entry count just read; `ace` is a writable pointer the call fills.
        assert_ne!(unsafe { GetAce(dacl, index, &mut ace) }, 0);
        let ace = ace.cast::<ACCESS_ALLOWED_ACE>().cast_const();
        // SAFETY: every entry starts with this layout (header, mask, then the SID at `SidStart`), and `dacl` is live.
        entries.push(unsafe {
            AclEntry {
                allow: (*ace).Header.AceType == ACCESS_ALLOWED,
                flags: u32::from((*ace).Header.AceFlags),
                mask: (*ace).Mask,
                sid: sid_text((&raw const (*ace).SidStart).cast_mut().cast())?,
            }
        });
    }
    // SAFETY: the call above allocated the descriptor with `LocalAlloc`, for the caller to free; nothing uses it now.
    unsafe { LocalFree(descriptor) };
    Ok((control & SE_DACL_PROTECTED != 0, entries))
}

/// Tests only: the current user's SID, as text.
#[cfg(test)]
pub fn test_user_sid() -> OsString {
    current_user_sid().unwrap()
}

/// Environment variables from the process, known folders from `SHGetKnownFolderPath`.
pub struct WinEnv;

impl Env for WinEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }

    fn known_folder(&self, id: KnownFolder) -> io::Result<PathBuf> {
        let folder = match id {
            KnownFolder::Profile => &FOLDERID_Profile,
            KnownFolder::LocalAppData => &FOLDERID_LocalAppData,
            KnownFolder::RoamingAppData => &FOLDERID_RoamingAppData,
        };
        let mut path: PWSTR = ptr::null_mut();
        // SAFETY: `folder` points to a GUID constant; flags 0 (`KF_FLAG_DEFAULT`) and a null token ask for the current
        // user's folder; `path` is a writable pointer the call fills with a buffer it allocates.
        let result = unsafe {
            SHGetKnownFolderPath(folder, KF_FLAG_DEFAULT as u32, ptr::null_mut(), &mut path)
        };
        let found = match result >= 0 && !path.is_null() {
            // SAFETY: on success `path` is a NUL-terminated UTF-16 string, read up to its terminator before it is
            // freed below.
            true => Ok(PathBuf::from(unsafe { wide_until_nul(path) })),
            false => Err(io::Error::new(io::ErrorKind::NotFound, "known folder")),
        };
        // SAFETY: the buffer was allocated by the call (with the COM allocator) and must be freed by the caller,
        // even on failure; freeing null does nothing. Nothing reads it afterwards.
        unsafe { CoTaskMemFree(path.cast_const().cast()) };
        found
    }
}

/// The NUL-terminated UTF-16 string at `text`, without its terminator.
///
/// # Safety
/// `text` must point to a readable UTF-16 string ending in a NUL unit.
unsafe fn wide_until_nul(text: *const u16) -> OsString {
    let mut len = 0;
    // SAFETY: the caller's promise: every unit up to and including the terminator is readable.
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: the `len` units before the terminator were just read one by one.
    OsString::from_wide(unsafe { std::slice::from_raw_parts(text, len) })
}

/// `path` as a NUL-terminated UTF-16 string, for a Windows call. A path holding a NUL itself is refused: Windows
/// would read only the part before it.
fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    wide_text(path.as_os_str())
}

/// `text` as a NUL-terminated UTF-16 string, for a Windows call; refused when it holds a NUL itself.
fn wide_text(text: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = text.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    wide.push(0);
    Ok(wide)
}

/// The name of the mutex that says a copy of the app runs in this sign-in: in the `Local\` namespace, so each sign-in has
/// its own, and not the single-instance plugin's own name.
const INSTANCE_NAME: &str = "Local\\io.github.sumguywhowantstobuild.lockbox.instance";

/// A claim on being the app's one running copy: the mutex handle, closed when the guard drops (and by Windows when the
/// process ends). Kept in the app's state for the life of the process.
pub struct InstanceGuard(HANDLE);

// SAFETY: the handle is only closed, once, by `Drop`; a mutex handle may be closed from any thread, and nothing else
// uses it.
unsafe impl Send for InstanceGuard {}
// SAFETY: as above: there is no use of the handle through a shared reference at all.
unsafe impl Sync for InstanceGuard {}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by `CreateMutexW` and is closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

/// Claims being the app's one running copy in this sign-in, before any launch work runs: the single-instance plugin
/// falls through when its mutex exists but its window does not exist yet, so two copies can reach launch work, and the
/// second would remove the first's staging folder. `None`: another copy has it. An error: Windows would not say.
pub fn claim_instance() -> io::Result<Option<InstanceGuard>> {
    claim(INSTANCE_NAME)
}

/// [`claim_instance`] for a mutex called `name` (tests use their own).
fn claim(name: &str) -> io::Result<Option<InstanceGuard>> {
    let name = wide_text(OsStr::new(name))?;
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call; no security attributes are passed
    // and the mutex is not owned by this call.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // Read at once, before anything else can change it: `CreateMutexW` of an existing mutex succeeds and sets
    // `ERROR_ALREADY_EXISTS`.
    // SAFETY: reads this thread's last error.
    let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let guard = InstanceGuard(handle);
    // The guard drops here for a mutex another copy holds: this handle closes, the other copy's stays.
    Ok((!exists).then_some(guard))
}

/// The text a call wrote into `buffer`, up to its first NUL (or the whole buffer).
fn text_in(buffer: &[u16]) -> OsString {
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    OsString::from_wide(&buffer[..len])
}

/// `GetDriveTypeW`'s answers (WinBase.h). windows-sys keeps them under `Win32_System_WindowsProgramming`, a feature
/// pulled in for these five numbers alone otherwise.
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_REMOTE: u32 = 4;
const DRIVE_CDROM: u32 = 5;
const DRIVE_RAMDISK: u32 = 6;

/// Room for a volume label or file system name: Windows' documented maximum, `MAX_PATH + 1`.
const VOLUME_TEXT: usize = MAX_PATH as usize + 1;

/// Volumes as Windows reports them.
pub struct WinVolumes;

impl WinVolumes {
    /// The volume's label and file system name (`GetVolumeInformationW`).
    fn information(root: &Path) -> io::Result<(String, String)> {
        let root = wide_path(root)?;
        let (mut label, mut file_system) = ([0u16; VOLUME_TEXT], [0u16; VOLUME_TEXT]);
        // SAFETY: `root` is NUL-terminated; each output buffer is writable for the length passed with it (in UTF-16
        // units, terminator included); the serial number, name length and flags are not asked for (null).
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                label.as_mut_ptr(),
                VOLUME_TEXT as u32,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                file_system.as_mut_ptr(),
                VOLUME_TEXT as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((
            text_in(&label).to_string_lossy().into_owned(),
            text_in(&file_system).to_string_lossy().into_owned(),
        ))
    }
}

impl Volumes for WinVolumes {
    fn drive_type(&self, root: &Path) -> DriveType {
        let Ok(root) = wide_path(root) else {
            return DriveType::Unknown;
        };
        // SAFETY: `root` is a NUL-terminated string the call only reads.
        match unsafe { GetDriveTypeW(root.as_ptr()) } {
            DRIVE_FIXED => DriveType::Fixed,
            DRIVE_REMOVABLE => DriveType::Removable,
            DRIVE_REMOTE => DriveType::Remote,
            DRIVE_CDROM => DriveType::CdRom,
            DRIVE_RAMDISK => DriveType::RamDisk,
            // `DRIVE_UNKNOWN`, `DRIVE_NO_ROOT_DIR`, and anything newer.
            _ => DriveType::Unknown,
        }
    }

    fn file_system(&self, root: &Path) -> io::Result<String> {
        Self::information(root).map(|(_, file_system)| file_system)
    }

    fn volume_label(&self, root: &Path) -> io::Result<String> {
        Self::information(root).map(|(label, _)| label)
    }

    fn volume_root(&self, path: &Path) -> io::Result<PathBuf> {
        let wide = wide_path(path)?;
        // The root is never longer than the path, plus a trailing backslash and the terminator; at least `MAX_PATH`,
        // as the documentation advises.
        let mut root = vec![0u16; (wide.len() + 1).max(MAX_PATH as usize + 1)];
        let len = u32::try_from(root.len()).map_err(|_| io::ErrorKind::InvalidInput)?;
        // SAFETY: `wide` is NUL-terminated; `root` is writable for `len` UTF-16 units, which the call fills with a
        // NUL-terminated path.
        let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), root.as_mut_ptr(), len) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PathBuf::from(text_in(&root)))
    }

    fn under_sync_root(&self, path: &Path) -> bool {
        sync_root(path).is_some()
    }

    fn sync_root_provider(&self, path: &Path) -> Option<String> {
        sync_root(path).flatten()
    }

    fn exists(&self, path: &Path) -> io::Result<bool> {
        path.try_exists()
    }
}

/// `HRESULT_FROM_WIN32`: a Win32 error code as an `HRESULT`.
const fn hresult_from_win32(code: u32) -> i32 {
    ((code & 0xFFFF) | 0x8007_0000) as i32
}

/// The sync root above `path` (an existing one), as Windows has it registered (`CfGetSyncRootInfoByPath`, provider
/// class): `None` when there is none (or the path cannot be passed), else `Some` of its provider name, `None` when
/// that cannot be read.
///
/// windows-sys 0.61.2's `CF_SYNC_ROOT_PROVIDER_INFO` is fixed-size: a status, then the name and the version as
/// 256-unit NUL-terminated arrays (`CF_MAX_PROVIDER_NAME_LENGTH` is 255); only the standard class ends in a
/// variable-length identity. The whole structure is passed, so a too-small answer should not come; it would still
/// mean a sync root, so it counts as one with an unreadable name.
fn sync_root(path: &Path) -> Option<Option<String>> {
    let path = wide_path(path).ok()?;
    let mut info = CF_SYNC_ROOT_PROVIDER_INFO::default();
    let mut returned = 0u32;
    // SAFETY: `path` is NUL-terminated; `info` is a writable, zeroed `CF_SYNC_ROOT_PROVIDER_INFO`, the structure the
    // provider class fills, and its full size is passed; `returned` is writable. Nothing is read from `info` unless
    // the call succeeded.
    let result = unsafe {
        CfGetSyncRootInfoByPath(
            path.as_ptr(),
            CF_SYNC_ROOT_INFO_PROVIDER,
            (&raw mut info).cast(),
            size_of::<CF_SYNC_ROOT_PROVIDER_INFO>() as u32,
            &mut returned,
        )
    };
    if result >= 0 {
        // Zeroed before the call and NUL-terminated by it, so the name ends inside the array.
        let name = text_in(&info.ProviderName).into_string().ok();
        return Some(name.filter(|name| !name.is_empty()));
    }
    let too_small = [ERROR_MORE_DATA, ERROR_INSUFFICIENT_BUFFER]
        .into_iter()
        .any(|code| result == hresult_from_win32(code));
    // Any other failure (not under a sync root among them) means none.
    too_small.then_some(None)
}

/// `rfd`'s dialogs (Windows' common item dialogs), owned by the main window: while one is open, the window does not
/// take input. Each call shows the dialog on the calling thread (a blocking-pool thread, never the main one) and
/// waits for the user.
pub struct WinDialogs<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> WinDialogs<R> {
    /// A dialog titled `title`, over the main window when it is there. Built on the thread that shows it: rfd's
    /// dialog holds the window's raw handle, which is not `Send`.
    fn dialog(&self, title: &str) -> rfd::FileDialog {
        let dialog = rfd::FileDialog::new().set_title(title);
        match self.app.get_webview_window(window::MAIN) {
            Some(main) => dialog.set_parent(&main),
            None => dialog,
        }
    }

    fn filtered(&self, title: &str, filter: Option<(&str, &[&str])>) -> rfd::FileDialog {
        let dialog = self.dialog(title);
        match filter {
            Some((name, extensions)) => dialog.add_filter(name, extensions),
            None => dialog,
        }
    }
}

/// Held from saving the working directory, through the dialog, to putting it back. Its own lock, outside the
/// sessions' lock order: dialogs are shown before any session, `Pending` or creation lock is taken, never under one.
static DIALOG: Mutex<()> = Mutex::new(());

/// Tests only: how many dialogs had to wait for another.
#[cfg(test)]
static DIALOG_WAITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
fn dialog_waits() -> usize {
    DIALOG_WAITS.load(Ordering::SeqCst)
}

/// Takes [`DIALOG`], waiting for a dialog shown on another thread.
fn dialog_turn() -> std::sync::MutexGuard<'static, ()> {
    #[cfg(test)]
    match DIALOG.try_lock() {
        Ok(turn) => return turn,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => return poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            DIALOG_WAITS.fetch_add(1, Ordering::SeqCst);
        }
    }
    lock(&DIALOG)
}

/// Runs `show` (a dialog) and puts the process's working directory back as it was. rfd 0.17.2's folder dialog
/// replaces the default options (`SetOptions(FOS_PICKFOLDERS)` in `build_pick_folder`), dropping `FOS_NOCHANGEDIR`,
/// so Windows may move the working directory into the folder chosen and hold it open (a USB stick then cannot be
/// safely removed). Its single-file open and save dialogs keep the defaults; they are wrapped too, so no dialog
/// depends on that. Best effort: a directory that cannot be read first or set back stays as it is; nothing in the
/// shell uses relative paths.
///
/// One dialog at a time ([`DIALOG`]): the working directory is the whole process's, so a second dialog that saved it
/// while the first had moved it would put the first's folder back afterwards.
fn keeping_current_dir<T>(show: impl FnOnce() -> T) -> T {
    let _turn = dialog_turn();
    let before = std::env::current_dir();
    let answer = show();
    if let Ok(before) = before {
        let _ = std::env::set_current_dir(before);
    }
    answer
}

impl<R: Runtime> Dialogs for WinDialogs<R> {
    /// With `start`, the dialog opens in that folder (rfd 0.17.2's `set_directory`, which its Windows backend applies to
    /// the folder dialog with `SetFolder`, dropping a `\\?\` prefix).
    fn pick_folder(&self, title: &str, start: Option<&Path>) -> Option<PathBuf> {
        keeping_current_dir(|| {
            let dialog = self.dialog(title);
            match start {
                Some(start) => dialog.set_directory(start),
                None => dialog,
            }
            .pick_folder()
        })
    }

    fn pick_file(&self, title: &str, filter: Option<(&str, &[&str])>) -> Option<PathBuf> {
        keeping_current_dir(|| self.filtered(title, filter).pick_file())
    }

    /// Windows asks before replacing an existing file: rfd leaves the save dialog's default options, which include
    /// `FOS_OVERWRITEPROMPT`.
    fn save_file(
        &self,
        title: &str,
        suggested: &str,
        filter: Option<(&str, &[&str])>,
    ) -> Option<PathBuf> {
        keeping_current_dir(|| {
            self.filtered(title, filter)
                .set_file_name(suggested)
                .save_file()
        })
    }
}

/// Posted by [`SignalThread::keep_awake`]: wparam 1 asks Windows to stay awake, 0 lets it sleep again. The window
/// answers with the thread's previous execution state.
const KEEP_AWAKE: u32 = WM_APP + 1;

/// Sent by [`SignalThread::set_hotkey`]: the window registers the shortcut the owner last asked for
/// ([`Shared::hotkey`]) and answers 0, or the error code Windows gave.
const SET_HOTKEY: u32 = WM_APP + 3;

/// How long [`SignalThread::set_hotkey`] waits for the window's answer, in milliseconds (as `SendMessageTimeoutW`
/// takes it).
// Used by `set_hotkey`, which nothing calls until the save box registers the shortcut.
#[allow(dead_code)]
const HOTKEY_WAIT_MS: u32 = 1_000;

/// How long `Drop` waits for the window to take its close request, in milliseconds (as `SendMessageTimeoutW` takes
/// it), and then again for the window's thread to end.
const STOP_WAIT_MS: u32 = 1_000;
const STOP_WAIT: Duration = Duration::from_millis(STOP_WAIT_MS as u64);

/// Numbers each window's class name, so windows started side by side (tests) or one after another never share a
/// class that another one is still registering or unregistering.
static NEXT_CLASS: AtomicU32 = AtomicU32::new(0);

/// What the owner ([`SignalThread`]) and the window's thread share.
struct Shared {
    /// The window's handle while messages may go to it: 0 until the window is registered for its notices, and 0
    /// again from just before it is destroyed. The owner sends or posts to the window only while holding this lock
    /// and finding the handle here, and the window's thread clears it under the same lock before destroying the
    /// window. So nothing the owner sends can reach the handle once the window is gone, when it may already name
    /// another program's window.
    window: Mutex<usize>,
    /// Set by `Drop` alone, just before it sends `WM_CLOSE`. Until then the window ignores every `WM_CLOSE`, whoever
    /// sends it.
    close_asked: AtomicBool,
    /// Ends the message loop after the next message `GetMessageW` returns for. Set by the window when it takes the
    /// close request, and by `Drop` once its send has returned, whether the request ran or not (Windows cancels a
    /// send that times out). `Drop` never sets it before that send, so its own request cannot leave the window's
    /// thread out of the loop and waiting for the slot lock that `Drop` holds while it sends.
    stopping: AtomicBool,
    /// The save shortcut the owner last asked for ([`SignalThread::set_hotkey`]); the window reads it when it gets
    /// [`SET_HOTKEY`]. A leaf lock: nothing is called while it is held.
    hotkey: Mutex<Option<Shortcut>>,
}

/// What the window procedure needs: where signals go, and what the window shares with its owner.
struct Context {
    sink: Sender<OsSignal>,
    shared: Arc<Shared>,
}

thread_local! {
    /// Set once, at the start of the window's thread, the only thread the window procedure runs on.
    static CONTEXT: OnceCell<Context> = const { OnceCell::new() };
    /// Whether the window is registered for session notices, undone just before it is destroyed.
    static SESSION_NOTICE: Cell<bool> = const { Cell::new(false) };
    /// The window's suspend-and-resume registration (0: none), undone just before it is destroyed.
    static POWER_NOTICE: Cell<HPOWERNOTIFY> = const { Cell::new(0) };
    /// The save shortcut as registered with Windows, if it is; undone just before the window is destroyed.
    static HOTKEY: Cell<Option<Registered>> = const { Cell::new(None) };
}

/// The thread that owns Lockbox's hidden signal window ([`spawn`]). Only dropping it closes the window or undoes its
/// notices; no message from another program can. The signals stop then, so the app keeps it for as long as it runs.
pub struct SignalThread {
    shared: Arc<Shared>,
    /// Disconnects once the window's thread has done its last step (unregistering the class). In a `Mutex` only so
    /// that this struct is `Sync`.
    ended: Mutex<Receiver<io::Result<()>>>,
    /// `None` only inside `drop`.
    thread: Option<JoinHandle<()>>,
}

/// Starts a thread with a hidden window that sends each lock signal Windows gives it ([`classify`]) to `sink`, and
/// returns once the window exists and is registered for session and suspend notices, or with the error that stopped
/// it. When the thread ends, its sender is dropped, so a listener sees the signals end.
///
/// The window is top-level (`WS_OVERLAPPED`) and never shown, not message-only: Windows sends broadcasts such as
/// `WM_POWERBROADCAST` and the volume notices of `WM_DEVICECHANGE` to top-level windows only. Its session
/// registration brings `WM_WTSSESSION_CHANGE`, and its suspend-and-resume registration asks for the suspend notice
/// on PCs with Modern Standby as well. Only [`SignalThread`]'s `Drop` closes it: a `WM_CLOSE`, `WM_QUIT` or
/// `WM_DESTROY` from anywhere else changes nothing.
pub fn spawn(sink: Sender<OsSignal>) -> io::Result<SignalThread> {
    let number = NEXT_CLASS.fetch_add(1, Ordering::Relaxed);
    let class: Vec<u16> = format!("Lockbox signal window {number}")
        .encode_utf16()
        .chain([0])
        .collect();
    let shared = Arc::new(Shared {
        window: Mutex::new(0),
        close_asked: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
        hotkey: Mutex::new(None),
    });
    let context = Context {
        sink,
        shared: Arc::clone(&shared),
    };
    let (ready, started) = mpsc::channel();
    #[cfg(test)]
    let hook = take_test_hook(&class);
    let thread = thread::Builder::new()
        .name("lockbox-signals".into())
        .spawn(move || {
            #[cfg(test)]
            TEST_HOOK.set(hook);
            window_thread(&class, context, ready);
        })?;
    match started.recv() {
        Ok(Ok(())) => Ok(SignalThread {
            shared,
            ended: Mutex::new(started),
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            let _ = thread.join();
            Err(io::Error::other(
                "the signal window's thread ended before its window was ready",
            ))
        }
    }
}

impl SignalThread {
    /// Asks Windows to keep the PC awake (`true`: `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) until called with `false`
    /// (`ES_CONTINUOUS` alone) or until the window closes, which withdraws the request. The request
    /// belongs to the thread that makes it, so it is posted to the window and made on the window's own thread. If the
    /// post fails (the window's queue is full), the request is not changed.
    pub fn keep_awake(&self, on: bool) {
        let window = lock(&self.shared.window);
        if *window != 0 {
            // SAFETY: the message carries no pointers. The handle is live: the window's thread clears the slot,
            // under the lock held here, before it destroys the window.
            unsafe { PostMessageW(*window as HWND, KEEP_AWAKE, usize::from(on), 0) };
        }
    }
}

impl SignalThread {
    /// Registers `shortcut` as the save shortcut system-wide (`None`: releases it), replacing the one registered
    /// before. `RegisterHotKey` ties the shortcut to the thread that calls it, and the press comes back to that
    /// thread's window, so the request is sent to the window and made on its own thread, and the answer comes back
    /// here. A shortcut Windows refuses leaves the one registered before working. [`HotkeyTaken::Taken`] only when
    /// Windows says the keys are registered already; any other refusal, and a window that does not answer in time, is
    /// [`HotkeyTaken::NotSet`].
    // Nothing registers the shortcut yet: the save box's task must, and until then only the tests call this.
    #[allow(dead_code)]
    pub fn set_hotkey(&self, shortcut: Option<Shortcut>) -> Result<(), HotkeyTaken> {
        // Held across the send, as `Drop` does: the window's thread clears the handle under this lock before it
        // destroys the window, and it takes no lock while it handles the request. It also makes two changes take turns.
        let window = lock(&self.shared.window);
        if *window == 0 {
            return Err(HotkeyTaken::NotSet);
        }
        // The message carries nothing: the window reads the request from here, so a message from another program can
        // only ask again for what was asked last.
        let before = std::mem::replace(&mut *lock(&self.shared.hotkey), shortcut);
        let mut answer = 0;
        // SAFETY: the message carries no pointers, and `answer` is writable. The handle is live for the whole call:
        // the window's thread clears the slot, under the lock held here, before it destroys the window.
        let sent = unsafe {
            SendMessageTimeoutW(
                *window as HWND,
                SET_HOTKEY,
                0,
                0,
                SMTO_BLOCK | SMTO_ABORTIFHUNG,
                HOTKEY_WAIT_MS,
                &mut answer,
            )
        } != 0;
        if !sent {
            // The window did not take the request in time: what it would find if it took it later is what it had.
            *lock(&self.shared.hotkey) = before;
            return Err(HotkeyTaken::NotSet);
        }
        hotkey_answer(answer)
    }
}

/// What the window answered to [`SET_HOTKEY`]: 0 for done, else the Win32 error code `RegisterHotKey` gave.
// Used by `set_hotkey`, which nothing calls until the save box registers the shortcut.
#[allow(dead_code)]
fn hotkey_answer(answer: usize) -> Result<(), HotkeyTaken> {
    match u32::try_from(answer) {
        Ok(0) => Ok(()),
        Ok(ERROR_HOTKEY_ALREADY_REGISTERED) => Err(HotkeyTaken::Taken),
        _ => Err(HotkeyTaken::NotSet),
    }
}

/// What the save shortcut is registered as on the window's thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Registered {
    id: i32,
    shortcut: Shortcut,
}

/// The `RegisterHotKey` modifiers for `shortcut`. `MOD_NOREPEAT`: holding the keys down presses once, not many times.
fn hotkey_modifiers(shortcut: Shortcut) -> u32 {
    [
        (shortcut.ctrl, MOD_CONTROL),
        (shortcut.shift, MOD_SHIFT),
        (shortcut.alt, MOD_ALT),
    ]
    .into_iter()
    .filter(|(held, _)| *held)
    .fold(MOD_NOREPEAT, |all, (_, modifier)| all | modifier)
}

/// `WM_HOTKEY`: whether `id` is the ID the save shortcut is registered under right now. Anything else, from another
/// program or from a shortcut released a moment ago, is not a press.
fn is_registered_hotkey(id: WPARAM) -> bool {
    HOTKEY
        .try_with(|registered| registered.get())
        .ok()
        .flatten()
        .is_some_and(|registered| i32::try_from(id) == Ok(registered.id))
}

/// [`SET_HOTKEY`], on the window's thread: makes the shortcut asked for the registered one. The new keys are
/// registered under the ID the old ones do not use, and only then are the old ones released, so a refusal leaves the
/// old shortcut as it was. Returns 0, or the error code Windows gave.
fn apply_hotkey(window: HWND) -> LRESULT {
    let wanted = CONTEXT
        .try_with(|context| {
            context
                .get()
                .and_then(|context| *lock(&context.shared.hotkey))
        })
        .ok()
        .flatten();
    let current = HOTKEY.get();
    if current.map(|registered| registered.shortcut) == wanted {
        return 0;
    }
    let new = match wanted {
        None => None,
        Some(shortcut) => {
            let Some(id) = HOTKEY_IDS
                .into_iter()
                .find(|id| Some(*id) != current.map(|registered| registered.id))
            else {
                return 1;
            };
            // SAFETY: `window` is this thread's live window; the ID, modifiers and key are plain numbers.
            let registered = unsafe {
                RegisterHotKey(
                    window,
                    id,
                    hotkey_modifiers(shortcut),
                    u32::from(shortcut.key),
                )
            } != 0;
            if !registered {
                // Read at once, before anything else can change it. A failure with no code is still a failure.
                // SAFETY: reads this thread's last error.
                let code = unsafe { GetLastError() };
                return code.max(1) as LRESULT;
            }
            Some(Registered { id, shortcut })
        }
    };
    if let Some(old) = current {
        // SAFETY: `old` is this thread's registration for this window, released once (replaced below).
        unsafe { UnregisterHotKey(window, old.id) };
    }
    HOTKEY.set(new);
    0
}

impl Drop for SignalThread {
    /// Asks the window to close, then waits for its thread to end, at most [`STOP_WAIT`] for each. The request is a
    /// sent `WM_CLOSE`, which the posted-message limit (10,000 per queue) cannot hold up. Whether or not it ran (a
    /// send that times out is cancelled), `stopping` is set afterwards, so the loop ends at its next message. Once
    /// the thread has ended, the window, its notices, its keep-awake request and its class are all gone, and the
    /// thread is joined. A thread that does not end in time is let go rather than waited for forever.
    fn drop(&mut self) {
        self.shared.close_asked.store(true, Ordering::SeqCst);
        let window = lock(&self.shared.window);
        if *window != 0 {
            let handle = *window as HWND;
            let mut answer = 0;
            // SAFETY: the message carries no pointers, and `answer` is writable. The handle is live for the whole
            // call: the window's thread clears the slot, under the lock held here, before it destroys the window.
            // Holding the lock cannot deadlock: `stopping` is still clear, so the loop goes on handling messages, and
            // the window takes the request without the lock. In the one case where its thread already waits for the
            // lock (another program's WM_CLOSE reached it after `close_asked` was set), this call times out after
            // STOP_WAIT, and the thread goes on once the lock is released below.
            let taken = unsafe {
                SendMessageTimeoutW(
                    handle,
                    WM_CLOSE,
                    0,
                    0,
                    SMTO_BLOCK | SMTO_ABORTIFHUNG,
                    STOP_WAIT_MS,
                    &mut answer,
                )
            } != 0;
            self.shared.stopping.store(true, Ordering::SeqCst);
            if !taken {
                // The loop checks `stopping` each time GetMessageW returns, which it does for posted messages only
                // (it handles sent ones inside the call). If this post fails, the queue is full, and the messages
                // already in it wake the loop instead.
                // SAFETY: the message carries no pointers; the handle is live as above, the lock still held.
                unsafe { PostMessageW(handle, WM_NULL, 0, 0) };
            }
        }
        drop(window);
        let ended = matches!(
            lock(&self.ended).recv_timeout(STOP_WAIT),
            Err(RecvTimeoutError::Disconnected)
        );
        if ended && let Some(thread) = self.thread.take() {
            // The thread has done its last step; joining only waits for it to exit.
            let _ = thread.join();
        }
    }
}

/// The window's thread: registers its class, opens the window, reports back to [`spawn`], handles messages until
/// its owner closes it, destroys it, and unregisters the class. `ready` is dropped only after that last step, which
/// is how the owner's `Drop` sees the thread end.
fn window_thread(class: &[u16], context: Context, ready: Sender<io::Result<()>>) {
    let shared = Arc::clone(&context.shared);
    // A new thread's cell is always empty, so this always stores the context.
    CONTEXT.with(|cell| {
        let _ = cell.set(context);
    });
    // SAFETY: a null name asks for the handle of the program's own file, whose code holds `window_procedure`; it
    // stays loaded for the life of the process.
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let window_class = WNDCLASSW {
        lpfnWndProc: Some(window_procedure),
        hInstance: instance,
        lpszClassName: class.as_ptr(),
        ..Default::default()
    };
    // SAFETY: `window_class` is fully initialised (zero, which Windows reads as "none", for every part not set), its
    // procedure is `window_procedure`, and its name is a NUL-terminated UTF-16 string, which Windows copies.
    if unsafe { RegisterClassW(&window_class) } == 0 {
        let _ = ready.send(Err(io::Error::last_os_error()));
        return;
    }
    match open_window(class, instance) {
        Ok(window) => {
            *lock(&shared.window) = window as usize;
            let _ = ready.send(Ok(()));
            run_messages(&shared);
            // From here on the owner finds no handle, so nothing more can be sent or posted to the window.
            *lock(&shared.window) = 0;
            destroy_window(window);
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
    // SAFETY: `class` is the NUL-terminated name registered above with `instance`, and its one window has been
    // destroyed (just above, or by `open_window` before it failed).
    unsafe { UnregisterClassW(class.as_ptr(), instance) };
}

/// Creates the hidden window and registers it for session and suspend notices. On failure the window is destroyed
/// again, and the error is the one Windows gave.
fn open_window(class: &[u16], instance: HINSTANCE) -> io::Result<HWND> {
    // SAFETY: `class` is the NUL-terminated name of a class registered with `instance` on this process; a null title,
    // parent, menu and creation data are all allowed. Without `WS_VISIBLE`, and with nothing calling `ShowWindow`,
    // the window is never shown.
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            ptr::null(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        )
    };
    if window.is_null() {
        return Err(io::Error::last_os_error());
    }
    #[cfg(test)]
    TEST_HOOK.with_borrow(|hook| {
        if let Some(hook) = hook {
            hook.seen.window.store(window as usize, Ordering::SeqCst);
        }
    });
    match register_session(window).and_then(|()| register_suspend(window)) {
        Ok(notice) => {
            POWER_NOTICE.set(notice);
            Ok(window)
        }
        Err(error) => {
            // No owner holds the handle yet.
            destroy_window(window);
            Err(error)
        }
    }
}

/// Registers the window for session notices (`WM_WTSSESSION_CHANGE`).
fn register_session(window: HWND) -> io::Result<()> {
    #[cfg(test)]
    if test_refuses(Registration::Session) {
        return Err(io::Error::other("test: session notices refused"));
    }
    // SAFETY: `window` is the live window just created on this thread.
    if unsafe { WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    SESSION_NOTICE.set(true);
    note(Note::SessionRegistered, true);
    Ok(())
}

/// Registers the window for suspend and resume notices, and returns the registration.
fn register_suspend(window: HWND) -> io::Result<HPOWERNOTIFY> {
    #[cfg(test)]
    if test_refuses(Registration::Suspend) {
        return Err(io::Error::other("test: suspend notices refused"));
    }
    // SAFETY: `window` is the live window just created on this thread; `DEVICE_NOTIFY_WINDOW_HANDLE` says the
    // recipient is a window handle.
    match unsafe { RegisterSuspendResumeNotification(window, DEVICE_NOTIFY_WINDOW_HANDLE) } {
        0 => Err(io::Error::last_os_error()),
        notice => {
            note(Note::SuspendRegistered, true);
            Ok(notice)
        }
    }
}

/// The message loop. It ends once `stopping` is set, which happens only after `Drop` has asked to close (the window
/// sets it on taking the request, `Drop` after its send). It checks after every message, never waiting for a
/// `WM_QUIT`: Windows makes one only when the posted queue is empty, which another program posting without pause
/// could put off forever. A `WM_QUIT` from anywhere (another program can post one to the window or to this thread)
/// only wakes it.
fn run_messages(shared: &Shared) {
    let mut message = MSG::default();
    while !shared.stopping.load(Ordering::SeqCst) {
        // SAFETY: `message` is a valid, writable MSG; a null window asks for every message of this thread.
        match unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } {
            // GetMessageW fails only for invalid arguments, which this loop never passes. If it ever did, the window
            // could hear nothing more: end, and the listener sees the signals end.
            -1 => return,
            0 => {}
            // SAFETY: `message` was just filled in by GetMessageW.
            _ => unsafe {
                DispatchMessageW(&message);
            },
        }
    }
}

/// The hidden window's procedure: sends each lock signal to the sink, then lets Windows handle the message as usual.
/// It never blocks: sending on an mpsc channel does not wait. It never panics either (a panic cannot leave a
/// procedure called by Windows): every thread-local it touches is reached with `try_with`, and a sink that is closed
/// is skipped.
///
/// # Safety
///
/// Called by Windows only, on the window's thread, with a message for this window and that message's arguments.
unsafe extern "system" fn window_procedure(
    window: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        KEEP_AWAKE => return set_keep_awake(wparam != 0),
        SET_HOTKEY => return apply_hotkey(window),
        // A press only under the ID the shortcut is registered with now; another program can post any message here.
        WM_HOTKEY if !is_registered_hotkey(wparam) => return 0,
        WM_CLOSE => {
            take_close_request();
            return 0;
        }
        // Sent by `DestroyWindow`, after `destroy_window` has already undone the notices and the keep-awake
        // request; another program's WM_DESTROY destroys nothing, so it must change nothing either.
        WM_DESTROY => return 0,
        #[cfg(test)]
        TEST_BLOCK => {
            wait_at_test_gate();
            return 0;
        }
        _ => {}
    }
    let header = if wants_device_header(msg, wparam) {
        // SAFETY: for a device that went away, Windows passes the event's DEV_BROADCAST_HDR in `lparam` (or 0),
        // readable for the length the header gives, until this procedure returns.
        unsafe { read_device_header(lparam) }
    } else {
        None
    };
    if let Some(signal) = classify(msg, wparam, header) {
        let _ = CONTEXT.try_with(|context| {
            if let Some(context) = context.get() {
                // A listener that has gone away no longer needs the signal.
                let _ = context.sink.send(signal);
            }
        });
    }
    // SAFETY: the arguments are the ones Windows gave this procedure.
    unsafe { DefWindowProcW(window, msg, wparam, lparam) }
}

/// `WM_CLOSE`: taken only once the owner's `Drop` has asked (`close_asked`), so no other program can end the signals;
/// any other is ignored. Taking it sets `stopping`, so the loop ends after its next message, and the window is
/// destroyed after the loop, once its handle is out of the owner's reach.
fn take_close_request() {
    let taken = CONTEXT
        .try_with(|context| {
            let Some(context) = context.get() else {
                return false;
            };
            let asked = context.shared.close_asked.load(Ordering::SeqCst);
            if asked {
                context.shared.stopping.store(true, Ordering::SeqCst);
            }
            asked
        })
        .unwrap_or(false);
    if taken {
        // GetMessageW does not return for this sent WM_CLOSE: wake it. The quit comes once the posted queue is empty,
        // and any posted message wakes the loop sooner.
        // SAFETY: takes no pointers; it sets this thread's quit flag rather than queueing a message, so the
        // posted-message limit cannot hold it up.
        unsafe { PostQuitMessage(0) };
    }
}

/// Asks Windows to keep the PC awake while this thread's request stands (`on`), or withdraws the request. Runs on
/// the window's thread, where the request lives. Returns the thread's previous state (0 if Windows refused).
fn set_keep_awake(on: bool) -> LRESULT {
    let state = if on {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    // SAFETY: takes only flags.
    let previous = unsafe { SetThreadExecutionState(state) };
    previous as LRESULT
}

/// Destroys this thread's window, after undoing its notices and its keep-awake request. Only the window's own thread
/// can destroy it, and only here, so this is also the only place its notices are undone.
fn destroy_window(window: HWND) {
    stop_notices(window);
    note(Note::KeepAwakeWithdrawn, set_keep_awake(false) != 0);
    #[cfg(test)]
    check_nothing_left(window);
    // SAFETY: `window` is this thread's live window, and no owner can reach its handle: the slot was cleared under
    // its lock first, or (in `open_window`) never set.
    unsafe { DestroyWindow(window) };
}

/// Undoes whichever of the window's session, suspend and shortcut registrations were made.
fn stop_notices(window: HWND) {
    if let Some(registered) = HOTKEY.replace(None) {
        // SAFETY: `registered` is this thread's registration for this window, undone once (it was replaced by `None`).
        unsafe { UnregisterHotKey(window, registered.id) };
    }
    if SESSION_NOTICE.replace(false) {
        // SAFETY: `window` is the live window that registered, on its own thread.
        let undone = unsafe { WTSUnRegisterSessionNotification(window) } != 0;
        note(Note::SessionUnregistered, undone);
    }
    let notice = POWER_NOTICE.replace(0);
    if notice != 0 {
        // SAFETY: `notice` is this thread's registration for this window, undone once (it was replaced by 0).
        let undone = unsafe { UnregisterSuspendResumeNotification(notice) } != 0;
        note(Note::SuspendUnregistered, undone);
    }
}

/// What a real Windows call did, as [`note`] records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Note {
    SessionRegistered,
    SuspendRegistered,
    SessionUnregistered,
    SuspendUnregistered,
    KeepAwakeWithdrawn,
    /// Test-only check after the clean-up: the window was still registered for session notices.
    #[cfg(test)]
    SessionLeft,
    /// Test-only check after the clean-up: the thread still asked Windows to keep the PC awake.
    #[cfg(test)]
    KeepAwakeLeft,
}

/// Test-only: checks with Windows itself that the clean-up left nothing, and notes what it left. A second
/// unregistration succeeds only if the window was still registered (tried before the window goes, on its own handle,
/// so no other test's window is touched). And right after a real withdrawal, the thread's previous state is exactly
/// `ES_CONTINUOUS`.
#[cfg(test)]
fn check_nothing_left(window: HWND) {
    // SAFETY: `window` is this thread's live window; for a window that is not registered, the call only fails.
    let session_left = unsafe { WTSUnRegisterSessionNotification(window) } != 0;
    note(Note::SessionLeft, session_left);
    // SAFETY: takes only flags; it sets the state the withdrawal should already have set.
    let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    note(Note::KeepAwakeLeft, previous != ES_CONTINUOUS);
}

/// Records that a real Windows call succeeded (`ok`), for the tests; outside tests it does nothing.
#[cfg(not(test))]
fn note(_what: Note, _ok: bool) {}

/// Test-only: records a real Windows call that succeeded (`ok`) in this window's hook, in order.
#[cfg(test)]
fn note(what: Note, ok: bool) {
    if !ok {
        return;
    }
    let _ = TEST_HOOK.try_with(|hook| {
        if let Ok(hook) = hook.try_borrow()
            && let Some(hook) = hook.as_ref()
        {
            lock(&hook.seen.notes).push(what);
        }
    });
}

/// Copies the device kind, and for a volume its drive mask, out of a `WM_DEVICECHANGE` event's `lparam`. Returns
/// `None` for a null pointer, for a header that claims fewer bytes than a whole header, or for a volume header too
/// short to hold the mask.
///
/// # Safety
///
/// `lparam` is 0, or points to a device event whose length field (`dbch_size`, its first 4 bytes) and first
/// `dbch_size` bytes are readable during this call.
unsafe fn read_device_header(lparam: LPARAM) -> Option<DeviceHeader> {
    if lparam == 0 {
        return None;
    }
    // SAFETY: the caller's promise covers the length field; `read_unaligned` needs no alignment.
    let size = unsafe { (lparam as *const u32).read_unaligned() } as usize;
    if size < size_of::<DEV_BROADCAST_HDR>() {
        return None;
    }
    // SAFETY: the event says it is at least a whole header long; `read_unaligned` needs no alignment.
    let DEV_BROADCAST_HDR {
        dbch_devicetype, ..
    } = unsafe { (lparam as *const DEV_BROADCAST_HDR).read_unaligned() };
    if dbch_devicetype != DBT_DEVTYP_VOLUME {
        return Some(DeviceHeader {
            kind: dbch_devicetype,
            unitmask: 0,
        });
    }
    // Read only as far as the mask: Windows may not count the struct's trailing padding in `dbch_size`.
    let mask_end = offset_of!(DEV_BROADCAST_VOLUME, dbcv_unitmask) + size_of::<u32>();
    if size < mask_end {
        return None;
    }
    let volume = lparam as *const DEV_BROADCAST_VOLUME;
    // SAFETY: the header says this is a volume event at least `mask_end` bytes long, so the mask lies inside the
    // readable bytes (DEV_BROADCAST_VOLUME begins with the same header fields); `read_unaligned` needs no alignment.
    let unitmask = unsafe { (&raw const (*volume).dbcv_unitmask).read_unaligned() };
    Some(DeviceHeader {
        kind: dbch_devicetype,
        unitmask,
    })
}

/// Test-only: a registration that one `spawn` refuses, as if Windows had.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Registration {
    Session,
    Suspend,
}

/// Test-only: what one `spawn` used and made, for the test to check afterwards.
#[cfg(test)]
#[derive(Default)]
struct Seen {
    /// The window class's NUL-terminated name.
    class: Mutex<Vec<u16>>,
    /// The window's handle once it was created (0 before).
    window: AtomicUsize,
    /// The real registrations, unregistrations and keep-awake withdrawal that succeeded, in order ([`note`]).
    notes: Mutex<Vec<Note>>,
}

/// Test-only changes to one `spawn` made on the test's own thread, so tests running side by side never meet each
/// other's.
#[cfg(test)]
#[derive(Default)]
struct TestHook {
    refuse: Option<Registration>,
    /// Where [`TEST_BLOCK`] holds the window's thread until the test sends `()` (or 5 s pass).
    gate: Option<Receiver<()>>,
    /// Told when the window's thread reaches the gate.
    at_gate: Option<Sender<()>>,
    seen: Arc<Seen>,
}

/// Test-only: the window's thread waits at its hook's gate.
#[cfg(test)]
const TEST_BLOCK: u32 = WM_APP + 2;

#[cfg(test)]
thread_local! {
    /// Test-only. On a test's thread: the hook its next `spawn` takes. On a window's thread: that window's hook.
    static TEST_HOOK: RefCell<Option<TestHook>> = const { RefCell::new(None) };
}

/// Test-only: takes the calling thread's hook for this `spawn`, and records the class name in it.
#[cfg(test)]
fn take_test_hook(class: &[u16]) -> Option<TestHook> {
    let hook = TEST_HOOK.take();
    if let Some(hook) = &hook {
        *lock(&hook.seen.class) = class.to_vec();
    }
    hook
}

/// Test-only: whether this window's hook refuses `registration`.
#[cfg(test)]
fn test_refuses(registration: Registration) -> bool {
    TEST_HOOK.with_borrow(|hook| {
        hook.as_ref()
            .is_some_and(|hook| hook.refuse == Some(registration))
    })
}

/// Test-only: waits at the hook's gate. It runs inside the window procedure, so it never panics.
/// `IsReparseTagNameSurrogate`: the reparse tag's bit for "this names another file or folder".
const NAME_SURROGATE: u32 = 0x2000_0000;

/// Whether a file or folder with these attributes and reparse tag leads somewhere else: a name-surrogate reparse point
/// (a symbolic link, a junction or a mount point). Other reparse points (cloud files such as OneDrive's
/// Files-On-Demand, deduplication) keep the item where it is, so they do not.
pub fn redirects(attributes: u32, reparse_tag: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && reparse_tag & NAME_SURROGATE != 0
}

/// Whether `path` itself (never what it leads to) leads somewhere else ([`redirects`]): its attributes and reparse tag
/// read from a handle opened on `path` itself (`FILE_FLAG_OPEN_REPARSE_POINT`; `FILE_FLAG_BACKUP_SEMANTICS` so a
/// folder opens), asking only to read attributes and sharing everything.
pub fn is_redirect(path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;

    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut info = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    // SAFETY: the handle stays open for as long as `file` lives, past this call; `info` is a writable
    // `FILE_ATTRIBUTE_TAG_INFO`, the class asked for, and the size passed is its own.
    let done = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(redirects(info.FileAttributes, info.ReparseTag))
}

#[cfg(test)]
fn wait_at_test_gate() {
    let _ = TEST_HOOK.try_with(|hook| {
        if let Ok(hook) = hook.try_borrow()
            && let Some(hook) = hook.as_ref()
            && let Some(gate) = hook.gate.as_ref()
        {
            if let Some(at_gate) = hook.at_gate.as_ref() {
                let _ = at_gate.send(());
            }
            let _ = gate.recv_timeout(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DBT_DEVICEREMOVECOMPLETE, DBT_DEVTYP_PORT, DBT_DEVTYP_VOLUME, DEV_BROADCAST_HDR,
        DEV_BROADCAST_VOLUME, GA_PARENT, GetAncestor, GetClassInfoW, GetDesktopWindow,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, PBT_APMSUSPEND, PostMessageW,
        PostThreadMessageW, SendMessageW, WM_CLOSE, WM_DESTROY, WM_DEVICECHANGE, WM_HOTKEY,
        WM_NULL, WM_POWERBROADCAST, WM_QUIT, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
    };

    use super::*;

    /// The deadline for every wait in these tests: a slow or stuck window fails a test instead of hanging it.
    const WAIT: Duration = Duration::from_secs(1);

    /// The hidden attribute is added to a file or a folder and nothing else changes (the read-only attribute and the
    /// content stay); a path that is not there is an error.
    #[test]
    fn set_hidden_adds_only_the_hidden_attribute() {
        use std::os::windows::fs::MetadataExt;

        use lockbox_core::internals::fsio::testutil::TempDir;
        let temp = TempDir::new();
        let file = temp.path().join("file.txt");
        std::fs::write(&file, b"content").unwrap();
        let mut permissions = std::fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&file, permissions).unwrap();
        let folder = temp.path().join("folder");
        std::fs::create_dir(&folder).unwrap();

        let before = std::fs::metadata(&file).unwrap().file_attributes();
        assert_eq!(before & FILE_ATTRIBUTE_HIDDEN, 0);
        set_hidden(&file).unwrap();
        set_hidden(&folder).unwrap();
        let after = std::fs::metadata(&file).unwrap().file_attributes();
        assert_eq!(after, before | FILE_ATTRIBUTE_HIDDEN);
        assert_ne!(
            std::fs::metadata(&folder).unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN,
            0
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"content");
        assert!(set_hidden(&temp.path().join("missing")).is_err());

        // The temp folder cannot remove a read-only file.
        let mut permissions = std::fs::metadata(&file).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(&file, permissions).unwrap();
    }

    /// What WebView2's completion handler is given becomes a fixed answer: only "no error and successful" is a PDF.
    /// The `HRESULT` it carries is kept, as a number.
    #[test]
    fn print_answer_is_a_pdf_only_when_webview2_says_so() {
        const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;
        assert_eq!(print_answer(Ok(()), true), Ok(()));
        assert_eq!(
            print_answer(Ok(()), false),
            Err(PrintFailed::NotWritten { code: 0 })
        );
        for successful in [true, false] {
            let refused = windows_core::Error::from(windows_core::HRESULT(ACCESS_DENIED));
            assert_eq!(
                print_answer(Err(refused), successful),
                Err(PrintFailed::NotWritten {
                    code: ACCESS_DENIED
                }),
                "successful: {successful}"
            );
        }
    }

    /// What WebView2's print completion is given becomes a fixed answer: only "no error and succeeded" is a job the
    /// printer took; "printer unavailable" and any other status are not, and an `HRESULT` is kept as a number.
    #[test]
    fn printer_job_answer_is_sent_only_when_webview2_says_so() {
        const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;
        let status = COREWEBVIEW2_PRINT_STATUS;
        assert_eq!(printer_job_answer(Ok(()), status(0)), Ok(()));
        for unsuccessful in [status(1), status(2), status(99)] {
            assert_eq!(
                printer_job_answer(Ok(()), unsuccessful),
                Err(PrintFailed::NotWritten { code: 0 })
            );
        }
        let refused = windows_core::Error::from(windows_core::HRESULT(ACCESS_DENIED));
        assert_eq!(
            printer_job_answer(Err(refused), status(0)),
            Err(PrintFailed::NotWritten {
                code: ACCESS_DENIED
            })
        );
    }

    /// The check before WebView2's call: a live token lets the job go on (its `done` is untouched); a cancelled one
    /// ends it with `Revoked` through that `done`, once, and says so, so the caller never reaches WebView2.
    #[test]
    fn a_cancelled_token_ends_the_job_before_webview2_is_called() {
        let answers = Arc::new(Mutex::new(Vec::new()));
        let job = |answers: &Arc<Mutex<Vec<Result<(), PrintFailed>>>>| {
            let answers = Arc::clone(answers);
            let done: PrintDone = Box::new(move |result| lock(&answers).push(result));
            Rc::new(Cell::new(Some(done)))
        };
        let cancel = CancelToken::new();
        let live = job(&answers);
        assert!(!revoked(&cancel, &live));
        assert!(lock(&answers).is_empty());
        assert!(live.take().is_some(), "still there for WebView2's handler");

        cancel.cancel();
        let stopped = job(&answers);
        assert!(revoked(&cancel, &stopped));
        assert_eq!(*lock(&answers), [Err(PrintFailed::Revoked)]);
        assert!(stopped.take().is_none(), "answered once");
    }

    /// A buffer as `EnumPrintersW` fills it: the structures first, the strings after them, all inside the bytes.
    /// `strings` gives each printer's (name, port, driver); `attributes` its attributes.
    fn printer_bytes(strings: &[(&str, &str, &str)], attributes: &[u32]) -> Vec<u64> {
        let size = size_of::<PRINTER_INFO_2W>();
        let mut text: Vec<u16> = Vec::new();
        let mut at = Vec::new();
        for (name, port, driver) in strings {
            let mut place = |value: &str| {
                let start = text.len();
                text.extend(value.encode_utf16());
                text.push(0);
                start
            };
            at.push((place(name), place(port), place(driver)));
        }
        let head = strings.len() * size;
        let total = (head + text.len() * 2).div_ceil(8);
        let mut buffer = vec![0u64; total];
        let base = buffer.as_mut_ptr().cast::<u8>();
        for (index, (name, port, driver)) in at.into_iter().enumerate() {
            let pointer = |start: usize| (base as usize + head + start * 2) as *mut u16;
            // SAFETY: the buffer is 8-aligned and `head` bytes long for the structures; `index` is in range.
            let info = unsafe { &mut *base.add(index * size).cast::<PRINTER_INFO_2W>() };
            info.pPrinterName = pointer(name);
            info.pPortName = pointer(port);
            info.pDriverName = pointer(driver);
            info.Attributes = attributes[index];
        }
        // SAFETY: the buffer is 8-aligned and has room for `text` after the structures.
        unsafe {
            ptr::copy_nonoverlapping(text.as_ptr().cast::<u8>(), base.add(head), text.len() * 2);
        }
        buffer
    }

    fn bytes_of(buffer: &[u64]) -> &[u8] {
        // SAFETY: a view of the buffer's own bytes.
        unsafe { slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len() * 8) }
    }

    /// The printers are read from the bytes `EnumPrintersW` fills, by the pointers in them, and nothing outside the
    /// bytes is ever read: a pointer out of range, or a string with no end, is a fixed error, not a read.
    #[test]
    fn printers_are_read_from_the_filled_buffer_and_only_from_it() {
        let buffer = printer_bytes(
            &[
                ("Office", "IP_10.0.0.8", "HP Universal"),
                ("Fax \u{e9}", "SHRFAX:", ""),
            ],
            &[0, 0x4000],
        );
        let read = printers_in(bytes_of(&buffer), 2).unwrap();
        assert_eq!(read[0].name, "Office");
        assert_eq!(read[0].port, "IP_10.0.0.8");
        assert_eq!(read[0].driver, "HP Universal");
        assert_eq!(read[1].name, "Fax \u{e9}");
        assert_eq!((read[1].driver.as_str(), read[1].attributes), ("", 0x4000));
        assert!(printers_in(bytes_of(&buffer), 0).unwrap().is_empty());

        // More structures than the bytes hold.
        assert_eq!(
            printers_in(bytes_of(&buffer), 1_000_000).err(),
            Some(PRINTERS_UNREADABLE)
        );
        // A name pointer into the structures' own area is fine (inside), one far outside is refused.
        let mut wild = printer_bytes(&[("Office", "P", "D")], &[0]);
        let info = wild.as_mut_ptr().cast::<PRINTER_INFO_2W>();
        // SAFETY: the buffer is 8-aligned and holds one structure.
        unsafe { (*info).pPrinterName = 8 as *mut u16 };
        assert_eq!(
            printers_in(bytes_of(&wild), 1).err(),
            Some(PRINTERS_UNREADABLE)
        );
        // A string whose terminator is missing before the bytes end.
        let mut endless = printer_bytes(&[("Office", "P", "D")], &[0]);
        let last = endless.len() - 1;
        endless[last] = u64::MAX;
        assert_eq!(
            printers_in(bytes_of(&endless), 1).err(),
            Some(PRINTERS_UNREADABLE)
        );
    }

    /// Windows' real list, on this machine: it can be read, and the default Lockbox offers is always one of the
    /// printers it offers. Needs the print spooler running, so it is run by hand: `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs the Windows print spooler"]
    fn this_pcs_printers_can_be_listed() {
        let installed = installed_printers().expect("Windows lists its printers");
        let offered = installed.offered();
        if let Some(default) = &offered.default {
            assert!(offered.printers.contains(default));
        }
        assert!(offered.printers.len() <= installed.printers.len());
    }

    /// Fix round 1 follow-up: only name-surrogate reparse points lead elsewhere. The tags are Windows' own
    /// (`winnt.h`). A cloud-file folder cannot be made here without a registered sync provider, so its tag is checked
    /// by value.
    #[test]
    fn only_name_surrogates_redirect() {
        const REPARSE: u32 = FILE_ATTRIBUTE_REPARSE_POINT;
        const DIRECTORY: u32 = 0x10;
        for (tag, name) in [
            (
                0xA000_0003,
                "IO_REPARSE_TAG_MOUNT_POINT (junction, mount point)",
            ),
            (0xA000_000C, "IO_REPARSE_TAG_SYMLINK"),
            (0xA000_001D, "IO_REPARSE_TAG_LX_SYMLINK"),
        ] {
            assert!(redirects(REPARSE | DIRECTORY, tag), "{name}");
        }
        for (tag, name) in [
            (0x9000_001A, "IO_REPARSE_TAG_CLOUD (OneDrive)"),
            (0x9000_601A, "IO_REPARSE_TAG_CLOUD_6"),
            (0x8000_0013, "IO_REPARSE_TAG_DEDUP"),
            (0x8000_0017, "IO_REPARSE_TAG_WOF"),
            (0x8000_001B, "IO_REPARSE_TAG_APPEXECLINK"),
        ] {
            assert!(!redirects(REPARSE | DIRECTORY, tag), "{name}");
        }
        // No reparse point at all: whatever the tag field holds, nothing redirects.
        assert!(!redirects(DIRECTORY, 0xA000_0003));
        assert!(!redirects(DIRECTORY, 0));
    }

    /// Fix round 1 follow-up: read from the disk, a junction leads elsewhere; a plain folder and a plain file do not.
    #[test]
    fn junction_is_a_redirect_on_disk() {
        use lockbox_core::internals::fsio::testutil::{TempDir, make_dir_link};
        let temp = TempDir::new();
        let (folder, file, link) = (
            temp.path().join("folder"),
            temp.path().join("file.txt"),
            temp.path().join("link"),
        );
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&file, b"x").unwrap();
        make_dir_link(&link, &folder);
        assert!(is_redirect(&link).unwrap());
        assert!(!is_redirect(&folder).unwrap());
        assert!(!is_redirect(&file).unwrap());
        assert_eq!(
            is_redirect(&temp.path().join("gone")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    /// Fix round 1 (F12): a dialog that moves the process's working directory (rfd's folder dialog drops
    /// `FOS_NOCHANGEDIR`) gets it moved back. Fix round 2 (G3): also when two dialogs overlap, the second starting
    /// while the first has moved it. The moves last only inside the calls, into this test's own folders; the only
    /// test that moves the working directory.
    #[test]
    fn dialogs_leave_the_working_directory_as_it_was() {
        use lockbox_core::internals::fsio::testutil::TempDir;
        use std::sync::atomic::AtomicBool;
        use std::time::Instant;

        let before = std::env::current_dir().unwrap();
        let (first_dir, second_dir) = (TempDir::new(), TempDir::new());
        let answer = keeping_current_dir(|| {
            std::env::set_current_dir(first_dir.path()).unwrap();
            7
        });
        let after_one = std::env::current_dir().unwrap();

        let (second_in, first_done) = (AtomicBool::new(false), AtomicBool::new(false));
        let give_up = Instant::now() + Duration::from_secs(60);
        thread::scope(|s| {
            let first = s.spawn(|| {
                keeping_current_dir(|| {
                    std::env::set_current_dir(first_dir.path()).unwrap();
                    let waits = dialog_waits();
                    let second = s.spawn(|| {
                        keeping_current_dir(|| {
                            second_in.store(true, Ordering::SeqCst);
                            std::env::set_current_dir(second_dir.path()).unwrap();
                            // Ends after the first has put the directory back.
                            while !first_done.load(Ordering::SeqCst) {
                                assert!(Instant::now() < give_up, "the first never ended");
                                thread::sleep(Duration::from_millis(1));
                            }
                        })
                    });
                    // Until the second dialog is shown, or waits for this one.
                    while !second_in.load(Ordering::SeqCst) && dialog_waits() == waits {
                        assert!(Instant::now() < give_up, "the second never started");
                        thread::sleep(Duration::from_millis(1));
                    }
                    second
                })
            });
            let second = first.join().unwrap();
            first_done.store(true, Ordering::SeqCst);
            second.join().unwrap();
        });
        let after_two = std::env::current_dir().unwrap();
        // Put back here as well, so a failure does not leave the test program in a folder about to be deleted.
        std::env::set_current_dir(&before).unwrap();
        assert_eq!(answer, 7);
        assert_eq!(after_one, before);
        assert_eq!(after_two, before);
    }

    fn started() -> (SignalThread, Receiver<OsSignal>) {
        let (sink, signals) = mpsc::channel();
        (spawn(sink).expect("the signal window starts"), signals)
    }

    /// Installs a hook for the next `spawn` on this thread, and returns what it will record.
    fn hook(refuse: Option<Registration>) -> Arc<Seen> {
        let seen = Arc::new(Seen::default());
        TEST_HOOK.set(Some(TestHook {
            refuse,
            seen: Arc::clone(&seen),
            ..TestHook::default()
        }));
        seen
    }

    /// The window's gate ([`TEST_BLOCK`]): `open` lets its thread go on, `reached` says it is waiting there.
    struct Gate {
        open: Sender<()>,
        reached: Receiver<()>,
    }

    impl Gate {
        /// Posts [`TEST_BLOCK`] and waits until the window's thread is held at the gate.
        fn hold(&self, window: usize) {
            post(window, TEST_BLOCK, 0);
            self.reached
                .recv_timeout(WAIT)
                .expect("the window's thread reaches the gate");
        }
    }

    /// Like [`hook`], with a gate for the window's thread.
    fn gated() -> (Arc<Seen>, Gate) {
        let seen = Arc::new(Seen::default());
        let (open, gate) = mpsc::channel();
        let (at_gate, reached) = mpsc::channel();
        TEST_HOOK.set(Some(TestHook {
            refuse: None,
            gate: Some(gate),
            at_gate: Some(at_gate),
            seen: Arc::clone(&seen),
        }));
        (seen, Gate { open, reached })
    }

    fn notes(seen: &Seen) -> Vec<Note> {
        lock(&seen.notes).clone()
    }

    /// The notes of a window that registered both notices.
    const REGISTERED: [Note; 2] = [Note::SessionRegistered, Note::SuspendRegistered];
    /// The notes of a window that registered both notices and was then closed by `Drop`.
    const CLOSED: [Note; 5] = [
        Note::SessionRegistered,
        Note::SuspendRegistered,
        Note::SessionUnregistered,
        Note::SuspendUnregistered,
        Note::KeepAwakeWithdrawn,
    ];

    fn window_of(signal_thread: &SignalThread) -> usize {
        *lock(&signal_thread.shared.window)
    }

    fn class_of(seen: &Seen) -> Vec<u16> {
        lock(&seen.class).clone()
    }

    /// Sends a message from a helper thread and waits at most [`WAIT`] for the answer.
    fn send(window: usize, msg: u32, wparam: WPARAM) -> LRESULT {
        send_with(window, msg, wparam, None::<()>)
    }

    /// Like [`send`], with `lparam` pointing to `payload`. The payload moves to the helper thread, so it stays valid
    /// for as long as the call can run, even after a test gives up waiting.
    fn send_with<P: Send + 'static>(
        window: usize,
        msg: u32,
        wparam: WPARAM,
        payload: Option<P>,
    ) -> LRESULT {
        let (answered, answer) = mpsc::channel();
        thread::spawn(move || {
            let lparam = payload
                .as_ref()
                .map_or(0, |payload| (&raw const *payload) as LPARAM);
            // SAFETY: the test holds the signal thread while it waits for this answer, so the handle is live; only
            // after the test has given up and dropped it can the handle be stale (and then name another window).
            // `lparam` is 0 or points to `payload`, which this thread owns until the call has returned.
            let result = unsafe { SendMessageW(window as HWND, msg, wparam, lparam) };
            let _ = answered.send(result);
            drop(payload);
        });
        answer
            .recv_timeout(WAIT)
            .expect("the window answers within the deadline")
    }

    /// Posts to a window whose signal thread the caller holds.
    fn post(window: usize, msg: u32, wparam: WPARAM) {
        // SAFETY: the message carries no pointers, and the caller holds the signal thread, so the handle is live.
        let posted = unsafe { PostMessageW(window as HWND, msg, wparam, 0) };
        assert_ne!(posted, 0, "post message {msg:#x}");
    }

    /// Posts a suspend notice behind whatever is already queued and waits for it: posted messages are handled in
    /// order, so everything posted before it has been handled too.
    fn flush(window: usize, signals: &Receiver<OsSignal>) {
        post(window, WM_POWERBROADCAST, PBT_APMSUSPEND as usize);
        assert_eq!(signals.recv_timeout(WAIT), Ok(OsSignal::Suspending));
    }

    /// Drops on a helper thread and waits at most `deadline` for the drop to return.
    fn drop_within(signal_thread: SignalThread, deadline: Duration) {
        let (dropped, done) = mpsc::channel();
        thread::spawn(move || {
            drop(signal_thread);
            let _ = dropped.send(());
        });
        done.recv_timeout(deadline)
            .expect("drop returns within the deadline");
    }

    fn is_window(window: usize) -> bool {
        // SAFETY: a plain query; a stale handle is what it checks for.
        unsafe { IsWindow(window as HWND) != 0 }
    }

    fn class_exists(class: &[u16]) -> bool {
        let mut info = WNDCLASSW::default();
        // SAFETY: a null name asks for this program's own module, the one the class is registered with; `class` is
        // NUL-terminated and `info` is writable.
        unsafe { GetClassInfoW(GetModuleHandleW(ptr::null()), class.as_ptr(), &mut info) != 0 }
    }

    #[test]
    fn sent_messages_reach_the_sink() {
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize);
        assert_eq!(signals.try_recv(), Ok(OsSignal::SessionLocked));
        send(window, WM_POWERBROADCAST, PBT_APMSUSPEND as usize);
        assert_eq!(signals.try_recv(), Ok(OsSignal::Suspending));
    }

    #[test]
    fn drive_removal_is_read_from_the_message() {
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        let removed = DBT_DEVICEREMOVECOMPLETE as usize;
        let volume = DEV_BROADCAST_VOLUME {
            dbcv_size: size_of::<DEV_BROADCAST_VOLUME>() as u32,
            dbcv_devicetype: DBT_DEVTYP_VOLUME,
            dbcv_unitmask: 0b100,
            ..Default::default()
        };
        send_with(window, WM_DEVICECHANGE, removed, Some(volume));
        assert_eq!(
            signals.try_recv(),
            Ok(OsSignal::DriveRemoved { mask: 0b100 })
        );

        // A header claiming fewer bytes than a header, a volume header too short to hold the mask, another kind of
        // device, and no header at all: no signal.
        let header = |dbch_size: usize, dbch_devicetype| DEV_BROADCAST_HDR {
            dbch_size: dbch_size as u32,
            dbch_devicetype,
            dbch_reserved: 0,
        };
        let whole = size_of::<DEV_BROADCAST_HDR>();
        for payload in [
            header(4, DBT_DEVTYP_VOLUME),
            header(whole, DBT_DEVTYP_VOLUME),
            header(whole, DBT_DEVTYP_PORT),
        ] {
            send_with(window, WM_DEVICECHANGE, removed, Some(payload));
        }
        send(window, WM_DEVICECHANGE, removed);
        assert_eq!(signals.try_recv(), Err(TryRecvError::Empty));
    }

    /// The header's own length is read first: below a whole header, nothing more is read.
    #[test]
    fn device_header_needs_its_full_length() {
        let header = |dbch_size: usize| DEV_BROADCAST_HDR {
            dbch_size: dbch_size as u32,
            dbch_devicetype: DBT_DEVTYP_PORT,
            dbch_reserved: 0,
        };
        let short = header(4);
        let whole = header(size_of::<DEV_BROADCAST_HDR>());
        // SAFETY: each points to a whole DEV_BROADCAST_HDR on this stack, at least as many bytes as it claims.
        unsafe {
            assert_eq!(read_device_header((&raw const short) as LPARAM), None);
            assert_eq!(
                read_device_header((&raw const whole) as LPARAM),
                Some(DeviceHeader {
                    kind: DBT_DEVTYP_PORT,
                    unitmask: 0
                })
            );
        }
    }

    /// Broadcasts such as sleep and volume notices reach top-level windows only, not message-only ones.
    #[test]
    fn window_is_top_level_and_never_shown() {
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread) as HWND;
        // SAFETY: plain queries on a live window handle.
        unsafe {
            assert_eq!(IsWindowVisible(window), 0, "never shown");
            assert_eq!(
                GetAncestor(window, GA_PARENT),
                GetDesktopWindow(),
                "top-level"
            );
        }
    }

    /// `keep_awake` reaches the window's own thread, where the stay-awake request lives. The window answers its
    /// stay-awake message with the thread's previous state, which shows what the earlier posts set.
    #[test]
    fn keep_awake_runs_on_the_window_thread() {
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        let awake = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;

        signal_thread.keep_awake(true);
        flush(window, &signals);
        assert_eq!(send(window, KEEP_AWAKE, 0) as u32, awake);

        signal_thread.keep_awake(true);
        signal_thread.keep_awake(false);
        flush(window, &signals);
        assert_eq!(send(window, KEEP_AWAKE, 0) as u32, ES_CONTINUOUS);
    }

    #[test]
    fn two_windows_run_side_by_side() {
        let (first, first_signals) = started();
        let (second, second_signals) = started();
        send(
            window_of(&first),
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_LOCK as usize,
        );
        send(
            window_of(&second),
            WM_POWERBROADCAST,
            PBT_APMSUSPEND as usize,
        );
        assert_eq!(first_signals.try_recv(), Ok(OsSignal::SessionLocked));
        assert_eq!(second_signals.try_recv(), Ok(OsSignal::Suspending));
        assert_eq!(first_signals.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn drop_stops_the_thread() {
        let seen = hook(None);
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        let class = class_of(&seen);
        assert!(
            class_exists(&class),
            "class registered while the window runs"
        );

        drop_within(signal_thread, WAIT);
        assert!(!is_window(window), "window destroyed");
        assert!(!class_exists(&class), "class unregistered");
        // The thread's sender went with it: a listener sees the signals end.
        assert_eq!(
            signals.recv_timeout(WAIT),
            Err(RecvTimeoutError::Disconnected)
        );

        let (again, signals) = started();
        send(
            window_of(&again),
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_LOCK as usize,
        );
        assert_eq!(signals.try_recv(), Ok(OsSignal::SessionLocked));
    }

    /// The real calls succeed: both notices are registered when the window opens, and both are undone, with the
    /// keep-awake request, when `Drop` closes it.
    #[test]
    fn notices_are_registered_and_undone() {
        let seen = hook(None);
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        assert_eq!(notes(&seen), REGISTERED, "registered on creation");

        signal_thread.keep_awake(true);
        flush(window, &signals);
        drop_within(signal_thread, WAIT);
        assert_eq!(notes(&seen), CLOSED, "undone when Lockbox closes it");
    }

    /// Only Lockbox closes the window: another program's `WM_CLOSE` (posted or sent) and `WM_QUIT` (to the window or
    /// to its thread) change nothing.
    #[test]
    fn outside_close_and_quit_do_not_stop_the_signals() {
        let seen = hook(None);
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        // SAFETY: a plain query on a live window handle; no process ID is asked for.
        let window_thread = unsafe { GetWindowThreadProcessId(window as HWND, ptr::null_mut()) };

        post(window, WM_CLOSE, 0);
        send(window, WM_CLOSE, 0);
        post(window, WM_QUIT, 0);
        // SAFETY: the message carries no pointers.
        let posted = unsafe { PostThreadMessageW(window_thread, WM_QUIT, 0, 0) };
        assert_ne!(posted, 0, "post a quit to the window's thread");
        // Posted after the quits, so it is handled only if the loop went on past them.
        flush(window, &signals);

        assert!(is_window(window), "window still there");
        send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize);
        assert_eq!(signals.try_recv(), Ok(OsSignal::SessionLocked));
        assert_eq!(notes(&seen), REGISTERED, "notices still registered");

        let class = class_of(&seen);
        drop_within(signal_thread, WAIT);
        assert!(!is_window(window), "window destroyed by drop");
        assert!(!class_exists(&class), "class unregistered by drop");
    }

    /// Another program's `WM_DESTROY` (sent or posted) destroys nothing, so it must change nothing: the notices stay
    /// registered, the keep-awake request stays, and a lock still reaches the sink.
    #[test]
    fn outside_destroy_changes_nothing() {
        let seen = hook(None);
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        signal_thread.keep_awake(true);
        flush(window, &signals);

        send(window, WM_DESTROY, 0);
        post(window, WM_DESTROY, 0);
        flush(window, &signals);

        assert!(is_window(window), "window still there");
        assert_eq!(notes(&seen), REGISTERED, "notices still registered");
        send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize);
        assert_eq!(signals.try_recv(), Ok(OsSignal::SessionLocked));
        assert_eq!(
            send(window, KEEP_AWAKE, 1) as u32,
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
            "keep-awake request still there"
        );

        drop_within(signal_thread, WAIT);
        assert_eq!(notes(&seen), CLOSED, "undone once, when Lockbox closes it");
    }

    /// `Drop` does not need room in the window's posted-message queue (Windows allows 10,000 messages): with the
    /// queue full it still closes the window and waits for its thread, so the class is gone when it returns.
    #[test]
    fn drop_does_not_need_room_in_the_queue() {
        let (seen, gate) = gated();
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let class = class_of(&seen);

        // Hold the window's thread at the gate, then fill its queue until Windows refuses more.
        gate.hold(window);
        let mut posted = 0;
        // SAFETY: the message carries no pointers, and the test holds the signal thread, so the handle is live.
        while unsafe { PostMessageW(window as HWND, WM_NULL, 0, 0) } != 0 {
            posted += 1;
            assert!(posted < 100_000, "the queue never filled");
        }

        let (dropped, done) = mpsc::channel();
        thread::spawn(move || {
            drop(signal_thread);
            let _ = dropped.send(());
        });
        // Let the drop start while the queue is still full, then let the window's thread go on.
        thread::sleep(Duration::from_millis(200));
        let _ = gate.open.send(());
        done.recv_timeout(WAIT)
            .expect("drop returns within the deadline");
        assert!(!is_window(window), "window destroyed");
        assert!(
            !class_exists(&class),
            "class unregistered before drop returned"
        );
        assert_eq!(notes(&seen), CLOSED);
    }

    /// Windows cancels a `WM_CLOSE` whose send times out. Holding the window's thread past `Drop`'s timeout loses the
    /// close request, and the thread must still stop once it runs again.
    #[test]
    fn a_timed_out_close_still_stops_the_thread() {
        let (seen, gate) = gated();
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let class = class_of(&seen);
        gate.hold(window);

        let (dropped, done) = mpsc::channel();
        thread::spawn(move || {
            drop(signal_thread);
            let _ = dropped.send(());
        });
        // Past the send's timeout, but before `Drop` stops waiting for the thread.
        thread::sleep(STOP_WAIT + Duration::from_millis(500));
        let _ = gate.open.send(());
        done.recv_timeout(WAIT)
            .expect("drop returns within the deadline");
        assert!(!is_window(window), "window destroyed");
        assert!(!class_exists(&class), "class unregistered");
        assert_eq!(notes(&seen), CLOSED);
    }

    /// The loop must not wait for an empty queue to stop: another program posting to the window without pause keeps
    /// the queue from ever emptying.
    #[test]
    fn drop_stops_the_thread_under_steady_posting() {
        /// Stops the posters when the test ends, whether it passes or fails.
        struct StopPosting(Arc<AtomicBool>);
        impl Drop for StopPosting {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }

        let (seen, gate) = gated();
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let class = class_of(&seen);
        let posting = Arc::new(AtomicBool::new(true));
        let _stop = StopPosting(Arc::clone(&posting));
        // Fill the queue while the window's thread is held, and keep it full with more posters than it can keep up
        // with, so it never empties while the thread drains it.
        gate.hold(window);
        for _ in 0..4 {
            let posting = Arc::clone(&posting);
            thread::spawn(move || {
                while posting.load(Ordering::SeqCst) {
                    // SAFETY: `WM_NULL` carries no pointers and does nothing. Once the window is gone the handle may
                    // be stale, and then this posts that harmless message to another window, or fails.
                    unsafe { PostMessageW(window as HWND, WM_NULL, 0, 0) };
                }
            });
        }
        thread::sleep(Duration::from_millis(100));
        let _ = gate.open.send(());

        drop_within(signal_thread, WAIT);
        assert!(!is_window(window), "window destroyed");
        assert!(!class_exists(&class), "class unregistered");
        assert_eq!(notes(&seen), CLOSED);
    }

    /// A registration Windows refuses makes `spawn` fail, and leaves no window, no class and no registration behind.
    #[test]
    fn refused_registration_leaves_nothing_behind() {
        for (refused, left) in [
            // Nothing was registered; only the keep-awake request is withdrawn, as on every close.
            (Registration::Session, vec![Note::KeepAwakeWithdrawn]),
            // The session notices were registered for real, and are undone.
            (
                Registration::Suspend,
                vec![
                    Note::SessionRegistered,
                    Note::SessionUnregistered,
                    Note::KeepAwakeWithdrawn,
                ],
            ),
        ] {
            let seen = hook(Some(refused));
            let (sink, _signals) = mpsc::channel();
            assert!(spawn(sink).is_err(), "{refused:?} refused: spawn fails");
            let window = seen.window.load(Ordering::SeqCst);
            assert_ne!(window, 0, "{refused:?} refused: the window was made first");
            assert!(!is_window(window), "{refused:?} refused: window destroyed");
            assert!(
                !class_exists(&class_of(&seen)),
                "{refused:?} refused: class unregistered"
            );
            assert_eq!(notes(&seen), left, "{refused:?} refused");
        }
    }

    /// Release builds drop the receiver: the window goes on, with nobody listening.
    #[test]
    fn signals_without_a_listener_keep_the_window() {
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        drop(signals);
        send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize);
        assert!(is_window(window), "window still there");
        send(window, KEEP_AWAKE, 1);
        assert_eq!(
            send(window, KEEP_AWAKE, 0) as u32,
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
            "still answers"
        );
    }

    /// Ctrl+Alt+Shift with a function key beyond F12 (`n` 1 to 12 is F13 to F24): keys no program has a use for. Each
    /// test takes its own, so tests running side by side never meet.
    fn combo(n: u16) -> Shortcut {
        Shortcut {
            ctrl: true,
            shift: true,
            alt: true,
            key: 0x7B + n,
        }
    }

    /// The signal a press of the shortcut makes, as Windows sends it: `WM_HOTKEY` with the shortcut's ID.
    fn press(window: usize, id: i32) {
        send(window, WM_HOTKEY, id as usize);
    }

    /// Nothing is waiting in `signals`: a suspend notice posted now is the next thing it hears.
    fn assert_no_signal(window: usize, signals: &Receiver<OsSignal>) {
        flush(window, signals);
    }

    /// Windows' own answer to a second window asking for keys that are registered: seen live, two windows of this
    /// process, so "taken" is what Windows said and not what a stand-in said. (Windows also answers it for keys it
    /// keeps for itself, such as F12 alone, seen live while building this.)
    #[test]
    fn hotkey_taken_is_reported() {
        let (first, _first_signals) = started();
        let (second, _second_signals) = started();
        let shortcut = combo(1);
        assert_eq!(first.set_hotkey(Some(shortcut)), Ok(()));
        assert_eq!(second.set_hotkey(Some(shortcut)), Err(HotkeyTaken::Taken));
        // The same keys again from the window that holds them change nothing, and are not "taken".
        assert_eq!(first.set_hotkey(Some(shortcut)), Ok(()));
        // Released, they are free for the other window.
        assert_eq!(first.set_hotkey(None), Ok(()));
        assert_eq!(second.set_hotkey(Some(shortcut)), Ok(()));
    }

    /// The error codes, as Microsoft documents them (`winerror.h`): 1409 is `ERROR_HOTKEY_ALREADY_REGISTERED`, the
    /// only one that means taken; 87 is `ERROR_INVALID_PARAMETER`, 1400 `ERROR_INVALID_WINDOW_HANDLE`, and 1419
    /// `ERROR_HOTKEY_NOT_REGISTERED`.
    #[test]
    fn only_already_registered_means_taken() {
        assert_eq!(hotkey_answer(0), Ok(()));
        assert_eq!(hotkey_answer(1409), Err(HotkeyTaken::Taken));
        for other in [87, 1400, 1419, 5, 1] {
            assert_eq!(hotkey_answer(other), Err(HotkeyTaken::NotSet), "{other}");
        }
        // A code beyond a Win32 error's size is nothing Windows said about this.
        assert_eq!(hotkey_answer(usize::MAX), Err(HotkeyTaken::NotSet));
    }

    /// A press of the registered shortcut reaches the sink as `SaveShortcut`; the same message under an ID that is
    /// not registered, or with nothing registered, does not (another program can post any message to the window).
    #[test]
    fn registered_hotkey_message_reaches_the_sink() {
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        let [first, second] = HOTKEY_IDS;

        press(window, first);
        assert_no_signal(window, &signals);

        assert_eq!(signal_thread.set_hotkey(Some(combo(2))), Ok(()));
        press(window, second);
        assert_no_signal(window, &signals);
        press(window, first);
        assert_eq!(signals.try_recv(), Ok(OsSignal::SaveShortcut));
        assert_no_signal(window, &signals);

        // A change moves the shortcut to the other ID: the old ID is nothing now.
        assert_eq!(signal_thread.set_hotkey(Some(combo(3))), Ok(()));
        press(window, first);
        assert_no_signal(window, &signals);
        press(window, second);
        assert_eq!(signals.try_recv(), Ok(OsSignal::SaveShortcut));

        // Cleared: no ID is accepted.
        assert_eq!(signal_thread.set_hotkey(None), Ok(()));
        for id in HOTKEY_IDS {
            press(window, id);
        }
        assert_no_signal(window, &signals);
    }

    /// A change Windows refuses leaves the old shortcut working: still registered (a second window cannot take its
    /// keys), still heard. A change that goes through frees the old keys.
    #[test]
    fn a_refused_change_keeps_the_old_shortcut() {
        let (first, first_signals) = started();
        let (second, _second_signals) = started();
        let window = window_of(&first);
        let (old, new) = (combo(4), combo(5));
        assert_eq!(first.set_hotkey(Some(old)), Ok(()));
        assert_eq!(second.set_hotkey(Some(new)), Ok(()));

        assert_eq!(first.set_hotkey(Some(new)), Err(HotkeyTaken::Taken));
        assert_eq!(second.set_hotkey(Some(old)), Err(HotkeyTaken::Taken));
        press(window, HOTKEY_IDS[0]);
        assert_eq!(first_signals.try_recv(), Ok(OsSignal::SaveShortcut));
        assert_no_signal(window, &first_signals);

        assert_eq!(first.set_hotkey(Some(combo(6))), Ok(()));
        assert_eq!(second.set_hotkey(Some(old)), Ok(()));
    }

    /// A window that does not answer in time is not "taken", and the change it never made is not made later either.
    #[test]
    fn a_window_that_does_not_answer_is_not_reported_as_taken() {
        let (_seen, gate) = gated();
        let (signal_thread, signals) = started();
        let window = window_of(&signal_thread);
        let (other, _other_signals) = started();
        let shortcut = combo(8);
        gate.hold(window);
        assert_eq!(
            signal_thread.set_hotkey(Some(shortcut)),
            Err(HotkeyTaken::NotSet)
        );
        let _ = gate.open.send(());
        flush(window, &signals);
        // Nothing was registered by the late message: another window gets the keys.
        assert_eq!(other.set_hotkey(Some(shortcut)), Ok(()));
        press(window, HOTKEY_IDS[0]);
        assert_no_signal(window, &signals);
    }

    /// Closing the window releases the shortcut: another window can take its keys at once.
    #[test]
    fn hotkey_is_released_when_the_window_closes() {
        let (first, _first_signals) = started();
        let (second, _second_signals) = started();
        let shortcut = combo(7);
        assert_eq!(first.set_hotkey(Some(shortcut)), Ok(()));
        assert_eq!(second.set_hotkey(Some(shortcut)), Err(HotkeyTaken::Taken));
        drop_within(first, WAIT);
        assert_eq!(second.set_hotkey(Some(shortcut)), Ok(()));
    }

    use std::time::Instant;

    use crate::os::{CLIPBOARD_BUSY, ClipboardBackend, CopyTag, WriteFailed};

    /// The real-clipboard tests take turns: the clipboard is one per Windows session.
    static REAL_CLIPBOARD: Mutex<()> = Mutex::new(());

    /// What the real-clipboard tests copy: a made-up value, never a real secret.
    const SAMPLE: &str = "Lockbox clipboard test 7f3a";
    const TAG: CopyTag = [0x5a; 16];
    const NEWER_TAG: CopyTag = [0xa5; 16];

    fn real_clipboard() -> ClipboardSteps<WinClipboard> {
        ClipboardSteps::new(Arc::new(WinClipboard), Arc::new(SystemClock))
    }

    /// The clipboard's text, read in an opening of its own.
    fn clipboard_text() -> Option<String> {
        clipboard_win::get_clipboard_string().ok()
    }

    /// Fix round 1 (5), fix round 2 (5): a block Windows refuses is wiped through the pointer it was filled through,
    /// right before it is freed, for the text and for any other value. Touches no clipboard content: the writes are
    /// refused because this thread has not opened the clipboard.
    #[test]
    fn refused_block_is_wiped_before_it_is_freed() {
        let text = "Pw-\u{e9}\u{1F600}-7f3a";
        REFUSED.set(None);
        assert!(!WinClipboard.set_text(text), "written without an opening");
        let units = text.encode_utf16().count() + 1;
        assert_eq!(
            REFUSED.take(),
            Some(vec![0; units * 2]),
            "the text block was not wiped"
        );
        let format = clipboard_win::raw::register_format("Lockbox.CopyTag").unwrap();
        assert!(!WinClipboard.set_bytes(format, &TAG));
        assert_eq!(
            REFUSED.take(),
            Some(vec![0; 16]),
            "the tag block was not wiped"
        );
    }

    /// The text from a block of UTF-16 is the same text in UTF-8, in a string made exactly its size (so it never grew,
    /// and left no unwiped buffer behind); it ends at the first NUL; a half of a surrogate pair alone is U+FFFD.
    #[test]
    fn utf16_text_becomes_exactly_sized_utf8() {
        let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
        let mut with_nul = units("ab");
        with_nul.extend([0, u16::from(b'c')]);
        let table: [(Vec<u16>, &str); 8] = [
            (units(""), ""),
            (units("Pw-0123"), "Pw-0123"),
            (
                units("Pw-\u{e9}\u{4e2d}\u{1F600}-7f3a"),
                "Pw-\u{e9}\u{4e2d}\u{1F600}-7f3a",
            ),
            (with_nul, "ab"),
            (vec![0xD83D], "\u{FFFD}"),
            (vec![0xDE00, u16::from(b'x')], "\u{FFFD}x"),
            (vec![u16::from(b'x'), 0xD83D, u16::from(b'y')], "x\u{FFFD}y"),
            (vec![u16::from(b'x'), 0xD83D], "x\u{FFFD}"),
        ];
        for (units, expected) in table {
            let text = utf8_from_utf16(units.iter().copied());
            assert_eq!(text.as_str(), expected, "{units:x?}");
            assert_eq!(text.capacity(), text.len(), "{units:x?} grew");
        }
    }

    #[test]
    #[ignore = "touches the real clipboard; run in the hands-on check"]
    fn real_clipboard_reads_text_in_one_opening_and_clears_only_a_match() {
        use lockbox_core::item::MAX_ITEM_JSON;

        let _turn = lock(&REAL_CLIPBOARD);
        let clipboard = real_clipboard();
        let unicode = "Pw-\u{e9}\u{4e2d}\u{1F600}-7f3a";
        for sample in [SAMPLE, unicode] {
            clipboard_win::set_clipboard_string(sample).unwrap();
            CLIPBOARD_STEPS.take();
            let read = clipboard.read_text(None).unwrap();
            assert_eq!(read.as_ref().map(|text| text.as_str()), Some(sample));
            assert_eq!(
                CLIPBOARD_STEPS.take(),
                ["open", "text size", "read text", "close"],
                "the read is not one opening"
            );
            assert_eq!(
                clipboard_text().as_deref(),
                Some(sample),
                "the read changed it"
            );
            assert_eq!(clipboard.clear_if_text("something else", None), Ok(false));
            assert_eq!(
                clipboard.clear_if_text(&format!("{sample} "), None),
                Ok(false)
            );
            assert_eq!(
                clipboard_text().as_deref(),
                Some(sample),
                "a mismatch cleared it"
            );
            CLIPBOARD_STEPS.take();
            assert_eq!(clipboard.clear_if_text(sample, None), Ok(true));
            assert_eq!(
                CLIPBOARD_STEPS.take(),
                ["open", "text size", "read text", "empty", "close"],
                "the check and the clear are not one opening"
            );
            assert_eq!(clipboard_text(), None);
        }

        // No text at all: nothing to read, nothing to clear.
        {
            let _open = clipboard_win::Clipboard::new_attempts(10).unwrap();
            clipboard_win::raw::empty().unwrap();
        }
        assert_eq!(clipboard.read_text(None), Ok(None));
        assert_eq!(clipboard.clear_if_text(SAMPLE, None), Ok(false));

        // Over the limit: refused, and left on the clipboard.
        let large = "a".repeat(MAX_ITEM_JSON + 1);
        clipboard_win::set_clipboard_string(&large).unwrap();
        assert_eq!(
            clipboard.read_text(None),
            Err(crate::os::CLIPBOARD_TOO_LARGE)
        );
        assert_eq!(clipboard.clear_if_text(SAMPLE, None), Ok(false));
        assert_eq!(clipboard_text().map(|text| text.len()), Some(large.len()));
        let exact = "a".repeat(MAX_ITEM_JSON);
        clipboard_win::set_clipboard_string(&exact).unwrap();
        let read = clipboard.read_text(None).unwrap().unwrap();
        assert_eq!(read.len(), MAX_ITEM_JSON);
        assert_eq!(clipboard.clear_if_text(&exact, None), Ok(true));
        assert_eq!(clipboard_text(), None);
    }

    #[test]
    #[ignore = "touches the real clipboard; run in the hands-on check"]
    fn real_clipboard_copy_sets_exclusion_formats() {
        let _turn = lock(&REAL_CLIPBOARD);
        let clipboard = real_clipboard();
        clipboard.write_secret(SAMPLE, &TAG).unwrap();
        {
            let _open = clipboard_win::Clipboard::new_attempts(10).unwrap();
            // The names as Microsoft documents them, written out here rather than taken from the code under test.
            let marks = [
                "ExcludeClipboardContentFromMonitorProcessing",
                "CanIncludeInClipboardHistory",
                "CanUploadToCloudClipboard",
            ];
            for name in marks {
                let format = clipboard_win::raw::register_format(name).unwrap();
                let mut value = Vec::new();
                clipboard_win::raw::get_vec(format.get(), &mut value)
                    .unwrap_or_else(|_| panic!("{name} is not on the clipboard"));
                assert_eq!(value, 0u32.to_ne_bytes(), "{name} is not a DWORD 0");
            }
            let tag_format = clipboard_win::raw::register_format("Lockbox.CopyTag").unwrap();
            let mut tag = Vec::new();
            clipboard_win::raw::get_vec(tag_format.get(), &mut tag).unwrap();
            assert_eq!(&tag[..16], TAG, "the tag");
            assert!(tag[16..].iter().all(|&byte| byte == 0), "more than the tag");
        }
        assert_eq!(clipboard_text().as_deref(), Some(SAMPLE));
        // Still Lockbox's copy: the clear empties it.
        assert_eq!(clipboard.clear_if(&NEWER_TAG, None), Ok(false));
        assert_eq!(clipboard.clear_if(&TAG, None), Ok(true));
        assert_eq!(clipboard_text(), None);
    }

    /// Calls the real clipboard, running a test step inside the next read of the tag: between the check and the
    /// clear, with the clipboard open.
    struct DuringRead {
        during_read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl ClipboardCalls for DuringRead {
        type Opened = WinOpened;
        fn register_format(&self, name: &str) -> Option<NonZeroU32> {
            WinClipboard.register_format(name)
        }
        fn open(&self) -> Option<WinOpened> {
            WinClipboard.open()
        }
        fn empty(&self) -> bool {
            WinClipboard.empty()
        }
        fn set_text(&self, text: &str) -> bool {
            WinClipboard.set_text(text)
        }
        fn set_bytes(&self, format: NonZeroU32, bytes: &[u8]) -> bool {
            WinClipboard.set_bytes(format, bytes)
        }
        fn read_bytes(&self, format: NonZeroU32) -> ShellResult<Option<Vec<u8>>> {
            let held = WinClipboard.read_bytes(format);
            let step = lock(&self.during_read).take();
            if let Some(step) = step {
                step();
            }
            held
        }
        fn text_size(&self) -> ShellResult<Option<usize>> {
            WinClipboard.text_size()
        }
        fn copy_text(&self) -> ShellResult<Option<Zeroizing<String>>> {
            WinClipboard.copy_text()
        }
    }

    #[test]
    #[ignore = "touches the real clipboard; run in the hands-on check"]
    fn real_clipboard_clear_checks_and_empties_in_one_opening() {
        let _turn = lock(&REAL_CLIPBOARD);
        let clipboard = real_clipboard();
        clipboard.write_secret(SAMPLE, &TAG).unwrap();
        // Another thread copies something of its own after Lockbox's write: its copy has no tag, so it stays.
        thread::spawn(|| clipboard_win::set_clipboard_string("theirs").unwrap())
            .join()
            .unwrap();
        assert_eq!(clipboard.clear_if(&TAG, None), Ok(false));
        assert_eq!(clipboard_text().as_deref(), Some("theirs"));

        // Another program (with a window, as programs open it) tries to copy between the check and the clear: the
        // clipboard is still open, so it cannot get in, and the clear takes only Lockbox's copy.
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let instrumented = ClipboardSteps::new(
            Arc::new(DuringRead {
                during_read: Mutex::new(Some(Box::new(move || {
                    let got_in = thread::spawn(move || {
                        clipboard_win::Clipboard::new_for(window as HWND).is_ok()
                    })
                    .join()
                    .unwrap();
                    assert!(!got_in, "another program opened the clipboard mid-clear");
                    clipboard_step("competitor refused");
                }))),
            }),
            Arc::new(SystemClock),
        );
        instrumented.write_secret(SAMPLE, &NEWER_TAG).unwrap();
        // The hook is for the matching clear, the one that empties: take it out for this mismatching one.
        let competitor = lock(&instrumented.calls.during_read).take();
        assert_eq!(
            instrumented.clear_if(&TAG, None),
            Ok(false),
            "an old tag cleared it"
        );
        *lock(&instrumented.calls.during_read) = competitor;
        assert_eq!(clipboard_text().as_deref(), Some(SAMPLE));
        CLIPBOARD_STEPS.take();
        assert_eq!(instrumented.clear_if(&NEWER_TAG, None), Ok(true));
        // Fix round 3 (2): the real steps of the matching clear. The tag check and the empty share one opening, with
        // no close between them, and the other program's try falls inside that span.
        assert_eq!(
            CLIPBOARD_STEPS.take(),
            ["open", "read", "competitor refused", "empty", "close"],
            "the check and the empty are not one opening"
        );
        assert_eq!(clipboard_text(), None);
    }

    #[test]
    #[ignore = "touches the real clipboard; run in the hands-on check"]
    fn busy_clipboard_fails_fast() {
        let _turn = lock(&REAL_CLIPBOARD);
        clipboard_win::set_clipboard_string("theirs").unwrap();
        // The holder opens it with a window of its own, as programs do: Windows lets a second opener with no window
        // in while the first also has none (seen in the hands-on probe), so that would never be busy.
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let (opened, is_open) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let holder = thread::spawn(move || {
            let _open = clipboard_win::Clipboard::new_for(window as HWND).unwrap();
            opened.send(()).unwrap();
            let _ = released.recv_timeout(Duration::from_secs(60));
        });
        is_open.recv_timeout(Duration::from_secs(60)).unwrap();
        let clipboard = real_clipboard();
        let began = Instant::now();
        assert_eq!(
            clipboard.write_secret(SAMPLE, &TAG),
            Err(WriteFailed {
                error: CLIPBOARD_BUSY,
                left_behind: false
            })
        );
        assert_eq!(clipboard.clear_if(&TAG, None), Err(CLIPBOARD_BUSY));
        let took = began.elapsed();
        release.send(()).unwrap();
        holder.join().unwrap();
        assert!(took < Duration::from_secs(1), "{took:?}");
        assert_eq!(clipboard_text().as_deref(), Some("theirs"));
    }

    /// One copy of the app per sign-in: the second claim of a name is refused (`None`), and the name is free again once
    /// the first claim's guard drops. A claim of another name is independent. Names are the tests' own.
    #[test]
    fn instance_claim_is_refused_while_another_holds_it() {
        let name = format!("Local\\lockbox-test-instance-{}", std::process::id());
        let first = claim(&name).unwrap().expect("the first claim is granted");
        assert!(claim(&name).unwrap().is_none(), "a second claim is refused");
        assert!(claim(&name).unwrap().is_none(), "and again");
        let other = claim(&format!("{name}-other")).unwrap();
        assert!(other.is_some(), "another name is its own claim");
        drop(first);
        let again = claim(&name).unwrap();
        assert!(again.is_some(), "free again once the guard is dropped");
        // A name Windows cannot take is an error, not "someone else has it".
        assert!(claim("Local\\bad\0name").is_err());
        // The real name is a `Local\` one: per sign-in.
        assert!(INSTANCE_NAME.starts_with("Local\\"));
    }
}
