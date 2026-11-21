//! Project-wide text search (ripgrep's `ignore` walker + `regex`), streamed to the UI.
//! A new search cancels the previous one. Respects .gitignore and skips dependency/build dirs.
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// The running search of each window (a new one cancels only that window's previous one).
static CURRENT: std::sync::LazyLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = std::sync::LazyLock::new(Default::default);

fn current(owner: &str) -> Arc<AtomicU64> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).entry(owner.to_string()).or_default().clone()
}

/// Stops the window's search and forgets its slot.
pub fn cancel_window(owner: &str) {
    if let Some(c) = CURRENT.lock().unwrap_or_else(|e| e.into_inner()).remove(owner) {
        c.store(0, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    /// e.g. "*.py,!test*" (empty = all files)
    mask: String,
    /// Restrict to these absolute files (scope "open files"); empty = walk `root`.
    files: Vec<String>,
    max_results: usize,
}

#[derive(Serialize, Clone)]
pub struct Hit {
    file: String,
    line: usize,
    /// UTF-16 column offsets of every match on the line (start, end).
    ranges: Vec<(usize, usize)>,
    text: String,
    /// Guest searches: the version of the whole line, as `text` can be cut short.
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Serialize, Clone)]
struct Batch {
    id: u64,
    hits: Vec<Hit>,
}

#[derive(Serialize, Clone)]
struct Done {
    id: u64,
    files: usize,
    hits: usize,
    truncated: bool,
    error: Option<String>,
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", "__pycache__", ".venv", "venv", ".git", ".idea", ".gradle", ".mypy_cache", ".pytest_cache", "dist", "build"];

fn build_mask(mask: &str) -> Result<(Option<GlobSet>, Option<GlobSet>), String> {
    let (mut inc, mut exc) = (GlobSetBuilder::new(), GlobSetBuilder::new());
    let (mut has_inc, mut has_exc) = (false, false);
    for part in mask.split([',', ';']).map(str::trim).filter(|p| !p.is_empty()) {
        let (neg, pat) = part.strip_prefix('!').map(|p| (true, p)).unwrap_or((false, part));
        // Bare names match anywhere: "*.py" → "**/*.py"
        let pat = if pat.contains('/') { pat.to_string() } else { format!("**/{pat}") };
        let g = Glob::new(&pat).map_err(|e| e.to_string())?;
        if neg {
            exc.add(g);
            has_exc = true;
        } else {
            inc.add(g);
            has_inc = true;
        }
    }
    let b = |b: GlobSetBuilder, has: bool| -> Result<Option<GlobSet>, String> { if has { b.build().map(Some).map_err(|e| e.to_string()) } else { Ok(None) } };
    Ok((b(inc, has_inc)?, b(exc, has_exc)?))
}

fn utf16_col(line: &str, byte: usize) -> usize {
    line[..byte].encode_utf16().count()
}

fn regex_builder(query: &str, case_sensitive: bool, whole_word: bool, is_regex: bool) -> RegexBuilder {
    let pattern = if is_regex { query.to_string() } else { regex::escape(query) };
    let pattern = if whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    let mut b = RegexBuilder::new(&pattern);
    b.case_insensitive(!case_sensitive);
    b
}

fn build_regex(query: &str, case_sensitive: bool, whole_word: bool, is_regex: bool) -> Result<regex::Regex, regex::Error> {
    regex_builder(query, case_sensitive, whole_word, is_regex).build()
}

/// Matches every line of one file. `total` counts matches across files; returns the hits and
/// whether `max_results` was reached (stops after the line that reached it).
fn match_text(re: &regex::Regex, file: &str, text: &str, total: &mut usize, max_results: usize) -> (Vec<Hit>, bool) {
    let mut hits = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let ranges: Vec<(usize, usize)> = re.find_iter(line).filter(|m| m.end() > m.start()).map(|m| (utf16_col(line, m.start()), utf16_col(line, m.end()))).collect();
        if ranges.is_empty() {
            continue;
        }
        *total += ranges.len();
        let shown: String = line.chars().take(400).collect();
        hits.push(Hit { file: file.to_string(), line: n + 1, ranges, text: shown, version: None });
        if *total >= max_results {
            return (hits, true);
        }
    }
    (hits, false)
}

#[tauri::command]
pub fn search_text(app: AppHandle, window: tauri::WebviewWindow, id: u64, root: String, opts: SearchOptions) -> Result<u64, String> {
    let owner = window.label().to_string();
    let slot = current(&owner);
    // The caller picks the id so it can match events that arrive before this call returns.
    slot.store(id, Ordering::SeqCst);
    if opts.query.is_empty() {
        crate::windows::emit(&app, &owner, "search-done", Done { id, files: 0, hits: 0, truncated: false, error: None });
        return Ok(id);
    }
    let re = match build_regex(&opts.query, opts.case_sensitive, opts.whole_word, opts.regex) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            crate::windows::emit(&app, &owner, "search-done", Done { id, files: 0, hits: 0, truncated: false, error: Some(e.to_string()) });
            return Ok(id);
        }
    };
    let (inc, exc) = build_mask(&opts.mask)?;

    std::thread::spawn(move || {
        let cancelled = || slot.load(Ordering::SeqCst) != id;
        let Some(paths) = candidates(&root, &opts, &inc, &exc, &cancelled, None) else { return };

        let (mut total, mut files_with_hits, mut truncated) = (0usize, 0usize, false);
        let mut batch: Vec<Hit> = Vec::new();
        let mut last_emit = std::time::Instant::now();
        for path in paths {
            if cancelled() {
                return;
            }
            let Some(text) = read_text(&path) else { continue };
            let (hits, t) = match_text(&re, &crate::env::norm(&path), &text, &mut total, opts.max_results);
            if !hits.is_empty() {
                files_with_hits += 1;
            }
            batch.extend(hits);
            truncated = t;
            if batch.len() >= 200 || (last_emit.elapsed().as_millis() > 60 && !batch.is_empty()) {
                crate::windows::emit(&app, &owner, "search-hits", Batch { id, hits: std::mem::take(&mut batch) });
                last_emit = std::time::Instant::now();
            }
            if truncated {
                break;
            }
        }
        if !batch.is_empty() {
            crate::windows::emit(&app, &owner, "search-hits", Batch { id, hits: batch });
        }
        crate::windows::emit(&app, &owner, "search-done", Done { id, files: files_with_hits, hits: total, truncated, error: None });
    });
    Ok(id)
}

