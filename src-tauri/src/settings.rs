//! Persistent user settings, stored as JSON in the app config directory and
//! broadcast to every window as a `settings-changed` event whenever they change.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// Light and reflection strength on 3D characters, 1.0 = as designed. The global fallback.
    pub lighting: f64,
    /// Lighting per character id, overriding the global value.
    pub lighting_by_character: HashMap<String, f64>,
    pub music_enabled: bool,
    pub mouse_enabled: bool,
    pub physics_enabled: bool,
    pub gravity_strength: f64,
    pub bounciness: f64,
    pub throw_strength: f64,
    pub screensaver_intensity: f64,
    /// Level (0..1) a track must exceed before dancing starts.
    /// How eagerly he locks onto a beat, 0..1; loudness no longer gates dancing.
    pub music_beat_lock: f64,
    /// Only dance once a stable tempo has been estimated. Filters game audio.
    /// "pixel" (hit-test the drawn pixels), "window" (whole window clickable), "locked" (never clickable).
    pub click_through: String,
    pub autostart: bool,
    /// Freeze all reactions (music, mouse, physics) without quitting.
    pub paused: bool,
    /// Minutes of inactivity before the buddy falls asleep; 0 = never.
    pub sleep_after_min: f64,
    pub sounds_enabled: bool,
    /// Master sound effects volume (0.0 .. 1.0).
    pub sounds_volume: f64,
    /// Footstep sounds while walking.
    pub footsteps_enabled: bool,
    /// Sound effects during the screensaver; off by default.
    pub screensaver_sounds: bool,
    /// A .scr to run behind the screensaver; blank means a plain black backdrop.
    pub screensaver_backdrop: String,
    /// Empty is a legacy setting: retain an explicit path, otherwise use Windows.
    pub screensaver_backdrop_mode: String,
    pub screensaver_after_min: f64,
    pub screensaver_erosion_style: String,
    pub screensaver_erosion_speed: f64,
    pub screensaver_void_seconds: f64,
    pub bubbles_enabled: bool,
    /// Wander along the floor when idle.
    pub wander_enabled: bool,
    /// "random", "procedural", or a dance clip name from the pack.
    pub dance_mode: String,
    /// Per pack id: the idle variants / fidgets left enabled. Missing = all.
    pub idle_sets: HashMap<String, Vec<String>>,
    /// Per clip name: user-assigned role ("idle", "fidget", "dance", "poke", "held", "fall", "off").
    pub anim_roles: HashMap<String, String>,
    /// Hide the buddy while a fullscreen app has focus.
    pub hide_when_fullscreen: bool,
    /// Let the window overlap the taskbar by the camera's bottom margin so the soles sit on its edge.
    pub stand_on_taskbar: bool,
    /// Talk (M6): off by default; nothing leaves the machine until enabled.
    pub chat_enabled: bool,
    /// Preset name for the settings UI: groq, gemini, openai, ollama, custom.
    pub chat_provider: String,
    /// OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1
    pub chat_endpoint: String,
    pub chat_model: String,
    /// Whisper-style model for /audio/transcriptions; empty = no microphone.
    pub chat_stt_model: String,
    /// Speak replies with the Windows voice.
    pub chat_voice: bool,
    /// Generate fresh speech-bubble lines per character.
    pub chat_generate_lines: bool,
    /// Requests per day, 0 = unlimited.
    pub chat_daily_cap: u32,
    /// "windows" (speechSynthesis) or "piper" (local piper.exe with an .onnx voice).
    pub tts_engine: String,
    pub piper_exe: String,
    pub piper_voice: String,
    /// Personality profile id; "pack" = the character's own persona and lines.
    pub personality: String,
    /// React to typing (key counts and a couple of shortcuts only; never which keys).
    pub keyboard_enabled: bool,
    /// "pipeline" (chat + speech models) or "live" (OpenAI GPT-Live).
    pub talk_mode: String,
    pub live_backend_model: String,
    pub live_voice: String,
    pub live_daily_minutes: u32,
    /// Land on and walk along the top edges of other windows.
    pub surfaces_enabled: bool,
    /// Open the talk box with a system-wide hotkey, from whatever app has the keyboard.
    pub talk_hotkey_enabled: bool,
    /// The hotkey itself, as "Ctrl+Shift+T": modifiers and one key, joined by pluses.
    pub talk_hotkey: String,
    /// Open the talk box *and* start listening, from whatever app has the keyboard.
    pub push_hotkey_enabled: bool,
    /// The push-to-talk combo. Tapped it toggles the microphone, held it listens until released.
    pub push_hotkey: String,
    /// Context-driven interactions (Clippy mode): chime in based on active app and activities.
    pub context_reactions_enabled: bool,
    /// Chattiness level: "rare", "normal", "chatty".
    pub context_chattiness: String,
    /// Allow passing window titles into AI prompts (false by default for privacy).
    pub context_llm_titles: bool,
    /// Process names excluded from context reactions.
    pub context_blacklist: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            character: "rocco".into(),
            size: 1.0,
            lighting: 1.0,
            lighting_by_character: HashMap::new(),
            music_enabled: true,
            mouse_enabled: true,
            physics_enabled: true,
            gravity_strength: 1.0,
            bounciness: 0.26,
            throw_strength: 1.0,
            screensaver_intensity: 70.0,
            music_beat_lock: 0.7,
            click_through: "pixel".into(),
            autostart: false,
            paused: false,
            sleep_after_min: 5.0,
            sounds_enabled: true,
            sounds_volume: 0.6,
            footsteps_enabled: true,
            screensaver_sounds: false,
            screensaver_backdrop: String::new(),
            screensaver_backdrop_mode: String::new(),
            screensaver_after_min: 0.0,
            screensaver_erosion_style: "cracks".into(),
            screensaver_erosion_speed: 20.0,
            screensaver_void_seconds: 6.0,
            bubbles_enabled: true,
            wander_enabled: true,
            dance_mode: "random".into(),
            idle_sets: HashMap::new(),
            anim_roles: HashMap::new(),
            hide_when_fullscreen: true,
            stand_on_taskbar: true,
            chat_enabled: false,
            chat_provider: "groq".into(),
            chat_endpoint: "https://api.groq.com/openai/v1".into(),
            chat_model: "groq/compound".into(),
            chat_stt_model: "whisper-large-v3-turbo".into(),
            chat_voice: true,
            chat_generate_lines: true,
            chat_daily_cap: 300,
            tts_engine: "windows".into(),
            piper_exe: String::new(),
            piper_voice: String::new(),
            personality: "pack".into(),
            keyboard_enabled: true,
            talk_mode: "pipeline".into(),
            live_backend_model: "gpt-5.6-luna".into(),
            live_voice: String::new(),
            live_daily_minutes: 30,
            surfaces_enabled: true,
            talk_hotkey_enabled: false,
            talk_hotkey: "Ctrl+Shift+T".into(),
            push_hotkey_enabled: false,
            push_hotkey: "Ctrl+Shift+Space".into(),
            context_reactions_enabled: true,
            context_chattiness: "normal".into(),
            context_llm_titles: false,
            context_blacklist: vec![
                "1Password.exe".into(),
                "Bitwarden.exe".into(),
                "KeePass.exe".into(),
                "KeePassXC.exe".into(),
            ],
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

/// Load before the app exists. Windows from the config are created before `setup` runs and
/// the buddy asks for its settings immediately, so the store must be managed on the Builder.
/// Mirrors Tauri's app_config_dir on Windows: %APPDATA%\<identifier>.
pub fn load_early(identifier: &str) -> Settings {
    std::env::var_os("APPDATA")
        .map(|base| PathBuf::from(base).join(identifier).join("settings.json"))
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
pub fn set_settings(app: AppHandle, state: tauri::State<SettingsState>, mut settings: Settings) {
    settings.gravity_strength = settings.gravity_strength.clamp(0.25, 2.0);
    settings.bounciness = settings.bounciness.clamp(0.0, 0.65);
    settings.throw_strength = settings.throw_strength.clamp(0.25, 2.0);
    settings.screensaver_intensity = settings.screensaver_intensity.clamp(0.0, 100.0);
    settings.sounds_volume = settings.sounds_volume.clamp(0.0, 1.0);
    {
        let mut cur = state.0.lock().unwrap();
        settings.screensaver_after_min = cur.screensaver_after_min;
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

