//! LaTeX and images for Code Together guests, on the host.
//!
//! Compiling is what the `run` capability allows, so it uses the host's normal Tectonic path. A guest
//! names a shared file and nothing else: no flags, environment or paths outside the project. The
//! shared text goes into a separate build dir, so the host's files and its own builds stay as they are.
use serde::{Deserialize, Serialize};
use base64::Engine;
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::collab::{guest_path_ok, is_git_name};
use crate::latex::{canonical, find_root, magic_root, prepare_build, run_and_collect, run_with_progress, Diagnostic, Progress, RunGuard, SyncBox, OVERLAYS};

/// Largest image a guest can fetch.
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
/// SVG is text that a browser parses, so it gets a tighter cap.
const MAX_SVG: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct GuestImage {
    mime: &'static str,
    data: String,
}

/// The image type by its content (never the file name). SVG is only ever shown through `<img>` with
/// a `data:` URL on the guest, where scripts and external loads don't run.
fn sniff_image(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else if b.len() > 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        Some("image/avif")
    } else if b.starts_with(b"BM") {
        Some("image/bmp")
    } else if is_svg(b) {
        Some("image/svg+xml")
    } else {
        None
    }
}

/// Whether the text starts (after a BOM, XML prolog, comments, doctype) with an `<svg` element.
fn is_svg(b: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(&b[..b.len().min(MAX_SVG as usize + 1)]) else { return false };
    if b.len() as u64 > MAX_SVG {
        return false;
    }
    let mut s = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        let end = if s.starts_with("<?") {
            s.find("?>").map(|i| i + 2)
        } else if s.starts_with("<!--") {
            s.find("-->").map(|i| i + 3)
        } else if s.starts_with("<!DOCTYPE") || s.starts_with("<!doctype") {
            s.find('>').map(|i| i + 1)
        } else {
            break;
        };
        let Some(end) = end else { return false };
        s = s[end..].trim_start();
    }
    s.strip_prefix("<svg").is_some_and(|r| r.starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/'))
}

/// A relative path of plain names: nothing absolute, no `.`/`..`, no git folder, no backslash.
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\0')
        && !rel.contains('\\')
        && Path::new(rel).components().all(|c| matches!(c, Component::Normal(n) if !is_git_name(&n.to_string_lossy())))
        && !rel.split('/').any(|s| s.is_empty() || s == "." || s == "..")
}

/// Opens a regular file without following a final symlink, and checks where it really is.
fn open_inside(path: &Path, real_root: &Path) -> Option<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); // a FIFO must not hang the host
    }
    let file = o.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    #[cfg(target_os = "linux")]
    let real = {
        use std::os::fd::AsRawFd;
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?
    };
    #[cfg(not(target_os = "linux"))]
    let real = path.canonicalize().ok()?;
    let rel = real.strip_prefix(real_root).ok()?;
    rel.components().all(|c| !is_git_name(&c.as_os_str().to_string_lossy())).then_some(file)
}

fn read_image(root: &Path, rel: &str) -> Result<GuestImage, &'static str> {
    if !safe_rel(rel) {
        return Err("asset_refused");
    }
    let path = root.join(rel);
    if !guest_path_ok(root, &path) {
        return Err("asset_refused");
    }
    let real_root = root.canonicalize().map_err(|_| "asset_refused")?;
    let file = open_inside(&path, &real_root).ok_or("asset_missing")?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE + 1).read_to_end(&mut bytes).map_err(|_| "asset_missing")?;
    if bytes.len() as u64 > MAX_IMAGE {
        return Err("too_large");
    }
    let mime = sniff_image(&bytes).ok_or("asset_unsupported")?;
    Ok(GuestImage { mime, data: base64::engine::general_purpose::STANDARD.encode(&bytes) })
}

/// Host: a project image for a guest's Markdown preview. Errors are stable codes without paths.
#[tauri::command]
pub async fn collab_read_image(app: AppHandle, window: tauri::WebviewWindow, root: String, rel: String) -> Result<GuestImage, String> {
    crate::collab::guard(&app, &window, Some(&root)).map_err(|_| "asset_missing".to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_image(Path::new(&root), &rel).map_err(str::to_string))
        .await
        .map_err(|_| "asset_missing".to_string())?
}

