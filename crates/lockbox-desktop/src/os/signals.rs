//! Which Windows messages are lock signals ([`classify`]). Safe and pure: `os::win` owns the window and reads the
//! message's pointers, then asks here.

use windows_sys::Win32::UI::WindowsAndMessaging::{
    DBT_DEVICEREMOVECOMPLETE, DBT_DEVTYP_VOLUME, PBT_APMSUSPEND, WM_DEVICECHANGE, WM_ENDSESSION,
    WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT,
    WTS_SESSION_LOCK, WTS_SESSION_LOGOFF,
};

use super::OsSignal;

/// The part of a `WM_DEVICECHANGE` message's `DEV_BROADCAST_HDR` that [`classify`] reads; `os::win` copies it out
/// of the message (and `unitmask` out of `DEV_BROADCAST_VOLUME`, 0 for other device kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceHeader {
    pub kind: u32,
    pub unitmask: u32,
}

/// Whether [`classify`] needs the message's device header: only for a device that went away, whose `lparam` then
/// points to a `DEV_BROADCAST_HDR`.
pub fn wants_device_header(msg: u32, wparam: usize) -> bool {
    msg == WM_DEVICECHANGE && u32::try_from(wparam) == Ok(DBT_DEVICEREMOVECOMPLETE)
}

/// The lock signal a window message carries, if any (spec §7.4 and §6.10).
///
/// Locking the session, signing out, a switch to another user (this session loses the console) and a remote-desktop
/// disconnect are all [`OsSignal::SessionLocked`]; sleep and hibernate are [`OsSignal::Suspending`]; a sign-out or
/// shutdown that goes ahead is [`OsSignal::Ending`]; a volume that went away is [`OsSignal::DriveRemoved`].
pub fn classify(msg: u32, wparam: usize, header: Option<DeviceHeader>) -> Option<OsSignal> {
    if wants_device_header(msg, wparam) {
        return match header {
            Some(DeviceHeader {
                kind: DBT_DEVTYP_VOLUME,
                unitmask,
            }) => Some(OsSignal::DriveRemoved { mask: unitmask }),
            _ => None,
        };
    }
    // `WM_ENDSESSION`'s wparam is a BOOL: any non-zero value means the session is ending.
    if msg == WM_ENDSESSION {
        return (wparam != 0).then_some(OsSignal::Ending);
    }
    // Session and power codes are 32-bit; a wparam with higher bits set is neither.
    let code = u32::try_from(wparam).ok()?;
    match (msg, code) {
        (
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_LOCK | WTS_SESSION_LOGOFF | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT,
        ) => Some(OsSignal::SessionLocked),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(OsSignal::Suspending),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DBT_DEVICEARRIVAL, DBT_DEVICEREMOVECOMPLETE, DBT_DEVTYP_PORT, DBT_DEVTYP_VOLUME,
        PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_DEVICECHANGE,
        WM_ENDSESSION, WM_POWERBROADCAST, WM_QUERYENDSESSION, WM_WTSSESSION_CHANGE,
        WTS_CONSOLE_CONNECT, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK,
        WTS_SESSION_LOGOFF, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK,
    };

    use super::*;

    fn volume(unitmask: u32) -> Option<DeviceHeader> {
        Some(DeviceHeader {
            kind: DBT_DEVTYP_VOLUME,
            unitmask,
        })
    }

    #[test]
    fn classify_table() {
        use OsSignal::*;
        let locked = Some(SessionLocked);
        let port = Some(DeviceHeader {
            kind: DBT_DEVTYP_PORT,
            unitmask: 0,
        });
        let cases: &[(u32, u32, Option<DeviceHeader>, Option<OsSignal>)] = &[
            // Locking, signing out, switching user and a remote-desktop disconnect all count as Windows lock (§7.4).
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK, None, locked),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOGOFF, None, locked),
            (WM_WTSSESSION_CHANGE, WTS_CONSOLE_DISCONNECT, None, locked),
            (WM_WTSSESSION_CHANGE, WTS_REMOTE_DISCONNECT, None, locked),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK, None, None),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOGON, None, None),
            (WM_WTSSESSION_CHANGE, WTS_CONSOLE_CONNECT, None, None),
            // Sleep and hibernate; waking up is not a signal.
            (WM_POWERBROADCAST, PBT_APMSUSPEND, None, Some(Suspending)),
            (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC, None, None),
            (WM_POWERBROADCAST, PBT_APMRESUMESUSPEND, None, None),
            // A sign-out or shutdown going ahead (wparam TRUE) is a signal; one called off (FALSE) is not, and nor is
            // Windows' question before it (WM_QUERYENDSESSION).
            (WM_ENDSESSION, 1, None, Some(Ending)),
            (WM_ENDSESSION, 0, None, None),
            (WM_QUERYENDSESSION, 0, None, None),
            // A volume went away; other device kinds, arrivals and a removal without its header are not signals.
            (
                WM_DEVICECHANGE,
                DBT_DEVICEREMOVECOMPLETE,
                volume(0b100),
                Some(DriveRemoved { mask: 0b100 }),
            ),
            (WM_DEVICECHANGE, DBT_DEVICEREMOVECOMPLETE, port, None),
            (WM_DEVICECHANGE, DBT_DEVICEREMOVECOMPLETE, None, None),
            (WM_DEVICECHANGE, DBT_DEVICEARRIVAL, volume(0b100), None),
            // A code means something only with its own message (7 is also PBT_APMRESUMESUSPEND and
            // DBT_DEVNODES_CHANGED, neither a signal).
            (WM_POWERBROADCAST, WTS_SESSION_LOCK, None, None),
            (WM_DEVICECHANGE, WTS_SESSION_LOCK, volume(0b100), None),
        ];
        for &(msg, wparam, header, expected) in cases {
            let wparam = usize::try_from(wparam).expect("u32 fits in usize on Windows");
            assert_eq!(
                classify(msg, wparam, header),
                expected,
                "message {msg:#x}, wparam {wparam:#x}, header {header:?}"
            );
        }
    }

    /// A wparam beyond 32 bits is no session or power code, even when its low bits are one.
    #[cfg(target_pointer_width = "64")]
    #[test]
    fn classify_ignores_high_wparam_bits() {
        let high = 1usize << 32;
        for (msg, code) in [
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK),
            (WM_POWERBROADCAST, PBT_APMSUSPEND),
            (WM_DEVICECHANGE, DBT_DEVICEREMOVECOMPLETE),
        ] {
            let wparam = high | usize::try_from(code).expect("u32 fits in usize");
            assert_eq!(
                classify(msg, wparam, volume(0b100)),
                None,
                "message {msg:#x}"
            );
        }
    }
}
