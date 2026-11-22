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
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Diagnostic {
    /// Path of the file the message refers to (as reported by TeX, mapped back to the source dir).
    pub(crate) file: String,
    pub(crate) line: u32,
    pub(crate) message: String,
    pub(crate) severity: String,
}

/// One SyncTeX box: page (1-based), source line, and its PDF rectangle in PostScript points
/// (origin top-left of the page).
#[derive(Serialize)]
pub struct SyncBox {
    page: u32,
    pub(crate) file: String,
    line: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Serialize)]
pub struct CompileResult {
    pub(crate) ok: bool,
    pub(crate) pdf: Option<String>,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) log: String,
    pub(crate) sync: Vec<SyncBox>,
    pub(crate) millis: u128,
}

fn which(cmd: &str) -> Option<PathBuf> {
    crate::env::which(cmd)
}

#[tauri::command]
pub fn latex_available() -> bool {
    which("tectonic").is_some()
}

/// Finds the root document for `path`: `% !TEX root = …`, the file itself if it has
/// `\documentclass`, else the nearest document in this or a parent folder that `\input`s /
/// `\include`s it, else the nearest main.tex.
pub(crate) fn find_root(path: &Path, content: &str) -> PathBuf {
    if let Some(root) = magic_root(path, content) {
        return root;
    }
    if content.contains("\\documentclass") {
        return path.to_path_buf();
    }
    let home = crate::env::home();
    let mut main = None;
    for dir in path.ancestors().skip(1).take(ROOT_SEARCH_DEPTH) {
        if dir.as_os_str().is_empty() {
            break;
        }
        if let Some(root) = including_document(dir, path) {
            return root;
        }
        if main.is_none() && dir.join("main.tex").is_file() {
            main = Some(dir.join("main.tex"));
        }
        // Don't climb out of the project (git root) or above the home folder.
        if dir.join(".git").exists() || dir == home {
            break;
        }
    }
    main.unwrap_or_else(|| path.to_path_buf())
}

/// The target of a `% !TEX root = …` comment in the first lines, as written (it can leave the folder).
pub(crate) fn magic_root(path: &Path, content: &str) -> Option<PathBuf> {
    for line in content.lines().take(10) {
        let l = line.trim_start_matches('%').trim();
        if let Some(rest) = l.strip_prefix("!TEX root").or_else(|| l.strip_prefix("!TeX root")) {
            let rel = rest.trim_start_matches([' ', '=']).trim();
            if let Some(dir) = path.parent() {
                return Some(dir.join(rel));
            }
        }
    }
    None
}

/// How many folders (the file's own and its parents) `find_root` searches.
const ROOT_SEARCH_DEPTH: usize = 6;

/// A `.tex` file directly in `dir` that has `\documentclass` and includes `file`
/// (`\input`, `\include` or `\subfile`, with or without `.tex`).
fn including_document(dir: &Path, file: &Path) -> Option<PathBuf> {
    let rel = file.strip_prefix(dir).ok()?;
    let mut docs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != file && p.is_file() && p.extension().is_some_and(|e| e == "tex"))
        .collect();
    docs.sort();
    docs.into_iter().find(|p| {
        // A huge sibling is never read whole (#174).
        let Some(text) = p.to_str().and_then(|p| crate::fs::read_limited(p, crate::fs::MAX_TEXT_FILE).ok()).and_then(|b| String::from_utf8(b).ok()) else { return false };
        text.contains("\\documentclass") && includes(&text, rel)
    })
}

