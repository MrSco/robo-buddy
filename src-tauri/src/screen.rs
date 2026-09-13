//! Desktop capture for the screensaver. He plays with a *picture* of your desktop: one
//! screenshot is taken when the screensaver starts, and everything he shoves around after that
//! is a sprite cut from that image. Nothing on the real desktop is ever touched.

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
};

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


/// One window's own pixels, even when something is sitting on top of it. Cutting a sprite out
/// of the desktop screenshot would give a rectangle full of whatever covers it; asking the
/// window to draw itself gives the real thing. Returns RGBA, or None when the window declines
/// (some hardware-accelerated windows hand back nothing but a flat colour).
#[cfg(windows)]
fn capture_window(hwnd: isize, fx: i32, fy: i32, fw: i32, fh: i32) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        // PrintWindow draws the whole window, including the invisible resize border that sits
        // outside the frame DWM reports. Capturing at the frame size would keep that border on
        // the left and shift everything, which is the black stripe down each cut-out edge.
        let mut wr = RECT::default();
        if GetWindowRect(hwnd, &mut wr).is_err() {
            return None;
        }
        let (w, h) = ((wr.right - wr.left).max(1), (wr.bottom - wr.top).max(1));
        let (offx, offy) = ((fx - wr.left).max(0), (fy - wr.top).max(0));
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if mem.is_invalid() || bmp.is_invalid() {
            ReleaseDC(None, screen);
            return None;
        }
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
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
            return None;
        }
        // A window that drew nothing comes back one flat colour; that is not worth showing.
        let total = pixels.len() / 4;
        let step = (total / 400).max(1);
        let first = [pixels[0], pixels[1], pixels[2]];
        let flat = (0..total).step_by(step).all(|i| pixels[i * 4] == first[0] && pixels[i * 4 + 1] == first[1] && pixels[i * 4 + 2] == first[2]);
        if flat {
            return None;
        }
        for p in pixels.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
        }
        // Keep only the visible frame, dropping the border PrintWindow included.
        if offx == 0 && offy == 0 && w == fw && h == fh {
            return Some(pixels);
        }
        if offx + fw > w || offy + fh > h {
            return None;
        }
        Some(crop(&pixels, w, offx, offy, fw, fh))
    }
}

#[cfg(not(windows))]
fn capture_window(_hwnd: isize, _fx: i32, _fy: i32, _fw: i32, _fh: i32) -> Option<Vec<u8>> {
    None
}

/// RGBA to a base64 PNG.
fn encode(rgba: &[u8], w: i32, h: i32) -> Result<String, String> {
    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png))
}

/// One monitor's worth of screensaver: the picture of it, and the windows that were on it.
/// A window per monitor rather than one giant one, because WebView2 cannot make a surface
/// spanning several screens and silently renders nothing when asked to.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorShot {
    pub virtual_desktop: DesktopRect,
    /// Position and size of this monitor in virtual-screen pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// PNG of this monitor, base64 for the webview to load as a data URL.
    pub png: String,
    /// Windows that were on this monitor, in coordinates relative to it.
    pub sprites: Vec<Sprite>,
    /// True when another screensaver is playing underneath, so the holes are left see-through
    /// instead of being painted black.
    pub see_through: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct DesktopRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrtCycle {
    pub started_at: u64,
    pub void_seconds: f64,
}

#[derive(Default)]
pub struct Cycle(pub std::sync::Mutex<Option<CrtCycle>>);

/// A window that was on screen when the picture was taken, with its own pixels so it stays
/// itself even when something was sitting on top of it.
#[derive(serde::Serialize, Clone)]
pub struct Sprite {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// PNG of this window alone, base64.
    pub png: String,
}

/// The pictures taken when the screensaver started, waiting for their pages to ask for them.
#[derive(Default)]
pub struct Shot(pub std::sync::Mutex<Vec<MonitorShot>>);

#[derive(Default)]
pub struct PageReadiness(pub std::sync::Mutex<(u64, std::collections::BTreeSet<usize>)>);

#[tauri::command]
pub fn screensaver_page_ready(app: tauri::AppHandle, index: usize) {
    use tauri::Manager;
    if let Ok(mut state) = app.state::<PageReadiness>().0.lock() { state.1.insert(index); }
    crate::chat::append_log(app, format!("screensaver: page {index} ready"));
}

