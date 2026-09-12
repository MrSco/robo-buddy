//! Windows' idle launch is a short-lived relay, never a second WebView2 host.
//! A named event crosses desktop boundaries; the resident owns all windows and cleanup.
#[cfg(windows)]
mod platform {
    use std::{time::Duration, os::windows::ffi::OsStrExt};
    use tauri::Manager;
    use windows::{core::{w, PCWSTR, PWSTR}, Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        System::{StationsAndDesktops::{CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, DESKTOP_CONTROL_FLAGS, UOI_NAME},
        Threading::{CreateEventW, CreateProcessW, GetCurrentThreadId, OpenEventW, SetEvent, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, EVENT_MODIFY_STATE, PROCESS_INFORMATION, STARTUPINFOW}},
    }};

    const EVENT: PCWSTR = w!("Local\\com.rocco.robobuddy.screensaver-request-v1");

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

    pub fn relay() -> Result<(), String> {
        if signal() { return Ok(()); }
        start_resident()?;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            if signal() { return Ok(()); }
        }
        Err("the resident buddy did not become ready for the screensaver".into())
    }

    pub fn listen(app: tauri::AppHandle) {
        std::thread::spawn(move || unsafe {
            let event = match CreateEventW(None, false, false, EVENT) {
                Ok(event) => event,
                Err(e) => { crate::chat::append_log(app, format!("screensaver relay: {e}")); return; }
            };
            loop {
                if WaitForSingleObject(event, u32::MAX) != WAIT_OBJECT_0 { break; }
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
                    continue;
                }
                if app.get_webview_window("screensaver-0").is_some() { continue; }
                crate::chat::append_log(app.clone(), "screensaver relay: Windows launch returned; starting on resident desktop".into());
                if let Err(e) = crate::screen::screensaver_start(app.clone()) {
                    crate::chat::append_log(app.clone(), format!("screensaver relay failed: {e}"));
                    let _ = crate::screen::screensaver_stop(app.clone());
                }
            }
            let _ = CloseHandle(event);
        });
    }
}

#[cfg(windows)]
pub use platform::{listen, relay};