#[derive(Deserialize)]
pub struct Overlay {
    rel: String,
    text: String,
}

#[derive(Serialize)]
pub struct GuestCompile {
    ok: bool,
    /// The PDF, base64.
    pdf: Option<String>,
    /// `file` is relative to the project, "" for anything else.
    diagnostics: Vec<Diagnostic>,
    log: String,
    sync: Vec<SyncBox>,
    millis: u128,
}

const MAX_TEXT: usize = 16 * 1024 * 1024;
/// The PDF, before base64.
const MAX_PDF: u64 = 16 * 1024 * 1024;
/// The whole answer as JSON, below the RPC limit (24 MB) with room for its envelope.
const MAX_RESPONSE: usize = 23 * 1024 * 1024;
const MAX_SYNC: usize = 40_000;
const MAX_DIAGNOSTICS: usize = 500;
const MAX_MESSAGE: usize = 2000;
/// A job folder older than this was left by a crash.
const STALE_JOB: Duration = Duration::from_secs(3600);
const MAX_LOG: usize = 256 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_TIME: Duration = Duration::from_secs(170);

fn is_tex(p: &Path) -> bool {
    p.extension().is_some_and(|e| ["tex", "ltx", "latex"].contains(&e.to_string_lossy().to_lowercase().as_str()))
}

/// Resolves `.` and `..` without touching the disk.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The document to compile. An explicit `!TEX root` that leaves the project is refused; a guess
/// that leaves it falls back to the file itself.
fn guest_root(project: &Path, rel: &str, content: &str) -> Result<PathBuf, &'static str> {
    let file = project.join(rel);
    if !safe_rel(rel) || !guest_path_ok(project, &file) {
        return Err("path_refused");
    }
    let usable = |p: &Path| p.strip_prefix(project).ok().and_then(|r| r.to_str()).is_some_and(safe_rel) && guest_path_ok(project, p) && p.is_file();
    let root = match magic_root(&file, content) {
        Some(magic) => {
            let magic = lexical(&magic);
            if magic != file && !usable(&magic) {
                return Err("root_outside");
            }
            magic
        }
        None => Some(lexical(&find_root(&file, content))).filter(|f| usable(f)).unwrap_or(file),
    };
    if is_tex(&root) { Ok(root) } else { Err("no_root") }
}

/// Puts the other shared files' current text into the build dir, where TeX finds it before the
/// project's copy. Only files at or below the root's folder can be shadowed this way.
fn write_overlays(build: &Path, project: &Path, root_dir: &Path, overlays: &[Overlay]) -> Result<(), &'static str> {
    let mut listed = std::fs::read_to_string(build.join(OVERLAYS)).unwrap_or_default();
    let mut total = 0;
    for o in overlays {
        let abs = project.join(&o.rel);
        if !safe_rel(&o.rel) || !guest_path_ok(project, &abs) {
            continue;
        }
        let Ok(rel) = abs.strip_prefix(root_dir) else { continue };
        total += o.text.len();
        if total > MAX_TEXT {
            return Err("project_too_large");
        }
        let dest = build.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "compile_failed")?;
        }
        std::fs::write(&dest, &o.text).map_err(|_| "compile_failed")?;
        listed.push_str(&format!("{}\n", rel.to_string_lossy()));
    }
    std::fs::write(build.join(OVERLAYS), listed).map_err(|_| "compile_failed")
}

