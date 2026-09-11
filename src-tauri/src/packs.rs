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
        "glb" | "vrm" | "gltf" | "fbx" => "3d",
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
    // Keep the original file name: FBX and glTF may reference textures relative to it.
    let model_name = src.file_name().unwrap().to_string_lossy().into_owned();
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


// ------------------------------------------------------------------ user clips + drop inbox

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserClip {
    /// File stem, used as the clip name.
    pub name: String,
    pub file: String,
    pub dir: String,
}

pub fn clips_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("clips");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

fn inbox_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("inbox");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

#[tauri::command]
pub fn list_user_clips(app: AppHandle) -> Vec<UserClip> {
    let Some(root) = clips_dir(&app) else { return vec![] };
    let mut out = vec![];
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "glb" | "gltf" | "fbx") { continue; }
            out.push(UserClip {
                name: p.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
                file: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                dir: root.to_string_lossy().into_owned(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Copy a dropped file into the inbox (inside the asset-protocol scope) so the frontend can
/// open it and decide whether it is a model or an animation.
#[tauri::command]
pub fn stage_dropped(app: AppHandle, source: String) -> Result<String, String> {
    let src = Path::new(&source);
    let name = src.file_name().ok_or("no file name")?.to_string_lossy().into_owned();
    let dir = inbox_dir(&app).ok_or("no data dir")?;
    let dst = dir.join(&name);
    fs::copy(src, &dst).map_err(|e| e.to_string())?;
    // FBX textures usually sit next to the file; bring image siblings along.
    if let Some(parent) = src.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            for e in entries.flatten() {
                let p = e.path();
                let ext = p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "tga" | "bmp" | "webp") {
                    let _ = fs::copy(&p, dir.join(p.file_name().unwrap()));
                }
            }
            let fbm = parent.join(format!("{}.fbm", src.file_stem().unwrap_or_default().to_string_lossy()));
            if fbm.is_dir() {
                let target = dir.join(fbm.file_name().unwrap());
                let _ = fs::create_dir_all(&target);
                if let Ok(entries) = fs::read_dir(&fbm) {
                    for e in entries.flatten() {
                        let _ = fs::copy(e.path(), target.join(e.file_name()));
                    }
                }
            }
        }
    }
    Ok(dst.to_string_lossy().into_owned())
}

/// Move a staged file into its final home: a new character pack ("model") or the clip library ("clip").
#[tauri::command]
pub fn finalize_import(app: AppHandle, staged: String, kind: String, name: Option<String>) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&staged);
    let inbox = inbox_dir(&app).ok_or("no data dir")?;
    if kind == "clip" {
        let dir = clips_dir(&app).ok_or("no data dir")?;
        let file_name = match &name {
            Some(n) if !n.trim().is_empty() => format!("{}.{}", n.trim(), src.extension().and_then(|e| e.to_str()).unwrap_or("glb")),
            _ => src.file_name().unwrap().to_string_lossy().into_owned(),
        };
        let dst = dir.join(&file_name);
        fs::rename(&src, &dst).or_else(|_| fs::copy(&src, &dst).map(|_| ())).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&src);
        return Ok(serde_json::json!({ "kind": "clip", "name": dst.file_stem().unwrap().to_string_lossy(), "file": file_name }));
    }
    // Model: reuse import_pack on the staged file, then move any staged siblings into the pack folder.
    let pack = import_pack(app.clone(), staged.clone(), name)?;
    let pack_dir = PathBuf::from(&pack.dir);
    if let Ok(entries) = fs::read_dir(&inbox) {
        for e in entries.flatten() {
            let p = e.path();
            if p == src { continue; }
            let target = pack_dir.join(e.file_name());
            if p.is_dir() {
                let _ = fs::create_dir_all(&target);
                if let Ok(inner) = fs::read_dir(&p) {
                    for f in inner.flatten() { let _ = fs::rename(f.path(), target.join(f.file_name())); }
                }
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::rename(&p, &target);
            }
        }
    }
    let _ = fs::remove_file(&src);
    Ok(serde_json::json!({ "kind": "model", "id": pack.id, "name": pack.name }))
}

#[tauri::command]
pub fn delete_user_clip(app: AppHandle, file: String) -> Result<(), String> {
    let dir = clips_dir(&app).ok_or("no data dir")?;
    let p = dir.join(Path::new(&file).file_name().ok_or("bad name")?);
    fs::remove_file(p).map_err(|e| e.to_string())
}
