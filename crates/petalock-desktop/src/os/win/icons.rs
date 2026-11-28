//! The main window's icons in Windows' own terms (see [`crate::app_icon`]): the frame of the right size for the taskbar
//! button and for the title bar, each drawn for its size, and a watch on the window's messages for Windows' light or
//! dark setting and the screen's scaling changing. Part of `win`, the only module allowed `unsafe`.

use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, DestroyIcon, HICON, ICON_BIG, ICON_SMALL, LR_DEFAULTCOLOR,
    PostMessageW, RegisterWindowMessageW, SM_CXICON, SM_CXSMICON, SendMessageW, WM_DPICHANGED,
    WM_NCDESTROY, WM_SETICON, WM_SETTINGCHANGE,
};

use crate::app_icon;
use crate::lock;

/// `CreateIconFromResourceEx`'s format version for icons (Windows 3.x and later, PNG frames included).
const ICON_FORMAT: u32 = 0x0003_0000;
/// The id of Petalock's watch among the window's subclasses.
const WATCH_ID: usize = 0x5045_5441;
/// What `WM_SETTINGCHANGE` names when the light or dark setting changed.
const COLOUR_SET: &str = "ImmersiveColorSet";

/// The icons this module made and gave the window (big, small), as handles, so each is destroyed once replaced and
/// never one Tauri made.
static OURS: Mutex<Option<(isize, isize)>> = Mutex::new(None);

/// Windows' small icon size at the system's scaling, the one the clock's corner draws its icons at: Windows sets that
/// scaling when the person signs in, so the tray's picture keeps the size it started with until then.
pub fn small_icon_size() -> u32 {
    // SAFETY: takes no pointer.
    small_icon_size_at(unsafe { GetDpiForSystem() })
}

/// Windows' small icon size at `dpi`: 16 pixels at 96 (100 %), 20 at 120, 24 at 144, 32 at 192.
fn small_icon_size_at(dpi: u32) -> u32 {
    // SAFETY: takes no pointer.
    let size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
    u32::try_from(size).unwrap_or(16).max(16)
}

/// Gives the window `ico`'s frames for its taskbar button and Alt+Tab (Windows' large size at the window's scaling)
/// and for its title bar (the small size). Either both change or neither does.
pub fn set_window_icons(window: isize, ico: &[u8]) -> io::Result<()> {
    let window = window as HWND;
    // SAFETY: takes no pointer; an invalid handle answers 0.
    let dpi = match unsafe { GetDpiForWindow(window) } {
        0 => unsafe { GetDpiForSystem() },
        dpi => dpi,
    };
    let big = make_icon(ico, SM_CXICON, dpi)?;
    let small = match make_icon(ico, SM_CXSMICON, dpi) {
        Ok(small) => small,
        Err(error) => {
            // SAFETY: `big` was made just now and given to no one.
            unsafe { DestroyIcon(big) };
            return Err(error);
        }
    };
    let mut ours = lock(&OURS);
    // SAFETY: the icons are live, and ours stay alive until replaced. The icons the messages hand back (Tauri's at
    // first) are not ours and are never destroyed here: Tauri keeps and frees its own.
    unsafe {
        SendMessageW(window, WM_SETICON, ICON_BIG as WPARAM, big as LPARAM);
        SendMessageW(window, WM_SETICON, ICON_SMALL as WPARAM, small as LPARAM);
    }
    if let Some((old_big, old_small)) = ours.replace((big as isize, small as isize)) {
        // SAFETY: made here earlier and just replaced on the window, so no one draws with them any more.
        unsafe {
            DestroyIcon(old_big as HICON);
            DestroyIcon(old_small as HICON);
        }
    }
    Ok(())
}

/// The icon for one of Windows' icon sizes (`metric`) at `dpi`, from the `.ico` frame drawn for it.
fn make_icon(ico: &[u8], metric: i32, dpi: u32) -> io::Result<HICON> {
    // SAFETY: takes no pointer.
    let side = unsafe { GetSystemMetricsForDpi(metric, dpi) }.max(16);
    let png = app_icon::frame(ico, side.unsigned_abs())
        .ok_or_else(|| io::Error::other("the icon file has no frame"))?;
    let length =
        u32::try_from(png.len()).map_err(|_| io::Error::other("the icon frame is too large"))?;
    // SAFETY: `png` is readable for `length` bytes for the whole call; Windows copies what it needs.
    let icon = unsafe {
        CreateIconFromResourceEx(
            png.as_ptr(),
            length,
            1,
            ICON_FORMAT,
            side,
            side,
            LR_DEFAULTCOLOR,
        )
    };
    if icon.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(icon)
    }
}