/// Replaces `needle`, also where TeX wrapped it across lines in its log (the line break is kept out).
fn replace_wrapped(text: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let (bytes, want) = (text.as_bytes(), needle.as_bytes());
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    while i < bytes.len() {
        if bytes[i] == want[0] {
            let (mut t, mut n) = (i, 0);
            while t < bytes.len() && n < want.len() {
                if bytes[t] == want[n] {
                    n += 1;
                    t += 1;
                } else if bytes[t] == b'\n' && n > 0 {
                    t += 1;
                } else {
                    break;
                }
            }
            if n == want.len() {
                out.push_str(&text[copied..i]);
                out.push_str(with);
                i = t;
                copied = t;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// Takes the host's own folders out of a text for a guest.
fn scrub(text: &str, build: &Path, project: Option<&Path>) -> String {
    let mut dirs = vec![(build.to_path_buf(), "."), (crate::env::home(), "~")];
    if let Some(p) = project {
        dirs.push((p.to_path_buf(), "."));
    }
    for (d, to) in dirs.clone() {
        if let Some(real) = canonical(&d) {
            dirs.push((real, to));
        }
    }
    scrub_dirs(text, dirs.iter().map(|(d, to)| (d.to_string_lossy().to_string(), *to)).collect())
}

/// Replaces each folder by its short form, as written and with the other kind of slash: TeX and
/// Tectonic report Windows paths as `C:/Users/…` as well as `C:\\Users\\…`.
fn scrub_dirs(text: &str, dirs: Vec<(String, &str)>) -> String {
    let mut all: Vec<(String, &str)> = Vec::new();
    for (d, to) in dirs {
        if d.len() <= 1 {
            continue;
        }
        let d = d.trim_end_matches(['/', '\\']).to_string();
        if d.contains('\\') {
            all.push((d.replace('\\', "/"), to));
        } else if d.as_bytes().get(1) == Some(&b':') {
            all.push((d.replace('/', "\\"), to));
        }
        all.push((d, to));
    }
    // Longest first: the project usually lies inside the home folder.
    all.sort_by_key(|(d, _)| std::cmp::Reverse(d.len()));
    let mut out = text.to_string();
    for (d, to) in all {
        let short = if to == "." { "" } else { "~/" };
        out = replace_wrapped(&out, &format!("{d}/"), short);
        out = replace_wrapped(&out, &format!("{d}\\"), short);
        out = replace_wrapped(&out, &d, to);
    }
    out
}

/// Keeps the JSON of an answer within `limit`: SyncTeX goes first, as it's only a convenience. A
/// PDF that doesn't fit even then is refused rather than cut.
fn fit_response(r: &mut GuestCompile, limit: usize) -> Result<(), &'static str> {
    let size = |r: &GuestCompile| serde_json::to_vec(r).map_or(usize::MAX, |v| v.len());
    while size(r) > limit && !r.sync.is_empty() {
        let keep = r.sync.len() / 2;
        r.sync.truncate(keep);
    }
    if size(r) <= limit {
        return Ok(());
    }
    r.log = tail(&r.log, 16 * 1024).to_string();
    r.diagnostics.truncate(50);
    if size(r) <= limit {
        Ok(())
    } else if r.pdf.is_some() {
        Err("pdf_too_large")
    } else {
        Err("output_too_large")
    }
}

fn cut(s: &mut String, max: usize) {
    if s.len() > max {
        let mut i = max;
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        s.truncate(i);
    }
}

/// A build folder for one compile: no output of an earlier one can be taken for this one's, and
/// guests don't share files. Removed however the compile ends.
struct JobDir(PathBuf);
impl JobDir {
    fn new(cache: &Path) -> Result<Self, &'static str> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let parent = cache.join("latex").join("guest-jobs");
        std::fs::create_dir_all(&parent).map_err(|_| "compile_failed")?;
        // What a crash left behind. Not everything: another instance may be compiling.
        for e in std::fs::read_dir(&parent).into_iter().flatten().flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE_JOB);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
        let dir = parent.join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir(&dir).map_err(|_| "compile_failed")?;
        Ok(JobDir(dir))
    }
}
impl Drop for JobDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = s.len() - max;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
}

/// An absolute path from the compile as a project-relative one; "" if it isn't a project file.
fn to_project(f: &str, project: Option<&Path>) -> String {
    let Some(project) = project else { return String::new() };
    let p = Path::new(f);
    let real = canonical(project);
    let rel = p.strip_prefix(project).ok().or_else(|| real.as_deref().and_then(|r| p.strip_prefix(r).ok()));
    match rel.and_then(|r| r.to_str()) {
        Some(r) if safe_rel(r) && guest_path_ok(project, p) && p.is_file() => r.to_string(),
        _ => String::new(),
    }
}

