use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod audio;
mod chat;
mod live;
mod input;
mod piper;
mod packs;
mod screen;
mod idle_saver;
mod settings;
mod context;

// Logic that carries its own tests lives in a crate with no Tauri in it. Re-exported under the
// same names so `crate::logging::` and `crate::idle_episode::` still read the way they did.
pub use robo_buddy_core::{idle_episode, logging};

/// The tab the settings window should open on, left here until the page asks for it.
#[derive(Default)]
struct PendingTab(std::sync::Mutex<Option<String>>);

/// Which tab to show, if the window was opened for a particular one. Clears as it is read, so
/// reopening later lands on whatever tab the user last used.
#[tauri::command]
fn take_settings_tab(state: tauri::State<PendingTab>) -> Option<String> {
    state.0.lock().ok().and_then(|mut t| t.take())
}

/// Files dropped on the buddy, waiting for the settings window to import them. Queued here rather
/// than sent in an event, because the window that is going to do the importing may be the one
/// this drop is opening, and an event fired at a page still loading is simply lost.
#[derive(Default)]
struct PendingImports(std::sync::Mutex<Vec<String>>);

/// Hand a dropped file to the settings window, opening it if need be. The buddy's own window is
/// no place to import from: it is small, it would have to load the whole model to find out what
/// it had, and Settings already has the code path for every kind of file.
// Async, and open_settings too: a plain command runs on the main thread, and building a window
// from there dispatches to the main thread and waits for it -- on Windows that is a deadlock. The
// settings window came up white and everything hung behind it. Off the main thread, build() hands
// the work over and waits like anything else.
#[tauri::command]
async fn import_via_settings(app: tauri::AppHandle, path: String) {
    if let Ok(mut q) = app.state::<PendingImports>().0.lock() {
        q.push(path.clone());
    }
    chat::append_log(app.clone(), format!("import: queued {path} for settings"));
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // A nudge, not the path: the window drains the queue itself.
        let _ = win.emit("import-file", ());
    } else {
        show_settings_on(&app, Some("character"));
    }
}

/// Everything waiting to be imported, and the queue emptied. The settings page asks on start-up
/// and again whenever it is nudged.
#[tauri::command]
fn take_pending_imports(state: tauri::State<PendingImports>) -> Vec<String> {
    state.0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
}

fn show_settings(app: &tauri::AppHandle) {
    show_settings_on(app, None);
}

/// Show the settings window, building it the first time and again after it is closed. It is not
/// declared in tauri.conf.json on purpose: a window declared there is created at launch, and a
/// second Chromium renderer costs about 100 MB whether or not anyone opens it.
fn show_settings_on(app: &tauri::AppHandle, tab: Option<&str>) {
    if let Some(t) = tab {
        if let Ok(mut pending) = app.state::<PendingTab>().0.lock() {
            *pending = Some(t.to_string());
        }
    }
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // An open window is already listening, so the tab to show can just be sent.
        if let Some(t) = tab {
            let _ = win.emit("settings-tab", t);
        }
        return;
    }
    match tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Robo Buddy Settings")
        .inner_size(1120.0, 860.0)
        .min_inner_size(600.0, 560.0)
        .resizable(true)
        .center()
        .build()
    {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => {
            let _ = app.emit("settings-error", e.to_string());
        }
    }
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle) {
    show_settings(&app);
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("unsupported platform".into())
    }
}