/// The screensaver playing behind ours, when one was chosen.
#[derive(Default)]
pub struct Backdrop(pub std::sync::Mutex<Option<BackdropProcess>>);

pub struct BackdropProcess {
    child: std::process::Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

impl BackdropProcess {
    fn attach(mut child: std::process::Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};
            let attached = (|| -> Result<OwnedHandle, String> {
                let raw = unsafe { CreateJobObjectW(None, None) }.map_err(|e| e.to_string())?;
                let job = unsafe { OwnedHandle::from_raw_handle(raw.0) };
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                unsafe {
                    SetInformationJobObject(raw, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32).map_err(|e| e.to_string())?;
                    AssignProcessToJobObject(raw, HANDLE(child.as_raw_handle())).map_err(|e| e.to_string())?;
                }
                Ok(job)
            })();
            match attached {
                Ok(job) => Ok(Self { child, _job: job }),
                Err(e) => { let _ = child.kill(); let _ = child.wait(); Err(e) }
            }
        }
        #[cfg(not(windows))]
        { Ok(Self { child }) }
    }
}
impl Drop for BackdropProcess {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

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

/// Grab one monitor as RGBA.
fn grab_rgba(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    let mut rgba = grab(x, y, w, h)?;
    // BGRA from GDI, RGBA for PNG; the alpha byte is meaningless here so it is forced opaque.
    for p in rgba.chunks_exact_mut(4) {
        p.swap(0, 2);
        p[3] = 255;
    }
    Ok(rgba)
}

/// A rectangle out of an RGBA image.
fn crop(src: &[u8], src_w: i32, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    let row_len = w as usize * 4;
    for row in 0..h as usize {
        let from = (((y as usize + row) * src_w as usize) + x as usize) * 4;
        let to = row * row_len;
        if from + row_len <= src.len() {
            out[to..to + row_len].copy_from_slice(&src[from..from + row_len]);
        }
    }
    out
}

/// The windows worth throwing around, front to back, in virtual-screen pixels. Reuses the same
/// enumeration the buddy stands on, so anything he can climb is something he can also shove.
fn list_windows() -> Vec<(isize, i32, i32, i32, i32)> {
    crate::input::list_surfaces()
        .into_iter()
        .filter_map(|w| {
            let (width, height) = (w.right - w.left, w.bottom - w.top);
            if width < 160 || height < 120 {
                return None;
            }
            Some((w.hwnd, w.left, w.top, width, height))
        })
        .take(32)
        .collect()
}

/// The buddy window in virtual-screen pixels, so the screensaver knows what he is walking into.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Which way the last punch was thrown, -1 or 1.
    pub punch: i32,
    /// How many punches he has thrown. There is a page per monitor and all of them poll this,
    /// so the count is left alone rather than cleared on read: each page acts on a number it
    /// has not seen before, and only the one he is actually standing on finds anything to hit.
    pub punch_seq: u32,
    /// He is running at a window to shove it. Only then does his speed move anything; the rest
    /// of the time the pages leave what he touches alone, so he can climb it.
    pub barging: bool,
}

/// What he is doing to the pieces: the last punch (which way, and how many so far) and
/// whether he is barging right now.
#[derive(Default)]
pub struct Punch(pub std::sync::Mutex<Hits>);

#[derive(Default, Clone, Copy)]
pub struct Hits {
    pub punch: i32,
    pub punch_seq: u32,
    pub barging: bool,
}

/// He hit something. The screensaver pages pick this up on their next poll.
#[tauri::command]
pub fn buddy_punch(app: tauri::AppHandle, dir: i32) {
    use tauri::Manager;
    if let Ok(mut slot) = app.state::<Punch>().0.lock() {
        slot.punch = dir.signum();
        slot.punch_seq = slot.punch_seq.wrapping_add(1);
    }
}

/// He has started, or finished, running at a window to shove it.
#[tauri::command]
pub fn buddy_barge(app: tauri::AppHandle, on: bool) {
    use tauri::Manager;
    if let Ok(mut slot) = app.state::<Punch>().0.lock() {
        slot.barging = on;
    }
}

