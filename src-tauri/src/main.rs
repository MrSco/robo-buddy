// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod desktop_guard {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Environment::GetCommandLineW;
    use windows::Win32::System::StationsAndDesktops::{
        GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
    };
    use windows::Win32::System::Threading::{
        CreateProcessW, GetCurrentThreadId, GetExitCodeProcess, WaitForSingleObject,
        INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
    };

    pub fn ensure_interactive_desktop() {
        // Prevent recursive spawns
        if std::env::var_os("ROBO_DESKTOP_ENFORCED").is_some() {
            return;
        }

        // Headless idle saver guard process doesn't need interactive UI
        if std::env::args().any(|a| a == "--idle-saver-guard") {
            return;
        }

        unsafe {
            let tid = GetCurrentThreadId();
            if let Ok(hdesk) = GetThreadDesktop(tid) {
                if !hdesk.is_invalid() {
                    let mut buf = [0u16; 256];
                    let mut needed = 0u32;
                    if GetUserObjectInformationW(
                        HANDLE(hdesk.0),
                        UOI_NAME,
                        Some(buf.as_mut_ptr().cast()),
                        (buf.len() * 2) as u32,
                        Some(&mut needed),
                    )
                    .is_ok()
                    {
                        let len = (needed as usize / 2).saturating_sub(1);
                        let name = String::from_utf16_lossy(&buf[..len.min(buf.len())]);
                        if name.eq_ignore_ascii_case("default") {
                            return;
                        }
                    }
                }
            }

            // Running on an isolated/non-interactive desktop station (e.g. IDE terminal sandbox).
            // Re-spawn on WinSta0\Default so the window, tray icon, and notifications appear on screen!
            std::env::set_var("ROBO_DESKTOP_ENFORCED", "1");

            let mut desktop_name: Vec<u16> = "WinSta0\\Default\0".encode_utf16().collect();
            let raw_cmd = GetCommandLineW();
            let cmd_str = raw_cmd.to_string().unwrap_or_default();
            let mut cmd: Vec<u16> = cmd_str.encode_utf16().chain(std::iter::once(0)).collect();

            let mut si = STARTUPINFOW::default();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.lpDesktop = PWSTR(desktop_name.as_mut_ptr());

            let mut pi = PROCESS_INFORMATION::default();

            if CreateProcessW(
                None,
                Some(PWSTR(cmd.as_mut_ptr())),
                None,
                None,
                true,
                Default::default(),
                None,
                None,
                &si,
                &mut pi,
            )
            .is_ok()
            {
                let _ = WaitForSingleObject(pi.hProcess, INFINITE);
                let mut code = 0u32;
                let _ = GetExitCodeProcess(pi.hProcess, &mut code);
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
                std::process::exit(code as i32);
            }
        }
    }
}

fn main() {
    #[cfg(windows)]
    desktop_guard::ensure_interactive_desktop();

    robo_buddy_lib::run()
}

