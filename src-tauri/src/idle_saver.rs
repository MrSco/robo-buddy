//! Resident idle mode. A small, separate process holds a runtime-only Windows saver lease.
//! Closing the pipe (including a resident crash) restores Windows without needing Tauri.
use tauri::Manager;

#[cfg(windows)]
mod platform {
    use std::{io::{BufRead, Read, Write}, os::windows::process::CommandExt, process::{Child, Stdio}, time::Duration};
    use winreg::{RegKey, enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}};
    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETSCREENSAVEACTIVE, SPI_GETSCREENSAVESECURE, SPI_SETSCREENSAVEACTIVE};

    pub fn parameter(action: windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_ACTION) -> Result<bool, String> {
        let mut value = windows::core::BOOL(0);
        unsafe { SystemParametersInfoW(action, 0, Some((&mut value as *mut windows::core::BOOL).cast()), Default::default()) }.map_err(|e| e.to_string())?;
        Ok(value.as_bool())
    }

    // Deliberately omit SPIF_UPDATEINIFILE: the user's persisted preference never changes.
    fn active(value: bool) -> Result<(), String> {
        unsafe { SystemParametersInfoW(SPI_SETSCREENSAVEACTIVE, value as u32, None, Default::default()) }.map_err(|e| e.to_string())
    }

    pub fn selected() -> String {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\Desktop")
            .ok().and_then(|k| k.get_value::<String, _>("SCRNSAVE.EXE").ok()).unwrap_or_default()
            .trim().trim_matches('"').to_string()
    }

    pub fn allowed() -> Result<(), String> {
        if parameter(SPI_GETSCREENSAVESECURE)? {
            return Err("Windows password-protected screensaver is enabled. Automatic Buddy mode stays off to preserve its locking behavior.".into());
        }
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Ok(key) = RegKey::predef(root).open_subkey(r"Software\Policies\Microsoft\Windows\Control Panel\Desktop") {
                if ["ScreenSaveActive", "ScreenSaverIsSecure", "ScreenSaveTimeOut", "SCRNSAVE.EXE"].iter().any(|n| key.get_raw_value(n).is_ok()) {
                    return Err("Windows screensaver is managed by policy; automatic Buddy mode is unavailable.".into());
                }
            }
        }
        Ok(())
    }

    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    pub struct Snapshot { enabled: bool, preferences: Vec<Option<String>> }
    impl Snapshot {
        fn preferences() -> Vec<Option<String>> {
            let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\Desktop").ok();
            ["SCRNSAVE.EXE", "ScreenSaveActive", "ScreenSaveTimeOut", "ScreenSaverIsSecure"].iter()
                .map(|n| key.as_ref().and_then(|k| k.get_raw_value(n).ok()).map(|v| format!("{v:?}"))).collect()
        }
        fn capture() -> Result<Self, String> {
            Ok(Self { enabled: parameter(SPI_GETSCREENSAVEACTIVE)?, preferences: Self::preferences() })
        }
        pub fn unchanged(&self) -> bool { self.preferences == Self::preferences() }
        pub fn restore(&self) {
            // A control-panel change belongs to the user, even while we hold the lease.
            let desired = if self.unchanged() { self.enabled } else {
                // If the user changed the path, timeout or lock preference, apply their latest
                // persisted active flag rather than leaving our temporary suppression behind.
                RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\Desktop").ok()
                    .and_then(|k| k.get_value::<String, _>("ScreenSaveActive").ok()).map(|v| v == "1").unwrap_or(false)
            };
            if desired && parameter(SPI_GETSCREENSAVEACTIVE) == Ok(false) { let _ = active(true); }
        }
    }

    pub fn guard() -> Result<(), String> {
        allowed()?;
        let before = Snapshot::capture()?;
        active(false)?;
        // The parent waits for this acknowledgement before enabling its idle watcher.
        let result = (|| -> Result<(), String> {
            println!("{}", serde_json::to_string(&before).map_err(|e| e.to_string())?);
            std::io::stdout().flush().map_err(|e| e.to_string())?;
            let mut byte = [0u8; 1];
            let _ = std::io::stdin().read(&mut byte);
            Ok(())
        })();
        before.restore();
        result
    }

    pub struct Lease { child: Child, before: Snapshot }
    impl Lease {
        pub fn acquire() -> Result<Self, String> {
            allowed()?;
            let fallback = Snapshot::capture()?;
            let mut child = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .arg("--idle-saver-guard").creation_flags(0x08000000)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
            let stdout = child.stdout.take().ok_or("missing guard output")?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = std::io::BufReader::new(stdout).read_line(&mut line).map(|_| line);
                let _ = tx.send(result);
            });
            match rx.recv_timeout(Duration::from_secs(5)).ok().and_then(Result::ok).and_then(|line| serde_json::from_str(&line).ok()) {
                Some(before) => Ok(Self { child, before }),
                None => {
                    drop(child.stdin.take());
                    let _ = child.kill();
                    let _ = child.wait();
                    fallback.restore();
                    Err("Could not start Windows screensaver recovery; automatic mode remains off.".into())
                }
            }
        }
        pub fn healthy(&mut self) -> bool {
            matches!(self.child.try_wait(), Ok(None)) && self.before.unchanged()
                && parameter(SPI_GETSCREENSAVEACTIVE) == Ok(false) && allowed().is_ok()
        }
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            drop(self.child.stdin.take());
            for _ in 0..100 {
                if !matches!(self.child.try_wait(), Ok(None)) { self.before.restore(); return; }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.before.restore();
        }
    }
}

