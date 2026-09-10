//! Global cursor polling. The buddy window is click-through most of the time,
//! so it cannot rely on webview pointer events; instead we poll the OS cursor
//! and mouse buttons and stream them to the frontend as `cursor` events.

use serde::Serialize;
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
                return WorkArea { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            }
        }
    }
    let _ = (x, y);
    WorkArea { left: 0, top: 0, right: 1920, bottom: 1040 }
}

pub fn start_cursor_thread(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<CursorState> = None;
        loop {
            if let Some(cur) = read_cursor() {
                if last != Some(cur) {
                    let _ = app.emit("cursor", cur);
                    last = Some(cur);
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
                out.push(WorkArea { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
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
