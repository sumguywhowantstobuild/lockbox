//! Direct Windows and WebView2 calls: WebView2's file-drop setting, and the hidden window that hears Windows lock,
//! sleep, sign-out, shutdown and drive removal ([`spawn`]). Every `unsafe` block of the crate is here, each with a
//! `// SAFETY:` comment.
#![allow(unsafe_code)]

use std::cell::{Cell, OnceCell};
use std::io;
use std::mem::offset_of;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Controller4,
};
use windows_core::{BOOL, Interface};
use windows_sys::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, HPOWERNOTIFY, RegisterSuspendResumeNotification,
    SetThreadExecutionState, UnregisterSuspendResumeNotification,
};
use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DBT_DEVTYP_VOLUME, DEV_BROADCAST_HDR, DEV_BROADCAST_VOLUME,
    DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, MSG,
    PostMessageW, PostQuitMessage, RegisterClassW, UnregisterClassW, WM_APP, WM_CLOSE, WM_DESTROY,
    WNDCLASSW, WS_OVERLAPPED,
};

use super::OsSignal;
use super::signals::{DeviceHeader, classify, wants_device_header};

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

/// Posted by [`SignalThread::keep_awake`]: wparam 1 asks Windows to stay awake, 0 lets it sleep again. The window
/// answers with the thread's previous execution state.
const KEEP_AWAKE: u32 = WM_APP + 1;

/// Numbers each window's class name, so windows started side by side (tests) or one after another never share a
/// class that another one is still registering or unregistering.
static NEXT_CLASS: AtomicU32 = AtomicU32::new(0);

thread_local! {
    /// Where the window procedure sends signals. Set once on the window's thread, the only thread it runs on.
    static SINK: OnceCell<Sender<OsSignal>> = const { OnceCell::new() };
    /// The window's suspend-and-resume registration, undone when the window is destroyed (0: none).
    static POWER_NOTICE: Cell<HPOWERNOTIFY> = const { Cell::new(0) };
}

/// The thread that owns Lockbox's hidden signal window ([`spawn`]). Dropping it closes the window and waits for the
/// thread to end, and the signals stop with it, so the app keeps it for as long as it runs.
pub struct SignalThread {
    /// The window's handle, kept as a number: a window handle may be used from any thread, and a number keeps this
    /// struct `Send` and `Sync`.
    window: usize,
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
/// on PCs with Modern Standby as well.
pub fn spawn(sink: Sender<OsSignal>) -> io::Result<SignalThread> {
    let number = NEXT_CLASS.fetch_add(1, Ordering::Relaxed);
    let class: Vec<u16> = format!("Lockbox signal window {number}")
        .encode_utf16()
        .chain([0])
        .collect();
    let (ready, started) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("lockbox-signals".into())
        .spawn(move || window_thread(class, sink, ready))?;
    let window = match started.recv() {
        Ok(Ok(window)) => window,
        Ok(Err(error)) => {
            let _ = thread.join();
            return Err(error);
        }
        Err(_) => {
            let _ = thread.join();
            return Err(io::Error::other(
                "the signal window's thread ended before its window was ready",
            ));
        }
    };
    Ok(SignalThread {
        window,
        thread: Some(thread),
    })
}

impl SignalThread {
    /// Asks Windows to keep the PC awake (`true`: `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) until called with `false`
    /// (`ES_CONTINUOUS` alone) or until the thread ends. The request belongs to the thread that makes it, so it is
    /// posted to the window and made on the window's own thread. If the post fails (the window's queue is full),
    /// the request is not changed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Task 11 keeps Windows awake during long operations"
        )
    )]
    pub fn keep_awake(&self, on: bool) {
        self.post(KEEP_AWAKE, usize::from(on));
    }

    fn hwnd(&self) -> HWND {
        self.window as HWND
    }

    /// Posts `msg` to the window while its thread still runs, and says whether it was posted. Once the thread has
    /// ended, the window is gone and its handle may already name another program's window, so nothing is posted.
    fn post(&self, msg: u32, wparam: WPARAM) -> bool {
        let running = self
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished());
        // SAFETY: the message carries no pointers, and the window exists while its thread runs.
        running && unsafe { PostMessageW(self.hwnd(), msg, wparam, 0) } != 0
    }
}

