//! LaTeX compilation with Tectonic, error parsing and SyncTeX parsing.
//!
//! The current (possibly unsaved) buffer is compiled without touching the user's files:
//! the root .tex is copied into a per-project build dir, the edited file is overlaid there,
//! and Tectonic's search path points back at the source dir for everything else.
use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Diagnostic {
    /// Path of the file the message refers to (as reported by TeX, mapped back to the source dir).
    file: String,
    line: u32,
    message: String,
    severity: String,
}

/// One SyncTeX box: page (1-based), source line, and its PDF rectangle in PostScript points
/// (origin top-left of the page).
#[derive(Serialize)]
pub struct SyncBox {
    page: u32,
    file: String,
    line: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Serialize)]
pub struct CompileResult {
    ok: bool,
    pdf: Option<String>,
    diagnostics: Vec<Diagnostic>,
    log: String,
    sync: Vec<SyncBox>,
    millis: u128,
}

fn which(cmd: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|p| p.join(cmd)).find(|p| p.is_file())
    })
}

#[tauri::command]
pub fn latex_available() -> bool {
    which("tectonic").is_some()
}

/// Finds the root document for `path`: `% !TEX root = …`, the file itself if it has
/// `\documentclass`, or a sibling main.tex.
fn find_root(path: &Path, content: &str) -> PathBuf {
    for line in content.lines().take(10) {
        let l = line.trim_start_matches('%').trim();
        if let Some(rest) = l.strip_prefix("!TEX root").or_else(|| l.strip_prefix("!TeX root")) {
            let rel = rest.trim_start_matches([' ', '=']).trim();
            if let Some(dir) = path.parent() {
                return dir.join(rel);
            }
        }
    }
    if content.contains("\\documentclass") {
        return path.to_path_buf();
    }
    if let Some(dir) = path.parent() {
        let main = dir.join("main.tex");
        if main.exists() {
            return main;
        }
    }
    path.to_path_buf()
}

