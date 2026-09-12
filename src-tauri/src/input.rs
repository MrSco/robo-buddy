//! Global cursor polling. The buddy window is click-through most of the time,
//! so it cannot rely on webview pointer events; instead we poll the OS cursor
//! and mouse buttons and stream them to the frontend as `cursor` events.

use serde::{Deserialize, Serialize};
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
pub struct CursorState {
    pub x: i32,
    pub y: i32,
    /// bit 0 = left, bit 1 = right, bit 2 = middle
    pub buttons: u8,
}

#[derive(Serialize, Clone, Copy)]
pub struct WorkArea {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    /// Bottom of the whole monitor; `bottom` excludes the taskbar, so the difference is its height.
    #[serde(rename = "monitorBottom")]
    pub monitor_bottom: i32,
}

#[cfg(windows)]
fn read_cursor() -> Option<CursorState> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut p = POINT::default();
    // SAFETY: plain Win32 call with a valid out-pointer.
    unsafe { GetCursorPos(&mut p).ok()? };
    let down = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| -> bool {
        // SAFETY: GetAsyncKeyState has no preconditions.
        (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
    };
    let mut buttons = 0u8;
    if down(VK_LBUTTON) { buttons |= 1; }
    if down(VK_RBUTTON) { buttons |= 2; }
    if down(VK_MBUTTON) { buttons |= 4; }
    Some(CursorState { x: p.x, y: p.y, buttons })
}

#[cfg(not(windows))]
fn read_cursor() -> Option<CursorState> {
    None
}

/// Work area (monitor bounds minus taskbar) of the monitor containing (x, y).
#[tauri::command]
pub fn work_area(x: i32, y: i32) -> WorkArea {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        // SAFETY: plain Win32 calls with valid pointers.
        unsafe {
            let hmon = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(hmon, &mut info).as_bool() {
                let r = info.rcWork;
                return WorkArea { left: r.left, top: r.top, right: r.right, bottom: r.bottom, monitor_bottom: info.rcMonitor.bottom };
            }
        }
    }
    let _ = (x, y);
    WorkArea { left: 0, top: 0, right: 1920, bottom: 1040, monitor_bottom: 1080 }
}

/// True while our screensaver covers the screens.
fn screensaver_up(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.get_webview_window("screensaver-0").is_some()
}

/// A moment's grace after the screensaver goes up, so the click or key that started it does
/// not also end it.
const SAVER_GRACE: Duration = Duration::from_millis(800);

pub fn start_cursor_thread(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<CursorState> = None;
        // Where the cursor was when the screensaver went up, and when. The screensaver ends on
        // any input, whichever window it lands on: the pages only hear what reaches them, and a
        // pointer parked over the buddy, or the keys held by some other window, would otherwise
        // leave them covering every screen with the cursor hidden. This thread sees it all.
        let mut saver: Option<(i32, i32, std::time::Instant)> = None;
        let mut tick = 0u32;
        loop {
            if let Some(cur) = read_cursor() {
                if last != Some(cur) {
                    let _ = app.emit("cursor", cur);
                    last = Some(cur);
                }
                tick = tick.wrapping_add(1);
                if tick % 8 == 0 {
                    if !screensaver_up(&app) {
                        saver = None;
                    } else if let Some((ax, ay, since)) = saver {
                        let moved = (cur.x - ax).abs() > 12 || (cur.y - ay).abs() > 12;
                        if since.elapsed() > SAVER_GRACE && (moved || cur.buttons != 0) {
                            let _ = crate::screen::screensaver_stop(app.clone());
                            saver = None;
                        }
                    } else {
                        saver = Some((cur.x, cur.y, std::time::Instant::now()));
                    }
                }
            }
            thread::sleep(Duration::from_millis(8));
        }
    });
}

/// Work areas of every monitor, so the frontend can pick one synchronously while dragging.
#[tauri::command]
pub fn work_areas() -> Vec<WorkArea> {
    #[cfg(windows)]
    {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{LPARAM, RECT};
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
        unsafe extern "system" fn cb(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, lp: LPARAM) -> BOOL {
            let out = &mut *(lp.0 as *mut Vec<WorkArea>);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(hmon, &mut info).as_bool() {
                let r = info.rcWork;
                out.push(WorkArea { left: r.left, top: r.top, right: r.right, bottom: r.bottom, monitor_bottom: info.rcMonitor.bottom });
            }
            BOOL(1)
        }
        let mut out: Vec<WorkArea> = Vec::new();
        // SAFETY: the callback only touches the Vec we pass through lparam for the duration of the call.
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut out as *mut _ as isize));
        }
        if !out.is_empty() {
            return out;
        }
    }
    vec![work_area(0, 0)]
}

