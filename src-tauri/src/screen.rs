//! Desktop capture for the screensaver. He plays with a *picture* of your desktop: one
//! screenshot is taken when the screensaver starts, and everything he shoves around after that
//! is a sprite cut from that image. Nothing on the real desktop is ever touched.

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// The whole virtual screen in physical pixels. The origin can be negative when a monitor sits
/// left of or above the primary one.
pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
        )
    }
}

/// Raw capture: BGRA rows, top down, of the whole virtual screen.
fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("no screen DC".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if mem.is_invalid() || bmp.is_invalid() {
            ReleaseDC(None, screen);
            return Err("could not make a bitmap".into());
        }
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        // No CAPTUREBLT: layered windows are left out, which is how the buddy keeps out of his
        // own screenshot instead of appearing frozen in it beside the live one.
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok();

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // Negative height asks for a top-down image, matching how canvases read pixels.
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        let rows = if ok {
            GetDIBits(mem, bmp, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS)
        } else {
            0
        };

        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if rows == 0 {
            return Err("the screen could not be read".into());
        }
        Ok(pixels)
    }
}

/// One monitor's worth of screensaver: the picture of it, and the windows that were on it.
/// A window per monitor rather than one giant one, because WebView2 cannot make a surface
/// spanning several screens and silently renders nothing when asked to.
#[derive(serde::Serialize, Clone)]
pub struct MonitorShot {
    /// Position and size of this monitor in virtual-screen pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// PNG of this monitor, base64 for the webview to load as a data URL.
    pub png: String,
    /// Windows that were on this monitor, in coordinates relative to it.
    pub sprites: Vec<Sprite>,
}

/// A window that was on screen when the picture was taken, so it can be cut out as a sprite.
#[derive(serde::Serialize, Clone)]
pub struct Sprite {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The pictures taken when the screensaver started, waiting for their pages to ask for them.
#[derive(Default)]
pub struct Shot(pub std::sync::Mutex<Vec<MonitorShot>>);

/// What one screensaver window draws. Taking the pictures when the screensaver starts rather
/// than in the page matters: by the time a page runs, its own window is covering the screen.
#[tauri::command]
pub fn capture_desktop(state: tauri::State<Shot>, index: usize) -> Result<MonitorShot, String> {
    state
        .0
        .lock()
        .map_err(|_| "capture unavailable".to_string())?
        .get(index)
        .cloned()
        .ok_or_else(|| "no picture was taken for this screen".to_string())
}

/// Grab one monitor and encode it.
fn shoot_monitor(x: i32, y: i32, w: i32, h: i32) -> Result<String, String> {
    let bgra = grab(x, y, w, h)?;
    // BGRA from GDI, RGBA for PNG; the alpha byte is meaningless here so it is forced opaque.
    let mut rgba = vec![0u8; bgra.len()];
    for (src, dst) in bgra.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = 255;
    }
    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        // Thrown away when the screensaver ends, so favour speed over size.
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png))
}

/// The windows worth throwing around, front to back, in virtual-screen pixels. Reuses the same
/// enumeration the buddy stands on, so anything he can climb is something he can also shove.
fn list_windows() -> Vec<(i32, i32, i32, i32)> {
    crate::input::list_surfaces()
        .into_iter()
        .filter_map(|w| {
            let (width, height) = (w.right - w.left, w.bottom - w.top);
            if width < 160 || height < 120 {
                return None;
            }
            Some((w.left, w.top, width, height))
        })
        .take(32)
        .collect()
}

/// The buddy window in virtual-screen pixels, so the screensaver knows what he is walking into.
#[derive(serde::Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[tauri::command]
pub fn buddy_rect(app: tauri::AppHandle) -> Option<Rect> {
    use tauri::Manager;
    let win = app.get_webview_window("buddy")?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(Rect { x: pos.x, y: pos.y, width: size.width as i32, height: size.height as i32 })
}

/// Put a backdrop up on every monitor, behind the buddy, and tell him to play.
#[tauri::command]
pub fn screensaver_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if app.get_webview_window("screensaver-0").is_some() {
        return Ok(());
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors".into());
    }
    // Everything he plays with is cut from these pictures, taken while the desktop is still the
    // desktop; the windows are listed at the same moment for the same reason.
    let windows = list_windows();
    let mut shots = Vec::new();
    for m in &monitors {
        let (mx, my) = (m.position().x, m.position().y);
        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
        let png = shoot_monitor(mx, my, mw, mh)?;
        // A window belongs to the monitor its middle sits on, and is clipped to it. Each screen
        // is then its own playpen, so nothing has to be kept in step across monitors.
        let sprites = windows
            .iter()
            .filter_map(|&(wx, wy, ww, wh)| {
                let (cx, cy) = (wx + ww / 2, wy + wh / 2);
                if cx < mx || cx >= mx + mw || cy < my || cy >= my + mh {
                    return None;
                }
                let x = wx.max(mx);
                let y = wy.max(my);
                let width = (wx + ww).min(mx + mw) - x;
                let height = (wy + wh).min(my + mh) - y;
                if width < 120 || height < 90 {
                    return None;
                }
                Some(Sprite { x: x - mx, y: y - my, width, height })
            })
            .collect();
        shots.push(MonitorShot { x: mx, y: my, width: mw, height: mh, png, sprites });
    }
    if let Ok(mut slot) = app.state::<Shot>().0.lock() {
        *slot = shots.clone();
    }

    for (i, shot) in shots.iter().enumerate() {
        let label = format!("screensaver-{i}");
        // Plain path, no query: WebviewUrl::App is a path, so a "?" would be encoded and the
        // page would 404. The window's own label carries which screen it is.
        let win = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("screensaver.html".into()))
            .title("Robo Buddy Screensaver")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .inner_size(shot.width as f64, shot.height as f64)
            .build()
            .map_err(|e| e.to_string())?;
        // Physical pixels: a monitor left of or above the primary one has a negative origin,
        // and logical coordinates on the builder do not land there.
        let _ = win.set_position(tauri::PhysicalPosition::new(shot.x, shot.y));
        let _ = win.set_size(tauri::PhysicalSize::new(shot.width as u32, shot.height as u32));
    }
    let _ = app.emit("screensaver", true);
    Ok(())
}

/// Take the backdrops down and put him back on the taskbar.
#[tauri::command]
pub fn screensaver_stop(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    for i in 0..16 {
        if let Some(win) = app.get_webview_window(&format!("screensaver-{i}")) {
            let _ = win.close();
        }
    }
    // Pictures of someone's desktop are not something to keep around once they are done with.
    if let Ok(mut slot) = app.state::<Shot>().0.lock() {
        slot.clear();
    }
    let _ = app.emit("screensaver", false);
    Ok(())
}
