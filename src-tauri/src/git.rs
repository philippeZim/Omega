//! Thin git wrapper: runs the git CLI (uses the user's own config, SSH keys and credential helper).
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
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
        // Untranslated messages: the toasts look for "fatal:"/"error:" (LC_ALL beats LANG/LC_MESSAGES).
        .env("LANG", "C")
        .env("LC_ALL", "C");
    c
}

/// `stderr` of a refused `git init`; the frontend shows its own translated text for it.
const INIT_IN_BARE: &str = "omega:init_in_bare_repository";

/// Whether `path` holds a valid HEAD as git understands it. Only reads the file, and only if it is
/// a regular one (a FIFO would block).
fn valid_head(path: &Path) -> bool {
    let Ok(meta) = path.symlink_metadata() else { return false };
    if meta.file_type().is_symlink() {
        return std::fs::read_link(path).is_ok_and(|target| target.starts_with("refs/"));
    }
    if !meta.is_file() {
        return false;
    }
    let mut bytes = Vec::new();
    let Ok(file) = std::fs::File::open(path) else { return false };
    if file.take(128).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_end();
    text.strip_prefix("ref:").is_some_and(|r| r.trim_start().starts_with("refs/")) || (matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether a folder has the layout of a bare repository. Purely structural: its `config` is never
/// read and git isn't asked, because a planted config can run commands.
fn looks_bare(dir: &Path) -> bool {
    valid_head(&dir.join("HEAD")) && dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

/// Whether `path` (which may not exist yet) is a bare repository or inside one. A `.git` on the way
/// up means a normal repository owns that folder.
fn inside_bare_repo(path: &Path) -> bool {
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    for dir in real.ancestors() {
        if dir.join(".git").symlink_metadata().is_ok() {
            return false;
        }
        if looks_bare(dir) {
            return true;
        }
    }
    false
}

/// Whether a `-c` / `--config-env` value defines a git alias (section names ignore case).
fn defines_alias(setting: &str) -> bool {
    setting.get(..6).is_some_and(|s| s.eq_ignore_ascii_case("alias."))
}

/// The folders a `git <args>` run in `root` could initialize; empty if it can't. That is `init`, its
/// synonym `init-db`, and any command when the arguments define an alias, since it may expand to
/// init. Every plain argument after the command counts, so an option's value can only make the
/// check stricter.
fn init_targets(root: &str, args: &[String]) -> Vec<PathBuf> {
    let mut cwd = PathBuf::from(root);
    let mut named = Vec::new();
    let mut alias = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-C" => {
                if let Some(dir) = it.next() {
                    cwd = cwd.join(dir);
                }
            }
            "--git-dir" | "--work-tree" => named.extend(it.next().cloned()),
            "-c" | "--config-env" => alias |= it.next().is_some_and(|v| defines_alias(v)),
            "--namespace" | "--attr-source" => {
                it.next();
            }
            other if other.starts_with("--config-env=") => alias |= defines_alias(&other["--config-env=".len()..]),
            other if other.starts_with("--git-dir=") || other.starts_with("--work-tree=") => {
                named.extend(other.split_once('=').map(|(_, dir)| dir.to_string()));
            }
            other if other.starts_with('-') => {}
            command => {
                if !alias && command != "init" && command != "init-db" {
                    return Vec::new();
                }
                named.extend(it.filter(|a| !a.starts_with('-')).cloned());
                let mut targets = vec![cwd.clone()];
                targets.extend(named.iter().map(|dir| cwd.join(dir)));
                return targets;
            }
        }
    }
    Vec::new()
}

/// Whether a new project at `path` would end up inside a bare repository (see `inside_bare_repo`).
#[tauri::command]
pub fn git_in_bare_repo(path: String) -> bool {
    inside_bare_repo(Path::new(&path))
}