struct Request<'a> {
    root: Option<&'a Path>,
    file: Option<&'a str>,
    content: &'a str,
    overlays: &'a [Overlay],
}

fn compile_job(tectonic: &Path, cache: &Path, req: &Request, cancel: &AtomicBool, emit: &(dyn Fn(Progress) + Sync)) -> Result<GuestCompile, &'static str> {
    let started = Instant::now();
    if req.content.len() > MAX_TEXT {
        return Err("project_too_large");
    }
    let target = match (req.root, req.file) {
        (Some(project), Some(file)) => Some((project, project.join(file), guest_root(project, file, req.content)?)),
        (None, None) => None,
        _ => return Err("path_refused"),
    };
    // Its own folder: a host compile of the same document may be running.
    let job = JobDir::new(cache)?;
    let build = job.0.clone();
    let (root_dir, root_name) = match &target {
        Some((project, file, root)) => {
            let dir = root.parent().ok_or("root_outside")?.to_path_buf();
            let name = prepare_build(&build, root, &dir, file, req.content).map_err(|_| "compile_failed")?;
            write_overlays(&build, project, &dir, req.overlays)?;
            (dir, name)
        }
        None => {
            // An unsaved tab has no folder: it sees nothing of the host's.
            std::fs::write(build.join("main.tex"), req.content).map_err(|_| "compile_failed")?;
            (build.clone(), "main.tex".to_string())
        }
    };
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    let guard = RunGuard { cancel, deadline: started + MAX_TIME, max_output: MAX_OUTPUT };
    let mut run = |c: std::process::Command, _cached: bool| run_with_progress(c, emit, Some(&guard));
    let result = run_and_collect(tectonic, &build, &root_dir, &root_name, started, &mut run);
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    if Instant::now() > guard.deadline {
        return Err("compile_timeout");
    }
    let r = result.map_err(|_| "compile_failed")?;
    let project = req.root;
    let pdf = match &r.pdf {
        Some(p) if r.ok || !r.sync.is_empty() => {
            let file = std::fs::File::open(p).map_err(|_| "compile_failed")?;
            let mut bytes = Vec::new();
            file.take(MAX_PDF + 1).read_to_end(&mut bytes).map_err(|_| "compile_failed")?;
            if bytes.len() as u64 > MAX_PDF {
                return Err("pdf_too_large");
            }
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        _ => None,
    };
    let mut diagnostics = r.diagnostics;
    // Errors first: they're what the panel can't do without.
    diagnostics.sort_by_key(|d| d.severity != "error");
    diagnostics.truncate(MAX_DIAGNOSTICS);
    for d in &mut diagnostics {
        d.file = to_project(&d.file, project);
        d.message = scrub(&d.message, &build, project);
        cut(&mut d.message, MAX_MESSAGE);
    }
    let mut sync = r.sync;
    sync.truncate(MAX_SYNC);
    let mut known = std::collections::HashMap::new();
    for b in &mut sync {
        let mapped = known.entry(std::mem::take(&mut b.file)).or_insert_with_key(|f| to_project(f, project));
        b.file = mapped.clone();
    }
    // A bit more than is kept, so a path cut off by the tail is scrubbed first.
    let log = scrub(tail(&r.log, MAX_LOG + 8192), &build, project);
    let mut answer = GuestCompile { ok: r.ok, pdf, diagnostics, log: tail(&log, MAX_LOG).to_string(), sync, millis: r.millis };
    fit_response(&mut answer, MAX_RESPONSE)?;
    Ok(answer)
}

#[derive(Default)]
struct Jobs {
    /// The one compile running for guests.
    active: Option<(String, Arc<AtomicBool>)>,
    /// Cancels that came before their job started. Job ids are unique, so old ones do no harm.
    early: VecDeque<String>,
}

