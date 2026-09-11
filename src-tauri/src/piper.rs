//! Managed Piper install: piper.exe under the app data folder, voices beside it, downloads
//! of both on demand so the user never hunts for files.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const PIPER_ZIP: &str = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const VOICES_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

/// A few good English voices from the Piper catalogue: id -> (label, path under the base).
const CATALOGUE: &[(&str, &str, &str)] = &[
    ("en_US-lessac-medium", "Lessac (US, neutral)", "en/en_US/lessac/medium/en_US-lessac-medium"),
    ("en_US-amy-medium", "Amy (US, female)", "en/en_US/amy/medium/en_US-amy-medium"),
    ("en_US-ryan-high", "Ryan (US, male, high quality)", "en/en_US/ryan/high/en_US-ryan-high"),
    ("en_US-joe-medium", "Joe (US, male)", "en/en_US/joe/medium/en_US-joe-medium"),
    ("en_GB-alan-medium", "Alan (UK, male)", "en/en_GB/alan/medium/en_GB-alan-medium"),
    ("en_GB-jenny_dioco-medium", "Jenny (UK, female)", "en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium"),
];

fn piper_root(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("piper");
    let _ = fs::create_dir_all(dir.join("voices"));
    Some(dir)
}

fn exe_path(root: &PathBuf) -> PathBuf {
    root.join("piper").join("piper.exe")
}

#[derive(Serialize)]
pub struct VoiceEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct CatalogueEntry {
    pub id: String,
    pub label: String,
}

#[derive(Serialize)]
pub struct PiperStatus {
    pub root: String,
    pub exe: Option<String>,
    pub voices: Vec<VoiceEntry>,
    pub catalogue: Vec<CatalogueEntry>,
}

#[tauri::command]
pub fn piper_status(app: AppHandle) -> Result<PiperStatus, String> {
    let root = piper_root(&app).ok_or("no data dir")?;
    let exe = exe_path(&root);
    let mut voices = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join("voices")) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "onnx").unwrap_or(false) {
                voices.push(VoiceEntry {
                    name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    voices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(PiperStatus {
        root: root.to_string_lossy().to_string(),
        exe: if exe.is_file() { Some(exe.to_string_lossy().to_string()) } else { None },
        voices,
        catalogue: CATALOGUE.iter().map(|(id, label, _)| CatalogueEntry { id: id.to_string(), label: label.to_string() }).collect(),
    })
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: {} for {url}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Download piper_windows_amd64.zip (about 22 MB) and unpack it; returns the exe path.
#[tauri::command]
pub async fn piper_install(app: AppHandle) -> Result<String, String> {
    let root = piper_root(&app).ok_or("no data dir")?;
    let exe = exe_path(&root);
    if exe.is_file() {
        return Ok(exe.to_string_lossy().to_string());
    }
    let bytes = fetch_bytes(PIPER_ZIP).await?;
    let root2 = root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let reader = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
        zip.extract(&root2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    if exe.is_file() {
        Ok(exe.to_string_lossy().to_string())
    } else {
        Err("The archive did not contain piper/piper.exe".into())
    }
}

/// Download a catalogue voice (.onnx and its .json) into the voices folder; returns the model path.
#[tauri::command]
pub async fn piper_download_voice(app: AppHandle, id: String) -> Result<String, String> {
    let root = piper_root(&app).ok_or("no data dir")?;
    let (_, _, rel) = CATALOGUE.iter().find(|(i, _, _)| *i == id).ok_or("Unknown voice")?;
    let target = root.join("voices").join(format!("{id}.onnx"));
    if target.is_file() {
        return Ok(target.to_string_lossy().to_string());
    }
    let json = fetch_bytes(&format!("{VOICES_BASE}/{rel}.onnx.json")).await?;
    let onnx = fetch_bytes(&format!("{VOICES_BASE}/{rel}.onnx")).await?;
    fs::write(root.join("voices").join(format!("{id}.onnx.json")), json).map_err(|e| e.to_string())?;
    fs::write(&target, onnx).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Show the voices folder in Explorer so the user can drop their own .onnx files in.
#[tauri::command]
pub fn piper_open_voices(app: AppHandle) -> Result<(), String> {
    let root = piper_root(&app).ok_or("no data dir")?;
    std::process::Command::new("explorer")
        .arg(root.join("voices"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
