//! Windows' idle launch is a short-lived relay, never a second WebView2 host.
//! A named event crosses desktop boundaries; the resident owns all windows and cleanup.
#[cfg(windows)]
mod platform {
    use std::{time::Duration, os::windows::ffi::OsStrExt};
    use tauri::Manager;
    use windows::{core::{w, PCWSTR, PWSTR}, Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        System::{StationsAndDesktops::{CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, DESKTOP_CONTROL_FLAGS, UOI_NAME},
        Threading::{CreateEventW, CreateProcessW, GetCurrentThreadId, OpenEventW, ResetEvent, SetEvent, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, EVENT_MODIFY_STATE, PROCESS_INFORMATION, STARTUPINFOW, SYNCHRONIZATION_ACCESS_RIGHTS, SYNCHRONIZATION_SYNCHRONIZE}},
    }};

    const EVENT: PCWSTR = w!("Local\\com.rocco.robobuddy.screensaver-request-v1");

    /// Signalled whenever no screensaver of ours is on screen. The `.scr` Windows launched holds
    /// itself open on this instead of returning, so Windows sees a screen saver that lasts as long
    /// as the screensaver does. One that returns at once reads to Windows exactly like a saver the
    /// user dismissed, and the display and sleep idle timers then stop firing altogether: the
    /// machine sits at the screensaver forever with the monitors lit. Nothing registers a power
    /// request while that happens, so `powercfg /requests` shows nothing to explain it.
    const DONE: PCWSTR = w!("Local\\com.rocco.robobuddy.screensaver-done-v1");

    /// Longest a launched `.scr` waits before giving up, in case the resident dies without ever
    /// saying the screensaver ended. Long enough to sit through an afternoon of it; short enough
    /// that a stuck one does not own Windows' screen saver slot until the next sign-out.
    const DONE_CEILING_MS: u32 = 4 * 60 * 60 * 1000;

    fn done_access() -> SYNCHRONIZATION_ACCESS_RIGHTS {
        SYNCHRONIZATION_ACCESS_RIGHTS(EVENT_MODIFY_STATE.0 | SYNCHRONIZATION_SYNCHRONIZE.0)
    }

    fn launch_log(message: &str) {
        use std::io::Write;
        let Some(base) = std::env::var_os("APPDATA") else { return };
        let path = std::path::PathBuf::from(base).join("com.rocco.robobuddy").join("buddy.log");
        if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            let _ = writeln!(log, "{now} screensaver launcher: pid={} {message}", std::process::id());
        }
    }

    fn object_name(handle: HANDLE) -> Option<String> {
        let mut buffer = [0u16; 256];
        unsafe { GetUserObjectInformationW(handle, UOI_NAME, Some(buffer.as_mut_ptr().cast()), (buffer.len() * 2) as u32, None).ok()?; }
        Some(String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())]))
    }

    pub fn desktop_is_visible() -> bool {
        unsafe {
            let Ok(input) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return false };
            let input_name = object_name(HANDLE(input.0));
            let own_name = GetThreadDesktop(GetCurrentThreadId()).ok().and_then(|d| object_name(HANDLE(d.0)));
            let _ = CloseDesktop(input);
            input_name.is_some() && input_name == own_name
        }
    }

    fn signal() -> bool {
        unsafe {
            let Ok(event) = OpenEventW(EVENT_MODIFY_STATE, false, EVENT) else { return false };
            let sent = SetEvent(event).is_ok();
            let _ = CloseHandle(event);
            sent
        }
    }

    fn start_resident() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("robo-buddy.exe");
        if !exe.is_file() { return Err("robo-buddy.exe is missing beside the screensaver".into()); }
        let path: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut desktop: Vec<u16> = "winsta0\\default\0".encode_utf16().collect();
        let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, lpDesktop: PWSTR(desktop.as_mut_ptr()), ..Default::default() };
        let mut process = PROCESS_INFORMATION::default();
        // Do not inherit Windows' temporary saver desktop or its process lifetime.
        unsafe {
            CreateProcessW(PCWSTR(path.as_ptr()), None, None, None, false, CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, None, PCWSTR::null(), &startup, &mut process).map_err(|e| e.to_string())?;
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
        }
        Ok(())
    }

    /// Stay alive until the resident says the screensaver is over. Called only after the request
    /// has been delivered, so the resident exists and its event does too. Resetting here rather
    /// than waiting for the resident to do it closes the gap between the request and the
    /// screensaver actually coming up, during which the event is still signalled from last time.
    fn hold_until_done() {
        unsafe {
            let done = match OpenEventW(done_access(), false, DONE) {
                Ok(done) => done,
                // An older resident without the event, or one that just died. Returning at once is
                // the pre-fix behaviour: the screensaver still runs, the idle timers still stall.
                Err(e) => {
                    launch_log(&format!("no done event ({e}); returning at once"));
                    return;
                }
            };
            let _ = ResetEvent(done);
            let waited = WaitForSingleObject(done, DONE_CEILING_MS);
            let _ = CloseHandle(done);
            launch_log(&format!("screensaver over (wait={waited:?}); returning to Windows"));
        }
    }

    /// Tell any `.scr` holding itself open that the screensaver has ended, so it can return to
    /// Windows. Safe to call when none is waiting, and when no screensaver was ever up.
    pub fn screensaver_ended() {
        unsafe {
            if let Ok(done) = OpenEventW(EVENT_MODIFY_STATE, false, DONE) {
                let _ = SetEvent(done);
                let _ = CloseHandle(done);
            }
        }
    }

    /// Something is on screen now, whoever asked for it. Keeps "signalled means nothing is up"
    /// true even when the screensaver is started from the tray on top of a Windows-launched one,
    /// whose teardown would otherwise send that launcher home while ours carries on.
    pub fn screensaver_active() {
        unsafe {
            if let Ok(done) = OpenEventW(done_access(), false, DONE) {
                let _ = ResetEvent(done);
                let _ = CloseHandle(done);
            }
        }
    }

    pub fn relay() -> Result<(), String> {
        let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()).ok().and_then(|d| object_name(HANDLE(d.0))) };
        launch_log(&format!("start desktop={desktop:?}"));
        if !signal() {
            start_resident()?;
            let mut delivered = false;
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(100));
                if signal() {
                    delivered = true;
                    break;
                }
            }
            if !delivered {
                return Err("the resident buddy did not become ready for the screensaver".into());
            }
        }
        hold_until_done();
        Ok(())
    }

    pub fn listen(app: tauri::AppHandle) {
        std::thread::spawn(move || unsafe {
            let event = match CreateEventW(None, false, false, EVENT) {
                Ok(event) => event,
                Err(e) => { crate::chat::append_log(app, format!("screensaver relay: {e}")); return; }
            };
            // Manual reset, born signalled: nothing is on screen yet, so a `.scr` that arrives
            // before we ever show a screensaver must not be left holding. Owned by this thread for
            // the life of the process so the name stays alive between requests.
            let done = match CreateEventW(None, true, true, DONE) {
                Ok(done) => done,
                Err(e) => { crate::chat::append_log(app, format!("screensaver relay: {e}")); return; }
            };
            loop {
                if WaitForSingleObject(event, u32::MAX) != WAIT_OBJECT_0 { break; }
                crate::chat::append_log(app.clone(), format!("screensaver relay: request received; resident pid={} desktop visible={}", std::process::id(), desktop_is_visible()));
                // The .scr must return to Windows before we capture/show the ordinary desktop.
                // Never switch desktops ourselves or bypass the Windows lock screen.
                std::thread::sleep(Duration::from_millis(400));
                let mut visible = false;
                for _ in 0..30 {
                    if desktop_is_visible() { visible = true; break; }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !visible {
                    crate::chat::append_log(app.clone(), "screensaver relay: desktop not interactive; request expired".into());
                    // Nothing will come up, so release the launcher rather than leave Windows
                    // holding a screen saver that shows nothing until the ceiling runs out.
                    screensaver_ended();
                    continue;
                }
                if app.get_webview_window("screensaver-0").is_some() {
                    crate::chat::append_log(app.clone(), "screensaver relay: already running; request ignored".into());
                    continue;
                }
                crate::chat::append_log(app.clone(), "screensaver relay: Windows launch returned; starting on resident desktop".into());
                if let Err(e) = crate::screen::screensaver_start(app.clone()) {
                    crate::chat::append_log(app.clone(), format!("screensaver relay failed: {e}"));
                    let _ = crate::screen::screensaver_stop(app.clone());
                }
            }
            let _ = CloseHandle(event);
            let _ = CloseHandle(done);
        });
    }
}

#[cfg(windows)]
pub use platform::{listen, relay, screensaver_active, screensaver_ended};

/// Nothing launches us as a screen saver anywhere else, so there is no launcher to release.
#[cfg(not(windows))]
pub fn screensaver_ended() {}

#[cfg(not(windows))]
pub fn screensaver_active() {}