impl Jobs {
    fn claim(&mut self, job: &str) -> Result<Arc<AtomicBool>, &'static str> {
        if let Some(i) = self.early.iter().position(|j| j == job) {
            self.early.remove(i);
            return Err("cancelled");
        }
        if self.active.is_some() {
            return Err("busy");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.active = Some((job.to_string(), cancel.clone()));
        Ok(cancel)
    }

    fn cancel(&mut self, job: &str) {
        match &self.active {
            Some((id, cancel)) if id == job => cancel.store(true, Ordering::SeqCst),
            _ => {
                if self.early.len() >= MAX_EARLY_CANCELS {
                    self.early.pop_front();
                }
                self.early.push_back(job.to_string());
            }
        }
    }
}

const MAX_EARLY_CANCELS: usize = 64;
static JOBS: LazyLock<Mutex<Jobs>> = LazyLock::new(Default::default);
fn jobs() -> std::sync::MutexGuard<'static, Jobs> {
    JOBS.lock().unwrap_or_else(|e| e.into_inner())
}

struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        jobs().active = None;
    }
}

#[derive(Serialize, Clone)]
struct JobProgress {
    job: String,
    #[serde(flatten)]
    progress: Progress,
}

/// Host: compiles a shared file for a guest. Errors are stable codes without paths.
#[tauri::command]
pub async fn latex_guest_compile(app: AppHandle, window: tauri::WebviewWindow, job: String, root: Option<String>, file: Option<String>, content: String, overlays: Vec<Overlay>) -> Result<GuestCompile, String> {
    crate::collab::guard(&app, &window, root.as_deref()).map_err(|_| "compile_failed".to_string())?;
    let cancel = jobs().claim(&job)?;
    let slot = Slot;
    let tectonic = crate::env::which("tectonic").ok_or("tectonic_missing")?;
    let cache = app.path().app_cache_dir().map_err(|_| "compile_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        let emit = |progress: Progress| {
            crate::windows::emit(&app, window.label(), "latex-guest-progress", JobProgress { job: job.clone(), progress });
        };
        let req = Request { root: root.as_deref().map(Path::new), file: file.as_deref(), content: &content, overlays: &overlays };
        compile_job(&tectonic, &cache, &req, &cancel, &emit).map_err(str::to_string)
    })
    .await
    .map_err(|_| "compile_failed".to_string())?
}

