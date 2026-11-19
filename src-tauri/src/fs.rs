use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const HIDDEN: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", ".idea"];

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if HIDDEN.contains(&name.as_str()) {
                return None;
            }
            let is_dir = e.file_type().ok()?.is_dir();
            Some(Entry { name, path: crate::env::norm(e.path()), is_dir })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(err)?;
    String::from_utf8(bytes).map_err(|_| "Datei ist keine UTF-8-Textdatei".into())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&path, content).map_err(err)
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("Ziel existiert bereits".into());
    }
    fs::rename(&from, &to).map_err(err)
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(err)
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn home_dir() -> String {
    crate::env::norm(crate::env::home())
}

/// Paths passed on the command line (`studio <ordner|datei>…`), made absolute.
#[tauri::command]
pub fn cli_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            crate::env::norm(p.canonicalize().unwrap_or(p))
        })
        .collect()
}

/// All files below `root` (relative paths), skipping VCS/dependency/build folders. Capped for huge trees.
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const SKIP: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".idea", "build", "dist", ".gradle", ".mypy_cache", ".pytest_cache", ".cache"];
        let base = PathBuf::from(&root);
        let mut out = Vec::new();
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    if !SKIP.contains(&name.as_str()) && !(name.starts_with('.') && name != ".github") {
                        stack.push(e.path());
                    }
                } else if ft.is_file() {
                    if let Ok(rel) = e.path().strip_prefix(&base) {
                        out.push(crate::env::norm(rel));
                    }
                    if out.len() >= 50_000 {
                        return Ok(out);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