/// Runs `git <args>` in `root`. `git init` is refused in a bare repository: it would put a nested
/// `.git` into it, because `safe.bareRepository=explicit` makes git not see the repository.
#[tauri::command]
pub async fn git(root: String, args: Vec<String>) -> Result<GitOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if init_targets(&root, &args).iter().any(|dir| inside_bare_repo(dir)) {
            return Ok(GitOut { code: 128, stdout: String::new(), stderr: INIT_IN_BARE.into() });
        }
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
    /// "rebase" or "merge" while one is in progress (e.g. stopped at a conflict), else None.
    operation: Option<String>,
}

/// Repository status (branch, ahead/behind, changed files). `repo: false` outside a repository.
#[tauri::command]
pub async fn git_status(root: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let top = git_cmd(&root).args(["rev-parse", "--show-toplevel"]).output().map_err(|e| e.to_string())?;
        if !top.status.success() {
            return Ok(Status { repo: false, top: String::new(), branch: String::new(), upstream: None, ahead: 0, behind: 0, changes: vec![], operation: None });
        }
        let top = String::from_utf8_lossy(&top.stdout).trim().to_string();
        let out = git_cmd(&top).args(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let mut s = Status { top: top.clone(), ..parse_status(&text) };
        let git_dir = git_cmd(&top).args(["rev-parse", "--absolute-git-dir"]).output().map_err(|e| e.to_string())?;
        if git_dir.status.success() {
            let (operation, branch) = operation_in(std::path::Path::new(String::from_utf8_lossy(&git_dir.stdout).trim()));
            s.operation = operation;
            // A rebase detaches HEAD ("HEAD (no branch)"); show the branch being rebased instead.
            if let Some(b) = branch {
                s.branch = b;
            }
        }
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rebase/merge in progress in `git_dir`: ("rebase" | "rebase-apply" | "merge", branch being rebased).
/// "rebase-apply" is the older apply backend (`--continue` only, no manual commit in between);
/// a `git am` session also lives in rebase-apply/ (marked by "applying") and is not reported.
fn operation_in(git_dir: &std::path::Path) -> (Option<String>, Option<String>) {
    for d in ["rebase-merge", "rebase-apply"] {
        let dir = git_dir.join(d);
        if dir.is_dir() {
            if dir.join("applying").exists() {
                return (None, None);
            }
            let head = std::fs::read_to_string(dir.join("head-name")).ok();
            let branch = head.map(|h| h.trim().trim_start_matches("refs/heads/").to_string()).filter(|h| !h.is_empty() && h != "detached HEAD");
            return (Some(if d == "rebase-merge" { "rebase" } else { "rebase-apply" }.into()), branch);
        }
    }
    if git_dir.join("MERGE_HEAD").is_file() {
        return (Some("merge".into()), None);
    }
    (None, None)
}

/// Parses `git status --porcelain=v1 -b -z` output (`top` is left empty).
fn parse_status(text: &str) -> Status {
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
    Status { repo: true, top: String::new(), branch, upstream, ahead, behind, changes, operation: None }
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
/// `no_textconv` is set for Code Together guests: they can edit `.gitattributes`, which picks the
/// helper a blame would run.
#[tauri::command]
pub async fn git_blame(root: String, path: String, contents: Option<String>, no_textconv: Option<bool>) -> Result<Option<Blame>, String> {
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
        if no_textconv.unwrap_or(false) {
            cmd.arg("--no-textconv");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_detects_rebase_and_merge() {
        let dir = std::env::temp_dir().join(format!("omega-git-op-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(operation_in(&dir), (None, None));
        std::fs::write(dir.join("MERGE_HEAD"), "abc\n").unwrap();
        assert_eq!(operation_in(&dir), (Some("merge".into()), None));
        std::fs::create_dir(dir.join("rebase-merge")).unwrap();
        std::fs::write(dir.join("rebase-merge/head-name"), "refs/heads/feature/x\n").unwrap();
        assert_eq!(operation_in(&dir), (Some("rebase".into()), Some("feature/x".into())));
        std::fs::remove_dir_all(dir.join("rebase-merge")).unwrap();
        std::fs::remove_file(dir.join("MERGE_HEAD")).unwrap();
        std::fs::create_dir(dir.join("rebase-apply")).unwrap();
        std::fs::write(dir.join("rebase-apply/head-name"), "refs/heads/main\n").unwrap();
        assert_eq!(operation_in(&dir), (Some("rebase-apply".into()), Some("main".into())));
        // `git am` uses rebase-apply/ too: not a rebase, nothing to continue from the branch menu.
        std::fs::write(dir.join("rebase-apply/applying"), "").unwrap();
        assert_eq!(operation_in(&dir), (None, None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn blame_for_guests_runs_no_textconv_helper() {
        let dir = scratch("blame-textconv");
        let root = dir.to_str().unwrap().to_string();
        run_git(&dir, &["init", "-q"]);
        let marker = dir.join("helper-ran");
        let helper = dir.join("conv.sh");
        std::fs::write(&helper, format!("#!/bin/sh\ntouch '{}'\ncat \"$1\"\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        run_git(&dir, &["config", "diff.x.textconv", helper.to_str().unwrap()]);
        std::fs::write(dir.join(".gitattributes"), "*.txt diff=x\n").unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run_git(&dir, &["add", "a.txt", ".gitattributes"]);
        run_git(&dir, &["commit", "-q", "-m", "one"]);
        let file = dir.join("a.txt").to_str().unwrap().to_string();
        let blame = tauri::async_runtime::block_on(git_blame(root, file, Some("one\n".into()), Some(true))).unwrap();
        assert_eq!(blame.map(|b| b.lines.len()), Some(1));
        assert!(!marker.exists(), "the textconv helper ran");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omega-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn run_git(dir: &std::path::Path, args: &[&str]) {
        let id = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
        let out = git_cmd(dir.to_str().unwrap()).args(id).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn status_of(dir: &std::path::Path) -> Status {
        tauri::async_runtime::block_on(git_status(dir.to_string_lossy().into())).unwrap()
    }

    fn new_repo(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        run_git(dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run_git(dir, &["add", "a.txt"]);
        run_git(dir, &["commit", "-qm", "a"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_bare_repository_never_runs_its_config() {
        use tauri::async_runtime::block_on;
        let tmp = scratch("planted");
        let (dir, marker) = (tmp.join("proj"), tmp.join("EXECUTED"));
        std::fs::create_dir_all(dir.join("objects")).unwrap();
        std::fs::create_dir_all(dir.join("refs")).unwrap();
        std::fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        let hook = format!("touch {}; false", marker.display());
        std::fs::write(dir.join("config"), format!("[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = \"{hook}\"\n")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let file = dir.join("a.txt").to_string_lossy().to_string();

        // Every way Omega reaches git: status poll, generic command, gutter, blame, run_capture.
        assert!(!status_of(&dir).repo);
        let direct = block_on(git(root.clone(), vec!["status".into()])).unwrap();
        assert_eq!(direct.code, 128);
        assert!(direct.stderr.contains("safe.bareRepository"), "{}", direct.stderr);
        assert_eq!(block_on(git_head_file(root.clone(), file.clone())).unwrap(), None);
        assert!(block_on(git_blame(root.clone(), file, Some("a\n".into()), None)).unwrap().is_none());
        let captured = block_on(crate::proc::run_capture("git".into(), vec!["status".into()], Some(root))).unwrap();
        assert_eq!(serde_json::to_value(&captured).unwrap()["code"], 128);
        assert!(!marker.exists(), "the planted core.fsmonitor ran");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn normal_repositories_worktrees_and_submodules_keep_working() {
        let tmp = scratch("layouts");
        let main = tmp.join("main");
        new_repo(&main);
        assert!(status_of(&main).repo);

        run_git(&main, &["worktree", "add", "-q", "../wt", "-b", "wt"]);
        assert!(tmp.join("wt/.git").is_file());
        let wt = status_of(&tmp.join("wt"));
        assert!(wt.repo);
        assert_eq!(wt.branch, "wt");

        new_repo(&tmp.join("lib"));
        run_git(&main, &["submodule", "add", "-q", "../lib", "mod"]);
        assert!(main.join("mod/.git").is_file());
        assert!(status_of(&main.join("mod")).repo);

        // A worktree of a bare repository is opened through its `.git` file, not discovered.
        run_git(&tmp, &["clone", "-q", "--bare", "main", "bare.git"]);
        let barewt = tmp.join("barewt");
        run_git(&tmp, &["--git-dir=bare.git", "worktree", "add", "-q", barewt.to_str().unwrap(), "-b", "bw"]);
        assert!(status_of(&barewt).repo);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_deliberately_opened_bare_repository_fails_cleanly() {
        use tauri::async_runtime::block_on;
        let tmp = scratch("bare");
        new_repo(&tmp.join("src"));
        run_git(&tmp, &["clone", "-q", "--bare", "src", "bare.git"]);
        let bare = tmp.join("bare.git");
        let s = status_of(&bare);
        assert!(!s.repo && s.changes.is_empty());
        let log = block_on(git(bare.to_string_lossy().into(), vec!["log".into()])).unwrap();
        assert_eq!(log.code, 128);
        assert!(log.stderr.starts_with("fatal:"), "{}", log.stderr);
        // Explicitly addressing it still works.
        run_git(&tmp, &["--git-dir=bare.git", "log", "-1"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn init_via_omega(root: &std::path::Path, args: &[&str]) -> GitOut {
        let args = args.iter().map(|a| a.to_string()).collect();
        tauri::async_runtime::block_on(git(root.to_string_lossy().into(), args)).unwrap()
    }

    fn plant_bare(dir: &std::path::Path, marker: &std::path::Path) {
        std::fs::create_dir_all(dir.join("objects")).unwrap();
        std::fs::create_dir_all(dir.join("refs")).unwrap();
        std::fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(dir.join("config"), format!("[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = \"touch {}; false\"\n", marker.display())).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn init_is_refused_in_a_bare_repository() {
        let tmp = scratch("init-bare");
        let (planted, marker) = (tmp.join("planted"), tmp.join("EXECUTED"));
        plant_bare(&planted, &marker);
        std::fs::create_dir_all(planted.join("sub")).unwrap();
        new_repo(&tmp.join("src"));
        run_git(&tmp, &["clone", "-q", "--bare", "src", "real.git"]);
        std::os::unix::fs::symlink(&planted, tmp.join("link")).unwrap();

        let refused: [(std::path::PathBuf, &[&str]); 16] = [
            (planted.clone(), &["init", "-q"]),
            (tmp.join("real.git"), &["init", "-q"]),
            (tmp.join("link"), &["init"]),
            (planted.join("sub"), &["init"]),
            (tmp.clone(), &["-C", "planted", "init"]),
            (tmp.clone(), &["-c", "a.b=c", "-C", "planted", "init", "-q"]),
            (tmp.clone(), &["init", "-q", "planted"]),
            (tmp.clone(), &["--git-dir=planted", "init"]),
            (tmp.clone(), &["--git-dir", "planted", "init"]),
            (planted.clone(), &["init-db", "-q"]),
            (planted.clone(), &["-c", "alias.i=init", "i"]),
            (planted.clone(), &["-c", "ALIAS.i=init", "i", "-q"]),
            (planted.clone(), &["-c", "alias.i=!git init", "i"]),
            (planted.clone(), &["--config-env=alias.i=SOME_VAR", "i"]),
            (planted.clone(), &["--config-env", "alias.i=SOME_VAR", "i"]),
            (tmp.clone(), &["-C", "planted", "-c", "alias.i=init", "i"]),
        ];
        for (root, args) in &refused {
            let out = init_via_omega(root, args);
            assert_eq!((out.code, out.stderr.as_str()), (128, INIT_IN_BARE), "{root:?} {args:?}");
        }
        for dir in [&planted, &planted.join("sub"), &tmp.join("real.git")] {
            assert!(!dir.join(".git").exists(), "{dir:?}");
        }
        assert!(!marker.exists(), "the planted core.fsmonitor ran");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn init_still_works_in_ordinary_folders() {
        let tmp = scratch("init-ok");
        let ok = |name: &str, setup: &dyn Fn(&std::path::Path)| {
            let dir = tmp.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            setup(&dir);
            let out = init_via_omega(&dir, &["init", "-q"]);
            assert_eq!(out.code, 0, "{name}: {}", out.stderr);
            assert!(dir.join(".git").is_dir(), "{name}");
            assert!(status_of(&dir).repo, "{name}");
        };
        ok("empty", &|_| {});
        ok("head-file", &|d| std::fs::write(d.join("HEAD"), "ref: refs/heads/main\n").unwrap());
        ok("head-and-objects", &|d| {
            std::fs::write(d.join("HEAD"), "ref: refs/heads/main\n").unwrap();
            std::fs::create_dir(d.join("objects")).unwrap();
        });
        ok("not-a-head", &|d| {
            std::fs::write(d.join("HEAD"), "release notes for the next version\n").unwrap();
            std::fs::create_dir(d.join("objects")).unwrap();
            std::fs::create_dir(d.join("refs")).unwrap();
        });
        ok("head-folder", &|d| {
            std::fs::create_dir(d.join("HEAD")).unwrap();
            std::fs::create_dir(d.join("objects")).unwrap();
            std::fs::create_dir(d.join("refs")).unwrap();
        });
        // Initializing again and a repository that lives below a bare-looking folder stay possible.
        new_repo(&tmp.join("existing"));
        assert_eq!(init_via_omega(&tmp.join("existing"), &["init", "-q"]).code, 0);
        // An alias in a normal repository just runs.
        let aliased = init_via_omega(&tmp.join("existing"), &["-c", "alias.st=status --short", "st"]);
        assert_eq!((aliased.code, aliased.stderr.as_str()), (0, ""));
        let outer = tmp.join("outer");
        plant_bare(&outer, &tmp.join("EXECUTED"));
        new_repo(&outer.join("inner"));
        assert_eq!(init_via_omega(&outer.join("inner"), &["init", "-q"]).code, 0);
        assert!(!tmp.join("EXECUTED").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn only_git_init_is_checked() {
        let args = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(init_targets("/r", &args(&["status"])).is_empty());
        assert!(init_targets("/r", &args(&["commit", "-m", "init"])).is_empty());
        assert!(init_targets("/r", &args(&["-c", "init", "log"])).is_empty());
        assert!(init_targets("/r", &args(&["-c", "user.name=alias.x", "status"])).is_empty());
        assert_eq!(init_targets("/r", &args(&["-c", "alias.s=status", "s"])), [PathBuf::from("/r")]);
        assert_eq!(init_targets("/r", &args(&["-C", "a", "init", "-q", "b"])), [PathBuf::from("/r/a"), PathBuf::from("/r/a/b")]);
    }

    #[cfg(unix)]
    #[test]
    fn new_projects_inside_a_bare_repository_are_detected() {
        let tmp = scratch("init-new");
        plant_bare(&tmp.join("planted"), &tmp.join("EXECUTED"));
        assert!(git_in_bare_repo(tmp.join("planted/new-project").to_string_lossy().into()));
        assert!(!git_in_bare_repo(tmp.join("new-project").to_string_lossy().into()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn git_runs_with_untranslated_messages() {
        let c = git_cmd(".");
        let env: Vec<_> = c.get_envs().filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string()))).collect();
        assert!(env.contains(&("LC_ALL".into(), "C".into())));
    }

    const H1: &str = "1111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222";
    const H0: &str = "0000000000000000000000000000000000000000";

    #[test]
    fn blame_reuses_index_for_repeated_hash() {
        let s = format!(
            "{H1} 1 1 1\nauthor Alice\nauthor-mail <alice@x.org>\nauthor-time 100\nsummary first\nfilename a.txt\n\tline1\n\
             {H2} 2 2 1\nauthor Bob\nauthor-mail <bob@x.org>\nauthor-time 200\nsummary second\nfilename a.txt\n\tline2\n\
             {H1} 3 3 1\nfilename a.txt\n\tline3\n"
        );
        let b = parse_blame(&s);
        assert_eq!(b.commits.len(), 2);
        assert_eq!(b.lines, vec![0, 1, 0]);
        assert_eq!(b.commits[0].hash, H1);
        assert_eq!(b.commits[0].author, "Alice");
        assert_eq!(b.commits[0].mail, "alice@x.org");
        assert_eq!(b.commits[0].time, 100);
        assert_eq!(b.commits[0].summary, "first");
        assert_eq!(b.commits[1].author, "Bob");
        assert_eq!(b.commits[1].mail, "bob@x.org");
        assert_eq!(b.commits[1].time, 200);
    }

    #[test]
    fn blame_uncommitted_is_minus_one() {
        let s = format!("{H0} 1 1 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\nsummary Version of a.txt from a.txt\n\tnew\n");
        let b = parse_blame(&s);
        assert_eq!(b.lines, vec![-1]);
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].author, "Not Committed Yet");
        assert_eq!(b.commits[0].mail, "not.committed.yet");
    }

    #[test]
    fn blame_length_is_highest_final_line_with_gaps() {
        let s = format!("{H1} 1 2 1\nauthor A\n\tx\n{H1} 3 5 1\n\ty\n");
        let b = parse_blame(&s);
        assert_eq!(b.lines, vec![-1, 0, -1, -1, 0]);
    }

    #[test]
    fn blame_empty() {
        let b = parse_blame("");
        assert!(b.commits.is_empty());
        assert!(b.lines.is_empty());
    }

    #[test]
    fn status_branch_ahead_behind() {
        let s = parse_status("## main...origin/main [ahead 1, behind 2]\0 M src/a.rs\0");
        assert!(s.repo);
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (1, 2));
        assert_eq!(s.changes.len(), 1);
        let c = &s.changes[0];
        assert_eq!((c.x.as_str(), c.y.as_str(), c.path.as_str()), (" ", "M", "src/a.rs"));
        assert!(c.orig.is_none());
    }

    #[test]
    fn status_only_behind_and_no_upstream() {
        let s = parse_status("## dev...origin/dev [behind 7]\0");
        assert_eq!((s.ahead, s.behind), (0, 7));
        let s = parse_status("## feature\0");
        assert_eq!(s.branch, "feature");
        assert!(s.upstream.is_none());
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn status_no_commits_yet() {
        let s = parse_status("## No commits yet on main\0?? a.txt\0");
        assert_eq!(s.branch, "main");
        assert!(s.upstream.is_none());
        assert_eq!(s.changes.len(), 1);
    }

    #[test]
    fn status_detached_head() {
        let s = parse_status("## HEAD (no branch)\0");
        assert_eq!(s.branch, "HEAD (no branch)");
        assert!(s.upstream.is_none());
    }

    #[test]
    fn status_rename_sets_orig() {
        let s = parse_status("## main\0R  new.rs\0old.rs\0M  other.rs\0");
        assert_eq!(s.changes.len(), 2);
        assert_eq!(s.changes[0].x, "R");
        assert_eq!(s.changes[0].path, "new.rs");
        assert_eq!(s.changes[0].orig.as_deref(), Some("old.rs"));
        assert_eq!(s.changes[1].path, "other.rs");
        assert!(s.changes[1].orig.is_none());
    }

    #[test]
    fn status_untracked_with_spaces() {
        let s = parse_status("## main\0?? path with spaces/file name.txt\0");
        assert_eq!(s.changes[0].x, "?");
        assert_eq!(s.changes[0].y, "?");
        assert_eq!(s.changes[0].path, "path with spaces/file name.txt");
    }

    #[test]
    fn status_skips_short_entries() {
        let s = parse_status("## main\0M \0?? \0 M ok\0");
        assert_eq!(s.changes.len(), 1);
        assert_eq!(s.changes[0].path, "ok");
    }

    #[test]
    fn status_empty() {
        let s = parse_status("");
        assert!(s.repo);
        assert_eq!(s.branch, "");
        assert!(s.changes.is_empty());
    }
}