/// Ask the buddy to come to the monitor the cursor is on (tray menu and settings button).
#[tauri::command]
pub fn bring_here(app: AppHandle) {
    let (x, y) = read_cursor().map(|c| (c.x, c.y)).unwrap_or((0, 0));
    let area = work_area(x, y);
    let _ = app.emit("bring-here", serde_json::json!({ "x": x, "area": area }));
}


/// True when the foreground window covers an entire monitor (a fullscreen game or video),
/// so the buddy can get out of the way.
#[cfg(windows)]
fn foreground_is_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetShellWindow, GetDesktopWindow};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() || hwnd == GetShellWindow() || hwnd == GetDesktopWindow() {
            return false;
        }
        // Our own screensaver covers the screen on purpose; hiding from it would hide the buddy
        // from the very thing he is meant to be playing in.
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return false;
        }
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(hmon, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

#[cfg(not(windows))]
fn foreground_is_fullscreen() -> bool {
    false
}

/// Poll the foreground window and emit `fullscreen` {active} when it changes.
/// Keep the buddy at the top of the topmost band. Tauri's set_always_on_top is a no-op when the
/// flag is already set, so other always-on-top windows opened later would sit above him.
pub fn start_topmost_thread(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        #[cfg(windows)]
        {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("buddy") {
                if win.is_visible().unwrap_or(false) && !own_popup_in_front(&app) {
                    if let Ok(hwnd) = win.hwnd() {
                        use windows::Win32::Foundation::HWND;
                        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
                        // SAFETY: a valid window handle; flags only reorder, never move or activate.
                        unsafe {
                            let _ = SetWindowPos(HWND(hwnd.0 as *mut core::ffi::c_void), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        let _ = &app;
    });
}

/// True while a menu (the buddy's right-click menu, the tray menu) or one of our own windows
/// is in front; re-asserting topmost then would cover the menu the user just opened.
#[cfg(windows)]
/// True when this window is one of the screensaver backdrops.
#[cfg(windows)]
fn is_screensaver_window(app: &AppHandle, hwnd: isize) -> bool {
    use tauri::Manager;
    (0..16).any(|i| {
        app.get_webview_window(&format!("screensaver-{i}"))
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize == hwnd)
            .unwrap_or(false)
    })
}

/// Put the buddy at the very top of the topmost band, now rather than at the next tick.
#[cfg(windows)]
pub fn raise_buddy(app: &AppHandle) {
    use tauri::Manager;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    if let Some(win) = app.get_webview_window("buddy") {
        if let Ok(hwnd) = win.hwnd() {
            // SAFETY: a valid window handle; the flags only reorder, never move or activate.
            unsafe {
                let _ = SetWindowPos(HWND(hwnd.0 as *mut core::ffi::c_void), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn raise_buddy(_app: &AppHandle) {}

fn own_popup_in_front(app: &AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        // The screensaver is ours and holds focus, but he plays *in* it, so he still has to be
        // pushed above it. Only a menu or the settings window should hold him back.
        if is_screensaver_window(app, hwnd.0 as isize) {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return true;
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf) as usize;
        let class = String::from_utf16_lossy(&buf[..n]);
        class == "#32768"
    }
}

/// A top-level window he can stand on: its frame bounds in physical pixels, in z-order (front first).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Surface {
    pub hwnd: isize,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[cfg(windows)]
pub(crate) fn list_surfaces() -> Vec<Surface> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut Vec<Surface>);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return BOOL(1);
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return BOOL(1);
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32);
        if cloaked != 0 {
            return BOOL(1);
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf) as usize;
        let class = String::from_utf16_lossy(&buf[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow" | "#32768") {
            return BOOL(1);
        }
        let mut r = RECT::default();
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
            return BOOL(1);
        }
        if r.right - r.left < 200 || r.bottom - r.top < 120 {
            return BOOL(1);
        }
        out.push(Surface { hwnd: hwnd.0 as isize, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        BOOL(1)
    }
    let mut out: Vec<Surface> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
    }
    out.truncate(40);
    out
}

#[cfg(not(windows))]
pub(crate) fn list_surfaces() -> Vec<Surface> {
    Vec::new()
}

/// Streams the windows he can stand on, whenever the set or their bounds change.
pub fn start_surfaces_thread(app: AppHandle) {
    thread::spawn(move || {
        // What was last sent; None when nothing has been, or the screensaver has had its turn.
        let mut last: Option<Vec<Surface>> = None;
        loop {
            thread::sleep(Duration::from_millis(150));
            let enabled = {
                use tauri::Manager;
                let state = app.state::<crate::settings::SettingsState>();
                let s = state.0.lock().unwrap();
                s.surfaces_enabled
            };
            // While the screensaver is up, the windows he can stand on are the cut-out pieces
            // the screensaver is drawing, not the real ones hidden behind it. That page sends
            // them, so this thread stands aside. It forgets what it last sent, so the real
            // windows go out again the moment the screensaver ends even if none of them moved:
            // otherwise he was left with the pieces, or nothing at all, to stand on.
            let screensaver = {
                use tauri::Manager;
                app.get_webview_window("screensaver-0").is_some()
            };
            if screensaver {
                last = None;
                continue;
            }
            let now = if enabled { list_surfaces() } else { Vec::new() };
            if last.as_ref() != Some(&now) {
                let _ = app.emit("surfaces", &now);
                last = Some(now);
            }
        }
    });
}

/// Counts key presses (never which keys) and spots Ctrl+S / Ctrl+Z, four times a second.
pub fn start_key_thread(app: AppHandle) {
    thread::spawn(move || {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
            let mut down = [false; 256];
            let mut presses = 0u32;
            let mut combo: Option<&'static str> = None;
            let mut last_emit = std::time::Instant::now();
            // When the screensaver went up, if it is up. Any key ends it, whichever window has
            // the keyboard, and whether or not he is meant to be watching the keys otherwise.
            let mut saver_since: Option<std::time::Instant> = None;
            loop {
                thread::sleep(Duration::from_millis(15));
                let enabled = {
                    use tauri::Manager;
                    let state = app.state::<crate::settings::SettingsState>();
                    let s = state.0.lock().unwrap();
                    s.keyboard_enabled
                };
                let saver = screensaver_up(&app);
                if !saver {
                    saver_since = None;
                } else if saver_since.is_none() {
                    saver_since = Some(std::time::Instant::now());
                }
                if !enabled && !saver {
                    presses = 0;
                    combo = None;
                    continue;
                }
                // SAFETY: GetAsyncKeyState has no preconditions.
                let ctrl = (unsafe { GetAsyncKeyState(0x11) } as u16 & 0x8000) != 0;
                for vk in 8usize..=254 {
                    let raw = unsafe { GetAsyncKeyState(vk as i32) } as u16;
                    let d = raw & 0x8000 != 0;
                    // Bit 0: pressed since this thread's previous poll, so taps shorter than the
                    // poll interval still count.
                    let tapped = raw & 0x0001 != 0;
                    if (d && !down[vk]) || (tapped && !d && !down[vk]) {
                        presses += 1;
                        if ctrl {
                            match vk {
                                0x53 => combo = Some("save"),
                                0x5A => combo = Some("undo"),
                                _ => {}
                            }
                        }
                    }
                    down[vk] = d;
                }
                if let Some(since) = saver_since {
                    if presses > 0 && since.elapsed() > SAVER_GRACE {
                        let _ = crate::screen::screensaver_stop(app.clone());
                        saver_since = None;
                    }
                }
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    if enabled && (presses > 0 || combo.is_some()) {
                        let _ = app.emit("keys", serde_json::json!({ "presses": presses, "combo": combo }));
                    }
                    presses = 0;
                    combo = None;
                    last_emit = std::time::Instant::now();
                }
            }
        }
        #[cfg(not(windows))]
        let _ = &app;
    });
}

pub fn start_fullscreen_thread(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            // While our own screensaver is up he is the show, and a backdrop .scr playing behind
            // it counts as a fullscreen app in front. Never report fullscreen then, or he hides
            // himself for the whole screensaver.
            let now = !screensaver_up(&app) && foreground_is_fullscreen();
            if last != Some(now) {
                let _ = app.emit("fullscreen", serde_json::json!({ "active": now }));
                last = Some(now);
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}
