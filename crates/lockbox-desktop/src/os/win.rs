//! Direct Windows and WebView2 calls: WebView2's file-drop setting, and the hidden window that hears Windows lock,
//! sleep, sign-out, shutdown and drive removal ([`spawn`]). Every `unsafe` block of the crate is here, each with a
//! `// SAFETY:` comment.
#![allow(unsafe_code)]

use std::cell::{Cell, OnceCell};
use std::io;
use std::mem::offset_of;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

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
    PostMessageW, PostQuitMessage, RegisterClassW, SMTO_ABORTIFHUNG, SMTO_BLOCK,
    SendMessageTimeoutW, UnregisterClassW, WM_APP, WM_CLOSE, WM_DESTROY, WNDCLASSW, WS_OVERLAPPED,
};

use super::OsSignal;
use super::signals::{DeviceHeader, classify, wants_device_header};

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

/// Posted by [`SignalThread::keep_awake`]: wparam 1 asks Windows to stay awake, 0 lets it sleep again. The window
/// answers with the thread's previous execution state.
const KEEP_AWAKE: u32 = WM_APP + 1;

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
    /// Set by `Drop` alone. Until then the window ignores every `WM_CLOSE`, whoever sends it.
    stopping: AtomicBool,
}

/// What the window procedure needs: where signals go, and what the window shares with its owner.
struct Context {
    sink: Sender<OsSignal>,
    shared: Arc<Shared>,
}

thread_local! {
    /// Set once, at the start of the window's thread, the only thread the window procedure runs on.
    static CONTEXT: OnceCell<Context> = const { OnceCell::new() };
    /// The window's suspend-and-resume registration, undone when the window is destroyed (0: none).
    static POWER_NOTICE: Cell<HPOWERNOTIFY> = const { Cell::new(0) };
    /// Set once the window has taken its owner's close request: the message loop then ends at the next `WM_QUIT`.
    static CLOSING: Cell<bool> = const { Cell::new(false) };
}

/// Locks `mutex`, also after a panic elsewhere left it poisoned: what each lock here guards is never left
/// half-written.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The thread that owns Lockbox's hidden signal window ([`spawn`]). Only dropping it closes the window; no other
/// program can. The signals stop then, so the app keeps it for as long as it runs.
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
/// on PCs with Modern Standby as well. Only [`SignalThread`]'s `Drop` closes it: a `WM_CLOSE` or `WM_QUIT` from
/// anywhere else changes nothing.
pub fn spawn(sink: Sender<OsSignal>) -> io::Result<SignalThread> {
    let number = NEXT_CLASS.fetch_add(1, Ordering::Relaxed);
    let class: Vec<u16> = format!("Lockbox signal window {number}")
        .encode_utf16()
        .chain([0])
        .collect();
    let shared = Arc::new(Shared {
        window: Mutex::new(0),
        stopping: AtomicBool::new(false),
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
    /// (`ES_CONTINUOUS` alone) or until the window closes, whose `WM_DESTROY` withdraws the request. The request
    /// belongs to the thread that makes it, so it is posted to the window and made on the window's own thread. If the
    /// post fails (the window's queue is full), the request is not changed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Task 11 keeps Windows awake during long operations"
        )
    )]
    pub fn keep_awake(&self, on: bool) {
        let window = lock(&self.shared.window);
        if *window != 0 {
            // SAFETY: the message carries no pointers. The handle is live: the window's thread clears the slot,
            // under the lock held here, before it destroys the window.
            unsafe { PostMessageW(*window as HWND, KEEP_AWAKE, usize::from(on), 0) };
        }
    }
}

