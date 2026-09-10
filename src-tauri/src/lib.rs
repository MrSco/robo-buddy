use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod audio;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .setup(|app| {
            let initial = settings::load(app.handle());
            app.manage(settings::SettingsState(std::sync::Mutex::new(initial.clone())));

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
            audio::start_audio_thread(app.handle().clone());
            Ok(())
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
            input::bring_here,
            settings::get_settings,
            settings::set_settings,
            packs::list_user_packs,
            packs::user_packs_dir,
            packs::import_pack,
            open_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Robo Buddy");
}
