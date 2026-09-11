//! GPT-Live: one WebRTC session that listens, thinks and speaks. The browser side does the
//! media; this side holds the OpenAI key (its own Credential Manager entry, separate from the
//! chat key), forwards the SDP offer to `/v1/live/sessions` and returns the answer, and keeps
//! the day's voice seconds so a forgotten session cannot run up a bill.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const KEY_SERVICE: &str = "robo-buddy";
const KEY_USER: &str = "live-api-key";
const SESSIONS_URL: &str = "https://api.openai.com/v1/live/sessions";

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string())
}

/// Store (or, with an empty string, forget) the OpenAI key used for Live voice.
#[tauri::command]
pub fn set_live_key(key: String) -> Result<(), String> {
    let entry = key_entry()?;
    let key = key.trim();
    if key.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_live_key() -> bool {
    read_key().is_some()
}

fn read_key() -> Option<String> {
    key_entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

// ---------- daily minutes ----------

#[derive(Serialize, Deserialize, Default)]
struct Usage {
    day: u64,
    seconds: f64,
}

fn usage_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("live_usage.json"))
}

fn today() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) / 86_400
}

fn read_usage(app: &AppHandle) -> Usage {
    let Some(path) = usage_path(app) else { return Usage::default() };
    let usage: Usage = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if usage.day == today() { usage } else { Usage { day: today(), seconds: 0.0 } }
}

/// Seconds of Live voice used today.
#[tauri::command]
pub fn live_usage(app: AppHandle) -> f64 {
    read_usage(&app).seconds
}

/// Add a finished (or running) session's seconds to today's total.
#[tauri::command]
pub fn live_add_seconds(app: AppHandle, seconds: f64) {
    let mut usage = read_usage(&app);
    usage.seconds += seconds.max(0.0);
    if let (Some(path), Ok(json)) = (usage_path(&app), serde_json::to_string(&usage)) {
        let _ = fs::write(path, json);
    }
}

// ---------- connect ----------

fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("{}: {}", status.as_u16(), msg)
}

/// Open a Live session: the browser's SDP offer plus the session config go to OpenAI with the
/// key; the SDP answer comes back for the browser to finish the WebRTC handshake.
#[tauri::command]
pub async fn live_connect(app: AppHandle, sdp: String, session: serde_json::Value) -> Result<String, String> {
    let key = read_key().ok_or("No OpenAI key saved for Live voice (Settings > Talk).")?;
    let body = serde_json::json!({
        "session": session,
        "transport": { "type": "webrtc", "sdp": sdp },
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(SESSIONS_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        crate::chat::append_log(app.clone(), format!("live connect failed {}", error_text(status, &text)));
        return Err(error_text(status, &text));
    }
    // JSON with the answer under transport.sdp; tolerate a bare SDP body too.
    if text.trim_start().starts_with("v=") {
        return Ok(text);
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Unexpected reply: {e}"))?;
    v["transport"]["sdp"]
        .as_str()
        .or_else(|| v["sdp"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            crate::chat::append_log(app.clone(), format!("live connect: no sdp in reply {}", text.chars().take(300).collect::<String>()));
            "The reply had no SDP answer.".to_string()
        })
}