impl Drop for SignalThread {
    /// Asks the window to close, then waits for its thread to end, at most [`STOP_WAIT`] for each. The request is a
    /// sent `WM_CLOSE`, which the posted-message limit (10,000 per queue) cannot hold up. Once the thread has ended,
    /// the window, its notices, its keep-awake request and its class are all gone, and the thread is joined. A thread
    /// that does not end in time is let go rather than waited for forever.
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        {
            let window = lock(&self.shared.window);
            if *window != 0 {
                let mut answer = 0;
                // SAFETY: the message carries no pointers, and `answer` is writable. The handle is live for the whole
                // call: the window's thread clears the slot, under the lock held here, before it destroys the window.
                // Holding the lock cannot deadlock: the window takes the request without it. In the one case where
                // its thread already waits for the lock (another program's WM_CLOSE reached it after `stopping` was
                // set), this call times out after STOP_WAIT and the thread then goes on.
                unsafe {
                    SendMessageTimeoutW(
                        *window as HWND,
                        WM_CLOSE,
                        0,
                        0,
                        SMTO_BLOCK | SMTO_ABORTIFHUNG,
                        STOP_WAIT_MS,
                        &mut answer,
                    )
                };
            }
        }
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
            run_messages();
            // From here on the owner finds no handle, so nothing more can be sent or posted to the window.
            *lock(&shared.window) = 0;
            // SAFETY: `window` is this thread's live window; its WM_DESTROY undoes its notices and its keep-awake
            // request.
            unsafe { DestroyWindow(window) };
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
            // SAFETY: `window` is live and belongs to this thread, and no owner holds its handle yet; its WM_DESTROY
            // undoes any registration that succeeded.
            unsafe { DestroyWindow(window) };
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
        notice => Ok(notice),
    }
}