pub fn guard_entry() -> bool {
    if !std::env::args().any(|a| a == "--idle-saver-guard") { return false; }
    #[cfg(windows)]
    let _ = platform::guard();
    true
}

pub fn windows_backdrop() -> String {
    #[cfg(windows)]
    { platform::selected() }
    #[cfg(not(windows))]
    { String::new() }
}

#[derive(Default)]
pub struct State {
    #[cfg(windows)]
    lease: std::sync::Mutex<Option<platform::Lease>>,
    status: std::sync::Mutex<String>,
}

#[tauri::command]
pub fn idle_saver_status(app: tauri::AppHandle) -> String {
    app.state::<State>().status.lock().unwrap().clone()
}

#[tauri::command]
pub async fn set_idle_screensaver(app: tauri::AppHandle, minutes: f64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || configure(app, minutes)).await.map_err(|e| e.to_string())?
}

fn configure(app: tauri::AppHandle, minutes: f64) -> Result<String, String> {
    if !minutes.is_finite() || !(0.0..=120.0).contains(&minutes) {
        return Err("Choose between 0 and 120 minutes (0 turns automatic mode off).".into());
    }
    #[cfg(windows)]
    {
        if minutes > 0.0 { crate::screen::migrate_windows_saver(&app)?; }
        let state = app.state::<State>();
        let mut lease = state.lease.lock().map_err(|e| e.to_string())?;
        if minutes > 0.0 && lease.is_none() { *lease = Some(platform::Lease::acquire()?); }
        if minutes == 0.0 { lease.take(); let _ = crate::screen::screensaver_stop(app.clone()); }
        crate::settings::update(&app, |s| s.screensaver_after_min = minutes);
        let message = if minutes == 0.0 { "Automatic Buddy mode is off. Windows handles your screensaver normally.".into() }
            else { format!("Buddy starts after {minutes} minutes idle. Your Windows screensaver returns when Buddy closes.") };
        *state.status.lock().unwrap() = message.clone();
        Ok(message)
    }
    #[cfg(not(windows))]
    { let _ = app; Err("Windows only".into()) }
}

pub fn shutdown(app: &tauri::AppHandle) {
    #[cfg(windows)]
    if let Ok(mut lease) = app.state::<State>().lease.lock() { lease.take(); }
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = crate::screen::migrate_windows_saver(&app) {
            *app.state::<State>().status.lock().unwrap() = e.clone();
            crate::chat::append_log(app, format!("idle screensaver migration: {e}"));
            return;
        }
        let minutes = app.state::<crate::settings::SettingsState>().0.lock().unwrap().screensaver_after_min;
        if let Err(e) = configure(app.clone(), minutes) {
            crate::settings::update(&app, |s| s.screensaver_after_min = 0.0);
            *app.state::<State>().status.lock().unwrap() = e;
        }
        let mut episode = crate::idle_episode::IdleEpisode::default();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let settings = app.state::<crate::settings::SettingsState>().0.lock().unwrap().clone();
            if settings.screensaver_after_min <= 0.0 { continue; }
            #[cfg(windows)]
            {
                let state = app.state::<State>();
                let healthy = state.lease.lock().unwrap().as_mut().map(|l| l.healthy()).unwrap_or(false);
                if !healthy {
                    let _ = configure(app.clone(), 0.0);
                    *state.status.lock().unwrap() = "Automatic mode stopped because Windows screensaver settings changed or its recovery helper exited.".into();
                    let _ = crate::screen::screensaver_stop(app.clone());
                    continue;
                }
            }
            if !crate::input::desktop_is_visible() {
                if app.get_webview_window("screensaver-0").is_some() { let _ = crate::screen::screensaver_stop(app.clone()); }
                continue;
            }
            let Some((last_input, idle)) = crate::input::idle_time() else { continue };
            let up = app.get_webview_window("screensaver-0").is_some();
            let blocked = settings.hide_when_fullscreen && crate::input::foreground_is_fullscreen();
            if !episode.should_start(last_input, idle, settings.screensaver_after_min, up, blocked) { continue; }
            crate::chat::append_log(app.clone(), format!("idle screensaver: starting after {idle:.0}s"));
            if let Err(e) = crate::screen::screensaver_start(app.clone()) {
                crate::chat::append_log(app.clone(), format!("idle screensaver: {e}"));
                let _ = crate::screen::screensaver_stop(app.clone());
            }
        }
    });
}