#[tauri::command]
pub fn buddy_rect(app: tauri::AppHandle) -> Option<Rect> {
    use tauri::Manager;
    let win = app.get_webview_window("buddy")?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let hits = match app.state::<Punch>().0.lock() {
        Ok(slot) => *slot,
        Err(_) => Hits::default(),
    };
    Some(Rect {
        x: pos.x,
        y: pos.y,
        width: size.width as i32,
        height: size.height as i32,
        punch: hits.punch,
        punch_seq: hits.punch_seq,
        barging: hits.barging,
    })
}

/// Put a backdrop up on every monitor, behind the buddy, and tell him to play.
#[tauri::command]
pub fn screensaver_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    static STARTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_starting) = STARTING.try_lock() else { return Ok(()); };
    if app.get_webview_window("screensaver-0").is_some() {
        // Already up, or left over from a teardown that did not finish. Either way, clear it
        // out and start again rather than refusing and leaving the stale ones on screen.
        let _ = screensaver_stop(app.clone());
    }
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors".into());
    }
    *app.state::<Cycle>().0.lock().map_err(|e| e.to_string())? = None;
    let left = monitors.iter().map(|m| m.position().x).min().unwrap();
    let top = monitors.iter().map(|m| m.position().y).min().unwrap();
    let right = monitors.iter().map(|m| m.position().x + m.size().width as i32).max().unwrap();
    let bottom = monitors.iter().map(|m| m.position().y + m.size().height as i32).max().unwrap();
    let virtual_desktop = DesktopRect { x: left, y: top, width: right - left, height: bottom - top };
    // A screensaver of their choosing plays underneath, seen through the holes where windows
    // were. Started further down, once the pictures are taken: a plain screen grab copies
    // whatever is on the glass, so starting it first would photograph it instead of the desktop.
    let chosen = {
        let state = app.state::<crate::settings::SettingsState>();
        let s = state.0.lock().unwrap();
        match s.screensaver_backdrop_mode.as_str() {
            "none" => String::new(),
            "custom" => s.screensaver_backdrop.trim().trim_matches('"').to_string(),
            // Empty mode migrates existing explicit backgrounds without losing them.
            "" if !s.screensaver_backdrop.trim().is_empty() => s.screensaver_backdrop.trim().trim_matches('"').to_string(),
            _ => crate::idle_saver::windows_backdrop(),
        }
    };

    // Out of shot: he is about to be standing on this picture, and a frozen copy of him in it
    // looks ridiculous. Hidden, the screen settles, the picture is taken, then he comes back.
    let buddy = app.get_webview_window("buddy");
    if let Some(b) = &buddy {
        let _ = b.hide();
        std::thread::sleep(std::time::Duration::from_millis(160));
    }
    // Everything he plays with is cut from these pictures, taken while the desktop is still the
    // desktop; the windows are listed at the same moment for the same reason.
    let windows = list_windows();
    let taken = (|| -> Result<Vec<MonitorShot>, String> {
        let mut shots = Vec::new();
        for m in &monitors {
            let (mx, my) = (m.position().x, m.position().y);
            let (mw, mh) = (m.size().width as i32, m.size().height as i32);
            let shot_rgba = grab_rgba(mx, my, mw, mh)?;
            let png = encode(&shot_rgba, mw, mh)?;
            // A window belongs to the monitor its middle sits on, and is clipped to it. Each
            // screen is then its own playpen, so nothing has to be kept in step across monitors.
            let sprites = windows
                .iter()
                .filter_map(|&(hwnd, wx, wy, ww, wh)| {
                    let (cx, cy) = (wx + ww / 2, wy + wh / 2);
                    if cx < mx || cx >= mx + mw || cy < my || cy >= my + mh {
                        return None;
                    }
                    // Its own pixels where the window will give them. Otherwise its patch of the
                    // desktop picture, which is right whenever nothing was covering it.
                    if let Some(rgba) = capture_window(hwnd, wx, wy, ww, wh) {
                        if let Ok(png) = encode(&rgba, ww, wh) {
                            return Some(Sprite { x: wx - mx, y: wy - my, width: ww, height: wh, png });
                        }
                    }
                    let x = wx.max(mx);
                    let y = wy.max(my);
                    let width = (wx + ww).min(mx + mw) - x;
                    let height = (wy + wh).min(my + mh) - y;
                    if width < 120 || height < 90 {
                        return None;
                    }
                    let rgba = crop(&shot_rgba, mw, x - mx, y - my, width, height);
                    Some(Sprite { x: x - mx, y: y - my, width, height, png: encode(&rgba, width, height).ok()? })
                })
                .collect();
            shots.push(MonitorShot { virtual_desktop: virtual_desktop.clone(), x: mx, y: my, width: mw, height: mh, png, sprites, see_through: false });
        }
        Ok(shots)
    })();
    // Whatever happened, he comes back. A grab fails outright while the system's own screen
    // saver holds the desktop, and giving up with him still hidden left him gone for good.
    if let Some(b) = &buddy {
        let _ = b.show();
    }
    let mut shots = match taken {
        Ok(shots) => shots,
        Err(e) => {
            crate::chat::append_log(app.clone(), format!("screensaver: could not photograph the desktop: {e}"));
            return Err(e);
        }
    };
    crate::chat::append_log(
        app.clone(),
        format!("screensaver: {} windows, {} per screen", windows.len(), shots.iter().map(|s| s.sprites.len().to_string()).collect::<Vec<_>>().join("/")),
    );
    let generation = {
        let state = app.state::<PageReadiness>();
        let mut ready = state.0.lock().map_err(|e| e.to_string())?;
        ready.0 += 1;
        ready.1.clear();
        ready.0
    };
    let expected = shots.len();
    let watchdog = app.clone();
    std::thread::spawn(move || {
        for _ in 0..150 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let state = watchdog.state::<PageReadiness>();
            if let Ok(ready) = state.0.lock() {
                if ready.0 != generation || ready.1.len() >= expected { return; }
            };
        }
        crate::chat::append_log(watchdog.clone(), "screensaver: startup timed out; removing all layers".into());
        let _ = screensaver_stop(watchdog);
    });
    // Now the desktop is safely photographed, the one playing underneath can start. Ours are
    // built after it and are topmost too, so they sit over it; the last one raised wins.
    let backdrop_running = if chosen.is_empty() { false } else { start_backdrop(&app, &chosen) };
    for shot in &mut shots {
        shot.see_through = backdrop_running;
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
            // See-through only when something is playing underneath; otherwise an opaque window
            // is cheaper and avoids any compositing surprises.
            .transparent(backdrop_running)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            // Do not steal the foreground. A backdrop .scr run with /s exits the instant it
            // loses focus, so grabbing focus for these windows killed glmatrix the moment it
            // appeared. Topmost keeps them in front without being the focused window, and the
            // screensaver is ended from the global input threads, not from page focus.
            .focused(false)
            .inner_size(shot.width as f64, shot.height as f64)
            .build();
        let win = match win {
            Ok(w) => w,
            // Never leave the one underneath playing with nothing over it.
            Err(e) => {
                let _ = screensaver_stop(app.clone());
                return Err(e.to_string());
            }
        };
        if app.state::<PageReadiness>().0.lock().map_err(|e| e.to_string())?.0 != generation {
            let _ = win.destroy();
            return Err("screensaver startup was cancelled".into());
        }
        // Physical pixels: a monitor left of or above the primary one has a negative origin,
        // and logical coordinates on the builder do not land there.
        let _ = win.set_position(tauri::PhysicalPosition::new(shot.x, shot.y));
        let _ = win.set_size(tauri::PhysicalSize::new(shot.width as u32, shot.height as u32));
    }
    // He belongs on top of his own playground, not behind it.
    crate::input::raise_buddy(&app);
    let _ = app.emit("screensaver", true);
    Ok(())
}