/// The message loop. It ends only once the window has taken its owner's close request and the `WM_QUIT` that the
/// request posts arrives; a `WM_QUIT` from anywhere else (another program can post one to the window or to this
/// thread) is skipped.
fn run_messages() {
    let mut message = MSG::default();
    loop {
        // SAFETY: `message` is a valid, writable MSG; a null window asks for every message of this thread.
        match unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } {
            // GetMessageW fails only for invalid arguments, which this loop never passes. If it ever did, the window
            // could hear nothing more: end, and the listener sees the signals end.
            -1 => return,
            0 if CLOSING.get() => return,
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
        WM_CLOSE => {
            take_close_request();
            return 0;
        }
        WM_DESTROY => {
            stop_notices(window);
            // The keep-awake request ends with the window.
            set_keep_awake(false);
            return 0;
        }
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

/// `WM_CLOSE`: taken only once the owner's `Drop` has asked (it sets `stopping` first), so no other program can end
/// the signals; any other is ignored. Taking it ends the message loop at the next `WM_QUIT`, and the window is
/// destroyed after the loop, once its handle is out of the owner's reach.
fn take_close_request() {
    let asked = CONTEXT
        .try_with(|context| {
            context
                .get()
                .is_some_and(|context| context.shared.stopping.load(Ordering::SeqCst))
        })
        .unwrap_or(false);
    if asked && CLOSING.try_with(|closing| closing.set(true)).is_ok() {
        // SAFETY: takes no pointers; it asks this thread's message loop to end. It sets a flag rather than queueing
        // a message, so the posted-message limit cannot hold it up.
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

/// Undoes the window's session and suspend registrations; runs on `WM_DESTROY`.
fn stop_notices(window: HWND) {
    // SAFETY: `window` is the live window being destroyed; for a window that never registered, the call only fails.
    unsafe { WTSUnRegisterSessionNotification(window) };
    let notice = POWER_NOTICE
        .try_with(|notice| notice.replace(0))
        .unwrap_or(0);
    if notice != 0 {
        // SAFETY: `notice` is this thread's registration for this window, undone once (it was replaced by 0).
        unsafe { UnregisterSuspendResumeNotification(notice) };
    }
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
}

/// Test-only changes to one `spawn` made on the test's own thread, so tests running side by side never meet each
/// other's.
#[cfg(test)]
#[derive(Default)]
struct TestHook {
    refuse: Option<Registration>,
    /// Where [`TEST_BLOCK`] holds the window's thread until the test sends `()` (or 5 s pass).
    gate: Option<Receiver<()>>,
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
#[cfg(test)]
fn wait_at_test_gate() {
    let _ = TEST_HOOK.try_with(|hook| {
        if let Ok(hook) = hook.try_borrow()
            && let Some(gate) = hook.as_ref().and_then(|hook| hook.gate.as_ref())
        {
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
        PostThreadMessageW, SendMessageW, WM_CLOSE, WM_DEVICECHANGE, WM_NULL, WM_POWERBROADCAST,
        WM_QUIT, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
    };

    use super::*;

    /// The deadline for every wait in these tests: a slow or stuck window fails a test instead of hanging it.
    const WAIT: Duration = Duration::from_secs(1);

    fn started() -> (SignalThread, Receiver<OsSignal>) {
        let (sink, signals) = mpsc::channel();
        (spawn(sink).expect("the signal window starts"), signals)
    }

    /// Installs a hook for the next `spawn` on this thread, and returns what it will record.
    fn hook(refuse: Option<Registration>, gate: Option<Receiver<()>>) -> Arc<Seen> {
        let seen = Arc::new(Seen::default());
        TEST_HOOK.set(Some(TestHook {
            refuse,
            gate,
            seen: Arc::clone(&seen),
        }));
        seen
    }

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
            // SAFETY: `window` is a handle from a signal thread the test still holds (if the test has failed and
            // dropped it, the call fails). `lparam` is 0 or points to `payload`, which this thread owns until the
            // call has returned.
            let result = unsafe { SendMessageW(window as HWND, msg, wparam, lparam) };
            let _ = answered.send(result);
            drop(payload);
        });
        answer
            .recv_timeout(WAIT)
            .expect("the window answers within the deadline")
    }

    fn post(window: usize, msg: u32, wparam: WPARAM) {
        // SAFETY: the message carries no pointers; the window lives while its signal thread does.
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
        let seen = hook(None, None);
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

    /// Only Lockbox closes the window: another program's `WM_CLOSE` (posted or sent) and `WM_QUIT` (to the window or
    /// to its thread) change nothing.
    #[test]
    fn outside_close_and_quit_do_not_stop_the_signals() {
        let seen = hook(None, None);
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

        let class = class_of(&seen);
        drop_within(signal_thread, WAIT);
        assert!(!is_window(window), "window destroyed by drop");
        assert!(!class_exists(&class), "class unregistered by drop");
    }

    /// `Drop` does not need room in the window's posted-message queue (Windows allows 10,000 messages): with the
    /// queue full it still closes the window and waits for its thread, so the class is gone when it returns.
    #[test]
    fn drop_does_not_need_room_in_the_queue() {
        let (open_gate, gate) = mpsc::channel();
        let seen = hook(None, Some(gate));
        let (signal_thread, _signals) = started();
        let window = window_of(&signal_thread);
        let class = class_of(&seen);

        // Hold the window's thread at the gate, then fill its queue until Windows refuses more.
        post(window, TEST_BLOCK, 0);
        let mut posted = 0;
        // SAFETY: the message carries no pointers; the window lives while its signal thread does.
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
        let _ = open_gate.send(());
        done.recv_timeout(WAIT)
            .expect("drop returns within the deadline");
        assert!(!is_window(window), "window destroyed");
        assert!(
            !class_exists(&class),
            "class unregistered before drop returned"
        );
    }

    /// A registration Windows refuses makes `spawn` fail, and leaves no window and no class behind.
    #[test]
    fn refused_registration_leaves_nothing_behind() {
        for refused in [Registration::Session, Registration::Suspend] {
            let seen = hook(Some(refused), None);
            let (sink, _signals) = mpsc::channel();
            assert!(spawn(sink).is_err(), "{refused:?} refused: spawn fails");
            let window = seen.window.load(Ordering::SeqCst);
            assert_ne!(window, 0, "{refused:?} refused: the window was made first");
            assert!(!is_window(window), "{refused:?} refused: window destroyed");
            assert!(
                !class_exists(&class_of(&seen)),
                "{refused:?} refused: class unregistered"
            );
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
}