impl Drop for SignalThread {
    /// Closes the window (`WM_CLOSE`) and waits for its thread, which unregisters the window class as it ends.
    fn drop(&mut self) {
        let posted = self.post(WM_CLOSE, 0);
        let Some(thread) = self.thread.take() else {
            return;
        };
        // A post fails only when the window's queue is full: waiting could then take forever, so let the thread go.
        if posted || thread.is_finished() {
            // A panic on that thread has already ended its window; there is nothing left to undo here.
            let _ = thread.join();
        }
    }
}

/// The window's thread: registers its class, opens the window, reports back to [`spawn`], handles messages until the
/// window is destroyed, then unregisters the class.
fn window_thread(class: Vec<u16>, sink: Sender<OsSignal>, ready: Sender<io::Result<usize>>) {
    // A new thread's cell is always empty, so this always stores the sink.
    SINK.with(|cell| {
        let _ = cell.set(sink);
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
    match open_window(&class, instance) {
        Ok(window) => {
            let _ = ready.send(Ok(window as usize));
            run_messages(window);
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
    // SAFETY: `class` is the NUL-terminated name registered above with `instance`. Its one window has been destroyed
    // by now (`open_window` destroys it before failing, and `run_messages` returns only after its WM_DESTROY).
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
    // SAFETY: `window` is the live window just created on this thread.
    if unsafe { WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) } != 0 {
        // SAFETY: as above; `DEVICE_NOTIFY_WINDOW_HANDLE` says the recipient is a window handle.
        let notice =
            unsafe { RegisterSuspendResumeNotification(window, DEVICE_NOTIFY_WINDOW_HANDLE) };
        if notice != 0 {
            POWER_NOTICE.set(notice);
            return Ok(window);
        }
    }
    let error = io::Error::last_os_error();
    // SAFETY: `window` is live and belongs to this thread; its WM_DESTROY undoes any registration that succeeded.
    unsafe { DestroyWindow(window) };
    Err(error)
}

/// The message loop: runs until `WM_QUIT`, which the window's `WM_DESTROY` posts.
fn run_messages(window: HWND) {
    let mut message = MSG::default();
    loop {
        // SAFETY: `message` is a valid, writable MSG; a null window asks for every message of this thread.
        match unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } {
            0 => return,
            -1 => {
                // Only invalid arguments make GetMessageW fail. Close the window, so the class can be unregistered.
                // SAFETY: `window` is this thread's live window (WM_QUIT has not been seen).
                unsafe { DestroyWindow(window) };
                return;
            }
            // SAFETY: `message` was just filled in by GetMessageW.
            _ => unsafe {
                DispatchMessageW(&message);
            },
        }
    }
}

/// The hidden window's procedure: sends each lock signal to the sink, then lets Windows handle the message as usual.
/// It never blocks: sending on an mpsc channel does not wait. It must not panic either (a panic cannot leave a
/// procedure called by Windows), so a sink that is unreachable or closed is skipped.
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
        WM_DESTROY => {
            stop_notices(window);
            // SAFETY: takes no pointers; it ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
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
        let _ = SINK.try_with(|sink| {
            if let Some(sink) = sink.get() {
                // A listener that has gone away no longer needs the signal.
                let _ = sink.send(signal);
            }
        });
    }
    // SAFETY: the arguments are the ones Windows gave this procedure.
    unsafe { DefWindowProcW(window, msg, wparam, lparam) }
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

/// Undoes the window's session and suspend registrations; runs on `WM_DESTROY`.
fn stop_notices(window: HWND) {
    // SAFETY: `window` is the live window being destroyed; for a window that never registered, the call only fails.
    unsafe { WTSUnRegisterSessionNotification(window) };
    let notice = POWER_NOTICE.replace(0);
    if notice != 0 {
        // SAFETY: `notice` is this thread's registration for this window, undone once (it was replaced by 0).
        unsafe { UnregisterSuspendResumeNotification(notice) };
    }
}

/// Copies the device kind, and for a volume its drive mask, out of a `WM_DEVICECHANGE` event's `lparam`. Returns
/// `None` for a null pointer, or for a volume header too short to hold the mask.
///
/// # Safety
///
/// `lparam` is 0, or points to a `DEV_BROADCAST_HDR` whose first `dbch_size` bytes are readable during this call.
unsafe fn read_device_header(lparam: LPARAM) -> Option<DeviceHeader> {
    let header = lparam as *const DEV_BROADCAST_HDR;
    if header.is_null() {
        return None;
    }
    // SAFETY: the caller's promise covers the header itself; `read_unaligned` needs no alignment.
    let DEV_BROADCAST_HDR {
        dbch_size,
        dbch_devicetype,
        ..
    } = unsafe { header.read_unaligned() };
    if dbch_devicetype != DBT_DEVTYP_VOLUME {
        return Some(DeviceHeader {
            kind: dbch_devicetype,
            unitmask: 0,
        });
    }
    // Read only as far as the mask: Windows may not count the struct's trailing padding in `dbch_size`.
    let mask_end = offset_of!(DEV_BROADCAST_VOLUME, dbcv_unitmask) + size_of::<u32>();
    if (dbch_size as usize) < mask_end {
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

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DBT_DEVICEREMOVECOMPLETE, DBT_DEVTYP_PORT, DBT_DEVTYP_VOLUME, DEV_BROADCAST_HDR,
        DEV_BROADCAST_VOLUME, GA_PARENT, GetAncestor, GetDesktopWindow, IsWindow, IsWindowVisible,
        PBT_APMSUSPEND, PostMessageW, SendMessageW, WM_DEVICECHANGE, WM_POWERBROADCAST,
        WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK,
    };

    use super::*;

    const WAIT: Duration = Duration::from_secs(1);

    fn started() -> (SignalThread, Receiver<OsSignal>) {
        let (sink, signals) = mpsc::channel();
        (spawn(sink).expect("the signal window starts"), signals)
    }

    /// Sends a message to the hidden window and waits for its answer.
    fn send(thread: &SignalThread, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // SAFETY: the window lives as long as `thread`. `lparam` is 0 or points to a DEV_BROADCAST struct on the
        // caller's stack, which outlives this call: SendMessageW returns only once the window has handled it.
        unsafe { SendMessageW(thread.hwnd(), msg, wparam, lparam) }
    }

    /// Posts a suspend notice behind whatever is already queued and waits for it: posted messages are handled in
    /// order, so everything posted before it has been handled too.
    fn flush(thread: &SignalThread, signals: &Receiver<OsSignal>) {
        // SAFETY: the window lives as long as `thread`; the message carries no pointers.
        let posted =
            unsafe { PostMessageW(thread.hwnd(), WM_POWERBROADCAST, PBT_APMSUSPEND as usize, 0) };
        assert_ne!(posted, 0, "post the marker");
        assert_eq!(signals.recv_timeout(WAIT), Ok(OsSignal::Suspending));
    }

    #[test]
    fn sent_messages_reach_the_sink() {
        let (thread, signals) = started();
        send(&thread, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize, 0);
        assert_eq!(signals.recv_timeout(WAIT), Ok(OsSignal::SessionLocked));
        send(&thread, WM_POWERBROADCAST, PBT_APMSUSPEND as usize, 0);
        assert_eq!(signals.recv_timeout(WAIT), Ok(OsSignal::Suspending));
    }

    #[test]
    fn drive_removal_is_read_from_the_message() {
        let (thread, signals) = started();
        let volume = DEV_BROADCAST_VOLUME {
            dbcv_size: size_of::<DEV_BROADCAST_VOLUME>() as u32,
            dbcv_devicetype: DBT_DEVTYP_VOLUME,
            dbcv_unitmask: 0b100,
            ..Default::default()
        };
        let removed = DBT_DEVICEREMOVECOMPLETE as usize;
        send(
            &thread,
            WM_DEVICECHANGE,
            removed,
            (&raw const volume) as LPARAM,
        );
        assert_eq!(
            signals.recv_timeout(WAIT),
            Ok(OsSignal::DriveRemoved { mask: 0b100 })
        );

        // A volume header too short to hold the mask, another kind of device, and no header at all: no signal.
        let short = DEV_BROADCAST_HDR {
            dbch_size: size_of::<DEV_BROADCAST_HDR>() as u32,
            dbch_devicetype: DBT_DEVTYP_VOLUME,
            dbch_reserved: 0,
        };
        let port = DEV_BROADCAST_HDR {
            dbch_devicetype: DBT_DEVTYP_PORT,
            ..short
        };
        send(
            &thread,
            WM_DEVICECHANGE,
            removed,
            (&raw const short) as LPARAM,
        );
        send(
            &thread,
            WM_DEVICECHANGE,
            removed,
            (&raw const port) as LPARAM,
        );
        send(&thread, WM_DEVICECHANGE, removed, 0);
        assert_eq!(signals.try_recv(), Err(TryRecvError::Empty));
    }

    /// Broadcasts such as sleep and volume notices reach top-level windows only, not message-only ones.
    #[test]
    fn window_is_top_level_and_never_shown() {
        let (thread, _signals) = started();
        // SAFETY: plain queries on a live window handle.
        unsafe {
            assert_eq!(IsWindowVisible(thread.hwnd()), 0, "never shown");
            assert_eq!(
                GetAncestor(thread.hwnd(), GA_PARENT),
                GetDesktopWindow(),
                "top-level"
            );
        }
    }

    /// `keep_awake` reaches the window's own thread, where the stay-awake request lives. The window answers its
    /// stay-awake message with the thread's previous state, which shows what the earlier posts set.
    #[test]
    fn keep_awake_runs_on_the_window_thread() {
        let (thread, signals) = started();
        let awake = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;

        thread.keep_awake(true);
        flush(&thread, &signals);
        assert_eq!(send(&thread, KEEP_AWAKE, 0, 0) as u32, awake);

        thread.keep_awake(true);
        thread.keep_awake(false);
        flush(&thread, &signals);
        assert_eq!(send(&thread, KEEP_AWAKE, 0, 0) as u32, ES_CONTINUOUS);
    }

    #[test]
    fn two_windows_run_side_by_side() {
        let (first, first_signals) = started();
        let (second, second_signals) = started();
        send(&first, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize, 0);
        send(&second, WM_POWERBROADCAST, PBT_APMSUSPEND as usize, 0);
        assert_eq!(
            first_signals.recv_timeout(WAIT),
            Ok(OsSignal::SessionLocked)
        );
        assert_eq!(second_signals.recv_timeout(WAIT), Ok(OsSignal::Suspending));
        assert_eq!(first_signals.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn drop_stops_the_thread() {
        let (thread, signals) = started();
        let window = thread.hwnd();
        let dropping = Instant::now();
        drop(thread);
        assert!(
            dropping.elapsed() < WAIT,
            "drop took {:?}",
            dropping.elapsed()
        );
        // The window is gone, and so is the thread's sender: a listener sees the signals end.
        // SAFETY: a plain query; a stale handle is what it checks for.
        assert_eq!(unsafe { IsWindow(window) }, 0, "window destroyed");
        assert_eq!(
            signals.recv_timeout(WAIT),
            Err(RecvTimeoutError::Disconnected)
        );

        let (again, signals) = started();
        send(&again, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize, 0);
        assert_eq!(signals.recv_timeout(WAIT), Ok(OsSignal::SessionLocked));
    }
}
