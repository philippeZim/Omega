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

fn build_regex(query: &str, case_sensitive: bool, whole_word: bool, is_regex: bool) -> Result<regex::Regex, regex::Error> {
    let pattern = if is_regex { query.to_string() } else { regex::escape(query) };
    let pattern = if whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build()
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
