//! Calls into the operating system. `win` is the only module of the crate allowed `unsafe`.

#[cfg(windows)]
pub mod win;
