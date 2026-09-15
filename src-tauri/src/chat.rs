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
    stt_endpoint: String,
    model: String,
    stt_model: String,
    stt_model_path: String,
    cap: u32,
    piper_exe: String,
    piper_voice: String,
}

fn target(app: &AppHandle) -> Target {
    let state = app.state::<SettingsState>();
    let s = state.0.lock().unwrap();
    let endpoint = s.chat_endpoint.trim().trim_end_matches('/').to_string();
    let stt = s.chat_stt_endpoint.trim().trim_end_matches('/').to_string();
    Target {
        stt_endpoint: if stt.is_empty() { endpoint.clone() } else { stt },
        endpoint,
        model: s.chat_model.trim().to_string(),
        stt_model: s.chat_stt_model.trim().to_string(),
        stt_model_path: s.chat_stt_model_path.trim().to_string(),
        cap: s.chat_daily_cap,
        piper_exe: s.piper_exe.trim().to_string(),
        piper_voice: s.piper_voice.trim().to_string(),
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
pub async fn chat_complete(app: AppHandle, messages: Vec<ChatMessage>, max_tokens: Option<u32>, temperature: Option<f32>) -> Result<String, String> {
    let t = target(&app);
    if t.endpoint.is_empty() || t.model.is_empty() {
        return Err("No chat endpoint or model set (Settings > Talk).".into());
    }
    take_request(&app, t.cap)?;
    let mut body = serde_json::json!({
        "model": t.model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(160),
        "temperature": temperature.unwrap_or(0.9),
    });
    // Groq's reasoning models and the compound system can put their thinking in the reply;
    // ask for it to be left out (other providers reject unknown fields, so only for Groq).
    if t.endpoint.contains("groq.com") {
        body["reasoning_format"] = serde_json::json!("hidden");
    }
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

/// Model ids the chat endpoint offers (`GET /models`), sorted.
#[tauri::command]
pub async fn list_models(app: AppHandle) -> Result<Vec<String>, String> {
    let t = target(&app);
    if t.endpoint.is_empty() {
        return Err("No chat endpoint set.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(format!("{}/models", t.endpoint));
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
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Speech-to-text through the endpoint's `/audio/transcriptions` (Whisper-style).
#[tauri::command]
pub async fn transcribe(app: AppHandle, audio: Vec<u8>, mime: String) -> Result<String, String> {
    let t = target(&app);
    if t.stt_endpoint.is_empty() {
        return Err("No speech endpoint set.".into());
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
    load_speech_model(&app, &t.stt_endpoint, &t.stt_model_path).await;
    let mut req = client.post(format!("{}/audio/transcriptions", t.stt_endpoint)).multipart(form);
    // Only send the key where it belongs: a local speech server never sees it.
    if t.stt_endpoint == t.endpoint {
        if let Some(k) = read_key() {
            req = req.bearer_auth(k);
        }
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

/// The speech model file this endpoint has already been told to load, so it is asked once per
/// run rather than before every utterance.
static LOADED_SPEECH_MODEL: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);
/// Held for the whole of a load, so a recording arriving mid warm-up waits for it instead of
/// asking the server to load the same model a second time underneath the first.
static SPEECH_MODEL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Load the speech model before it is wanted. The talk box calls this as it opens, so the wait
/// happens while you are getting ready to speak rather than after you have finished: a large
/// model takes long enough that the first recording otherwise looks like it has failed.
#[tauri::command]
pub async fn warm_speech_model(app: AppHandle) {
    let t = target(&app);
    load_speech_model(&app, &t.stt_endpoint, &t.stt_model_path).await;
}

/**
 * Tell a local speech server which model file to use, if one has been configured.
 *
 * Vibe refuses every transcription with "no model loaded" until it is told, and it forgets
 * between runs, so there is nothing the user can set once and be done with. Servers that need
 * no such thing do not have the route; that answer is ignored and the transcription goes ahead,
 * which then reports whatever the server really thinks is wrong.
 */
async fn load_speech_model(app: &AppHandle, endpoint: &str, path: &str) {
    if path.is_empty() || endpoint.is_empty() {
        return;
    }
    let _serialised = SPEECH_MODEL_LOCK.lock().await;
    // Checked again now the lock is held: the warm-up this call was queued behind may well have
    // been loading this very model.
    if let Ok(slot) = LOADED_SPEECH_MODEL.lock() {
        if slot.as_ref().is_some_and(|(e, p)| e == endpoint && p == path) {
            return;
        }
    }
    if !std::path::Path::new(path).is_file() {
        crate::chat::append_log(app.clone(), format!("speech: model file not found at {path}"));
        return;
    }
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(120)).build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let sent = client
        .post(format!("{endpoint}/models/load"))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await;
    match sent {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(mut slot) = LOADED_SPEECH_MODEL.lock() {
                *slot = Some((endpoint.to_string(), path.to_string()));
            }
        }
        Ok(resp) => {
            let status = resp.status();
            crate::chat::append_log(app.clone(), format!("speech: {endpoint}/models/load answered {status}"));
        }
        Err(e) => crate::chat::append_log(app.clone(), format!("speech: could not reach {endpoint}/models/load: {e}")),
    }
}

// ---------- local text-to-speech through piper ----------

/// Synthesise `text` with piper.exe and return the WAV bytes (raw IPC response, not JSON).
#[tauri::command]
pub async fn speak_piper(app: AppHandle, text: String) -> Result<tauri::ipc::Response, String> {
    let t = target(&app);
    if t.piper_exe.is_empty() || t.piper_voice.is_empty() {
        return Err("Set the piper.exe and voice paths in Settings > Talk.".into());
    }
    if !std::path::Path::new(&t.piper_exe).is_file() {
        return Err(format!("piper.exe not found at {}", t.piper_exe));
    }
    if !std::path::Path::new(&t.piper_voice).is_file() {
        return Err(format!("Voice model not found at {}", t.piper_voice));
    }
    let out = std::env::temp_dir().join(format!("robo-buddy-{}.wav", std::process::id()));
    let out_str = out.to_string_lossy().to_string();
    let exe = t.piper_exe.clone();
    let voice = t.piper_voice.clone();
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new(&exe);
        cmd.arg("--model").arg(&voice).arg("--output_file").arg(&out_str);
        cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start piper: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("piper failed: {}", err.lines().last().unwrap_or("unknown error")));
        }
        let bytes = std::fs::read(&out_str).map_err(|e| format!("piper wrote no audio: {e}"))?;
        let _ = std::fs::remove_file(&out_str);
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(result))
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

// ---------- a small diagnostic log the user can send back ----------

#[tauri::command]
pub fn append_log(app: AppHandle, line: String) {
    let Some(dir) = app.path().app_data_dir().ok() else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("buddy.log");
    if fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{secs} {line}");
    }
}

// ---------- user personality profiles ----------

fn personalities_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("personalities.json"))
}

#[tauri::command]
pub fn load_user_personalities(app: AppHandle) -> Option<String> {
    fs::read_to_string(personalities_path(&app)?).ok()
}

#[tauri::command]
pub fn save_user_personalities(app: AppHandle, json: String) -> Result<(), String> {
    let path = personalities_path(&app).ok_or("no data dir")?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_phrases(app: AppHandle, pack: String) {
    if let Some(p) = phrases_path(&app, &pack) {
        let _ = fs::remove_file(p);
    }
}