/// Right-click menu on the buddy: the same items as the tray, at the cursor.
#[tauri::command]
fn context_menu(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("buddy") else { return Err("no buddy window".into()) };
    let (paused, chat) = {
        let state = app.state::<settings::SettingsState>();
        let s = state.0.lock().unwrap();
        (s.paused, s.chat_enabled)
    };
    let talk_item = MenuItem::with_id(&app, "talk", "Talk to him...", chat, None::<&str>).map_err(|e| e.to_string())?;
    let capture_item = MenuItem::with_id(&app, "capture", "Copy me (webcam)...", true, None::<&str>).map_err(|e| e.to_string())?;
    let saver_item = MenuItem::with_id(&app, "screensaver", "Screensaver now", true, None::<&str>).map_err(|e| e.to_string())?;
    let settings_item = MenuItem::with_id(&app, "settings", "Settings...", true, None::<&str>).map_err(|e| e.to_string())?;
    let bring_item = MenuItem::with_id(&app, "bring", "Bring buddy here", true, None::<&str>).map_err(|e| e.to_string())?;
    let pause_item = CheckMenuItem::with_id(&app, "pause_ctx", "Pause reactions", true, paused, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "Quit Robo Buddy", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&talk_item, &capture_item, &saver_item, &sep, &settings_item, &bring_item, &pause_item, &sep2, &quit]).map_err(|e| e.to_string())?;
    menu.popup(win.as_ref().window()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if idle_saver::guard_entry() { return; }
    let context = tauri::generate_context!();
    let initial = settings::load_early(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| input::bring_here(app.clone())))
        // Managed before any window exists: the buddy window calls get_settings on load.
        .manage(settings::SettingsState(std::sync::Mutex::new(initial.clone())))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Only remember where windows sit; size and visibility are ours to control.
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PendingTab::default())
        .manage(PendingImports::default())
        .manage(idle_saver::State::default())
        .manage(screen::Shot::default())
        .manage(screen::PageReadiness::default())
        .manage(screen::Cycle::default())
        .manage(screen::Standable::default())
        .manage(screen::Backdrop::default())
        .manage(screen::Punch::default())
        .setup(move |app| {
            // Before anything else, so that whatever follows can be seen to have failed.
            if let Ok(dir) = app.path().app_data_dir() {
                logging::init(&dir);
            }
            log::info!("robo buddy {} starting", env!("CARGO_PKG_VERSION"));
            let bring_item = MenuItem::with_id(app, "bring", "Bring buddy here", true, None::<&str>)?;
            let saver_item = MenuItem::with_id(app, "screensaver", "Screensaver now", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let pause_item = CheckMenuItem::with_id(app, "pause", "Pause reactions", true, initial.paused, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Robo Buddy", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&bring_item, &saver_item, &settings_item, &pause_item, &PredefinedMenuItem::separator(app)?, &quit],
            )?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("bundle icon missing").clone())
                .tooltip("Robo Buddy")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "capture" => show_settings_on(app, Some("capture")),
                    "screensaver" => {
                        let _ = screen::screensaver_start(app.clone());
                    }
                    "bring" => input::bring_here(app.clone()),
                    "settings" => show_settings(app),
                    "pause" => {
                        let checked = pause_item.is_checked().unwrap_or(false);
                        settings::update(app, |s| s.paused = checked);
                    }
                    "pause_ctx" => {
                        let s = settings::update(app, |s| s.paused = !s.paused);
                        let _ = pause_item.set_checked(s.paused);
                    }
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::POSITION);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(win) = app.get_webview_window("buddy") {
                let _ = win.show();
            }
            input::start_cursor_thread(app.handle().clone());
            input::start_fullscreen_thread(app.handle().clone());
            input::start_topmost_thread(app.handle().clone());
            input::start_surfaces_thread(app.handle().clone());
            input::start_key_thread(app.handle().clone());
            input::start_hotkey_thread(app.handle().clone());
            idle_saver::start(app.handle().clone());
            audio::start_audio_thread(app.handle().clone());
            context::start_context_watcher(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => show_settings_on(app, Some("capture")),
            "talk" => {
                if let Some(win) = app.get_webview_window("buddy") {
                    let _ = win.emit("talk", ());
                }
            }
            "bring" => input::bring_here(app.clone()),
            "settings" => show_settings(app),
            "pause_ctx" => {
                settings::update(app, |s| s.paused = !s.paused);
            }
            "quit" => {
                let _ = app.save_window_state(StateFlags::POSITION);
                app.exit(0);
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            // Closing the settings window destroys it, taking its renderer process with it; the
            // next Settings... builds a fresh one. The webcam stops because the webview is gone.
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { .. } = event {
                    let _ = window.emit("settings-hidden", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            input::work_area,
            input::work_areas,
            input::bring_here,
            settings::get_settings,
            settings::set_settings,
            packs::list_user_packs,
            packs::user_packs_dir,
            packs::import_pack,
            packs::set_pack_persona,
            packs::list_user_clips,
            packs::stage_dropped,
            packs::finalize_import,
            packs::delete_user_clip,
            packs::delete_user_pack,
            packs::open_user_folder,
            piper::piper_delete_voice,
            packs::save_user_clip,
            packs::save_staged_glb,
            packs::save_pack_glb,
            packs::set_pack_rig_params,
            open_settings,
            open_url,
            screen::capture_desktop,
            screen::buddy_rect,
            screen::buddy_punch,
            screen::buddy_barge,
            screen::screensaver_page_ready,
            screen::screensaver_start,
            screen::screensaver_stop,
            screen::screensaver_surfaces,
            screen::screensaver_crt,
            idle_saver::set_idle_screensaver,
            idle_saver::idle_saver_status,
            take_settings_tab,
            import_via_settings,
            take_pending_imports,
            context_menu,
            chat::set_chat_key,
            chat::has_chat_key,
            chat::chat_complete,
            chat::transcribe,
            chat::speak_piper,
            chat::chat_usage,
            chat::load_phrases,
            chat::save_phrases,
            chat::clear_phrases,
            chat::load_user_personalities,
            chat::save_user_personalities,
            chat::append_log,
            chat::list_models,
            live::set_live_key,
            live::has_live_key,
            live::live_connect,
            live::live_usage,
            live::live_add_seconds,
            piper::piper_status,
            piper::piper_install,
            piper::piper_download_voice,
            piper::piper_open_voices,
        ])
        .build(context)
        .expect("error while building Robo Buddy")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                idle_saver::shutdown(app);
                let _ = screen::screensaver_stop(app.clone());
            }
        });
}
