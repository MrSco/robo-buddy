//! Context awareness watcher: detects active foreground application, window title,
//! user idle duration, and sensitive/private contexts, broadcasting updates to the frontend.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvent {
    pub process: String,
    pub title: String,
    pub idle_seconds: f64,
    pub is_sensitive: bool,
}

#[cfg(windows)]
mod platform {
    use std::path::Path;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn foreground_window_info() -> Option<(String, String, u32)> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() || hwnd == GetShellWindow() || hwnd == GetDesktopWindow() {
                return None;
            }

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return None;
            }

            let process = process_name(pid).unwrap_or_default();
            let title = window_title(hwnd);

            Some((process, title, pid))
        }
    }

    fn process_name(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(handle);

            if ok && size > 0 {
                let path = String::from_utf16_lossy(&buf[..size as usize]);
                Path::new(&path)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
            } else {
                None
            }
        }
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let read = GetWindowTextW(hwnd, &mut buf);
            if read > 0 {
                String::from_utf16_lossy(&buf[..read as usize])
            } else {
                String::new()
            }
        }
    }
}

pub fn is_sensitive_window(process: &str, title: &str, blacklist: &[String]) -> bool {
    let proc_lower = process.to_lowercase();
    let title_lower = title.to_lowercase();

    // User configured blacklist
    if blacklist.iter().any(|b| {
        let b_lower = b.to_lowercase();
        proc_lower == b_lower || proc_lower.starts_with(&b_lower)
    }) {
        return true;
    }

    // Common security & password apps
    const BUILTIN_SENSITIVE_PROCS: &[&str] = &[
        "1password",
        "bitwarden",
        "keepass",
        "keepassxc",
        "dashlane",
        "lastpass",
        "enpass",
        "credentialmanager",
    ];

    if BUILTIN_SENSITIVE_PROCS.iter().any(|p| proc_lower.contains(p)) {
        return true;
    }

    // Incognito / Private browsing windows
    const PRIVATE_TITLE_PATTERNS: &[&str] = &[
        "inprivate",
        "incognito",
        "private browsing",
        "tor browser",
    ];

    if PRIVATE_TITLE_PATTERNS.iter().any(|p| title_lower.contains(p)) {
        return true;
    }

    false
}

pub fn start_context_watcher(app: AppHandle) {
    let running = Arc::new(AtomicBool::new(true));

    thread::spawn(move || {
        let mut last_process = String::new();
        let mut last_title = String::new();

        while running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(1500));

            // Check if context reactions are enabled
            let (enabled, blacklist) = {
                let state = app.state::<crate::settings::SettingsState>();
                let s = state.0.lock().unwrap();
                (s.context_reactions_enabled, s.context_blacklist.clone())
            };

            if !enabled {
                continue;
            }

            let idle_seconds = crate::input::idle_time().map(|(_, s)| s).unwrap_or(0.0);

            #[cfg(windows)]
            {
                if let Some((process, title, _pid)) = platform::foreground_window_info() {
                    let sensitive = is_sensitive_window(&process, &title, &blacklist);
                    let safe_title = if sensitive {
                        "[Private Window]".to_string()
                    } else {
                        title.clone()
                    };

                    let changed = process != last_process || safe_title != last_title;
                    if changed {
                        last_process = process.clone();
                        last_title = safe_title.clone();
                    }

                    let event = ContextEvent {
                        process,
                        title: safe_title,
                        idle_seconds,
                        is_sensitive: sensitive,
                    };

                    let _ = app.emit("context-event", event);
                }
            }

            #[cfg(not(windows))]
            let _ = (&app, &blacklist, idle_seconds);
        }
    });
}
