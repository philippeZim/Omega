//! Project-wide text search (ripgrep's `ignore` walker + `regex`), streamed to the UI.
//! A new search cancels the previous one. Respects .gitignore and skips dependency/build dirs.
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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

#[tauri::command]
pub fn search_text(app: AppHandle, id: u64, root: String, opts: SearchOptions) -> Result<u64, String> {
    // The caller picks the id so it can match events that arrive before this call returns.
    CURRENT.store(id, Ordering::SeqCst);
    if opts.query.is_empty() {
        let _ = app.emit("search-done", Done { id, files: 0, hits: 0, truncated: false, error: None });
        return Ok(id);
    }
    let pattern = if opts.regex { opts.query.clone() } else { regex::escape(&opts.query) };
    let pattern = if opts.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    let re = match RegexBuilder::new(&pattern).case_insensitive(!opts.case_sensitive).build() {
        Ok(r) => Arc::new(r),
        Err(e) => {
            let _ = app.emit("search-done", Done { id, files: 0, hits: 0, truncated: false, error: Some(e.to_string()) });
            return Ok(id);
        }
    };
    let (inc, exc) = build_mask(&opts.mask)?;

    std::thread::spawn(move || {
        let cancelled = || CURRENT.load(Ordering::SeqCst) != id;
        let root_path = std::path::PathBuf::from(&root);
        let mut paths: Vec<std::path::PathBuf> = Vec::new();
        if opts.files.is_empty() {
            let walker = ignore::WalkBuilder::new(&root)
                .hidden(true)
                .git_ignore(true)
                .git_global(true)
                .parents(true)
                .require_git(false)
                .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
                .build();
            for entry in walker.flatten() {
                if cancelled() {
                    return;
                }
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    paths.push(entry.into_path());
                }
            }
        } else {
            paths = opts.files.iter().map(std::path::PathBuf::from).collect();
        }

        let (mut total, mut files_with_hits, mut truncated) = (0usize, 0usize, false);
        let mut batch: Vec<Hit> = Vec::new();
        let mut last_emit = std::time::Instant::now();
        for path in paths {
            if cancelled() {
                return;
            }
            let rel = path.strip_prefix(&root_path).unwrap_or(&path);
            if let Some(i) = &inc {
                if !i.is_match(rel) {
                    continue;
                }
            }
            if let Some(x) = &exc {
                if x.is_match(rel) {
                    continue;
                }
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if bytes.len() > 8 * 1024 * 1024 || bytes[..bytes.len().min(8000)].contains(&0) {
                continue; // binary or huge
            }
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let mut in_file = false;
            for (n, line) in text.lines().enumerate() {
                let ranges: Vec<(usize, usize)> = re.find_iter(line).filter(|m| m.end() > m.start()).map(|m| (utf16_col(line, m.start()), utf16_col(line, m.end()))).collect();
                if ranges.is_empty() {
                    continue;
                }
                if !in_file {
                    in_file = true;
                    files_with_hits += 1;
                }
                total += ranges.len();
                let shown: String = line.chars().take(400).collect();
                batch.push(Hit { file: crate::env::norm(&path), line: n + 1, ranges, text: shown });
                if total >= opts.max_results {
                    truncated = true;
                    break;
                }
            }
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

#[tauri::command]
pub fn search_cancel() {
    CURRENT.store(0, Ordering::SeqCst);
}