#[tauri::command]
pub async fn latex_compile(app: AppHandle, path: Option<String>, content: String) -> Result<CompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || compile(&app, path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn compile(app: &AppHandle, path: Option<String>, content: String) -> Result<CompileResult, String> {
    let started = std::time::Instant::now();
    let tectonic = which("tectonic").ok_or("Tectonic ist nicht installiert (sudo pacman -S tectonic)")?;

    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let src_path = path.map(PathBuf::from).unwrap_or_else(|| home.join("untitled.tex"));
    let src_dir = src_path.parent().unwrap_or(&home).to_path_buf();
    let root = find_root(&src_path, &content);
    let root_dir = root.parent().unwrap_or(&src_dir).to_path_buf();

    let mut h = DefaultHasher::new();
    root.hash(&mut h);
    let build = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("latex")
        .join(format!("{:x}", h.finish()));
    std::fs::create_dir_all(&build).map_err(|e| e.to_string())?;

    // Root copy + overlay of the edited buffer (relative to the root's directory).
    let root_name = root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or("main.tex".into());
    let root_copy = build.join(&root_name);
    if root == src_path {
        std::fs::write(&root_copy, &content).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(&root, &root_copy).map_err(|e| format!("Root-Datei {}: {e}", root.display()))?;
        if let Ok(rel) = src_path.strip_prefix(&root_dir) {
            let overlay = build.join(rel);
            if let Some(p) = overlay.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            std::fs::write(&overlay, &content).map_err(|e| e.to_string())?;
        }
    }

    // Offline first (≈0.2 s); if a package isn't cached yet, retry online so Tectonic can fetch it.
    let run = |cached: bool| {
        let mut c = Command::new(&tectonic);
        c.current_dir(&build);
        if cached {
            c.arg("--only-cached");
        }
        c.args(["--synctex", "--keep-logs", "--keep-intermediates", "--chatter", "minimal", "-Z", "continue-on-errors", "-Z"])
            .arg(format!("search-path={}", root_dir.display()))
            .arg(&root_name)
            .output()
    };
    let mut out = run(true).map_err(|e| e.to_string())?;
    if !out.status.success() {
        out = run(false).map_err(|e| e.to_string())?;
    }

    let stem = root_name.trim_end_matches(".tex");
    let mut log = String::from_utf8_lossy(&out.stderr).to_string();
    log.push_str(&String::from_utf8_lossy(&out.stdout));
    let tex_log = std::fs::read_to_string(build.join(format!("{stem}.log"))).unwrap_or_default();

    let map_file = |f: &str| -> String {
        let p = Path::new(f);
        let rel = p.strip_prefix(&build).unwrap_or(p);
        let rel = rel.strip_prefix("./").unwrap_or(rel);
        if rel.is_absolute() { rel.display().to_string() } else { root_dir.join(rel).display().to_string() }
    };

    let mut diagnostics = parse_tectonic(&log, &map_file);
    if diagnostics.iter().all(|d| d.severity != "error") {
        diagnostics.extend(parse_tex_log(&tex_log, &map_file).into_iter().filter(|d| d.severity == "warning"));
    }

    let pdf = build.join(format!("{stem}.pdf"));
    let sync = read_synctex(&build.join(format!("{stem}.synctex.gz")), &map_file).unwrap_or_default();
    let ok = out.status.success() && !diagnostics.iter().any(|d| d.severity == "error");
    Ok(CompileResult {
        ok,
        pdf: pdf.exists().then(|| pdf.display().to_string()),
        diagnostics,
        log: if tex_log.is_empty() { log } else { format!("{log}\n{tex_log}") },
        sync,
        millis: started.elapsed().as_millis(),
    })
}

/// Tectonic reports `error: file.tex:12: Undefined control sequence` (also `warning:`).
fn parse_tectonic(out: &str, map_file: &dyn Fn(&str) -> String) -> Vec<Diagnostic> {
    let mut v = Vec::new();
    for line in out.lines() {
        let (sev, rest) = if let Some(r) = line.strip_prefix("error: ") {
            ("error", r)
        } else if let Some(r) = line.strip_prefix("warning: ") {
            ("warning", r)
        } else {
            continue;
        };
        if rest.starts_with("errors were issued by the TeX engine") {
            continue;
        }
        let mut parts = rest.splitn(3, ':');
        let (f, l, msg) = (parts.next(), parts.next(), parts.next());
        match (f, l.and_then(|l| l.trim().parse::<u32>().ok()), msg) {
            (Some(f), Some(l), Some(m)) => v.push(Diagnostic { file: map_file(f.trim()), line: l, message: m.trim().into(), severity: sev.into() }),
            _ => v.push(Diagnostic { file: String::new(), line: 0, message: rest.trim().into(), severity: sev.into() }),
        }
    }
    v.dedup_by(|a, b| a.line == b.line && a.message == b.message && a.file == b.file);
    v
}

/// Picks up `LaTeX Warning: … on input line 42.` style warnings from the .log.
fn parse_tex_log(log: &str, _map_file: &dyn Fn(&str) -> String) -> Vec<Diagnostic> {
    let mut v = Vec::new();
    let joined = log.replace("\n", " ");
    for chunk in joined.split("LaTeX Warning: ").skip(1) {
        let msg: String = chunk.chars().take(300).collect();
        let line = msg
            .find("input line ")
            .and_then(|i| msg[i + 11..].split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()))
            .unwrap_or(0);
        let text = msg.split(" on input line").next().unwrap_or(&msg).split("  ").next().unwrap_or("").trim().to_string();
        if !text.is_empty() {
            v.push(Diagnostic { file: String::new(), line, message: text, severity: "warning".into() });
        }
    }
    v
}