/// Take the backdrops down and put him back on the taskbar.
#[tauri::command]
pub fn screensaver_stop(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    // Stop the external renderer even if a WebView is stuck during construction/destruction.
    stop_backdrop(&app);
    if let Ok(mut ready) = app.state::<PageReadiness>().0.lock() { ready.0 += 1; ready.1.clear(); }
    for i in 0..16 {
        if let Some(win) = app.get_webview_window(&format!("screensaver-{i}")) {
            // destroy, not close: a close is a polite request that something can refuse or
            // lose, and these windows cover every screen with the cursor hidden. One that
            // refuses to go leaves the machine looking hung.
            let _ = win.destroy();
        }
    }
    // Pictures of someone's desktop are not something to keep around once they are done with.
    if let Ok(mut slot) = app.state::<Shot>().0.lock() {
        slot.clear();
    }
    if let Ok(mut per_screen) = app.state::<Standable>().0.lock() {
        per_screen.clear();
    }
    stop_backdrop(&app);
    let _ = app.emit("screensaver", false);
    Ok(())
}

/// What each screen's backdrop last reported as standable, so one screen's list does not
/// replace another's.
#[derive(Default)]
pub struct Standable(pub std::sync::Mutex<std::collections::BTreeMap<usize, Vec<crate::input::Surface>>>);

