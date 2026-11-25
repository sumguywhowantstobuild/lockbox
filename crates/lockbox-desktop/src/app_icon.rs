//! Petalock's icon by the clock, on the taskbar and in the title bar, in the colour for the taskbar Windows shows
//! (design: "Name and logo"). One colour can't serve both: the slate blue that stands out on a light taskbar looks dull on
//! a dark one, and a light blue that stands out on a dark one fades on a light one. So both icons ship
//! (`scripts/make-icon.mjs` draws them) and Windows' own light or dark setting for its taskbar picks one, again whenever
//! that setting or the screen's scaling changes. The program's own icon in Explorer stays `icon.ico`: Explorer can't
//! switch icons by theme.

use std::io::Cursor;

use tauri::image::Image;
use tauri::{AppHandle, Runtime, WebviewWindow};

/// The icon for a light taskbar, in slate blue: also the program's own icon (`tauri.conf.json`).
const LIGHT_TASKBAR: &[u8] = include_bytes!("../icons/icon.ico");
/// The icon for a dark taskbar, in light slate blue.
const DARK_TASKBAR: &[u8] = include_bytes!("../icons/icon-dark-taskbar.ico");

/// The taskbar Windows shows, from its own "Choose your default Windows mode" setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taskbar {
    Light,
    Dark,
}

impl Taskbar {
    /// The taskbar Windows shows now. Dark when Windows can't say: it is Windows 11's own default, and the light icon
    /// still measures 3.8 to 1 there, while the dark icon would fade on a light taskbar.
    pub fn now() -> Taskbar {
        match crate::os::win::taskbar_is_light() {
            Ok(true) => Taskbar::Light,
            Ok(false) | Err(_) => Taskbar::Dark,
        }
    }

    /// The `.ico` file drawn for this taskbar.
    pub fn icon_file(self) -> &'static [u8] {
        match self {
            Taskbar::Light => LIGHT_TASKBAR,
            Taskbar::Dark => DARK_TASKBAR,
        }
    }
}

/// The PNG bytes of the frame in `ico` for `size` pixels: that size if drawn, else the smallest larger one (Windows
/// shrinks it a little), else the largest. `None` when the file isn't an `.ico` of PNG frames as `make-icon.mjs` writes.
pub(crate) fn frame(ico: &[u8], size: u32) -> Option<&[u8]> {
    let count = usize::from(u16::from_le_bytes([*ico.get(4)?, *ico.get(5)?]));
    let mut frames = Vec::with_capacity(count);
    for index in 0..count {
        let entry = ico.get(6 + 16 * index..6 + 16 * (index + 1))?;
        // 0 means 256.
        let side = match entry[0] {
            0 => 256,
            side => u32::from(side),
        };
        let length = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let offset = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        frames.push((side, ico.get(offset..offset.checked_add(length)?)?));
    }
    frames
        .iter()
        .filter(|(side, _)| *side >= size)
        .min_by_key(|(side, _)| *side)
        .or_else(|| frames.iter().max_by_key(|(side, _)| *side))
        .map(|(_, png)| *png)
}

/// A frame's picture for the tray: its pixels as red, green, blue and alpha. `None` when the bytes are not an 8-bit RGBA
/// PNG, the only kind `make-icon.mjs` writes.
pub(crate) fn picture(png: &[u8]) -> Option<Image<'static>> {
    let mut reader = png::Decoder::new(Cursor::new(png)).read_info().ok()?;
    let mut pixels = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut pixels).ok()?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    pixels.truncate(info.buffer_size());
    Some(Image::new_owned(pixels, info.width, info.height))
}

/// The tray's picture for `taskbar`, at Windows' small icon size for the system's scaling (the size the clock's corner
/// draws its icons at).
pub(crate) fn tray_picture(taskbar: Taskbar) -> Option<Image<'static>> {
    picture(frame(
        taskbar.icon_file(),
        crate::os::win::icons::small_icon_size(),
    )?)
}

/// Puts the icon for the taskbar Windows shows now on the window (its taskbar button, its title bar and Alt+Tab) and by
/// the clock. Nothing changes where Windows refuses: the icon Tauri gave the window stays, which is only a colour off.
pub fn apply<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let taskbar = Taskbar::now();
    crate::tray::set_picture(app, tray_picture(taskbar));
    if let Ok(handle) = window.hwnd() {
        let _ = crate::os::win::icons::set_window_icons(handle.0 as isize, taskbar.icon_file());
    }
}

/// [`apply`] now, and again each time Windows says its light or dark setting or the window's screen scaling changed. The
/// watch acts in a message of its own, posted after Windows' notice, on the window's thread.
pub fn follow_taskbar<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    apply(app, window);
    if let Ok(handle) = window.hwnd() {
        let (app, window) = (app.clone(), window.clone());
        let _ = crate::os::win::icons::on_taskbar_change(
            handle.0 as isize,
            Box::new(move || apply(&app, &window)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pixels of a picture that are drawn at all, as their colour.
    fn colours(image: &Image<'_>) -> Vec<[u8; 3]> {
        image
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|[.., alpha]| *alpha > 0)
            .map(|[red, green, blue, _]| [*red, *green, *blue])
            .collect()
    }

    #[test]
    fn each_taskbar_gets_its_own_colour() {
        // Slate blue on a light taskbar, light slate blue on a dark one: the colours make-icon.mjs draws.
        for (taskbar, colour) in [
            (Taskbar::Light, [0x5b, 0x7b, 0xa8]),
            (Taskbar::Dark, [0xbc, 0xd0, 0xec]),
        ] {
            let image =
                picture(frame(taskbar.icon_file(), 16).expect("a 16 px frame")).expect("a picture");
            assert_eq!((image.width(), image.height()), (16, 16));
            let drawn = colours(&image);
            assert!(!drawn.is_empty(), "{taskbar:?}: nothing drawn");
            assert!(drawn.iter().all(|pixel| *pixel == colour), "{taskbar:?}");
        }
        // The light taskbar's icon is the program's own, the one Explorer shows (compared, not printed, on failure).
        assert!(Taskbar::Light.icon_file() == include_bytes!("../icons/icon.ico"));
        assert!(Taskbar::Dark.icon_file() != Taskbar::Light.icon_file());
    }

    #[test]
    fn the_frame_for_a_size_is_that_size_or_the_next_larger() {
        let side = |size| {
            let png = frame(LIGHT_TASKBAR, size).expect("a frame");
            picture(png).expect("a picture").width()
        };
        // Drawn sizes: 16, 20, 24, 32, 40, 48, 64, 256.
        assert_eq!(side(16), 16);
        assert_eq!(side(20), 20);
        assert_eq!(side(24), 24);
        assert_eq!(side(32), 32);
        // 175 % (28) and 225 % (36) take the next larger drawing, which Windows shrinks a little.
        assert_eq!(side(28), 32);
        assert_eq!(side(36), 40);
        assert_eq!(side(100), 256);
        // Larger than any: the largest.
        assert_eq!(side(512), 256);
    }

    #[test]
    fn a_damaged_icon_file_gives_no_frame() {
        assert!(frame(&[], 16).is_none());
        assert!(frame(&[0, 0, 1, 0], 16).is_none());
        // Five frames listed, no directory after the header.
        assert!(frame(&[0, 0, 1, 0, 5, 0], 16).is_none());
        // One frame listed, its bytes past the file's end.
        let mut short = LIGHT_TASKBAR[..6 + 16].to_vec();
        short[4] = 1;
        assert!(frame(&short, 16).is_none());
        // Not a PNG.
        assert!(picture(b"not a png").is_none());
    }
}