/// Minimal SyncTeX reader: returns every box/glue/kern record with its page and rectangle.
fn read_synctex(path: &Path, map_file: &dyn Fn(&str) -> String) -> Option<Vec<SyncBox>> {
    let mut raw = String::new();
    GzDecoder::new(std::fs::File::open(path).ok()?).read_to_string(&mut raw).ok()?;

    let mut inputs: std::collections::HashMap<u32, String> = Default::default();
    let (mut unit, mut mag, mut xoff, mut yoff) = (1.0f32, 1000.0f32, 0.0f32, 0.0f32);
    let mut page = 0u32;
    let mut out = Vec::new();
    // TeX sp → PostScript big points
    let to_bp = |v: f32, unit: f32, mag: f32| v * unit * mag / 1000.0 / 65781.76;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some((tag, file)) = rest.split_once(':') {
                if let Ok(t) = tag.parse() {
                    inputs.insert(t, map_file(file));
                }
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("Unit:") { unit = v.parse().unwrap_or(1.0); continue; }
        if let Some(v) = line.strip_prefix("Magnification:") { mag = v.parse().unwrap_or(1000.0); continue; }
        if let Some(v) = line.strip_prefix("X Offset:") { xoff = v.parse().unwrap_or(0.0); continue; }
        if let Some(v) = line.strip_prefix("Y Offset:") { yoff = v.parse().unwrap_or(0.0); continue; }
        if let Some(v) = line.strip_prefix('{') { page = v.parse().unwrap_or(page); continue; }

        let kind = line.as_bytes().first().copied().unwrap_or(0);
        if !matches!(kind, b'[' | b'(' | b'h' | b'v' | b'x' | b'k' | b'g' | b'$') {
            continue;
        }
        // Format: K tag,line:x,y[:W,H,D]
        let body = &line[1..];
        let mut sections = body.split(':');
        let (Some(tl), Some(xy)) = (sections.next(), sections.next()) else { continue };
        let Some((tag, ln)) = tl.split_once(',') else { continue };
        let Some((x, y)) = xy.split_once(',') else { continue };
        let (Ok(tag), Ok(ln), Ok(x), Ok(y)) = (tag.parse::<u32>(), ln.parse::<u32>(), x.parse::<f32>(), y.parse::<f32>()) else { continue };
        let (mut w, mut hgt) = (0.0, 0.0);
        if let Some(whd) = sections.next() {
            let n: Vec<f32> = whd.split(',').filter_map(|s| s.parse().ok()).collect();
            if n.len() >= 2 {
                w = n[0];
                hgt = n[1];
            }
        }
        if ln == 0 {
            continue;
        }
        out.push(SyncBox {
            page,
            file: inputs.get(&tag).cloned().unwrap_or_default(),
            line: ln,
            x: to_bp(x, unit, mag) + to_bp(xoff, 1.0, 1000.0),
            y: to_bp(y - hgt, unit, mag) + to_bp(yoff, 1.0, 1000.0),
            w: to_bp(w, unit, mag),
            h: to_bp(hgt, unit, mag).max(8.0),
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run with LATEX_TEST_DIR pointing at a dir containing main.synctex.gz.
    #[test]
    fn synctex_and_errors() {
        let out = "error: main.tex:9: Undefined control sequence\nerror: main.tex:9: Undefined control sequence\nwarning: errors were issued by the TeX engine, but were ignored; use --print";
        let d = parse_tectonic(out, &|f| f.to_string());
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 9);
        let Ok(dir) = std::env::var("LATEX_TEST_DIR") else { return };
        let boxes = read_synctex(&Path::new(&dir).join("main.synctex.gz"), &|f| f.to_string()).unwrap();
        let l5: Vec<_> = boxes.iter().filter(|b| b.line == 5).collect();
        println!("{} boxes; line 5: {:?}", boxes.len(), l5.first().map(|b| (b.page, b.x, b.y, b.w, b.h)));
        assert!(!l5.is_empty());
        assert!(l5.iter().all(|b| b.x > 50.0 && b.x < 600.0 && b.y > 50.0 && b.y < 800.0));
    }
}
