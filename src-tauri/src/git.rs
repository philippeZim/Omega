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
    let mut c = Command::new("git");
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
