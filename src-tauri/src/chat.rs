//! Talk to the buddy: chat completions and speech-to-text through any OpenAI-compatible
//! endpoint (Groq, Gemini, OpenAI, a local Ollama, ...). The API key lives in Windows
//! Credential Manager via `keyring`, never in settings.json. Requests are counted against a
//! daily cap so a runaway loop cannot burn a paid key.

use crate::settings::SettingsState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const KEY_SERVICE: &str = "robo-buddy";
const KEY_USER: &str = "chat-api-key";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string())
}

/// Store (or, with an empty string, forget) the API key in the OS credential store.
#[tauri::command]
pub fn set_chat_key(key: String) -> Result<(), String> {
    let entry = key_entry()?;
    let key = key.trim();
    if key.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_chat_key() -> bool {
    read_key().is_some()
}

fn read_key() -> Option<String> {
    key_entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

struct Target {
    endpoint: String,
    model: String,
    stt_model: String,
    cap: u32,
}

fn target(app: &AppHandle) -> Target {
    let state = app.state::<SettingsState>();
    let s = state.0.lock().unwrap();
    Target {
        endpoint: s.chat_endpoint.trim().trim_end_matches('/').to_string(),
        model: s.chat_model.trim().to_string(),
        stt_model: s.chat_stt_model.trim().to_string(),
        cap: s.chat_daily_cap,
    }
}

// ---------- daily cap ----------

#[derive(Serialize, Deserialize, Default)]
struct Usage {
    day: u64,
    count: u32,
}

fn usage_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("chat_usage.json"))
}

fn today() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) / 86_400
}

/// Count one request against today's cap; errors when the cap is reached.
fn take_request(app: &AppHandle, cap: u32) -> Result<(), String> {
    let Some(path) = usage_path(app) else { return Ok(()) };
    let mut usage: Usage = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let day = today();
    if usage.day != day {
        usage = Usage { day, count: 0 };
    }
    if cap > 0 && usage.count >= cap {
        return Err(format!("Daily chat limit of {cap} reached; raise it in Settings > Talk."));
    }
    usage.count += 1;
    if let Ok(json) = serde_json::to_string(&usage) {
        let _ = fs::write(&path, json);
    }
    Ok(())
}

#[tauri::command]
pub fn chat_usage(app: AppHandle) -> u32 {
    let Some(path) = usage_path(&app) else { return 0 };
    let usage: Usage = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if usage.day == today() { usage.count } else { 0 }
}

// ---------- requests ----------

fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    // Surface the provider's message when there is one; they are usually clear (bad key, model name).
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("{}: {}", status.as_u16(), msg)
}

/// One chat completion. `messages` is the full OpenAI-style list including the system prompt.
#[tauri::command]
pub async fn chat_complete(app: AppHandle, messages: Vec<ChatMessage>, max_tokens: Option<u32>) -> Result<String, String> {
    let t = target(&app);
    if t.endpoint.is_empty() || t.model.is_empty() {
        return Err("No chat endpoint or model set (Settings > Talk).".into());
    }
    take_request(&app, t.cap)?;
    let body = serde_json::json!({
        "model": t.model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(160),
        "temperature": 0.9,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(format!("{}/chat/completions", t.endpoint)).json(&body);
    if let Some(k) = read_key() {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_text(status, &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "The model sent an empty reply.".into())
}

/// Speech-to-text through the endpoint's `/audio/transcriptions` (Whisper-style).
#[tauri::command]
pub async fn transcribe(app: AppHandle, audio: Vec<u8>, mime: String) -> Result<String, String> {
    let t = target(&app);
    if t.endpoint.is_empty() {
        return Err("No chat endpoint set.".into());
    }
    if t.stt_model.is_empty() {
        return Err("This provider has no speech model set; type instead.".into());
    }
    if audio.len() < 2_000 {
        return Err("That was too short to hear.".into());
    }
    take_request(&app, t.cap)?;
    let ext = if mime.contains("webm") {
        "webm"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("mp4") {
        "mp4"
    } else {
        "wav"
    };
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(format!("speech.{ext}"))
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", t.stt_model)
        .text("response_format", "json")
        .part("file", part);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(format!("{}/audio/transcriptions", t.endpoint)).multipart(form);
    if let Some(k) = read_key() {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_text(status, &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

// ---------- generated phrase cache ----------

fn phrases_path(app: &AppHandle, pack: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("phrases");
    let _ = fs::create_dir_all(&dir);
    let safe: String = pack.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    Some(dir.join(format!("{safe}.json")))
}

#[tauri::command]
pub fn load_phrases(app: AppHandle, pack: String) -> Option<String> {
    fs::read_to_string(phrases_path(&app, &pack)?).ok()
}

#[tauri::command]
pub fn save_phrases(app: AppHandle, pack: String, json: String) -> Result<(), String> {
    let path = phrases_path(&app, &pack).ok_or("no data dir")?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_phrases(app: AppHandle, pack: String) {
    if let Some(p) = phrases_path(&app, &pack) {
        let _ = fs::remove_file(p);
    }
}