/// The screensaver telling the buddy what is standable right now: the cut-out windows where
/// they have ended up, rather than the real ones sitting untouched behind the backdrop. Every
/// screen reports its own, and he is sent all of them together.
#[tauri::command]
pub fn screensaver_surfaces(app: tauri::AppHandle, index: usize, surfaces: Vec<crate::input::Surface>) {
    use tauri::{Emitter, Manager};
    let merged = {
        let state = app.state::<Standable>();
        let Ok(mut per_screen) = state.0.lock() else { return };
        per_screen.insert(index, surfaces);
        per_screen.values().flatten().cloned().collect::<Vec<_>>()
    };
    let _ = app.emit("surfaces", &merged);
}

/// The registry value we tuck the user's previous screen saver into, so "restore" can put it
/// back. Windows ignores value names it does not know, so it is safe to keep it here.
#[cfg(windows)]
const PREV_SAVER: &str = "SCRNSAVE.EXE.RoboBuddyPrev";

/// Where our screen-saver copy lives: a `.scr` beside the running exe. Windows only launches
/// files ending in `.scr` as screen savers, so we cannot point it straight at the `.exe`.
#[cfg(windows)]
fn scr_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.with_file_name("robo-buddy.scr"))
}

/// Whether a registered screen-saver path is our own `.scr` (compared by file name).
#[cfg(windows)]
fn is_our_scr(path: &str, scr: &std::path::Path) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    let candidate = std::path::Path::new(path.trim().trim_matches('"'));
    // Windows' control panel writes DOS short paths (ROBO-B~1.SCR). Resolve the file
    // identity before comparing names or we back up ourselves as the "previous" saver.
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(candidate), std::fs::canonicalize(scr)) {
        if a.as_os_str().eq_ignore_ascii_case(b.as_os_str()) { return true; }
    }
    candidate.file_name().zip(scr.file_name())
        .map(|(a, b)| a.eq_ignore_ascii_case(b)).unwrap_or(false)
}

#[cfg(all(test, windows))]
mod registration_tests {
    use super::is_our_scr;
    use std::os::windows::ffi::OsStrExt;

    #[test]
    fn recognises_windows_short_paths_and_quoted_paths() {
        #[link(name = "kernel32")]
        extern "system" { fn GetShortPathNameW(long: *const u16, short: *mut u16, size: u32) -> u32; }
        let dir = std::env::temp_dir().join(format!("robo buddy saver test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let scr = dir.join("robo-buddy.scr");
        std::fs::write(&scr, b"test").unwrap();
        let long: Vec<u16> = scr.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut short = [0u16; 1024];
        let length = unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
        assert!(length > 0 && length < short.len() as u32);
        let alias = String::from_utf16_lossy(&short[..length as usize]);
        assert!(is_our_scr(&alias, &scr));
        assert!(is_our_scr(&format!("\"{alias}\""), &scr));
        assert!(!is_our_scr("glmatrix.scr", &scr));
        std::fs::remove_file(scr).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}

/// One-time migration only: return Windows to the user's saved saver before retiring the relay.
pub fn migrate_windows_saver(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE}};
        let scr = scr_path()?;
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Control Panel\Desktop", KEY_READ | KEY_WRITE).map_err(|e| e.to_string())?;
        let current: String = key.get_value("SCRNSAVE.EXE").unwrap_or_default();
        if is_our_scr(&current, &scr) {
            // Missing backup is not the same as an explicitly empty (None) selection.
            let previous: String = key.get_value(PREV_SAVER).map_err(|_| "Choose your Windows screensaver in Windows settings; the previous selection is missing.")?;
            if is_our_scr(&previous, &scr) { return Err("Saved screensaver points to Robo Buddy. Choose a Windows screensaver first.".into()); }
            key.set_value("SCRNSAVE.EXE", &previous).map_err(|e| e.to_string())?;
            let timeout = key.get_value::<String, _>("ScreenSaveTimeOut").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(300.0);
            crate::settings::update(app, |s| {
                s.screensaver_after_min = (timeout / 60.0).clamp(1.0, 120.0);
                if s.screensaver_backdrop.trim().trim_matches('"').eq_ignore_ascii_case(previous.trim().trim_matches('"')) {
                    s.screensaver_backdrop_mode = "windows".into();
                }
            });
            let _ = key.delete_value(PREV_SAVER);
        }
        // Remove only our sibling copy after registration has been migrated successfully.
        if scr.is_file() { let _ = std::fs::remove_file(scr); }
    }
    Ok(())
}