#[tauri::command]
pub fn latex_guest_cancel(job: String) {
    jobs().cancel(&job);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_progress(_: Progress) {}

    /// Tectonic with a cached LaTeX format, for the tests that really compile.
    fn tectonic() -> Option<PathBuf> {
        let exe = crate::env::which("tectonic").or_else(|| {
            let p = crate::env::home().join(".local/share/com.eron.ide/tools/tectonic/tectonic");
            p.is_file().then_some(p)
        })?;
        let cache = std::env::var_os("TECTONIC_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|| crate::env::home().join(".cache/tectonic"));
        std::fs::read_dir(cache.join("formats")).ok()?.next().map(|_| exe)
    }

    const END: &str = "\\shipout\\hbox{\\vrule width 1pt height 1pt}\\csname @@end\\endcsname\\end\n";

    #[test]
    fn the_root_stays_in_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join("ch")).unwrap();
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::write(dir.path().join("evil.tex"), "\\documentclass{article}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("evil.tex"), project.join("link.tex")).unwrap();
        std::fs::write(project.join("main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(project.join(".git/x.tex"), "").unwrap();
        for bad in ["../../evil.tex", "/etc/passwd", "../.git/x.tex"] {
            assert_eq!(guest_root(&project, "ch/a.tex", &format!("% !TEX root = {bad}\n")), Err("root_outside"), "{bad}");
        }
        #[cfg(unix)]
        assert_eq!(guest_root(&project, "ch/a.tex", "% !TEX root = ../link.tex\n"), Err("root_outside"));
        assert_eq!(guest_root(&project, "ch/a.tex", "% !TEX root = ../main.tex\n"), Ok(project.join("main.tex")));
        for bad in ["../evil.tex", ".git/x.tex", "/etc/passwd"] {
            assert_eq!(guest_root(&project, bad, ""), Err("path_refused"), "{bad}");
        }
    }

    #[test]
    fn a_guessed_root_outside_the_project_falls_back_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(dir.path().join("main.tex"), "\\documentclass{article}\n\\input{proj/a}\n").unwrap();
        assert_eq!(guest_root(&project, "a.tex", "text"), Ok(project.join("a.tex")));
    }

    #[test]
    fn results_name_only_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join("ch")).unwrap();
        std::fs::write(project.join("ch/a.tex"), "").unwrap();
        let abs = project.join("ch/a.tex");
        assert_eq!(to_project(&abs.to_string_lossy(), Some(&project)), "ch/a.tex");
        assert_eq!(to_project(&abs.canonicalize().unwrap().to_string_lossy(), Some(&project)), "ch/a.tex");
        for other in ["/etc/passwd", "article.cls", "../x.tex"] {
            assert_eq!(to_project(other, Some(&project)), "", "{other}");
        }
        assert_eq!(to_project(&abs.to_string_lossy(), None), "");
    }

    #[test]
    fn logs_lose_host_paths_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let (build, project) = (dir.path().join("cache/guest-1"), dir.path().join("proj"));
        std::fs::create_dir_all(&build).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        let (head, rest) = p.split_at(p.len() / 2);
        let log = format!("({}/main.tex\n! Undefined control sequence.\nl.3 ({head}\n{rest}/ch/a.tex) ({}/x.aux) 100% /usr/share/x", build.display(), project.display());
        let out = scrub(&log, &build, Some(&project));
        assert!(!out.contains(&p) && !out.contains(head), "{out}");
        assert!(out.starts_with("(main.tex\n! Undefined control sequence.\nl.3 (ch/a.tex) (x.aux) 100% /usr/share/x"), "{out}");
    }

    #[test]
    fn the_shared_text_is_compiled_and_the_host_files_stay() {
        let Some(exe) = tectonic() else { return eprintln!("skipped: needs Tectonic with a cached format") };
        let dir = tempfile::tempdir().unwrap();
        let (project, cache) = (dir.path().join("proj"), dir.path().join("cache"));
        std::fs::create_dir_all(project.join("ch")).unwrap();
        std::fs::write(project.join("main.tex"), "saved main").unwrap();
        std::fs::write(project.join("ch/one.tex"), "\\immediate\\write16{SAVED-PART}\n").unwrap();
        let doc = format!("\\immediate\\write16{{UNSAVED-MAIN}}\n\\input{{ch/one}}\n{END}");
        let overlays = [Overlay { rel: "ch/one.tex".into(), text: "\\immediate\\write16{UNSAVED-PART}\n".into() }];
        let req = Request { root: Some(&project), file: Some("main.tex"), content: &doc, overlays: &overlays };
        let r = compile_job(&exe, &cache, &req, &AtomicBool::new(false), &no_progress).unwrap();
        assert!(r.log.contains("UNSAVED-MAIN") && r.log.contains("UNSAVED-PART") && !r.log.contains("SAVED-PART\n\n"), "{}", r.log);
        assert!(r.pdf.is_some());
        assert_eq!(std::fs::read_to_string(project.join("main.tex")).unwrap(), "saved main");
        assert_eq!(std::fs::read_to_string(project.join("ch/one.tex")).unwrap(), "\\immediate\\write16{SAVED-PART}\n");
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 2, "nothing new in the project");
        assert!(!r.log.contains(&project.display().to_string()) && !r.log.contains(&cache.display().to_string()), "{}", r.log);
    }

    #[test]
    fn shell_escape_stays_off() {
        let Some(exe) = tectonic() else { return eprintln!("skipped: needs Tectonic with a cached format") };
        let dir = tempfile::tempdir().unwrap();
        let (project, marker) = (dir.path().join("proj"), dir.path().join("pwned"));
        std::fs::create_dir_all(&project).unwrap();
        let doc = format!("\\immediate\\write18{{touch {}}}\n{END}", marker.display());
        std::fs::write(project.join("main.tex"), &doc).unwrap();
        let req = Request { root: Some(&project), file: Some("main.tex"), content: &doc, overlays: &[] };
        compile_job(&exe, &dir.path().join("cache"), &req, &AtomicBool::new(false), &no_progress).unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn a_cancelled_compile_is_killed() {
        let Some(exe) = tectonic() else { return eprintln!("skipped: needs Tectonic with a cached format") };
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let doc = "\\def\\spin{\\spin}\\spin\n";
        std::fs::write(project.join("main.tex"), doc).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let req = Request { root: Some(&project), file: Some("main.tex"), content: doc, overlays: &[] };
        assert_eq!(compile_job(&exe, &dir.path().join("cache"), &req, &cancel, &no_progress).err(), Some("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_failed_compile_never_returns_an_older_pdf() {
        let Some(exe) = tectonic() else { return eprintln!("skipped: needs Tectonic with a cached format") };
        let dir = tempfile::tempdir().unwrap();
        let (project, cache) = (dir.path().join("proj"), dir.path().join("cache"));
        std::fs::create_dir_all(&project).unwrap();
        let good = format!("\\immediate\\write16{{GOOD}}\n{END}");
        std::fs::write(project.join("main.tex"), &good).unwrap();
        let req = Request { root: Some(&project), file: Some("main.tex"), content: &good, overlays: &[] };
        assert!(compile_job(&exe, &cache, &req, &AtomicBool::new(false), &no_progress).unwrap().pdf.is_some());
        let broken = "\\csname @@end\\endcsname\\end\n"; // no page, so no new PDF
        let req = Request { root: Some(&project), file: Some("main.tex"), content: broken, overlays: &[] };
        let r = compile_job(&exe, &cache, &req, &AtomicBool::new(false), &no_progress).unwrap();
        assert!(r.pdf.is_none() && r.sync.is_empty() && !r.log.contains("GOOD"), "stale output: {}", r.log);
    }

    #[test]
    fn nothing_stays_behind_after_a_compile_or_a_failed_overlay() {
        let Some(exe) = tectonic() else { return eprintln!("skipped: needs Tectonic with a cached format") };
        let dir = tempfile::tempdir().unwrap();
        let (project, cache) = (dir.path().join("proj"), dir.path().join("cache"));
        std::fs::create_dir_all(&project).unwrap();
        let doc = format!("{END}");
        std::fs::write(project.join("main.tex"), &doc).unwrap();
        // The second needs the first to be a folder, so the list fails halfway.
        let overlays = [Overlay { rel: "a.tex".into(), text: "SECRET-UNSAVED".into() }, Overlay { rel: "a.tex/b.tex".into(), text: "x".into() }];
        let req = Request { root: Some(&project), file: Some("main.tex"), content: &doc, overlays: &overlays };
        assert_eq!(compile_job(&exe, &cache, &req, &AtomicBool::new(false), &no_progress).err(), Some("compile_failed"));
        let jobs = cache.join("latex/guest-jobs");
        assert_eq!(std::fs::read_dir(&jobs).unwrap().count(), 0, "overlays stayed behind");
        let req = Request { root: Some(&project), file: Some("main.tex"), content: &doc, overlays: &[] };
        compile_job(&exe, &cache, &req, &AtomicBool::new(false), &no_progress).unwrap();
        assert_eq!(std::fs::read_dir(&jobs).unwrap().count(), 0);
    }

    #[test]
    fn two_unsaved_tabs_never_share_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (JobDir::new(dir.path()).unwrap(), JobDir::new(dir.path()).unwrap());
        assert_ne!(a.0, b.0);
        let path = a.0.clone();
        drop(a);
        assert!(!path.exists() && b.0.exists());
    }

    #[test]
    fn windows_paths_are_scrubbed_with_either_slash() {
        let dirs = || vec![("C:\\Users\\me\\proj".to_string(), "."), ("C:\\Users\\me".to_string(), "~")];
        let log = "(C:/Users/me/proj/main.tex) (C:\\Users\\me\\proj\\ch.tex) C:/Users/me/x.sty C:/Users/me/proj";
        assert_eq!(scrub_dirs(log, dirs()), "(main.tex) (ch.tex) ~/x.sty .");
        let wrapped = "(C:/Users/m\ne/proj/main.tex)";
        assert_eq!(scrub_dirs(wrapped, dirs()), "(main.tex)");
        // Not a folder of the host's: stays.
        assert_eq!(scrub_dirs("D:/Users/me/a.tex C:/Users/meta", dirs()), "D:/Users/me/a.tex ~ta");
    }

    fn answer(pdf: usize, sync: usize) -> GuestCompile {
        let boxes = (0..sync).map(|_| serde_json::from_value::<SyncBoxForTest>(serde_json::json!({})).unwrap().0).collect();
        GuestCompile { ok: true, pdf: (pdf > 0).then(|| "x".repeat(pdf)), diagnostics: vec![], log: "l".repeat(1000), sync: boxes, millis: 1 }
    }
    struct SyncBoxForTest(SyncBox);
    impl<'de> Deserialize<'de> for SyncBoxForTest {
        fn deserialize<D: serde::Deserializer<'de>>(_: D) -> Result<Self, D::Error> {
            Ok(SyncBoxForTest(SyncBox::for_test("chapters/one.tex")))
        }
    }

    #[test]
    fn an_answer_fits_the_limit_or_says_why_not() {
        let mut r = answer(1000, 2000);
        let full = serde_json::to_vec(&r).unwrap().len();
        let limit = full / 2;
        fit_response(&mut r, limit).unwrap();
        assert!(serde_json::to_vec(&r).unwrap().len() <= limit);
        assert!(!r.sync.is_empty() && r.pdf.is_some(), "only as much SyncTeX as needed goes");
        let mut r = answer(5000, 10);
        assert_eq!(fit_response(&mut r, 1000), Err("pdf_too_large"));
    }

    #[test]
    fn a_cancel_before_the_job_registers_is_not_lost() {
        let mut j = Jobs::default();
        j.cancel("early");
        assert_eq!(j.claim("early").err(), Some("cancelled"));
        assert!(j.active.is_none(), "a cancelled job takes no slot");
        let flag = j.claim("early").unwrap(); // once only
        assert!(!flag.load(Ordering::SeqCst));
        assert_eq!(j.claim("other").err(), Some("busy"));
        j.cancel("early");
        assert!(flag.load(Ordering::SeqCst));
        for i in 0..200 {
            j.cancel(&format!("x{i}"));
        }
        assert!(j.early.len() <= MAX_EARLY_CANCELS);
    }

    #[test]
    fn images_are_checked_by_content_and_place() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest";
        std::fs::write(project.join("a.png"), png).unwrap();
        std::fs::write(project.join("fake.png"), "<html><script>alert(1)</script>").unwrap();
        std::fs::write(project.join("b.svg"), "<?xml version='1.0'?>\n<!-- c -->\n<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        std::fs::write(project.join("big.svg"), format!("<svg>{}</svg>", " ".repeat(MAX_SVG as usize))).unwrap();
        std::fs::write(project.join(".git/c.png"), png).unwrap();
        std::fs::write(dir.path().join("out.png"), png).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("out.png"), project.join("link.png")).unwrap();
        std::fs::write(project.join("big.png"), vec![0u8; MAX_IMAGE as usize + 1]).unwrap();
        assert_eq!(read_image(&project, "a.png").unwrap().mime, "image/png");
        assert_eq!(read_image(&project, "b.svg").unwrap().mime, "image/svg+xml");
        let code = |rel: &str| read_image(&project, rel).err().unwrap();
        assert_eq!(code("fake.png"), "asset_unsupported");
        assert_eq!(code("big.svg"), "asset_unsupported");
        assert_eq!(code("big.png"), "too_large");
        for bad in ["../out.png", "/etc/passwd", ".git/c.png", "a/../a.png"] {
            assert_eq!(code(bad), "asset_refused", "{bad}");
        }
        #[cfg(unix)]
        assert_eq!(code("link.png"), "asset_refused");
    }
}
