//! Native "the computer is going to sleep / the screen locked" signals, as a `system-lock` event
//! (payload "sleep" or "screen") the frontend turns into an app lock when that setting is on.

use tauri::AppHandle;

/// logind signal → lock reason. `value` is PrepareForSleep's flag, or the session's new
/// `LockedHint` for a PropertiesChanged signal; the plain `Lock` signal carries none.
pub(crate) fn linux_signal_reason(member: &str, value: Option<bool>) -> Option<&'static str> {
    match (member, value) {
        ("PrepareForSleep", Some(true)) => Some("sleep"),
        ("Lock", _) | ("PropertiesChanged", Some(true)) => Some("screen"),
        _ => None,
    }
}

/// Starts the platform listener. Never blocks or fails setup: without it (no logind, a
/// sandbox…) only the idle timer and Lock now remain.
pub fn start(app: AppHandle) {
    #[cfg(target_os = "linux")]
    linux::start(app);
    #[cfg(windows)]
    windows_events::start(app);
    #[cfg(target_os = "macos")]
    macos::start(app);
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    let _ = app;
}

#[cfg(target_os = "linux")]
mod linux {
    use super::linux_signal_reason;
    use std::collections::HashMap;
    use tauri::{AppHandle, Emitter};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue};

    const LOGIND: &str = "org.freedesktop.login1";
    const MANAGER_PATH: &str = "/org/freedesktop/login1";

    fn emit(app: &AppHandle, member: &str, value: Option<bool>) {
        if let Some(reason) = linux_signal_reason(member, value) {
            let _ = app.emit("system-lock", reason);
        }
    }

    fn sleep(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let manager = Proxy::new(&conn, LOGIND, MANAGER_PATH, "org.freedesktop.login1.Manager")?;
        for msg in manager.receive_signal("PrepareForSleep")? {
            emit(app, "PrepareForSleep", msg.body().deserialize::<bool>().ok());
        }
        Ok(())
    }

    /// The real object path of this process's session ("auto" only resolves in method calls).
    fn session_path(conn: &Connection) -> zbus::Result<OwnedObjectPath> {
        let manager = Proxy::new(conn, LOGIND, MANAGER_PATH, "org.freedesktop.login1.Manager")?;
        manager
            .call("GetSession", &("auto",))
            .or_else(|_| manager.call("GetSessionByPID", &(std::process::id(),)))
    }

    fn screen(app: &AppHandle) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let path = session_path(&conn)?;
        let session = Proxy::new(&conn, LOGIND, path.as_str(), "org.freedesktop.login1.Session")?;
        let props = Proxy::new(&conn, LOGIND, path.as_str(), "org.freedesktop.DBus.Properties")?;
        let locks = session.receive_signal("Lock")?;
        let changes = props.receive_signal("PropertiesChanged")?;
        // `loginctl lock-session` sends Lock; desktop lockers (GNOME, KDE) set LockedHint.
        let lock_app = app.clone();
        std::thread::spawn(move || {
            for _ in locks {
                emit(&lock_app, "Lock", None);
            }
        });
        for msg in changes {
            let Ok((iface, changed, _)) = msg.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>() else {
                continue;
            };
            if iface != "org.freedesktop.login1.Session" {
                continue;
            }
            let hint = changed.get("LockedHint").and_then(|v| bool::try_from(v).ok());
            emit(app, "PropertiesChanged", hint);
        }
        Ok(())
    }

    pub fn start(app: AppHandle) {
        let sleep_app = app.clone();
        let _ = std::thread::Builder::new().name("system-lock-sleep".into()).spawn(move || {
            if let Err(e) = sleep(&sleep_app) {
                eprintln!("system lock: sleep signals unavailable: {e}");
            }
        });
        let _ = std::thread::Builder::new().name("system-lock-screen".into()).spawn(move || {
            if let Err(e) = screen(&app) {
                eprintln!("system lock: screen-lock signals unavailable: {e}");
            }
        });
    }
}

#[cfg(windows)]
mod windows_events {
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::core::w;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::RegisterSuspendResumeNotification;
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, DEVICE_NOTIFY_WINDOW_HANDLE, MSG,
        PBT_APMSUSPEND,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let reason = match msg {
            WM_WTSSESSION_CHANGE if wparam.0 as u32 == WTS_SESSION_LOCK => Some("screen"),
            WM_POWERBROADCAST if wparam.0 as u32 == PBT_APMSUSPEND => Some("sleep"),
            _ => None,
        };
        if let (Some(reason), Some(app)) = (reason, APP.get()) {
            let _ = app.emit("system-lock", reason);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// A hidden top-level window (message-only windows miss broadcasts like WM_POWERBROADCAST)
    /// registered for session notifications, pumping messages on its own thread.
    fn run() -> windows::core::Result<()> {
        unsafe {
            let instance: HINSTANCE = GetModuleHandleW(None)?.into();
            let class = w!("ShetuSystemLock");
            let wc = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance, lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!("Shetu system lock"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance),
                None,
            )?;
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)?;
            // Connected standby (Modern Standby) sends suspend only to windows registered for it.
            // Kept for the app's lifetime, like this thread, so it is never unregistered.
            if let Err(e) = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE) {
                // Session-lock notifications still work; only connected-standby sleep is missed.
                eprintln!("system lock: suspend notifications unavailable: {e}");
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        let _ = std::thread::Builder::new().name("system-lock".into()).spawn(|| {
            if let Err(e) = run() {
                eprintln!("system lock: session notifications unavailable: {e}");
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillSleepNotification};
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};
    use std::ptr::NonNull;
    use tauri::{AppHandle, Emitter};

    /// Observers registered on the main thread (in setup) and kept for the app's lifetime.
    pub fn start(app: AppHandle) {
        let sleep_app = app.clone();
        let on_sleep = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = sleep_app.emit("system-lock", "sleep");
        });
        let on_screen = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = app.emit("system-lock", "screen");
        });
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let token = workspace.notificationCenter().addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &on_sleep,
            );
            std::mem::forget(token);
            let screen_locked = NSString::from_str("com.apple.screenIsLocked");
            let token = NSDistributedNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(&screen_locked),
                None,
                None,
                &on_screen,
            );
            std::mem::forget(token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_signal_reason_maps_logind_signals() {
        assert_eq!(linux_signal_reason("PrepareForSleep", Some(true)), Some("sleep"));
        assert_eq!(linux_signal_reason("PrepareForSleep", Some(false)), None);
        assert_eq!(linux_signal_reason("Lock", None), Some("screen"));
        assert_eq!(linux_signal_reason("Unlock", None), None);
        // GNOME/KDE's own lock (Super+L) only flips LockedHint.
        assert_eq!(linux_signal_reason("PropertiesChanged", Some(true)), Some("screen"));
        assert_eq!(linux_signal_reason("PropertiesChanged", Some(false)), None);
        assert_eq!(linux_signal_reason("PropertiesChanged", None), None);
    }
}