/// The private message the watch posts to the window so the change is acted on after Windows' notice, once that has
/// been handled (Windows has saved the new setting by then), and not inside it.
fn reapply_message() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    *MESSAGE.get_or_init(|| {
        let name: Vec<u16> = "Petalock.ReapplyIcons".encode_utf16().chain([0]).collect();
        // SAFETY: `name` is NUL-terminated and outlives the call. 0 (refused) is kept: the watch then never fires.
        unsafe { RegisterWindowMessageW(name.as_ptr()) }
    })
}

/// Calls `changed` each time Windows tells the window that its light or dark setting changed (`WM_SETTINGCHANGE` naming
/// `ImmersiveColorSet`) or that the window's screen scaling changed (`WM_DPICHANGED`), until the window is destroyed.
/// `changed` runs on the window's thread in a message of its own, posted after Windows' notice; a panic in it is caught
/// there, since none may leave a procedure Windows calls.
pub fn on_taskbar_change(window: isize, changed: Box<dyn Fn() + Send>) -> io::Result<()> {
    if reapply_message() == 0 {
        return Err(io::Error::other(
            "Windows gave no message for the icon change",
        ));
    }
    let data = Box::into_raw(Box::new(changed));
    // SAFETY: `watch` matches SUBCLASSPROC; `data` stays alive until the watch is removed (`WM_NCDESTROY`), which drops it.
    let added = unsafe { SetWindowSubclass(window as HWND, Some(watch), WATCH_ID, data as usize) };
    if added == 0 {
        // SAFETY: Windows took no reference: the box is still ours alone.
        drop(unsafe { Box::from_raw(data) });
        return Err(io::Error::other(
            "the window's messages could not be watched",
        ));
    }
    Ok(())
}

unsafe extern "system" fn watch(
    window: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    let changed = data as *mut Box<dyn Fn() + Send>;
    let reapply = reapply_message();
    match msg {
        // SAFETY: for WM_SETTINGCHANGE, `lparam` is 0 or a NUL-terminated string Windows keeps alive for the message.
        WM_SETTINGCHANGE if unsafe { names(lparam, COLOUR_SET) } => {
            // SAFETY: takes no pointer. A full queue drops it; the next change brings another.
            unsafe { PostMessageW(window, reapply, 0, 0) };
        }
        WM_DPICHANGED => {
            // SAFETY: as above.
            unsafe { PostMessageW(window, reapply, 0, 0) };
        }
        _ if msg == reapply && reapply != 0 => {
            // SAFETY: `data` is the box `on_taskbar_change` made, alive until WM_NCDESTROY, which comes after.
            let _ = catch_unwind(AssertUnwindSafe(|| unsafe { (*changed)() }));
            return 0;
        }
        WM_NCDESTROY => {
            // SAFETY: the window's last message: the watch comes off and its box is dropped, once.
            unsafe {
                RemoveWindowSubclass(window, Some(watch), id);
                drop(Box::from_raw(changed));
            }
        }
        _ => {}
    }
    // SAFETY: the arguments are the ones Windows gave this procedure.
    unsafe { DefSubclassProc(window, msg, wparam, lparam) }
}

