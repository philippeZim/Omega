//! Project-wide text search (ripgrep's `ignore` walker + `regex`), streamed to the UI.
//! A new search cancels the previous one. Respects .gitignore and skips dependency/build dirs.
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

static CURRENT: AtomicU64 = AtomicU64::new(0);

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
        hits.push(Hit { file: file.to_string(), line: n + 1, ranges, text: shown });
        if *total >= max_results {
            return (hits, true);
        }
    }
    (hits, false)
}

#[tauri::command]
pub fn search_text(app: AppHandle, id: u64, root: String, opts: SearchOptions) -> Result<u64, String> {
    // The caller picks the id so it can match events that arrive before this call returns.
    CURRENT.store(id, Ordering::SeqCst);
    if opts.query.is_empty() {
        let _ = app.emit("search-done", Done { id, files: 0, hits: 0, truncated: false, error: None });
        return Ok(id);
    }
    let re = match build_regex(&opts.query, opts.case_sensitive, opts.whole_word, opts.regex) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            let _ = app.emit("search-done", Done { id, files: 0, hits: 0, truncated: false, error: Some(e.to_string()) });
            return Ok(id);
        }
    };
    let (inc, exc) = build_mask(&opts.mask)?;

    std::thread::spawn(move || {
        let cancelled = || CURRENT.load(Ordering::SeqCst) != id;
        let Some(paths) = candidates(&root, &opts, &inc, &exc, &cancelled) else { return };

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
                let _ = app.emit("search-hits", Batch { id, hits: std::mem::take(&mut batch) });
                last_emit = std::time::Instant::now();
            }
            if truncated {
                break;
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("search-hits", Batch { id, hits: batch });
        }
        let _ = app.emit("search-done", Done { id, files: files_with_hits, hits: total, truncated, error: None });
    });
    Ok(id)
}

