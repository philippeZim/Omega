//! Thin git wrapper: runs the git CLI (uses the user's own config, SSH keys and credential helper).
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitOut {
    code: i32,
    stdout: String,
    stderr: String,
}

fn git_cmd(root: &str) -> Command {
    let mut c = crate::env::which("git").map(crate::env::command).unwrap_or_else(|| crate::env::command("git"));
    c.current_dir(root)
        // Never block on an interactive prompt (no TTY here): fail with a readable message instead.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("LANG", "C");
    c
}

/// Runs `git <args>` in `root`.
#[tauri::command]
pub async fn git(root: String, args: Vec<String>) -> Result<GitOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = git_cmd(&root).args(&args).output().map_err(|e| format!("git: {e}"))?;
        Ok(GitOut {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into(),
            stderr: String::from_utf8_lossy(&out.stderr).into(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Change {
    path: String,
    /// Porcelain XY codes (index, worktree)
    x: String,
    y: String,
    orig: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    repo: bool,
    top: String,
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<Change>,
}

/// Repository status (branch, ahead/behind, changed files). `repo: false` outside a repository.
#[tauri::command]
pub async fn git_status(root: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let top = git_cmd(&root).args(["rev-parse", "--show-toplevel"]).output().map_err(|e| e.to_string())?;
        if !top.status.success() {
            return Ok(Status { repo: false, top: String::new(), branch: String::new(), upstream: None, ahead: 0, behind: 0, changes: vec![] });
        }
        let top = String::from_utf8_lossy(&top.stdout).trim().to_string();
        let out = git_cmd(&top).args(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let mut parts = text.split('\0').filter(|s| !s.is_empty());
        let (mut branch, mut upstream, mut ahead, mut behind) = (String::new(), None, 0, 0);
        let mut changes = Vec::new();
        while let Some(p) = parts.next() {
            if let Some(h) = p.strip_prefix("## ") {
                // "main...origin/main [ahead 1, behind 2]" or "No commits yet on main"
                let h = h.trim_start_matches("No commits yet on ").to_string();
                let (head, rest) = h.split_once(" [").map(|(a, b)| (a.to_string(), b.trim_end_matches(']').to_string())).unwrap_or((h.clone(), String::new()));
                if let Some((b, u)) = head.split_once("...") {
                    branch = b.into();
                    upstream = Some(u.into());
                } else {
                    branch = head;
                }
                for piece in rest.split(", ") {
                    if let Some(n) = piece.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = piece.strip_prefix("behind ") { behind = n.parse().unwrap_or(0); }
                }
                continue;
            }
            if p.len() < 4 {
                continue;
            }
            let (x, y, path) = (p[0..1].to_string(), p[1..2].to_string(), p[3..].to_string());
            let orig = if x == "R" || x == "C" { parts.next().map(|s| s.to_string()) } else { None };
            changes.push(Change { path, x, y, orig });
        }
        Ok(Status { repo: true, top, branch, upstream, ahead, behind, changes })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// File content at HEAD (None if the file is new / not in HEAD).
#[tauri::command]
pub async fn git_head_file(root: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let top = git_cmd(&root).args(["rev-parse", "--show-toplevel"]).output().map_err(|e| e.to_string())?;
        if !top.status.success() {
            return Ok(None);
        }
        let top = String::from_utf8_lossy(&top.stdout).trim().to_string();
        let rel = std::path::Path::new(&path).strip_prefix(&top).map(|p| p.to_string_lossy().to_string()).unwrap_or(path);
        let out = git_cmd(&top).args(["show", &format!("HEAD:{rel}")]).output().map_err(|e| e.to_string())?;
        Ok(out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct BlameCommit {
    hash: String,
    author: String,
    mail: String,
    /// Unix seconds (author time).
    time: i64,
    summary: String,
}

#[derive(Serialize)]
pub struct Blame {
    commits: Vec<BlameCommit>,
    /// One entry per line: index into `commits`, or -1 for not yet committed lines.
    lines: Vec<i32>,
}

/// `git blame` of a file. With `contents` the (unsaved) editor buffer is blamed instead of the
/// file on disk, so line numbers always match the editor. None outside a repository / untracked.
#[tauri::command]
pub async fn git_blame(root: String, path: String, contents: Option<String>) -> Result<Option<Blame>, String> {
    use std::io::Write;
    use std::process::Stdio;
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve the repository from the file's own folder (it may live outside the project).
        let dir = std::path::Path::new(&path).parent().filter(|d| d.is_dir()).map(|d| d.to_string_lossy().to_string()).unwrap_or(root);
        let top = git_cmd(&dir).args(["rev-parse", "--show-toplevel"]).output().map_err(|e| e.to_string())?;
        if !top.status.success() {
            return Ok(None);
        }
        let top = String::from_utf8_lossy(&top.stdout).trim().to_string();
        let rel = std::path::Path::new(&path).strip_prefix(&top).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(path);
        let mut cmd = git_cmd(&top);
        cmd.args(["blame", "--porcelain"]);
        if contents.is_some() {
            cmd.args(["--contents", "-"]);
        }
        cmd.args(["--", &rel]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("git: {e}"))?;
        if let (Some(text), Some(mut stdin)) = (contents, child.stdin.take()) {
            // Write from a thread: a large file could otherwise deadlock against a full stdout pipe.
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        } else {
            drop(child.stdin.take());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Ok(None);
        }
        Ok(Some(parse_blame(&String::from_utf8_lossy(&out.stdout))))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_blame(s: &str) -> Blame {
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index = std::collections::HashMap::<String, usize>::new();
    let mut lines: Vec<(usize, i32)> = Vec::new();
    let mut cur: Option<usize> = None;
    let mut final_line = 0usize;
    for l in s.lines() {
        if l.starts_with('\t') {
            if let Some(c) = cur {
                let i = if commits[c].hash.bytes().all(|b| b == b'0') { -1 } else { c as i32 };
                lines.push((final_line, i));
            }
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            final_line = parts.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            let c = *index.entry(first.to_string()).or_insert_with(|| {
                commits.push(BlameCommit { hash: first.to_string(), author: String::new(), mail: String::new(), time: 0, summary: String::new() });
                commits.len() - 1
            });
            cur = Some(c);
            continue;
        }
        let Some(c) = cur else { continue };
        let rest = l.get(first.len() + 1..).unwrap_or("").to_string();
        match first {
            "author" => commits[c].author = rest,
            "author-mail" => commits[c].mail = rest.trim_matches(|ch| ch == '<' || ch == '>').to_string(),
            "author-time" => commits[c].time = rest.parse().unwrap_or(0),
            "summary" => commits[c].summary = rest,
            _ => {}
        }
    }
    let n = lines.iter().map(|(l, _)| *l).max().unwrap_or(0);
    let mut out = vec![-1; n];
    for (l, i) in lines {
        if l >= 1 {
            out[l - 1] = i;
        }
    }
    Blame { commits, lines: out }
}