/// Whether `lparam` is a NUL-terminated UTF-16 string equal to `name`. Reads at most one character past `name`'s length.
///
/// # Safety
/// `lparam` is 0 or points at a NUL-terminated UTF-16 string.
unsafe fn names(lparam: LPARAM, name: &str) -> bool {
    if lparam == 0 {
        return false;
    }
    let text = lparam as *const u16;
    for (index, expected) in name.encode_utf16().chain([0]).enumerate() {
        // SAFETY: every character up to the first that differs is inside the string, its NUL included: the loop stops
        // at the first difference, and `name`'s own NUL is the last one compared.
        if unsafe { *text.add(index) } != expected {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use std::ptr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, WM_GETICON,
        WS_OVERLAPPED,
    };

    use super::*;
    use crate::app_icon::Taskbar;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// A hidden window of Windows' own `STATIC` class, owned by this test's thread.
    fn hidden_window() -> HWND {
        let class = wide("STATIC");
        // SAFETY: the class name is NUL-terminated and outlives the call; every other pointer may be null.
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
                GetModuleHandleW(ptr::null()),
                ptr::null(),
            )
        };
        assert!(!window.is_null(), "the test window was not made");
        window
    }

    /// Hands every message waiting for `window` to its procedure.
    fn pump(window: HWND) {
        // SAFETY: `message` is writable; the window is this thread's.
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, window, 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&message);
            }
        }
    }

    #[test]
    fn only_the_colour_setting_counts_as_a_theme_change() {
        let colour = wide("ImmersiveColorSet");
        // SAFETY: each is NUL-terminated and alive for the call.
        unsafe {
            assert!(names(colour.as_ptr() as LPARAM, COLOUR_SET));
            assert!(!names(0, COLOUR_SET));
            assert!(!names(wide("Policy").as_ptr() as LPARAM, COLOUR_SET));
            assert!(!names(
                wide("ImmersiveColorSetX").as_ptr() as LPARAM,
                COLOUR_SET
            ));
            assert!(!names(wide("Immersive").as_ptr() as LPARAM, COLOUR_SET));
        }
    }

    /// The tray's size follows Windows' scaling as drawn: 16 at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %.
    #[test]
    fn small_icon_size_follows_the_scaling() {
        for (dpi, size) in [(96, 16), (120, 20), (144, 24), (192, 32)] {
            assert_eq!(small_icon_size_at(dpi), size, "at {dpi} dpi");
        }
    }

    /// Windows makes an icon from each icon file's PNG frame for both sizes at every common scaling.
    #[test]
    fn each_frame_makes_an_icon_at_every_scaling() {
        for taskbar in [Taskbar::Light, Taskbar::Dark] {
            for dpi in [96, 120, 144, 168, 192] {
                for metric in [SM_CXICON, SM_CXSMICON] {
                    let icon = make_icon(taskbar.icon_file(), metric, dpi)
                        .unwrap_or_else(|error| panic!("{taskbar:?} at {dpi}: {error}"));
                    // SAFETY: made just now, given to no one.
                    unsafe { DestroyIcon(icon) };
                }
            }
        }
    }

    /// The window shows the icons made for it, both sizes, and a second change replaces them.
    #[test]
    fn the_window_takes_both_icons() {
        let window = hidden_window();
        for taskbar in [Taskbar::Dark, Taskbar::Light] {
            set_window_icons(window as isize, taskbar.icon_file()).expect("the icons are set");
            let (big, small) = (*lock(&OURS)).expect("ours are kept");
            // SAFETY: the window is this thread's; WM_GETICON takes no pointer.
            unsafe {
                assert_eq!(SendMessageW(window, WM_GETICON, ICON_BIG as WPARAM, 0), big);
                assert_eq!(
                    SendMessageW(window, WM_GETICON, ICON_SMALL as WPARAM, 0),
                    small
                );
            }
        }
        // SAFETY: the window is this thread's and not used again.
        unsafe { DestroyWindow(window) };
    }

    /// Counts its calls, and its drops through the guard it holds.
    struct Dropped(Arc<AtomicUsize>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The watch acts once for the colour setting and once for a scaling change, after Windows' notice, never for
    /// another setting; a panic in it is caught; and its work is dropped once, with the window.
    #[test]
    fn the_watch_acts_on_the_colour_setting_and_scaling_only() {
        let window = hidden_window();
        let calls = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        let (counted, guard) = (Arc::clone(&calls), Dropped(Arc::clone(&drops)));
        on_taskbar_change(
            window as isize,
            Box::new(move || {
                let _held = &guard;
                if counted.fetch_add(1, Ordering::SeqCst) == 2 {
                    panic!("a panic in the work must not leave the window's procedure");
                }
            }),
        )
        .expect("the watch is set");
        let colour = wide("ImmersiveColorSet");
        let policy = wide("Policy");
        let rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: the window is this thread's; each pointer is alive for its message.
        unsafe {
            SendMessageW(window, WM_SETTINGCHANGE, 0, colour.as_ptr() as LPARAM);
            // Not yet: the work waits for its own message.
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            pump(window);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            SendMessageW(window, WM_SETTINGCHANGE, 0, policy.as_ptr() as LPARAM);
            SendMessageW(window, WM_SETTINGCHANGE, 0, 0);
            pump(window);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            SendMessageW(
                window,
                WM_DPICHANGED,
                0x0060_0060,
                ptr::from_ref(&rect) as LPARAM,
            );
            pump(window);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            // The third call panics inside; the test goes on.
            SendMessageW(
                window,
                WM_DPICHANGED,
                0x0060_0060,
                ptr::from_ref(&rect) as LPARAM,
            );
            pump(window);
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            DestroyWindow(window);
        }
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    /// Windows' taskbar setting reads on a real PC (light or dark, either is fine), rather than failing.
    #[test]
    fn taskbar_setting_reads() {
        assert!(super::super::taskbar_is_light().is_ok());
    }
}