/// Where a guest's walk ends early. `hit` tells the guest that the result is incomplete.
struct WalkLimit {
    max: usize,
    deadline: std::time::Instant,
    hit: std::cell::Cell<bool>,
}

impl WalkLimit {
    fn reached(&self, found: usize) -> bool {
        let over = found >= self.max || std::time::Instant::now() > self.deadline;
        if over {
            self.hit.set(true);
        }
        over
    }
}

/// The files a search looks at: every non-ignored file under `root` (or `opts.files`), filtered by
/// the mask. `None` if the search was cancelled while walking.
fn candidates(root: &str, opts: &SearchOptions, inc: &Option<GlobSet>, exc: &Option<GlobSet>, cancelled: &dyn Fn() -> bool, limit: Option<&WalkLimit>) -> Option<Vec<std::path::PathBuf>> {
    let root_path = std::path::Path::new(root);
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    if opts.files.is_empty() {
        let walker = ignore::WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .parents(true)
            .require_git(false)
            .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
            .build();
        for entry in walker.flatten() {
            if cancelled() {
                return None;
            }
            if limit.is_some_and(|l| l.reached(paths.len())) {
                break;
            }
            if entry.file_type().is_some_and(|t| t.is_file()) {
                paths.push(entry.into_path());
            }
        }
    } else {
        paths = opts.files.iter().map(std::path::PathBuf::from).collect();
    }
    paths.retain(|path| {
        // Globs use "/" (also on Windows).
        let rel = crate::env::norm(path.strip_prefix(root_path).unwrap_or(path));
        inc.as_ref().is_none_or(|i| i.is_match(rel.as_str())) && !exc.as_ref().is_some_and(|x| x.is_match(rel.as_str()))
    });
    Some(paths)
}

const MAX_TEXT: u64 = 8 * 1024 * 1024;

/// Opens a regular file for reading. Anything else (FIFO, device, folder) is refused without
/// blocking on it, also if the path is swapped for one between the check and the open.
fn open_regular(path: &Path) -> Option<(std::fs::File, std::fs::Metadata)> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    meta.is_file().then_some((file, meta))
}

/// At most `MAX_TEXT` bytes of an open file; `None` if it holds more.
fn read_bounded(file: &mut std::fs::File, size: u64) -> Option<Vec<u8>> {
    if size > MAX_TEXT {
        return None;
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_TEXT + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_TEXT).then_some(bytes)
}

