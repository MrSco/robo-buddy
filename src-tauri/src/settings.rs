//! Persistent user settings, stored as JSON in the app config directory and
//! broadcast to every window as a `settings-changed` event whenever they change.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Pack id: a bundled id like "rocco" or "user:<folder>" for packs in the app data dir.
    pub character: String,
    /// Window scale, 1.0 = 320x440 logical pixels.
    pub size: f64,
    pub music_enabled: bool,
    pub mouse_enabled: bool,
    pub physics_enabled: bool,
    /// Level (0..1) a track must exceed before dancing starts.
    pub music_threshold: f64,
    /// Only dance once a stable tempo has been estimated. Filters game audio.
    pub require_tempo: bool,
    /// "pixel" (hit-test the drawn pixels), "window" (whole window clickable), "locked" (never clickable).
    pub click_through: String,
    pub autostart: bool,
    /// Freeze all reactions (music, mouse, physics) without quitting.
    pub paused: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            character: "rocco".into(),
            size: 1.0,
            music_enabled: true,
            mouse_enabled: true,
            physics_enabled: true,
            music_threshold: 0.15,
            require_tempo: false,
            click_through: "pixel".into(),
            autostart: false,
            paused: false,
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = fs::write(p, json);
        }
    }
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: tauri::State<SettingsState>, settings: Settings) {
    {
        let mut cur = state.0.lock().unwrap();
        *cur = settings.clone();
    }
    save(&app, &settings);
    let _ = app.emit("settings-changed", settings);
}

/// Update a single flag from native code (tray toggles) and broadcast.
pub fn update<F: FnOnce(&mut Settings)>(app: &AppHandle, f: F) -> Settings {
    let state = app.state::<SettingsState>();
    let snapshot = {
        let mut cur = state.0.lock().unwrap();
        f(&mut cur);
        cur.clone()
    };
    save(app, &snapshot);
    let _ = app.emit("settings-changed", snapshot.clone());
    snapshot
}
