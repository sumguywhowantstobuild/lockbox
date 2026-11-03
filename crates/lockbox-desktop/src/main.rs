// Release builds open no console window next to the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(unsafe_code)]

fn main() {
    lockbox_desktop::run();
}