/// Whether `text` has an uncommented `\input{…}`, `\include{…}` or `\subfile{…}` naming `rel`.
fn includes(text: &str, rel: &Path) -> bool {
    let want = rel.with_extension("");
    for line in text.lines() {
        let code = line.split('%').next().unwrap_or("");
        for cmd in ["\\input{", "\\include{", "\\subfile{"] {
            for (i, _) in code.match_indices(cmd) {
                let arg = &code[i + cmd.len()..];
                let Some(end) = arg.find('}') else { continue };
                let name = arg[..end].trim().trim_start_matches("./");
                let name = Path::new(name.strip_suffix(".tex").unwrap_or(name));
                if name == want {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
pub async fn latex_compile(app: AppHandle, window: tauri::WebviewWindow, path: Option<String>, content: String) -> Result<CompileResult, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || compile(&app, &owner, path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn compile(app: &AppHandle, owner: &str, path: Option<String>, content: String) -> Result<CompileResult, String> {
    let started = std::time::Instant::now();
    let tectonic = which("tectonic").ok_or("TECTONIC_MISSING")?;

    let home = crate::env::home();
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

    let root_name = prepare_build(&build, &root, &root_dir, &src_path, &content)?;
    let emit = |p: Progress| {
        crate::windows::emit(app, owner, "latex-progress", p);
    };
    run_and_collect(&tectonic, &build, &root_dir, &root_name, started, &mut |mut c, cached| if cached { c.output() } else { run_with_progress(c, &emit, None) })
}

/// Runs Tectonic in a prepared build dir and reads the result. `run` starts each attempt
/// (`cached`: the offline one).
pub(crate) fn run_and_collect(
    tectonic: &Path,
    build: &Path,
    root_dir: &Path,
    root_name: &str,
    started: std::time::Instant,
    run: &mut dyn FnMut(std::process::Command, bool) -> std::io::Result<std::process::Output>,
) -> Result<CompileResult, String> {
    // Offline first (≈0.2 s); if a package isn't cached yet, retry online so Tectonic can fetch it.
    // The online run can take minutes the first time (format + hundreds of support files), so it
    // keeps Tectonic's normal chatter and streams it to the UI as progress.
    let cmd = |cached: bool| {
        let mut c = crate::env::command(tectonic);
        c.current_dir(build);
        if cached {
            c.args(["--only-cached", "--chatter", "minimal"]);
        }
        c.args(["--synctex", "--keep-logs", "--keep-intermediates", "-Z", "continue-on-errors", "-Z"])
            .arg(format!("search-path={}", root_dir.display()))
            .arg(root_name);
        c
    };
    let mut out = run(cmd(true), true).map_err(|e| e.to_string())?;
    if !out.status.success() {
        out = run(cmd(false), false).map_err(|e| e.to_string())?;
    }

    let stem = root_name.trim_end_matches(".tex");
    let mut log = String::from_utf8_lossy(&out.stderr).to_string();
    log.push_str(&String::from_utf8_lossy(&out.stdout));
    let tex_log = std::fs::read_to_string(build.join(format!("{stem}.log"))).unwrap_or_default();

    let map_file = |f: &str| map_source(f, build, root_dir);

    let mut diagnostics = parse_tectonic(&log, &map_file);
    if diagnostics.iter().all(|d| d.severity != "error") {
        diagnostics.extend(parse_tex_log(&tex_log, &map_file).into_iter().filter(|d| d.severity == "warning"));
    }

    let pdf = build.join(format!("{stem}.pdf"));
    let sync = read_synctex(&build.join(format!("{stem}.synctex.gz")), &map_file).unwrap_or_default();
    let ok = out.status.success() && !diagnostics.iter().any(|d| d.severity == "error");
    Ok(CompileResult {
        ok,
        pdf: pdf.exists().then(|| crate::env::norm(&pdf)),
        diagnostics,
        log: if tex_log.is_empty() { log } else { format!("{log}\n{tex_log}") },
        sync,
        millis: started.elapsed().as_millis(),
    })
}

/// Lists the overlays written into the build dir, so the next compile can remove them.
pub(crate) const OVERLAYS: &str = ".omega-overlays";

/// Puts the sources into the build dir: the root copy plus an overlay of the edited buffer
/// (relative to the root's directory). Overlays from earlier compiles are removed first: they
/// would shadow the source file in later compiles (unsaved edits that were saved, reverted or
/// discarded since). Returns the root's file name.
pub(crate) fn prepare_build(build: &Path, root: &Path, root_dir: &Path, src_path: &Path, content: &str) -> Result<String, String> {
    if let Ok(list) = std::fs::read_to_string(build.join(OVERLAYS)) {
        for rel in list.lines().filter(|l| !l.is_empty()) {
            let rel = Path::new(rel);
            if rel.is_relative() && !rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                let _ = std::fs::remove_file(build.join(rel));
            }
        }
        let _ = std::fs::remove_file(build.join(OVERLAYS));
    }
    let root_name = root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or("main.tex".into());
    let root_copy = build.join(&root_name);
    if root == src_path {
        std::fs::write(&root_copy, content).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(root, &root_copy).map_err(|e| format!("Root-Datei {}: {e}", root.display()))?;
        if let Ok(rel) = src_path.strip_prefix(root_dir) {
            let overlay = build.join(rel);
            if let Some(p) = overlay.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            std::fs::write(build.join(OVERLAYS), format!("{}\n", rel.to_string_lossy())).map_err(|e| e.to_string())?;
            std::fs::write(&overlay, content).map_err(|e| e.to_string())?;
        }
    }
    Ok(root_name)
}

/// Maps a file name as TeX reports it (relative to the build dir, or a path inside it) back to
/// the source dir. `\input{chapters/one}` is reported without `.tex`, so that is added when only
/// the `.tex` file exists. TeX reports absolute paths with symlinks resolved (e.g. a cache dir
/// that is a symlink from an old app id), so the canonical build and root dirs are matched too.
fn map_source(f: &str, build: &Path, root_dir: &Path) -> String {
    let p = Path::new(f);
    let build_real = canonical(build);
    let root_real = canonical(root_dir);
    let rel = p
        .strip_prefix(build)
        .ok()
        .or_else(|| build_real.as_deref().and_then(|b| p.strip_prefix(b).ok()))
        .or_else(|| root_real.as_deref().filter(|r| *r != root_dir).and_then(|r| p.strip_prefix(r).ok()))
        .unwrap_or(p);
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    let mut path = if rel.is_absolute() { rel.to_path_buf() } else { root_dir.join(rel) };
    if !path.exists() {
        let mut tex = path.clone().into_os_string();
        tex.push(".tex");
        if Path::new(&tex).is_file() {
            path = tex.into();
        }
    }
    crate::env::norm(path)
}

/// `canonicalize` without the verbatim prefix Windows adds (`\\?\C:\…`), which would never
/// match the plain `C:\…` paths TeX reports. UNC paths (`\\?\UNC\…`) are kept as they are.
pub(crate) fn canonical(p: &Path) -> Option<PathBuf> {
    let c = p.canonicalize().ok()?;
    let plain = c.to_str().and_then(|s| s.strip_prefix(r"\\?\")).filter(|r| !r.starts_with("UNC\\")).map(PathBuf::from);
    Some(plain.unwrap_or(c))
}

#[derive(Serialize, Clone)]
pub(crate) struct Progress {
    /// "format" (building the LaTeX format, first run only), "download", "tex", "rerun", "pdf", "write"
    pub(crate) phase: &'static str,
    /// Files downloaded so far in this run.
    pub(crate) downloads: u32,
    /// File currently being downloaded.
    pub(crate) file: Option<String>,
}

#[cfg(test)]
impl SyncBox {
    pub(crate) fn for_test(file: &str) -> Self {
        SyncBox { page: 1, file: file.into(), line: 1, x: 0.0, y: 0.0, w: 1.0, h: 1.0 }
    }
}

/// Stops a run from outside and bounds what it keeps in memory.
pub(crate) struct RunGuard<'a> {
    pub(crate) cancel: &'a std::sync::atomic::AtomicBool,
    pub(crate) deadline: std::time::Instant,
    pub(crate) max_output: usize,
}

/// Runs Tectonic, turning its `note:` lines (stdout) into progress. With a guard, a cancelled or
/// overdue run is killed and ends in an `Interrupted` error.
pub(crate) fn run_with_progress(mut c: std::process::Command, emit: &(dyn Fn(Progress) + Sync), guard: Option<&RunGuard>) -> std::io::Result<std::process::Output> {
    use std::io::BufRead;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    let max_output = guard.map_or(usize::MAX, |g| g.max_output);
    let mut child = c.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let child_stdout = child.stdout.take().expect("piped stdout");
    let err_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if b.len() < max_output {
                b.extend_from_slice(&chunk[..n]);
            }
        }
        b
    });
    let child = std::sync::Mutex::new(child);
    let (finished, stopped) = (AtomicBool::new(false), AtomicBool::new(false));
    let mut stdout = Vec::new();
    let mut phase = "tex";
    let mut downloads = 0;
    std::thread::scope(|scope| -> std::io::Result<()> {
    if let Some(g) = guard {
        let (child, finished, stopped) = (&child, &finished, &stopped);
        scope.spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if g.cancel.load(Ordering::SeqCst) || std::time::Instant::now() > g.deadline {
                    stopped.store(true, Ordering::SeqCst);
                    let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        });
    }
    let done = |r| {
        finished.store(true, Ordering::SeqCst);
        r
    };
    for line in std::io::BufReader::new(child_stdout).split(b'\n') {
        let line = match line {
            Ok(l) => l,
            Err(e) => return done(Err(e)),
        };
        let text = String::from_utf8_lossy(&line);
        let note = text.trim().strip_prefix("note: ").unwrap_or("");
        let mut file = None;
        if note.starts_with("generating format") {
            phase = "format";
        } else if let Some(f) = note.strip_prefix("downloading ") {
            downloads += 1;
            file = Some(f.to_string());
            if phase != "format" && phase != "pdf" {
                phase = "download";
            }
        } else if note.starts_with("Running TeX") {
            phase = "tex";
        } else if note.starts_with("Rerunning TeX") {
            phase = "rerun";
        } else if note.starts_with("Running xdvipdfmx") {
            phase = "pdf";
        } else if note.starts_with("Writing") {
            phase = "write";
        } else {
            if stdout.len() < max_output {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            continue;
        }
        emit(Progress { phase, downloads, file });
    }
    done(Ok(()))
    })?;
    let status = child.into_inner().unwrap_or_else(|e| e.into_inner()).wait()?;
    if stopped.load(Ordering::SeqCst) {
        return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
    }
    Ok(std::process::Output { status, stdout, stderr: err_thread.join().unwrap_or_default() })
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
        match split_location(rest) {
            Some((f, l, m)) => v.push(Diagnostic { file: map_file(f), line: l, message: m.into(), severity: sev.into() }),
            None => v.push(Diagnostic { file: String::new(), line: 0, message: rest.trim().into(), severity: sev.into() }),
        }
    }
    // Tectonic repeats messages on every TeX pass (not necessarily adjacent): keep the first of each.
    let mut seen = std::collections::HashSet::new();
    v.retain(|d| seen.insert((d.file.clone(), d.line, d.message.clone())));
    v
}

/// Splits `file:line: message` at the first `:<digits>:` segment, so colons inside the
/// file name (Windows drive letters like `C:\x\a.tex`) or the message don't break it.
fn split_location(rest: &str) -> Option<(&str, u32, &str)> {
    for (i, _) in rest.match_indices(':') {
        let after = &rest[i + 1..];
        let Some(j) = after.find(':') else { break };
        let file = rest[..i].trim();
        if let (false, Ok(line)) = (file.is_empty(), after[..j].trim().parse::<u32>()) {
            return Some((file, line, after[j + 1..].trim()));
        }
    }
    None
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

    fn id(f: &str) -> String {
        f.to_string()
    }

    #[test]
    fn tectonic_warning_and_no_location() {
        let out = "note: Running TeX ...\nwarning: main.tex:4: Overfull \\hbox\nerror: something went wrong\nwarning: no colon here";
        let d = parse_tectonic(out, &|f| format!("/src/{f}"));
        assert_eq!(d.len(), 3);
        assert_eq!((d[0].file.as_str(), d[0].line, d[0].message.as_str(), d[0].severity.as_str()), ("/src/main.tex", 4, "Overfull \\hbox", "warning"));
        assert_eq!((d[1].file.as_str(), d[1].line, d[1].message.as_str(), d[1].severity.as_str()), ("", 0, "something went wrong", "error"));
        assert_eq!((d[2].file.as_str(), d[2].line, d[2].message.as_str()), ("", 0, "no colon here"));
    }

    #[test]
    fn tectonic_non_numeric_line_falls_back() {
        let d = parse_tectonic("error: a.tex:x: msg", &id);
        assert_eq!((d[0].file.as_str(), d[0].line, d[0].message.as_str()), ("", 0, "a.tex:x: msg"));
    }

    #[test]
    fn tectonic_dedupes_non_adjacent() {
        let out = "error: a.tex:1: A\nerror: a.tex:2: B\nerror: a.tex:1: A\nerror: b.tex:1: A\nwarning: a.tex:2: B";
        let d = parse_tectonic(out, &id);
        let got: Vec<_> = d.iter().map(|d| (d.file.as_str(), d.line, d.message.as_str())).collect();
        // Same file/line/message with another severity counts as a duplicate too.
        assert_eq!(got, vec![("a.tex", 1, "A"), ("a.tex", 2, "B"), ("b.tex", 1, "A")]);
    }

    #[test]
    fn tectonic_windows_path() {
        let d = parse_tectonic("error: C:\\x\\a.tex:3: msg", &id);
        assert_eq!((d[0].file.as_str(), d[0].line, d[0].message.as_str()), ("C:\\x\\a.tex", 3, "msg"));
    }

    #[test]
    fn tectonic_message_with_colons() {
        let out = "error: a.tex:5: Missing $ inserted: see b.tex:12: here\nwarning: C:\\x\\a.tex:7: Overfull \\hbox: 3pt too wide";
        let d = parse_tectonic(out, &id);
        let got: Vec<_> = d.iter().map(|d| (d.file.as_str(), d.line, d.message.as_str(), d.severity.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("a.tex", 5, "Missing $ inserted: see b.tex:12: here", "error"),
                ("C:\\x\\a.tex", 7, "Overfull \\hbox: 3pt too wide", "warning"),
            ]
        );
    }

    #[test]
    fn tectonic_unix_path_and_no_line() {
        let d = parse_tectonic("error: /home/u/a.tex:3: msg\nerror: C:\\x\\a.tex: no line", &id);
        assert_eq!((d[0].file.as_str(), d[0].line, d[0].message.as_str()), ("/home/u/a.tex", 3, "msg"));
        assert_eq!((d[1].file.as_str(), d[1].line, d[1].message.as_str()), ("", 0, "C:\\x\\a.tex: no line"));
    }

    #[test]
    fn tex_log_reference_warning() {
        let log = "(./main.tex\nLaTeX Warning: Reference `fig:a' on page 1 undefined on input line 42.\n\n[1]";
        let d = parse_tex_log(log, &id);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 42);
        assert_eq!(d[0].message, "Reference `fig:a' on page 1 undefined");
        assert_eq!(d[0].severity, "warning");
        assert_eq!(d[0].file, "");
    }

    #[test]
    fn tex_log_without_input_line() {
        let log = "LaTeX Warning: There were undefined references.\n\n\nLaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\n\n )";
        let d = parse_tex_log(log, &id);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].line, d[0].message.as_str()), (0, "There were undefined references."));
        assert_eq!((d[1].line, d[1].message.as_str()), (0, "Label(s) may have changed. Rerun to get cross-references right."));
    }

    #[test]
    fn tex_log_wrapped_lines() {
        let log = "LaTeX Warning: Citation `knuth84' on page 3 undefined on input\nline 17.\n\n";
        let d = parse_tex_log(log, &id);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 17);
        assert_eq!(d[0].message, "Citation `knuth84' on page 3 undefined");
        let log = "LaTeX Warning: Reference `a' on page 1 undefined\non input line 5.\n\n";
        let d = parse_tex_log(log, &id);
        assert_eq!((d[0].line, d[0].message.as_str()), (5, "Reference `a' on page 1 undefined"));
        assert!(parse_tex_log("no warnings here", &id).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn source_through_symlinked_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir_all(real.join("cache/abc")).unwrap();
        std::fs::create_dir_all(real.join("proj")).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (build, src) = (link.join("cache/abc"), link.join("proj"));
        let norm = |p: PathBuf| crate::env::norm(p);
        let real = real.canonicalize().unwrap();
        // SyncTeX names the build copy by its resolved path.
        let f = real.join("cache/abc/./main.tex");
        assert_eq!(map_source(&f.to_string_lossy(), &build, &src), norm(src.join("main.tex")));
        // Files found through the search path, resolved as well.
        let f = real.join("proj/chapters/one.tex");
        assert_eq!(map_source(&f.to_string_lossy(), &build, &src), norm(src.join("chapters/one.tex")));
        // Unresolved and relative names keep working.
        assert_eq!(map_source(&build.join("main.tex").to_string_lossy(), &build, &src), norm(src.join("main.tex")));
        assert_eq!(map_source("./chapters/one.tex", &build, &src), norm(src.join("chapters/one.tex")));
        assert_eq!(map_source("/usr/share/x.sty", &build, &src), "/usr/share/x.sty");
    }

    #[test]
    fn source_without_tex_extension() {
        let dir = tempfile::tempdir().unwrap();
        let (src, build) = (dir.path().join("src"), dir.path().join("build"));
        std::fs::create_dir_all(src.join("chapters")).unwrap();
        std::fs::write(src.join("chapters/broken.tex"), "").unwrap();
        std::fs::write(src.join("data"), "").unwrap();
        std::fs::write(src.join("data.tex"), "").unwrap();
        let norm = |p: PathBuf| crate::env::norm(p);
        assert_eq!(map_source("chapters/broken", &build, &src), norm(src.join("chapters/broken.tex")));
        assert_eq!(map_source("./chapters/broken.tex", &build, &src), norm(src.join("chapters/broken.tex")));
        assert_eq!(map_source(&build.join("main.tex").to_string_lossy(), &build, &src), norm(src.join("main.tex")));
        // An existing file without extension is kept; a missing one stays as reported.
        assert_eq!(map_source("data", &build, &src), norm(src.join("data")));
        assert_eq!(map_source("missing", &build, &src), norm(src.join("missing")));
    }

    #[test]
    fn stale_overlays_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (src, build) = (dir.path().join("src"), dir.path().join("build"));
        std::fs::create_dir_all(src.join("chapters")).unwrap();
        std::fs::create_dir_all(&build).unwrap();
        let (main, one) = (src.join("main.tex"), src.join("chapters/one.tex"));
        std::fs::write(&main, "\\documentclass{article}").unwrap();
        std::fs::write(&one, "saved").unwrap();
        // Compiling while chapters/one.tex has unsaved edits overlays them.
        assert_eq!(prepare_build(&build, &main, &src, &one, "unsaved").unwrap(), "main.tex");
        assert_eq!(std::fs::read_to_string(build.join("chapters/one.tex")).unwrap(), "unsaved");
        // The edits are discarded and main.tex is compiled: the source file must win again.
        prepare_build(&build, &main, &src, &main, "\\documentclass{article}").unwrap();
        assert!(!build.join("chapters/one.tex").exists());
        assert!(!build.join(OVERLAYS).exists());
        assert!(build.join("main.tex").exists());
        // A manifest entry can't delete anything outside the build dir.
        std::fs::write(build.join(OVERLAYS), "../src/chapters/one.tex\n/etc/passwd\n").unwrap();
        prepare_build(&build, &main, &src, &main, "x").unwrap();
        assert!(one.exists());
    }

    #[test]
    fn root_magic_comment() {
        let p = Path::new("/proj/chapters/ch1.tex");
        assert_eq!(find_root(p, "% !TEX root = ../main.tex\n\\section{A}"), Path::new("/proj/chapters").join("../main.tex"));
        assert_eq!(find_root(p, "%!TeX root=main.tex\n"), Path::new("/proj/chapters/main.tex"));
        // Magic comment wins over \documentclass.
        assert_eq!(find_root(p, "% !TEX root = book.tex\n\\documentclass{article}"), Path::new("/proj/chapters/book.tex"));
    }

    #[test]
    fn root_documentclass_sibling_and_self() {
        let dir = tempfile::tempdir().unwrap();
        let ch = dir.path().join("ch.tex");
        assert_eq!(find_root(&ch, "\\section{A}"), ch);
        assert_eq!(find_root(&ch, "\\documentclass{article}"), ch);
        std::fs::write(dir.path().join("main.tex"), "\\documentclass{article}").unwrap();
        assert_eq!(find_root(&ch, "\\section{A}"), dir.path().join("main.tex"));
        assert_eq!(find_root(&ch, "\\documentclass{article}"), ch);
    }

    #[test]
    fn including_document_skips_a_huge_sibling() {
        let t = tempfile::tempdir().unwrap();
        let (huge, part) = (t.path().join("huge.tex"), t.path().join("part.tex"));
        std::fs::write(&huge, "\\documentclass{article}\n\\input{part}\n").unwrap();
        std::fs::OpenOptions::new().write(true).open(&huge).unwrap().set_len(crate::fs::MAX_TEXT_FILE + 1).unwrap();
        std::fs::write(&part, "x").unwrap();
        assert_eq!(including_document(t.path(), &part), None);
    }

    #[test]
    fn root_in_parent_folder() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path();
        std::fs::create_dir_all(proj.join("chapters/deep")).unwrap();
        std::fs::create_dir(proj.join(".git")).unwrap();
        let one = proj.join("chapters/one.tex");
        // A parent main.tex is found even without an \input of the file.
        std::fs::write(proj.join("main.tex"), "\\documentclass{article}").unwrap();
        assert_eq!(find_root(&one, "\\section{A}"), proj.join("main.tex"));
        // A document that includes the file wins over main.tex.
        std::fs::write(proj.join("thesis.tex"), "\\documentclass{book}\n% \\input{chapters/two}\n\\input{./chapters/one}\n").unwrap();
        assert_eq!(find_root(&one, "\\section{A}"), proj.join("thesis.tex"));
        assert_eq!(find_root(&proj.join("chapters/deep/x.tex"), ""), proj.join("main.tex"));
        // Commented-out includes don't count.
        assert_eq!(find_root(&proj.join("chapters/two.tex"), ""), proj.join("main.tex"));
        // The search stops at the git root.
        let sub = proj.join("sub");
        std::fs::create_dir_all(sub.join(".git")).unwrap();
        assert_eq!(find_root(&sub.join("a.tex"), ""), sub.join("a.tex"));
    }

    #[test]
    fn include_matching() {
        let rel = Path::new("chapters/one.tex");
        assert!(includes("\\input{chapters/one}", rel));
        assert!(includes("x \\include{ chapters/one.tex }", rel));
        assert!(includes("\\subfile{./chapters/one}", rel));
        assert!(!includes("\\input{chapters/one2}", rel));
        assert!(!includes("% \\input{chapters/one}", rel));
    }
}