/// One monitor's page has eroded away: tell every page to run the tube-off collapse together,
/// so the whole desk powers down at once rather than each screen doing its own thing at its own
/// time. Whichever screen finishes first calls this; the rest follow.
#[tauri::command]
pub fn screensaver_crt(app: tauri::AppHandle) -> Result<CrtCycle, String> {
    use tauri::{Emitter, Manager};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let state = app.state::<Cycle>();
    let mut active = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(cycle) = active.as_ref() {
        if now < cycle.started_at + 1350 + (cycle.void_seconds * 1000.0) as u64 + 200 {
            return Ok(cycle.clone());
        }
    }
    let settings = app.state::<crate::settings::SettingsState>();
    let hold = settings.0.lock().map_err(|e| e.to_string())?.screensaver_void_seconds;
    let cycle = CrtCycle { started_at: now + 150, void_seconds: if hold.is_finite() { hold.clamp(0.0, 120.0) } else { 6.0 } };
    app.emit("screensaver-crt", &cycle).map_err(|e| e.to_string())?;
    *active = Some(cycle.clone());
    Ok(cycle)
}

/// Start the chosen screensaver full screen behind ours. Returns whether it actually started.
fn start_backdrop(app: &tauri::AppHandle, path: &str) -> bool {
    use tauri::Manager;
    #[cfg(windows)]
    if scr_path().map(|scr| is_our_scr(path, &scr)).unwrap_or(true) { return false; }
    let exists = std::path::Path::new(path).is_file();
    if !exists {
        crate::chat::append_log(app.clone(), format!("screensaver: backdrop not found at {path}"));
        return false;
    }
    // "/s" is the standard "run it" argument every Windows screensaver understands.
    match std::process::Command::new(path).arg("/s").spawn() {
        Ok(child) => {
            let mut owned = match BackdropProcess::attach(child) {
                Ok(owned) => owned,
                Err(e) => { crate::chat::append_log(app.clone(), format!("screensaver: backdrop recovery unavailable: {e}")); return false; }
            };
            let child = &mut owned.child;
            let pid = child.id();
            // It needs a moment to put its own window up before ours goes over the top.
            std::thread::sleep(std::time::Duration::from_millis(700));
            // If it has already quit, it is one of the screensavers that exits the instant it is
            // not the foreground: no use pretending it is playing behind us.
            if let Ok(Some(status)) = child.try_wait() {
                crate::chat::append_log(app.clone(), format!("screensaver: backdrop pid {pid} exited at once ({status}); black instead"));
                return false;
            }
            crate::chat::append_log(app.clone(), format!("screensaver: backdrop pid {pid} playing behind"));
            if let Ok(mut slot) = app.state::<Backdrop>().0.lock() {
                *slot = Some(owned);
            }
            true
        }
        Err(e) => {
            crate::chat::append_log(app.clone(), format!("screensaver: backdrop would not start: {e}"));
            false
        }
    }
}

/// Stop the screensaver playing underneath, if one is.
fn stop_backdrop(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(mut slot) = app.state::<Backdrop>().0.lock() {
        slot.take();
    }
}
