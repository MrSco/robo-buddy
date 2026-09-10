//! User character packs live in `<app data>/characters/<folder>/manifest.json`.
//! Bundled packs are static frontend assets and are listed by the frontend itself.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserPack {
    /// "user:<folder>"
    pub id: String,
    pub name: String,
    /// Absolute directory path, to be turned into an asset URL by the frontend.
    pub dir: String,
}

pub fn characters_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("characters");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

#[tauri::command]
pub fn list_user_packs(app: AppHandle) -> Vec<UserPack> {
    let Some(root) = characters_dir(&app) else { return vec![] };
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(&root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let manifest = dir.join("manifest.json");
        if !manifest.is_file() {
            continue;
        }
        let name = fs::read_to_string(&manifest)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("name")?.as_str().map(String::from))
            .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
        out.push(UserPack {
            id: format!("user:{}", entry.file_name().to_string_lossy()),
            name,
            dir: dir.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub fn user_packs_dir(app: AppHandle) -> String {
    characters_dir(&app).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Copy a model file (glb/vrm/gltf or webp/gif/png/apng) into a fresh pack folder with a generated manifest.
#[tauri::command]
pub fn import_pack(app: AppHandle, source: String, name: Option<String>) -> Result<UserPack, String> {
    let src = Path::new(&source);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("file has no extension")?;
    let renderer = match ext.as_str() {
        "glb" | "vrm" | "gltf" => "3d",
        "webp" | "gif" | "png" | "apng" => "2d",
        _ => return Err(format!("unsupported file type .{ext}")),
    };
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("character")
        .to_string();
    let display = name.unwrap_or_else(|| stem.clone());
    let folder: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let root = characters_dir(&app).ok_or("no data dir")?;
    let mut dir = root.join(&folder);
    let mut n = 2;
    while dir.exists() {
        dir = root.join(format!("{folder}-{n}"));
        n += 1;
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let model_name = format!("model.{ext}");
    fs::copy(src, dir.join(&model_name)).map_err(|e| e.to_string())?;

    let manifest = if renderer == "3d" {
        serde_json::json!({
            "name": display, "author": "", "version": 1, "renderer": "3d", "model": model_name,
            "states": { "idle": { "clip": "idle", "loop": true } },
            "reactions": {
                "music": { "enabled": true, "threshold": 0.15 },
                "mouse": { "enabled": true, "lookAtCursor": true },
                "physics": { "gravity": true, "throwable": true, "walk": false }
            }
        })
    } else {
        serde_json::json!({
            "name": display, "author": "", "version": 1, "renderer": "2d", "model": model_name,
            "states": { "idle": { "clip": model_name, "loop": true } },
            "reactions": {
                "music": { "enabled": true, "threshold": 0.15 },
                "mouse": { "enabled": true, "lookAtCursor": true },
                "physics": { "gravity": true, "throwable": true, "walk": false }
            }
        })
    };
    fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| e.to_string())?;
    let folder_name = dir.file_name().unwrap().to_string_lossy().into_owned();
    Ok(UserPack {
        id: format!("user:{folder_name}"),
        name: display,
        dir: dir.to_string_lossy().into_owned(),
    })
}