/// The files a search looks at: every non-ignored file under `root` (or `opts.files`), filtered by
/// the mask. `None` if the search was cancelled while walking.
fn candidates(root: &str, opts: &SearchOptions, inc: &Option<GlobSet>, exc: &Option<GlobSet>, cancelled: &dyn Fn() -> bool) -> Option<Vec<std::path::PathBuf>> {
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

/// The file's text, or `None` for unreadable, binary, huge or non-UTF-8 files (never searched).
fn read_text(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 8 * 1024 * 1024 || bytes[..bytes.len().min(8000)].contains(&0) {
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
    let paths = candidates(root, opts, &inc, &exc, &|| false).unwrap_or_default();
    Ok(paths.iter().filter(|p| read_text(p).is_some_and(|t| re.find_iter(&t).any(|m| m.end() > m.start()))).map(|p| crate::env::norm(p)).collect())
}

#[tauri::command]
pub async fn search_files(root: String, opts: SearchOptions) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || matching_files(&root, &opts)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn search_cancel() {
    CURRENT.store(0, Ordering::SeqCst);
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
pub fn guest_search_cancel(token: u64) {
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestHits {
    hits: Vec<Hit>,
    files: usize,
    total: usize,
    truncated: bool,
}

#[derive(Serialize)]
pub struct GuestFiles {
    files: Vec<String>,
    truncated: bool,
}

fn guest_regex(q: &GuestQuery) -> Result<regex::Regex, String> {
    regex_builder(&q.query, q.case_sensitive, q.whole_word, q.regex).size_limit(GUEST_REGEX_LIMIT).dfa_size_limit(GUEST_REGEX_LIMIT).build().map_err(|_| "bad_pattern".to_string())
}

fn guest_ok(root: &str, path: &Path) -> bool {
    crate::collab::collab_path_inside(root.to_string(), crate::env::norm(path))
}

/// The files of a guest's search, each with its relative path. Only what the guest may read.
fn guest_candidates(root: &str, q: &GuestQuery, run: &GuestRun) -> Result<Vec<(String, PathBuf)>, String> {
    let base = Path::new(root);
    let (inc, exc) = build_mask(&q.mask).map_err(|_| "bad_pattern".to_string())?;
    let folder = if q.folder.is_empty() { base.to_path_buf() } else { base.join(&q.folder) };
    if !guest_ok(root, &folder) {
        return Err("unavailable".into());
    }
    let files: Vec<String> = q.files.iter().map(|f| crate::env::norm(base.join(f))).collect();
    let opts = SearchOptions { query: String::new(), case_sensitive: false, whole_word: false, regex: false, mask: String::new(), files, max_results: 0 };
    let paths = candidates(&crate::env::norm(&folder), &opts, &inc, &exc, &|| run.stopped()).ok_or("cancelled")?;
    Ok(paths.into_iter().filter_map(|p| Some((crate::env::norm(p.strip_prefix(base).ok()?), p))).collect())
}

/// The text a guest's search sees: the live copy of an open file, else the disk. The check sits
/// right before the read, so a file swapped for a symlink during the walk isn't followed.
fn guest_text(root: &str, q: &GuestQuery, rel: &str, path: &Path) -> Option<String> {
    if !guest_ok(root, path) {
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
    let (mut out, mut total, mut files, mut bytes, mut truncated) = (Vec::new(), 0usize, 0usize, 0usize, false);
    for (rel, path) in guest_candidates(root, q, run)? {
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
    Ok(GuestHits { hits: out, files, total, truncated })
}

/// Every file with a match (Replace All), up to `GUEST_MAX_FILES`. Lines, like the search itself.
fn run_guest_matching(root: &str, q: &GuestQuery, run: &GuestRun) -> Result<GuestFiles, String> {
    let re = guest_regex(q)?;
    let started = std::time::Instant::now();
    let (mut files, mut truncated) = (Vec::new(), false);
    for (rel, path) in guest_candidates(root, q, run)? {
        if run.stopped() {
            return Err("cancelled".into());
        }
        if files.len() >= GUEST_MAX_FILES || started.elapsed() > GUEST_DEADLINE {
            truncated = true;
            break;
        }
        let Some(text) = guest_text(root, q, &rel, &path) else { continue };
        if text.lines().any(|l| re.find_iter(l).any(|m| m.end() > m.start())) {
            files.push(rel);
        }
    }
    Ok(GuestFiles { files, truncated })
}

/// Blocking work of a guest's call, on its own thread with its cancel flag.
async fn guest_blocking<T: Send + 'static>(token: u64, f: impl FnOnce(&GuestRun) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&GuestRun::new(token))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn guest_search_text(token: u64, root: String, query: GuestQuery) -> Result<GuestHits, String> {
    guest_blocking(token, move |run| run_guest_search(&root, &query, run)).await
}

#[tauri::command]
pub async fn guest_search_matching(token: u64, root: String, query: GuestQuery) -> Result<GuestFiles, String> {
    guest_blocking(token, move |run| run_guest_matching(&root, &query, run)).await
}

/// The project's files by the rules of the host's own list, without what a guest may not see.
fn run_guest_list(root: &str, run: &GuestRun) -> Result<GuestFiles, String> {
    let (files, truncated) = crate::fs::collect_guest_files(root, GUEST_MAX_LISTED, &|p| guest_ok(root, p), &|| run.stopped()).ok_or("cancelled")?;
    let base = Path::new(root);
    Ok(GuestFiles { files: files.into_iter().filter(|f| guest_ok(root, &base.join(f))).collect(), truncated })
}

#[tauri::command]
pub async fn guest_list_files(token: u64, root: String) -> Result<GuestFiles, String> {
    guest_blocking(token, move |run| run_guest_list(&root, run)).await
}

/// A project file's text for a guest; `None` for what search skips (binary, huge, not UTF-8) or may
/// not be read.
#[tauri::command]
pub async fn guest_read_text(root: String, rel: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&root).join(&rel);
        Ok(if guest_ok(&root, &path) { read_text(&path) } else { None })
    })
    .await
    .map_err(|e| e.to_string())?
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
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ReplacePlan {
    /// (from, to, text) in UTF-16 offsets of the whole text, in ascending order.
    edits: Vec<(usize, usize, String)>,
    count: usize,
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
    Ok(ReplacePlan { edits, count })
}

#[tauri::command]
pub async fn guest_replace_plan(text: String, replace: GuestReplace) -> Result<ReplacePlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if text.len() > GUEST_MAX_FILE {
            return Err("too_large".to_string());
        }
        let re = regex_builder(&replace.query, replace.case_sensitive, replace.whole_word, replace.regex).size_limit(GUEST_REGEX_LIMIT).dfa_size_limit(GUEST_REGEX_LIMIT).build().map_err(|_| "bad_pattern".to_string())?;
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
        GuestQuery { query: query.into(), case_sensitive: false, whole_word: false, regex: false, mask: String::new(), folder: String::new(), files: vec![], max_results: 100, overlay: HashMap::new() }
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
        guest_search_cancel(9006);
        assert_eq!(run_guest_search(&root, &guest_query("needle"), &run).err().as_deref(), Some("cancelled"));
    }

    #[test]
    fn guest_regex_is_bounded() {
        let mut q = guest_query("(a{1000}){1000}");
        q.regex = true;
        assert_eq!(guest_regex(&q).err().as_deref(), Some("bad_pattern"));
    }

    fn plan(query: &str, is_regex: bool, replacement: &str, line: Option<usize>, text: &str) -> ReplacePlan {
        let r = GuestReplace { query: query.into(), case_sensitive: true, whole_word: false, regex: is_regex, replacement: replacement.into(), line };
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
    fn replace_plan_refuses_output_that_would_not_fit_one_update() {
        let r = GuestReplace { query: "a".into(), case_sensitive: true, whole_word: false, regex: false, replacement: "x".repeat(1024 * 1024), line: None };
        let re = build_regex("a", true, false, false).unwrap();
        assert_eq!(plan_replace(&"a".repeat(9), &re, &r).err().as_deref(), Some("too_large"));
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
