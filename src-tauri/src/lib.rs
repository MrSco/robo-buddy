use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod audio;
mod chat;
mod input;
mod packs;
mod settings;

fn show_settings(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    show_settings(&app);
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
    let settings_item = MenuItem::with_id(&app, "settings", "Settings...", true, None::<&str>).map_err(|e| e.to_string())?;
    let bring_item = MenuItem::with_id(&app, "bring", "Bring buddy here", true, None::<&str>).map_err(|e| e.to_string())?;
    let pause_item = CheckMenuItem::with_id(&app, "pause_ctx", "Pause reactions", true, paused, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "Quit Robo Buddy", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&talk_item, &sep, &settings_item, &bring_item, &pause_item, &sep2, &quit]).map_err(|e| e.to_string())?;
    menu.popup(win.as_ref().window()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let initial = settings::load_early(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch just summons the existing buddy.
            input::bring_here(app.clone());
        }))
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
        .setup(move |app| {
            let bring_item = MenuItem::with_id(app, "bring", "Bring buddy here", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let pause_item = CheckMenuItem::with_id(app, "pause", "Pause reactions", true, initial.paused, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Robo Buddy", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&bring_item, &settings_item, &pause_item, &PredefinedMenuItem::separator(app)?, &quit],
            )?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("bundle icon missing").clone())
                .tooltip("Robo Buddy")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
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
            audio::start_audio_thread(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
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
            // The settings window hides instead of closing so it can be reopened from the tray.
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
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
            packs::list_user_clips,
            packs::stage_dropped,
            packs::finalize_import,
            packs::delete_user_clip,
            open_settings,
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
        ])
        .run(context)
        .expect("error while running Robo Buddy");
}