/// The file's text, or `None` for unreadable, binary, huge or non-UTF-8 files (never searched).
fn read_text(path: &std::path::Path) -> Option<String> {
    let (mut file, meta) = open_regular(path)?;
    let bytes = read_bounded(&mut file, meta.len())?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Every file in the search scope with at least one match, without a result cap (Replace All
/// when the hit list was truncated).
fn matching_files(root: &str, opts: &SearchOptions) -> Result<Vec<String>, String> {
    if opts.query.is_empty() {
        return Ok(Vec::new());
    }
    let re = build_regex(&opts.query, opts.case_sensitive, opts.whole_word, opts.regex).map_err(|e| e.to_string())?;
    let (inc, exc) = build_mask(&opts.mask)?;
    let paths = candidates(root, opts, &inc, &exc, &|| false, None).unwrap_or_default();
    Ok(paths.iter().filter(|p| read_text(p).is_some_and(|t| re.find_iter(&t).any(|m| m.end() > m.start()))).map(|p| crate::env::norm(p)).collect())
}

#[tauri::command]
pub async fn search_files(root: String, opts: SearchOptions) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || matching_files(&root, &opts)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn search_cancel(window: tauri::WebviewWindow) {
    current(window.label()).store(0, Ordering::SeqCst);
}

// ------------------------------------------------------------------ Code Together guests
//
// One-shot searches for a guest, run on the host. They don't touch `CURRENT`, so a guest never
// cancels the host's own search, and everything they return is relative to the project.

const GUEST_MAX_HITS: usize = 5000;
const GUEST_MAX_FILES: usize = 5000;
const GUEST_MAX_LISTED: usize = 50_000;
/// Text of all hits together, well below the RPC limit.
const GUEST_MAX_BYTES: usize = 8 * 1024 * 1024;
const GUEST_MAX_FILE: usize = 8 * 1024 * 1024;
const GUEST_MAX_RANGES: usize = 100;
const GUEST_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
/// A guest's pattern compiles into at most this much, so it can't take the host's memory.
const GUEST_REGEX_LIMIT: usize = 1024 * 1024;
const GUEST_MAX_EDITS: usize = 200_000;
/// New text per file: it travels to every guest as one update.
const GUEST_MAX_INSERT: usize = 8 * 1024 * 1024;
/// Files a guest's walk looks at.
const GUEST_MAX_CANDIDATES: usize = 200_000;

static GUEST_RUNS: std::sync::LazyLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = std::sync::LazyLock::new(Default::default);

/// The cancel flag of a guest search; it's removed when the search ends.
struct GuestRun(u64, Arc<AtomicBool>);

impl GuestRun {
    fn new(token: u64) -> Self {
        Self(token, guest_flag(token))
    }
    fn stopped(&self) -> bool {
        self.1.load(Ordering::SeqCst)
    }
}

impl Drop for GuestRun {
    fn drop(&mut self) {
        if let Ok(mut runs) = GUEST_RUNS.lock() {
            runs.remove(&self.0);
        }
    }
}

fn guest_flag(token: u64) -> Arc<AtomicBool> {
    let mut runs = GUEST_RUNS.lock().unwrap_or_else(|e| e.into_inner());
    // A cancel that arrives after its search ended leaves a flag nobody holds.
    if runs.len() > 256 {
        runs.retain(|_, f| Arc::strong_count(f) > 1);
    }
    runs.entry(token).or_default().clone()
}

#[tauri::command]
pub fn guest_search_cancel(app: AppHandle, window: tauri::WebviewWindow, token: u64) {
    if !crate::collab::can_cancel(&app, &window) {
        return;
    }
    guest_flag(token).store(true, Ordering::SeqCst);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestQuery {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    mask: String,
    /// Relative folder to search in ("" = the project).
    #[serde(default)]
    folder: String,
    /// Relative files (scope "open files"); empty = walk the folder.
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    max_results: usize,
    /// Relative path -> live text of files open in the session, which may be ahead of the disk.
    #[serde(default)]
    overlay: HashMap<String, String>,
    /// Open files whose live text didn't fit `overlay`: skipped, as the disk may be behind them.
    #[serde(default)]
    omit: HashSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestHits {
    hits: Vec<Hit>,
    files: usize,
    total: usize,
    truncated: bool,
    /// Relative path -> version of the text the hits came from.
    versions: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct GuestFiles {
    files: Vec<String>,
    truncated: bool,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    versions: HashMap<String, String>,
}

/// Identifies a text across machines (FNV-1a and length), so a Replace can tell that it still works
/// on what the guest saw. Not a defence against a crafted text: a guest with `edit` can write anyway.
fn text_version(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{:x}-{hash:016x}", text.len())
}

fn guest_regex(q: &GuestQuery) -> Result<regex::Regex, String> {
    regex_builder(&q.query, q.case_sensitive, q.whole_word, q.regex).size_limit(GUEST_REGEX_LIMIT).dfa_size_limit(GUEST_REGEX_LIMIT).build().map_err(|_| "bad_pattern".to_string())
}

fn guest_ok(root: &str, path: &Path) -> bool {
    crate::collab::guest_path_ok(Path::new(root), Path::new(&crate::env::norm(path)))
}

/// The files of a guest's search, each with its relative path. Only what the guest may read.
fn guest_candidates(root: &str, q: &GuestQuery, run: &GuestRun, started: std::time::Instant) -> Result<(Vec<(String, PathBuf)>, bool), String> {
    let base = Path::new(root);
    let (inc, exc) = build_mask(&q.mask).map_err(|_| "bad_pattern".to_string())?;
    let folder = if q.folder.is_empty() { base.to_path_buf() } else { base.join(&q.folder) };
    if !guest_ok(root, &folder) {
        return Err("unavailable".into());
    }
    let files: Vec<String> = q.files.iter().map(|f| crate::env::norm(base.join(f))).collect();
    let opts = SearchOptions { query: String::new(), case_sensitive: false, whole_word: false, regex: false, mask: String::new(), files, max_results: 0 };
    let limit = WalkLimit { max: GUEST_MAX_CANDIDATES, deadline: started + GUEST_DEADLINE, hit: Default::default() };
    let paths = candidates(&crate::env::norm(&folder), &opts, &inc, &exc, &|| run.stopped(), Some(&limit)).ok_or("cancelled")?;
    Ok((paths.into_iter().filter_map(|p| Some((crate::env::norm(p.strip_prefix(base).ok()?), p))).collect(), limit.hit.get()))
}

/// The text a guest's search sees: the live copy of an open file, else the disk. The check sits
/// right before the read, so a file swapped for a symlink during the walk isn't followed.
fn guest_text(root: &str, q: &GuestQuery, rel: &str, path: &Path) -> Option<String> {
    if q.omit.contains(rel) || !guest_ok(root, path) {
        return None;
    }
    match q.overlay.get(rel) {
        Some(live) => (live.len() <= GUEST_MAX_FILE).then(|| live.clone()),
        None => read_text(path),
    }
}

fn run_guest_search(root: &str, q: &GuestQuery, run: &GuestRun) -> Result<GuestHits, String> {
    let re = guest_regex(q)?;
    let max = q.max_results.clamp(1, GUEST_MAX_HITS);
    let started = std::time::Instant::now();
    let (mut out, mut total, mut files, mut bytes) = (Vec::new(), 0usize, 0usize, 0usize);
    let mut versions = HashMap::new();
    let (paths, mut truncated) = guest_candidates(root, q, run, started)?;
    for (rel, path) in paths {
        if run.stopped() {
            return Err("cancelled".into());
        }
        if started.elapsed() > GUEST_DEADLINE {
            truncated = true;
            break;
        }
        let Some(text) = guest_text(root, q, &rel, &path) else { continue };
        let (mut hits, capped) = match_text(&re, &rel, &text, &mut total, max);
        if !hits.is_empty() {
            files += 1;
            versions.insert(rel.clone(), text_version(&text));
            let lines: Vec<&str> = text.lines().collect();
            for hit in &mut hits {
                hit.version = lines.get(hit.line - 1).map(|l| text_version(l));
            }
        }
        for hit in &mut hits {
            hit.ranges.truncate(GUEST_MAX_RANGES);
            bytes += hit.text.len() + rel.len();
        }
        out.append(&mut hits);
        if capped || bytes > GUEST_MAX_BYTES {
            truncated = true;
            break;
        }
    }
    Ok(GuestHits { hits: out, files, total, truncated, versions })
}

/// Every file with a match (Replace All), up to `GUEST_MAX_FILES`. Lines, like the search itself.
fn run_guest_matching(root: &str, q: &GuestQuery, run: &GuestRun) -> Result<GuestFiles, String> {
    let re = guest_regex(q)?;
    let started = std::time::Instant::now();
    let mut files = Vec::new();
    let mut versions = HashMap::new();
    let (paths, mut truncated) = guest_candidates(root, q, run, started)?;
    for (rel, path) in paths {
        if run.stopped() {
            return Err("cancelled".into());
        }
        if files.len() >= GUEST_MAX_FILES || started.elapsed() > GUEST_DEADLINE {
            truncated = true;
            break;
        }
        let Some(text) = guest_text(root, q, &rel, &path) else { continue };
        if text.lines().any(|l| re.find_iter(l).any(|m| m.end() > m.start())) {
            versions.insert(rel.clone(), text_version(&text));
            files.push(rel);
        }
    }
    Ok(GuestFiles { files, truncated, versions })
}

/// Blocking work of a guest's call, on its own thread with its cancel flag.
async fn guest_blocking<T: Send + 'static>(token: u64, f: impl FnOnce(&GuestRun) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&GuestRun::new(token))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn guest_search_text(app: AppHandle, window: tauri::WebviewWindow, token: u64, root: String, query: GuestQuery) -> Result<GuestHits, String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    guest_blocking(token, move |run| run_guest_search(&root, &query, run)).await
}

#[tauri::command]
pub async fn guest_search_matching(app: AppHandle, window: tauri::WebviewWindow, token: u64, root: String, query: GuestQuery) -> Result<GuestFiles, String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    guest_blocking(token, move |run| run_guest_matching(&root, &query, run)).await
}

/// The project's files by the rules of the host's own list, without what a guest may not see.
fn run_guest_list(root: &str, run: &GuestRun) -> Result<GuestFiles, String> {
    let deadline = std::time::Instant::now() + GUEST_DEADLINE;
    let (files, truncated) = crate::fs::collect_guest_files(root, GUEST_MAX_LISTED, &|p| guest_ok(root, p), &|| run.stopped(), deadline).ok_or("cancelled")?;
    let base = Path::new(root);
    Ok(GuestFiles { files: files.into_iter().filter(|f| guest_ok(root, &base.join(f))).collect(), truncated, versions: HashMap::new() })
}

#[tauri::command]
pub async fn guest_list_files(app: AppHandle, window: tauri::WebviewWindow, token: u64, root: String) -> Result<GuestFiles, String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    guest_blocking(token, move |run| run_guest_list(&root, run)).await
}

/// A file a guest names, for preview or Replace. Like `doc.open`, naming a file may reach hidden and
/// ignored ones, which only the walk leaves out; `.git` and escapes stay refused. `None` also for what
/// search skips (binary, huge, not UTF-8).
fn read_guest_file(root: &str, rel: &str) -> Option<String> {
    let path = Path::new(root).join(rel);
    if guest_ok(root, &path) { read_text(&path) } else { None }
}

#[tauri::command]
pub async fn guest_read_text(app: AppHandle, window: tauri::WebviewWindow, root: String, rel: String) -> Result<Option<String>, String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    tauri::async_runtime::spawn_blocking(move || Ok(read_guest_file(&root, &rel))).await.map_err(|e| e.to_string())?
}

/// Whether a guest's change may reach this file. A second hard link may alias a file outside the
/// project, which no path check can see. A missing file is fine: only its open copy is left.
fn check_guest_write(root: &str, rel: &str) -> Result<(), String> {
    let path = Path::new(root).join(rel);
    if !guest_ok(root, &path) {
        return Err("unavailable".into());
    }
    match std::fs::metadata(&path) {
        Err(_) => Ok(()),
        Ok(meta) if !meta.is_file() => Err("unreadable".into()),
        Ok(meta) => check_links(&meta),
    }
}

fn check_links(_meta: &std::fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if _meta.nlink() > 1 {
            return Err("hardlinked".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn guest_write_check(app: AppHandle, window: tauri::WebviewWindow, root: String, rel: String) -> Result<(), String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    tauri::async_runtime::spawn_blocking(move || check_guest_write(&root, &rel)).await.map_err(|e| e.to_string())?
}

/// Writes a guest's Replace into a file nobody has open, if it still holds the `expected` version.
/// In place through one handle: the inode keeps its mode, owner and links, a symlink keeps pointing
/// at it, and the check and the write are about the same file. A writer outside Omega can still
/// slip in between them; only it could prevent that.
fn write_guest_file(root: &str, rel: &str, expected: &str, content: &str) -> Result<(), String> {
    let path = Path::new(root).join(rel);
    if !guest_ok(root, &path) {
        return Err("unavailable".into());
    }
    let real = path.canonicalize().map_err(|_| "unavailable")?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let mut file = options.open(&real).map_err(|_| "unavailable")?;
    let meta = file.metadata().map_err(|_| "unavailable")?;
    if !meta.is_file() {
        return Err("unreadable".into());
    }
    check_links(&meta)?;
    // A folder on the way may have been swapped while this was opened.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let now = std::fs::metadata(&path).map_err(|_| "unavailable")?;
        if (now.dev(), now.ino()) != (meta.dev(), meta.ino()) || !guest_ok(root, &path) {
            return Err("unavailable".into());
        }
    }
    let bytes = read_bounded(&mut file, meta.len()).ok_or("too_large")?;
    if std::str::from_utf8(&bytes).map(text_version).ok().as_deref() != Some(expected) {
        return Err("changed".into());
    }
    file.seek(std::io::SeekFrom::Start(0)).map_err(|_| "write_failed")?;
    file.write_all(content.as_bytes()).map_err(|_| "write_failed")?;
    file.set_len(content.len() as u64).map_err(|_| "write_failed")?;
    Ok(())
}

#[tauri::command]
pub async fn guest_write_text(app: AppHandle, window: tauri::WebviewWindow, root: String, rel: String, expected: String, content: String) -> Result<(), String> {
    crate::collab::guard(&app, &window, Some(&root))?;
    tauri::async_runtime::spawn_blocking(move || write_guest_file(&root, &rel, &expected, &content)).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestReplace {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    replacement: String,
    /// Only this line (1-based), for "Replace" on one hit.
    line: Option<usize>,
    /// The text version the guest saw (Replace All).
    #[serde(default)]
    expect_version: Option<String>,
    /// The version of `line` the guest saw (Replace on one hit).
    #[serde(default)]
    expect_line: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ReplacePlan {
    /// (from, to, text) in UTF-16 offsets of the whole text, in ascending order.
    edits: Vec<(usize, usize, String)>,
    count: usize,
    /// Version of the text this plan is for.
    version: String,
}

/// Whether the text is still what the guest saw. Without an expectation nothing is replaced.
fn check_expected(text: &str, r: &GuestReplace) -> Result<(), String> {
    let same = match (&r.expect_version, r.line, &r.expect_line) {
        (Some(version), _, _) => *version == text_version(text),
        (None, Some(line), Some(expected)) => line >= 1 && text.lines().nth(line - 1).is_some_and(|l| text_version(l) == *expected),
        _ => false,
    };
    if same { Ok(()) } else { Err("changed".into()) }
}

/// Expands a replacement like JS `String.replace` does, the syntax the host's Replace uses:
/// `$$`, `$&`, `` $` ``, `$'`, `$1`..`$99`, `$<name>`. Anything else stays as written.
fn expand_replacement(rep: &str, caps: &regex::Captures, line: &str, has_names: bool, out: &mut String) {
    let whole = caps.get(0).expect("group 0 always exists");
    let b = rep.as_bytes();
    let mut i = 0;
    while let Some(off) = rep[i..].find('$') {
        out.push_str(&rep[i..i + off]);
        i += off;
        let (next, after) = (b.get(i + 1).copied(), b.get(i + 2).copied());
        match next {
            Some(b'$') => (out.push('$'), i += 2).1,
            Some(b'&') => (out.push_str(whole.as_str()), i += 2).1,
            Some(b'`') => (out.push_str(&line[..whole.start()]), i += 2).1,
            Some(b'\'') => (out.push_str(&line[whole.end()..]), i += 2).1,
            Some(b'<') if has_names => match rep[i + 2..].find('>') {
                Some(end) => {
                    if let Some(m) = caps.name(&rep[i + 2..i + 2 + end]) {
                        out.push_str(m.as_str());
                    }
                    i += end + 3;
                }
                None => (out.push('$'), i += 1).1,
            },
            Some(d) if d.is_ascii_digit() => {
                let one = (d - b'0') as usize;
                let two = after.filter(u8::is_ascii_digit).map(|e| one * 10 + (e - b'0') as usize);
                let (group, len) = match two {
                    Some(n) if n >= 1 && n < caps.len() => (n, 3),
                    _ if one >= 1 && one < caps.len() => (one, 2),
                    _ => (0, 0),
                };
                if len == 0 {
                    out.push('$');
                    i += 1;
                } else {
                    out.push_str(caps.get(group).map_or("", |m| m.as_str()));
                    i += len;
                }
            }
            _ => (out.push('$'), i += 1).1,
        }
    }
    out.push_str(&rep[i..]);
}

/// The edits that replace every match, line by line like the search, so Replace changes exactly
/// what the guest saw. A plan of edits (not new text) keeps other people's cursors in place.
fn plan_replace(text: &str, re: &regex::Regex, r: &GuestReplace) -> Result<ReplacePlan, String> {
    let has_names = re.capture_names().flatten().next().is_some();
    let (mut edits, mut inserted, mut offset) = (Vec::new(), 0usize, 0usize);
    for (n, raw) in text.split_inclusive('\n').enumerate() {
        let line = match raw.strip_suffix('\n') {
            Some(l) => l.strip_suffix('\r').unwrap_or(l),
            None => raw,
        };
        if r.line.is_none_or(|only| only == n + 1) {
            for caps in re.captures_iter(line) {
                let m = caps.get(0).expect("group 0 always exists");
                if m.end() == m.start() {
                    continue;
                }
                let mut new = String::new();
                if r.regex {
                    expand_replacement(&r.replacement, &caps, line, has_names, &mut new);
                } else {
                    new.push_str(&r.replacement);
                }
                inserted += new.len();
                if edits.len() >= GUEST_MAX_EDITS || inserted > GUEST_MAX_INSERT {
                    return Err("too_large".into());
                }
                edits.push((offset + utf16_col(line, m.start()), offset + utf16_col(line, m.end()), new));
            }
        }
        offset += raw.encode_utf16().count();
    }
    let count = edits.len();
    Ok(ReplacePlan { edits, count, version: text_version(text) })
}

#[tauri::command]
pub async fn guest_replace_plan(text: String, replace: GuestReplace) -> Result<ReplacePlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if text.len() > GUEST_MAX_FILE {
            return Err("too_large".to_string());
        }
        let re = regex_builder(&replace.query, replace.case_sensitive, replace.whole_word, replace.regex).size_limit(GUEST_REGEX_LIMIT).dfa_size_limit(GUEST_REGEX_LIMIT).build().map_err(|_| "bad_pattern".to_string())?;
        check_expected(&text, &replace)?;
        plan_replace(&text, &re, &replace)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(query: &str, case_sensitive: bool, whole_word: bool, is_regex: bool, text: &str) -> Vec<Hit> {
        let re = build_regex(query, case_sensitive, whole_word, is_regex).unwrap();
        let mut total = 0;
        match_text(&re, "f", text, &mut total, usize::MAX).0
    }

    fn ranges(hits: &[Hit]) -> Vec<(usize, Vec<(usize, usize)>)> {
        hits.iter().map(|h| (h.line, h.ranges.clone())).collect()
    }

    #[test]
    fn matching_files_has_no_cap_and_respects_the_mask() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("big.log"), "line 1\n".repeat(10_000)).unwrap();
        std::fs::write(dir.path().join("late.txt"), "a line\n").unwrap();
        std::fs::write(dir.path().join("skip.md"), "line\n").unwrap();
        std::fs::write(dir.path().join("none.txt"), "nothing\n").unwrap();
        let opts = SearchOptions { query: "line".into(), case_sensitive: false, whole_word: false, regex: false, mask: "!*.md".into(), files: vec![], max_results: 5 };
        let mut files = matching_files(&crate::env::norm(dir.path()), &opts).unwrap();
        files.sort();
        let names: Vec<&str> = files.iter().map(|f| f.rsplit('/').next().unwrap()).collect();
        assert_eq!(names, ["big.log", "late.txt"]);
    }

    fn guest_query(query: &str) -> GuestQuery {
        GuestQuery { query: query.into(), case_sensitive: false, whole_word: false, regex: false, mask: String::new(), folder: String::new(), files: vec![], max_results: 100, overlay: HashMap::new(), omit: HashSet::new() }
    }

    fn guest_project() -> (tempfile::TempDir, tempfile::TempDir, String) {
        let (dir, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let p = dir.path();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::create_dir_all(p.join("sub/.git")).unwrap();
        std::fs::write(p.join("src/a.txt"), "needle here\n").unwrap();
        std::fs::write(p.join(".git/config"), "needle in git\n").unwrap();
        std::fs::write(p.join("sub/.git/config"), "needle in nested git\n").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "needle outside\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), p.join("ext")).unwrap();
            std::os::unix::fs::symlink(outside.path().join("secret.txt"), p.join("leak.txt")).unwrap();
            std::os::unix::fs::symlink(p.join(".git/config"), p.join("cfg")).unwrap();
            std::os::unix::fs::symlink(p.join("src/a.txt"), p.join("inner.txt")).unwrap();
        }
        let root = crate::env::norm(p.canonicalize().unwrap());
        (dir, outside, root)
    }

    #[test]
    fn guest_search_stays_in_the_project_and_out_of_git() {
        let (_d, _o, root) = guest_project();
        let run = GuestRun::new(9001);
        let r = run_guest_search(&root, &guest_query("needle"), &run).unwrap();
        let files: Vec<&str> = r.hits.iter().map(|h| h.file.as_str()).collect();
        assert_eq!(files, ["src/a.txt"]);
        assert!(!r.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn guest_open_files_scope_refuses_escapes() {
        let (_d, _o, root) = guest_project();
        let run = GuestRun::new(9002);
        let mut q = guest_query("needle");
        q.files = vec!["leak.txt".into(), "cfg".into(), ".git/config".into(), "ext/secret.txt".into(), "src/a.txt".into()];
        let r = run_guest_search(&root, &q, &run).unwrap();
        assert_eq!(r.hits.iter().map(|h| h.file.as_str()).collect::<Vec<_>>(), ["src/a.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn guest_list_has_no_git_and_no_escaping_links() {
        let (_d, _o, root) = guest_project();
        let run = GuestRun::new(9003);
        let l = run_guest_list(&root, &run).unwrap();
        assert_eq!(l.files, ["inner.txt", "src/a.txt"]);
        assert!(!l.truncated);
    }

    #[test]
    fn guest_search_reports_truncation_at_the_cap() {
        let (d, _o, root) = guest_project();
        std::fs::write(d.path().join("many.txt"), "needle\n".repeat(50)).unwrap();
        let run = GuestRun::new(9004);
        let mut q = guest_query("needle");
        q.max_results = 10;
        let r = run_guest_search(&root, &q, &run).unwrap();
        assert!(r.truncated);
        assert!(r.hits.len() <= 10);
    }

    #[test]
    fn guest_search_sees_live_text_of_open_files() {
        let (_d, _o, root) = guest_project();
        let run = GuestRun::new(9005);
        let mut q = guest_query("unsaved");
        q.overlay.insert("src/a.txt".into(), "first\nunsaved text\n".into());
        let r = run_guest_search(&root, &q, &run).unwrap();
        assert_eq!((r.hits[0].file.as_str(), r.hits[0].line), ("src/a.txt", 2));
    }

    #[test]
    fn guest_search_stops_when_cancelled() {
        let (_d, _o, root) = guest_project();
        let run = GuestRun::new(9006);
        guest_flag(9006).store(true, Ordering::SeqCst);
        assert_eq!(run_guest_search(&root, &guest_query("needle"), &run).err().as_deref(), Some("cancelled"));
    }

    #[test]
    fn guest_regex_is_bounded() {
        let mut q = guest_query("(a{1000}){1000}");
        q.regex = true;
        assert_eq!(guest_regex(&q).err().as_deref(), Some("bad_pattern"));
    }

    fn plan(query: &str, is_regex: bool, replacement: &str, line: Option<usize>, text: &str) -> ReplacePlan {
        let r = GuestReplace { query: query.into(), case_sensitive: true, whole_word: false, regex: is_regex, replacement: replacement.into(), line, expect_version: None, expect_line: None };
        let re = build_regex(query, true, false, is_regex).unwrap();
        plan_replace(text, &re, &r).unwrap()
    }

    #[test]
    fn replace_plan_uses_utf16_offsets_across_crlf_lines() {
        let p = plan("x", false, "$1", None, "😀x\r\nax\n");
        assert_eq!(p.edits, vec![(2, 3, "$1".to_string()), (6, 7, "$1".to_string())]);
        assert_eq!(p.count, 2);
    }

    #[test]
    fn replace_plan_expands_like_js() {
        let e = |q: &str, rep: &str, t: &str| plan(q, true, rep, None, t).edits[0].2.clone();
        assert_eq!(e(r"(a)(b)", "$2$1", "ab"), "ba");
        assert_eq!(e(r"(a)", "$$ $& $9 $x", "a"), "$ a $9 $x");
        assert_eq!(e(r"(?P<n>a)", "[$<n>]", "a"), "[a]");
        assert_eq!(e(r"b", "$`|$'", "abc"), "a|c");
    }

    #[test]
    fn replace_plan_matches_per_line_and_can_take_one_line() {
        assert_eq!(plan("^a", true, "b", None, "a\na\n").count, 2);
        let p = plan("a", false, "b", Some(2), "a\na\n");
        assert_eq!(p.edits, vec![(2, 3, "b".to_string())]);
    }

    #[test]
    fn replace_plan_counts_what_the_search_shows_on_crlf_lines() {
        let text = "foo\r\nfoo\nfoo";
        let shown: usize = run("foo$", true, false, true, text).iter().map(|h| h.ranges.len()).sum();
        let p = plan("foo$", true, "X", None, text);
        assert_eq!((shown, p.count), (3, 3));
        assert_eq!(p.edits.iter().map(|e| (e.0, e.1)).collect::<Vec<_>>(), [(0, 3), (5, 8), (9, 12)]);
    }

    #[test]
    fn replace_plan_refuses_output_that_would_not_fit_one_update() {
        let r = GuestReplace { query: "a".into(), case_sensitive: true, whole_word: false, regex: false, replacement: "x".repeat(1024 * 1024), line: None, expect_version: None, expect_line: None };
        let re = build_regex("a", true, false, false).unwrap();
        assert_eq!(plan_replace(&"a".repeat(9), &re, &r).err().as_deref(), Some("too_large"));
    }

    #[cfg(unix)]
    #[test]
    fn read_text_refuses_fifos_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || tx.send(read_text(&fifo)).unwrap());
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap(), None);
    }

    #[test]
    fn read_text_skips_a_file_over_the_limit_and_reads_one_at_it() {
        let dir = tempfile::tempdir().unwrap();
        let (big, fits) = (dir.path().join("big"), dir.path().join("fits"));
        std::fs::File::create(&big).unwrap().set_len(MAX_TEXT + 1).unwrap();
        std::fs::write(&fits, "a".repeat(MAX_TEXT as usize)).unwrap();
        assert_eq!(read_text(&big), None);
        assert_eq!(read_text(&fits).map(|t| t.len()), Some(MAX_TEXT as usize));
    }

    #[test]
    fn a_named_hidden_or_ignored_file_can_be_read_but_the_walk_leaves_it_out() {
        let (d, _o, root) = guest_project();
        std::fs::write(d.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(d.path().join("ignored.txt"), "needle ignored\n").unwrap();
        std::fs::write(d.path().join(".env"), "needle=hidden\n").unwrap();
        let run = GuestRun::new(9007);
        let found = run_guest_search(&root, &guest_query("needle"), &run).unwrap();
        assert_eq!(found.hits.iter().map(|h| h.file.as_str()).collect::<Vec<_>>(), ["src/a.txt"]);
        assert!(read_guest_file(&root, ".env").is_some());
        assert!(read_guest_file(&root, "ignored.txt").is_some());
        assert_eq!(read_guest_file(&root, ".git/config"), None);
        assert_eq!(read_guest_file(&root, "../secret.txt"), None);
        #[cfg(unix)]
        assert_eq!(read_guest_file(&root, "leak.txt"), None);
    }

    #[test]
    fn a_walk_over_its_limit_reports_truncation() {
        let (_d, _o, root) = guest_project();
        let (inc, exc) = build_mask("").unwrap();
        let opts = SearchOptions { query: String::new(), case_sensitive: false, whole_word: false, regex: false, mask: String::new(), files: vec![], max_results: 0 };
        let limit = WalkLimit { max: 0, deadline: std::time::Instant::now() + GUEST_DEADLINE, hit: Default::default() };
        assert!(candidates(&root, &opts, &inc, &exc, &|| false, Some(&limit)).unwrap().is_empty());
        assert!(limit.hit.get());
    }

    #[test]
    fn replace_refuses_text_the_guest_did_not_see() {
        let replace = |version: Option<String>, line: Option<usize>, expect_line: Option<String>| GuestReplace { query: "a".into(), case_sensitive: true, whole_word: false, regex: false, replacement: "b".into(), line, expect_version: version, expect_line };
        let text = "a one\na two\n";
        assert!(check_expected(text, &replace(Some(text_version(text)), None, None)).is_ok());
        assert_eq!(check_expected("a one\nchanged a\n", &replace(Some(text_version(text)), None, None)).err().as_deref(), Some("changed"));
        assert!(check_expected(text, &replace(None, Some(2), Some(text_version("a two")))).is_ok());
        assert_eq!(check_expected(text, &replace(None, Some(2), Some(text_version("a one")))).err().as_deref(), Some("changed"));
        assert_eq!(check_expected(text, &replace(None, Some(9), Some(text_version("a two")))).err().as_deref(), Some("changed"));
        assert_eq!(check_expected(text, &replace(None, None, None)).err().as_deref(), Some("changed"));
    }

    #[test]
    fn guest_hits_carry_versions_of_their_file_and_full_line() {
        let (d, _o, root) = guest_project();
        let long = format!("needle{}", "x".repeat(500));
        std::fs::write(d.path().join("src/a.txt"), format!("{long}\n")).unwrap();
        let run = GuestRun::new(9008);
        let r = run_guest_search(&root, &guest_query("needle"), &run).unwrap();
        assert_eq!(r.hits[0].version.as_deref(), Some(text_version(&long).as_str()));
        assert_eq!(r.versions["src/a.txt"], text_version(&format!("{long}\n")));
    }

    #[test]
    fn guest_write_needs_the_version_it_was_planned_for() {
        let (d, _o, root) = guest_project();
        let file = d.path().join("src/a.txt");
        assert_eq!(write_guest_file(&root, "src/a.txt", &text_version("other"), "new").err().as_deref(), Some("changed"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "needle here\n");
        write_guest_file(&root, "src/a.txt", &text_version("needle here\n"), "n\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "n\n");
    }

    #[cfg(unix)]
    #[test]
    fn guest_write_keeps_mode_and_symlink_and_refuses_hard_links_and_escapes() {
        use std::os::unix::fs::PermissionsExt;
        let (d, o, root) = guest_project();
        let file = d.path().join("src/a.txt");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
        write_guest_file(&root, "inner.txt", &text_version("needle here\n"), "via link\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "via link\n");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o750);
        assert!(std::fs::symlink_metadata(d.path().join("inner.txt")).unwrap().file_type().is_symlink());

        let secret = o.path().join("secret.txt");
        std::fs::hard_link(&secret, d.path().join("alias.txt")).unwrap();
        assert_eq!(check_guest_write(&root, "alias.txt").err().as_deref(), Some("hardlinked"));
        assert_eq!(write_guest_file(&root, "alias.txt", &text_version("needle outside\n"), "x").err().as_deref(), Some("hardlinked"));
        assert_eq!(write_guest_file(&root, "leak.txt", &text_version("needle outside\n"), "x").err().as_deref(), Some("unavailable"));
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "needle outside\n");
    }

    #[test]
    fn mask_include_exclude() {
        let (inc, exc) = build_mask("*.rs, !target/**; src/*.ts").unwrap();
        let (inc, exc) = (inc.unwrap(), exc.unwrap());
        assert!(inc.is_match("main.rs"));
        assert!(inc.is_match("a/b/lib.rs"));
        assert!(inc.is_match("src/x.ts"));
        assert!(!inc.is_match("lib/x.ts"));
        assert!(!inc.is_match("a.py"));
        assert!(exc.is_match("target/debug/x.rs"));
        assert!(!exc.is_match("src/target.rs"));
    }

    #[test]
    fn mask_bare_matches_anywhere() {
        let (inc, exc) = build_mask("*.py").unwrap();
        let inc = inc.unwrap();
        assert!(exc.is_none());
        assert!(inc.is_match("a/b/c.py"));
        assert!(inc.is_match("c.py"));
        assert!(!inc.is_match("c.pyc"));
    }

    #[test]
    fn mask_empty_and_invalid() {
        let (inc, exc) = build_mask("").unwrap();
        assert!(inc.is_none() && exc.is_none());
        let (inc, exc) = build_mask(" , ;").unwrap();
        assert!(inc.is_none() && exc.is_none());
        assert!(build_mask("[").is_err());
    }

    #[test]
    fn utf16_columns() {
        let s = "äö😀x";
        let b = s.find('x').unwrap();
        assert_eq!(b, 8);
        assert_eq!(utf16_col(s, b), 4);
        assert_eq!(utf16_col(s, 0), 0);
    }

    #[test]
    fn literal_is_escaped() {
        let h = run("a.b(", true, false, false, "axb(\na.b(c\n");
        assert_eq!(ranges(&h), vec![(2, vec![(0, 4)])]);
        assert_eq!(h[0].text, "a.b(c");
        assert_eq!(h[0].file, "f");
    }

    #[test]
    fn regex_mode() {
        let h = run(r"b\d+", true, false, true, "b1 b22 bx");
        assert_eq!(ranges(&h), vec![(1, vec![(0, 2), (3, 6)])]);
        assert!(build_regex("(", true, false, true).is_err());
    }

    #[test]
    fn whole_word() {
        let h = run("foo", true, true, false, "foobar\nfoo bar\nx.foo()");
        assert_eq!(ranges(&h), vec![(2, vec![(0, 3)]), (3, vec![(2, 5)])]);
    }

    #[test]
    fn whole_word_unicode() {
        let h = run("Größe", true, true, false, "Größenordnung\ndie Größe ist");
        assert_eq!(ranges(&h), vec![(2, vec![(4, 9)])]);
        // A prefix must not match inside an umlaut word.
        assert!(run("Gr", true, true, false, "Größe").is_empty());
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(ranges(&run("hello", false, false, false, "HeLLo hello")), vec![(1, vec![(0, 5), (6, 11)])]);
        assert!(run("hello", true, false, false, "HeLLo").is_empty());
        assert_eq!(ranges(&run("größe", false, false, false, "GRÖßE")).len(), 1);
    }

    #[test]
    fn empty_matches_ignored() {
        let h = run("a*", true, false, true, "bab\nxyz\naa");
        assert_eq!(ranges(&h), vec![(1, vec![(1, 2)]), (3, vec![(0, 2)])]);
    }

    #[test]
    fn max_results_truncates() {
        let re = build_regex("x", true, false, false).unwrap();
        let mut total = 0;
        let (h, t) = match_text(&re, "f", "x\nxxx\nx\n", &mut total, 2);
        assert!(t);
        assert_eq!(h.len(), 2);
        assert_eq!(total, 4);
        // Total carries over from previous files.
        let mut total = 5;
        let (h, t) = match_text(&re, "f", "x\n", &mut total, 6);
        assert!(t);
        assert_eq!(h.len(), 1);
        let mut total = 0;
        let (h, t) = match_text(&re, "f", "x\nx\n", &mut total, 10);
        assert!(!t);
        assert_eq!((h.len(), total), (2, 2));
    }

    #[test]
    fn long_line_capped_at_400_chars() {
        let line = format!("{}needle", "ä".repeat(500));
        let h = run("needle", true, false, false, &line);
        assert_eq!(h[0].text.chars().count(), 400);
        // Ranges still refer to the full line.
        assert_eq!(h[0].ranges, vec![(500, 506)]);
    }
}
