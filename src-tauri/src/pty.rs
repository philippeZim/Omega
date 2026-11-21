//! Real terminals: each tab is a PTY running the user's login shell, or one command (Build/Run).
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// What runs in a PTY. Guest input is only ever accepted for the matching kind.
#[derive(Clone, Copy, PartialEq, Debug)]
enum PtyKind {
    /// The host's own interactive shell.
    Shell,
    /// One command (Build/Run): the terminal ends with it.
    Command,
    /// An interactive shell the host granted to a Code Together guest.
    GuestShell,
}

/// Input not yet taken by the program, per PTY, that guests may queue. A program that stops
/// reading must not hold up anything else.
const GUEST_QUEUE_BYTES: usize = 64 * 1024;

/// Writes to a PTY on its own thread: a full PTY buffer blocks there, not the caller.
struct WriteQueue {
    tx: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
}

impl WriteQueue {
    fn new(mut writer: Box<dyn Write + Send>) -> Self {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(AtomicUsize::new(0));
        let left = queued.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = rx.recv() {
                let done = writer.write_all(&bytes).and_then(|_| writer.flush());
                left.fetch_sub(bytes.len(), Ordering::SeqCst);
                if done.is_err() {
                    break;
                }
            }
        });
        Self { tx, queued }
    }

    fn push(&self, bytes: Vec<u8>) -> Result<(), String> {
        let n = bytes.len();
        self.queued.fetch_add(n, Ordering::SeqCst);
        self.tx.send(bytes).map_err(|_| {
            self.queued.fetch_sub(n, Ordering::SeqCst);
            "terminal does not exist".to_string()
        })
    }

    /// Like `push`, refused while more than `limit` bytes would be waiting.
    fn push_limited(&self, bytes: Vec<u8>, limit: usize) -> Result<(), String> {
        if self.queued.load(Ordering::SeqCst) + bytes.len() > limit {
            return Err("pty:busy".into());
        }
        self.push(bytes)
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writes: WriteQueue,
    child: Box<dyn Child + Send + Sync>,
    kind: PtyKind,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String,
}

/// Sent when a terminal's process ended. `code`: its exit code (None if it was killed by us or
/// the status is unknown).
#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    code: Option<i32>,
}

#[derive(serde::Serialize)]
pub struct ShellInfo {
    id: String,
    label: String,
}

/// Shells the user can open a terminal with. The first entry is the system default.
/// Windows: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and every WSL distribution;
/// macOS/Linux: the login shell and the other shells listed in /etc/shells.
#[tauri::command]
pub fn list_shells() -> Vec<ShellInfo> {
    let mut v = Vec::new();
    let mut add = |id: String, label: String| v.push(ShellInfo { id, label });
    if cfg!(windows) {
        if crate::env::which("pwsh").is_some() {
            add("pwsh".into(), "PowerShell".into());
        }
        add("powershell".into(), "Windows PowerShell".into());
        add("cmd".into(), "Command Prompt".into());
        if git_bash().is_some() {
            add("gitbash".into(), "Git Bash".into());
        }
        for d in wsl_distros() {
            add(format!("wsl:{d}"), format!("{d} (WSL)"));
        }
    } else {
        let login = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
        let mut seen = std::collections::HashSet::new();
        let shells = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        let others = shells.lines().map(str::trim).filter(|l| l.starts_with('/')).map(String::from);
        for path in std::iter::once(login).chain(others) {
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            // Skip duplicates (/bin/bash vs /usr/bin/bash) and non-interactive helpers.
            if ["nologin", "false", "git-shell", "rbash", "systemd-home-fallback-shell"].contains(&name.as_str()) || !std::path::Path::new(&path).is_file() || !seen.insert(name.clone()) {
                continue;
            }
            add(path, name);
        }
    }
    v
}

fn git_bash() -> Option<std::path::PathBuf> {
    let git = crate::env::which("git")?;
    // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    let bash = git.parent()?.parent()?.join("bin").join("bash.exe");
    bash.is_file().then_some(bash)
}

/// Installed WSL distributions (`wsl -l -q` prints UTF-16).
fn wsl_distros() -> Vec<String> {
    let Ok(out) = crate::env::command("wsl.exe").args(["-l", "-q"]).output() else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    let units: Vec<u16> = out.stdout.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0' || c == '\u{feff}').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

/// Command for a terminal. `run`: the Run terminal, which on Windows is always cmd.exe because
/// Omega's run commands use `&&` (missing in Windows PowerShell 5). `shell`: an id from
/// `list_shells` (None = system default).
fn shell_command(run: bool, shell: Option<&str>, cwd: &str) -> CommandBuilder {
    if cfg!(windows) {
        let id = if run { "cmd" } else { shell.unwrap_or("") };
        if let Some(distro) = id.strip_prefix("wsl:") {
            let mut c = CommandBuilder::new("wsl.exe");
            c.args(["-d", distro, "--cd", cwd]);
            return c;
        }
        match id {
            "cmd" => {
                let mut c = CommandBuilder::new("cmd.exe");
                if run {
                    c.arg("/Q");
                }
                return c;
            }
            "gitbash" => {
                if let Some(b) = git_bash() {
                    let mut c = CommandBuilder::new(b);
                    c.args(["--login", "-i"]);
                    return c;
                }
            }
            "powershell" => {
                let mut c = CommandBuilder::new("powershell.exe");
                c.arg("-NoLogo");
                return c;
            }
            _ => {}
        }
        let ps = crate::env::which("pwsh").map(|p| p.display().to_string()).unwrap_or_else(|| "powershell.exe".into());
        let mut c = CommandBuilder::new(ps);
        c.arg("-NoLogo");
        return c;
    }
    let shell = shell
        .filter(|s| std::path::Path::new(s).is_file())
        .map(String::from)
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
    let mut c = CommandBuilder::new(shell);
    c.arg("-l");
    c
}

/// Runs one command instead of an interactive shell (Build/Run steps): the terminal ends with the
/// command, so its exit code can be shown. POSIX: the login shell with `-c` (or `/bin/sh` when the
/// login shell doesn't speak POSIX, e.g. fish); Windows: cmd.exe on a temporary batch file, because
/// cmd.exe doesn't understand the `\"` quoting CreateProcess arguments get.
fn single_command(id: &str, command: &str) -> Result<CommandBuilder, String> {
    if cfg!(windows) {
        let file = std::env::temp_dir().join(format!("omega-run-{}.cmd", id.replace(|c: char| !c.is_ascii_alphanumeric(), "_")));
        std::fs::write(&file, format!("@echo off\r\n{command}\r\n")).map_err(|e| e.to_string())?;
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/Q", "/D", "/C"]);
        c.arg(file);
        return Ok(c);
    }
    let login = std::env::var("SHELL").ok().filter(|s| std::path::Path::new(s).is_file());
    let posix = login.as_deref().and_then(|s| s.rsplit('/').next()).is_some_and(|n| matches!(n, "bash" | "zsh" | "sh" | "dash" | "ksh" | "mksh"));
    let mut c = CommandBuilder::new(if posix { login.unwrap() } else { "/bin/sh".into() });
    c.args(["-l", "-c", command]);
    Ok(c)
}

/// Variables through which a terminal reaches this Omega (control MCP, IDE server).
const OMEGA_ACCESS_ENV: [&str; 4] = ["OMEGA_MCP_TOKEN", "CLAUDE_CODE_SSE_PORT", "ENABLE_IDE_INTEGRATION", "FORCE_CODE_TERMINAL"];

/// Shell prompts run git by themselves in whatever folder the terminal is in.
fn apply_git_guard(cmd: &mut CommandBuilder) {
    for (k, v) in crate::env::git_guard_env() {
        cmd.env(k, v);
    }
    cmd.env_remove(crate::env::GIT_PARAMETERS);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(app: AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16, kind: Option<String>, shell: Option<String>, command: Option<String>) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let home = crate::env::home().display().to_string();
    let dir = cwd.filter(|d| std::path::Path::new(d).is_dir()).unwrap_or(home);
    let pty_kind = match (&command, kind.as_deref()) {
        (Some(_), _) => PtyKind::Command,
        (None, Some("guest-shell")) => PtyKind::GuestShell,
        _ => PtyKind::Shell,
    };
    let mut cmd = match command.as_deref() {
        Some(c) => single_command(&id, c)?,
        None if pty_kind == PtyKind::GuestShell => shell_command(false, None, &dir),
        None => shell_command(kind.as_deref() == Some("run"), shell.as_deref(), &dir),
    };
    cmd.cwd(&dir);
    cmd.env("PATH", crate::env::path());
    apply_git_guard(&mut cmd);
    // Don't leak a parent Claude Code session's markers (e.g. Omega started from `claude`) into
    // the user's shells; the login shell re-reads the user's own profile anyway.
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_AGENT_SDK_VERSION" {
            cmd.env_remove(&k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Omega");
    // Claude Code started in this terminal connects to our IDE server automatically.
    let ide_port = crate::ide_ws::PORT.load(Ordering::SeqCst);
    if ide_port != 0 && pty_kind != PtyKind::GuestShell {
        cmd.env("CLAUDE_CODE_SSE_PORT", ide_port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
        cmd.env("FORCE_CODE_TERMINAL", "true");
        let no_proxy = std::env::var("NO_PROXY").map(|v| format!("{v},127.0.0.1,localhost")).unwrap_or("127.0.0.1,localhost".into());
        cmd.env("NO_PROXY", &no_proxy);
        cmd.env("no_proxy", &no_proxy);
    }

    if pty_kind == PtyKind::GuestShell {
        // Omega hands a guest none of its own access to the editor.
        for k in OMEGA_ACCESS_ENV {
            cmd.env_remove(k);
        }
    } else if let Some(t) = crate::mcp_control::TOKEN.lock().unwrap().clone() {
        cmd.env("OMEGA_MCP_TOKEN", t);
    }
    if cfg!(windows) {
        // Forward Omega's variables into WSL shells (Windows → Linux env bridging).
        let fwd = format!("TERM_PROGRAM:COLORTERM:CLAUDE_CODE_SSE_PORT:ENABLE_IDE_INTEGRATION:FORCE_CODE_TERMINAL:OMEGA_MCP_TOKEN:{}", crate::env::git_guard_wslenv());
        let wslenv = std::env::var("WSLENV").map(|v| format!("{v}:{fwd}")).unwrap_or(fwd);
        cmd.env("WSLENV", wslenv);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    // Registered before the reader starts: a command that ends at once must still find its session.
    app.state::<PtyState>()
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), Session { master: pair.master, writes: WriteQueue::new(writer), child, kind: pty_kind });

    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("pty-data", PtyData { id: id.clone(), data });
                }
            }
        }
        // Killed sessions are already gone from the map (no exit code then).
        let session = app2.state::<PtyState>().sessions.lock().unwrap().remove(&id);
        let code = session.and_then(|mut s| s.child.wait().ok()).map(|st| st.exit_code() as i32);
        let _ = app2.emit("pty-exit", PtyExit { id, code });
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("terminal does not exist")?;
    s.writes.push(data.into_bytes())
}

/// Whether these process arguments are a shell waiting for commands: a shell without `-c` or a
/// script to run, or one started with `-i`.
fn is_interactive_shell(args: &[String]) -> bool {
    let Some(name) = args.first().map(|a| a.rsplit(['/', '\\']).next().unwrap_or(a).trim_start_matches('-').trim_end_matches(".exe").to_ascii_lowercase()) else { return true };
    if !["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "nu", "elvish", "xonsh", "pwsh", "powershell", "cmd"].contains(&name.as_str()) {
        return false;
    }
    for a in &args[1..] {
        if a.starts_with("--") {
            continue;
        }
        let Some(flags) = a.strip_prefix('-') else { return false }; // a script
        if flags.contains('i') {
            return true;
        }
        if flags.contains('c') {
            return false;
        }
    }
    true
}

#[cfg(target_os = "linux")]
fn process_args(pid: i32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<String> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    (!args.is_empty()).then_some(args)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_args(pid: i32) -> Option<Vec<String>> {
    let out = std::process::Command::new("/bin/ps").args(["-ww", "-o", "args=", "-p", &pid.to_string()]).output().ok()?;
    let args: Vec<String> = String::from_utf8_lossy(&out.stdout).split_whitespace().map(String::from).collect();
    (out.status.success() && !args.is_empty()).then_some(args)
}

/// A login profile can start an interactive shell inside a Build/Run PTY (`exec fish`). Unknown
/// counts as a shell. Windows runs `cmd /D /C`, which skips AutoRun and ends with the batch file.
#[cfg(unix)]
fn shell_in_foreground(s: &Session) -> bool {
    s.master.process_group_leader().and_then(process_args).is_none_or(|a| is_interactive_shell(&a))
}
#[cfg(not(unix))]
fn shell_in_foreground(_: &Session) -> bool {
    false
}

/// Input from a Code Together guest. `target` says what the host means to reach: "task" only
/// lands in a live Build/Run command, "shell" only in a shell granted to a guest. Never blocks.
#[tauri::command(async)]
pub fn pty_write_guest(app: AppHandle, id: String, data: String, target: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("pty:ended")?;
    let accepted = match target.as_str() {
        "task" => s.kind == PtyKind::Command && matches!(s.child.try_wait(), Ok(None)) && !shell_in_foreground(s),
        "shell" => s.kind == PtyKind::GuestShell,
        _ => false,
    };
    if !accepted {
        return Err("pty:ended".into());
    }
    s.writes.push_limited(data.into_bytes(), GUEST_QUEUE_BYTES)
}

#[tauri::command]
pub fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Ends all terminals (frontend reload: its xterm instances are gone, so the shells – and e.g.
/// a `claude` running in them – would otherwise keep running invisibly).
/// Process ids of all terminal shells (for the keep-awake monitor).
pub fn shell_pids(app: &AppHandle) -> Vec<u32> {
    app.state::<PtyState>().sessions.lock().unwrap().values().filter_map(|s| s.child.process_id()).collect()
}

#[tauri::command]
pub fn pty_kill_all(app: AppHandle) {
    let sessions: Vec<Session> = app.state::<PtyState>().sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in sessions {
        end_session(s);
    }
}

/// Process ids in the terminal session led by `sid`, background jobs and `nohup` included.
#[cfg(target_os = "linux")]
fn session_members(sid: i32) -> Vec<i32> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return vec![] };
    dir.flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
        .filter(|pid| {
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
            // After the name in parentheses: state, ppid, pgrp, session.
            stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(3)?.parse::<i32>().ok()) == Some(sid)
        })
        .collect()
}
#[cfg(all(unix, not(target_os = "linux")))]
fn session_members(_: i32) -> Vec<i32> {
    vec![]
}

/// Kills what runs in a guest's shell at once. Only a process that left the terminal session
/// (`setsid`) gets away; outside Linux, so does a background job that ignores the hangup.
#[cfg(unix)]
fn kill_guest_processes(s: &mut Session) {
    let Some(pid) = s.child.process_id().map(|p| p as i32).filter(|p| *p > 1) else { return };
    let foreground = s.master.process_group_leader().filter(|p| *p > 1);
    // A finished shell's id can be reused, so its group is only signalled while it's alive.
    let alive = matches!(s.child.try_wait(), Ok(None));
    unsafe {
        if alive {
            libc::killpg(pid, libc::SIGKILL);
        }
        if let Some(group) = foreground {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    // Repeated for what forked while the first pass ran.
    for _ in 0..3 {
        let left = session_members(pid);
        if left.is_empty() {
            break;
        }
        for p in left {
            unsafe { libc::kill(p, libc::SIGKILL) };
        }
    }
}
#[cfg(not(unix))]
fn kill_guest_processes(_: &mut Session) {}

fn end_session(mut s: Session) {
    if s.kind == PtyKind::GuestShell {
        kill_guest_processes(&mut s);
    }
    let _ = s.child.kill();
}

#[tauri::command]
pub fn pty_kill(app: AppHandle, id: String) {
    let session = app.state::<PtyState>().sessions.lock().unwrap().remove(&id);
    if let Some(s) = session {
        end_session(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn tells_a_waiting_shell_from_a_program_or_script() {
        for a in [&["bash"][..], &["-zsh"], &["/usr/bin/fish", "-l"], &["bash", "-i", "x.sh"], &["sh", "-s"], &["bash", "--login"]] {
            assert!(is_interactive_shell(&args(a)), "{a:?}");
        }
        for a in [&["python3", "main.py"][..], &["bash", "run.sh"], &["bash", "-l", "-c", "python3 x.py"], &["sh", "-lc", "make"], &["node"]] {
            assert!(!is_interactive_shell(&args(a)), "{a:?}");
        }
        assert!(is_interactive_shell(&[]), "unknown counts as a shell");
    }

    /// Blocks in `write` until released, like a PTY whose program stopped reading.
    struct Stuck(Arc<Mutex<()>>);
    impl Write for Stuck {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            drop(self.0.lock().unwrap());
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn guest_input_is_bounded_and_never_blocks_the_caller() {
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().unwrap();
        let q = WriteQueue::new(Box::new(Stuck(gate.clone())));
        q.push_limited(vec![0; 60], 100).unwrap();
        q.push_limited(vec![0; 40], 100).unwrap();
        assert_eq!(q.push_limited(vec![0; 1], 100).unwrap_err(), "pty:busy");
        drop(held);
        for _ in 0..200 {
            if q.queued.load(Ordering::SeqCst) == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        q.push_limited(vec![0; 100], 100).unwrap();
    }

    #[cfg(unix)]
    fn session(kind: PtyKind, script: &str) -> Session {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-c", script]);
        let child = pair.slave.spawn_command(c).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        Session { master: pair.master, writes: WriteQueue::new(writer), child, kind }
    }

    #[cfg(unix)]
    fn wait_until(mut f: impl FnMut() -> bool) -> bool {
        (0..400).any(|_| {
            let ok = f();
            if !ok {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            ok
        })
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ending_a_guest_shell_kills_jobs_that_ignore_the_hangup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pid");
        let s = session(PtyKind::GuestShell, &format!("trap '' HUP; sleep 300 & echo $! > {}.tmp; mv {0}.tmp {0}; wait", file.display()));
        assert!(wait_until(|| file.exists()));
        let job: i32 = std::fs::read_to_string(&file).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(job, 0) }, 0);
        end_session(s);
        let gone = |p: i32| std::fs::read_to_string(format!("/proc/{p}/stat")).map_or(true, |st| st.rsplit_once(')').is_some_and(|(_, r)| r.trim_start().starts_with('Z')));
        assert!(wait_until(|| gone(job)), "the job survived");
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_command_leaves_no_shell_behind() {
        let mut s = session(PtyKind::Command, "exit 0");
        assert!(wait_until(|| matches!(s.child.try_wait(), Ok(Some(_)))));
    }

    #[test]
    fn terminals_get_the_git_guard_without_inherited_parameters() {
        let mut c = CommandBuilder::new("sh");
        c.env(crate::env::GIT_PARAMETERS, "'safe.bareRepository=all'");
        apply_git_guard(&mut c);
        assert!(c.get_env(crate::env::GIT_PARAMETERS).is_none());
        assert!(c.get_env("GIT_CONFIG_COUNT").is_some());
    }
    #[test]
    fn lists_shells() {
        let shells = super::list_shells();
        for s in &shells {
            println!("{} -> {}", s.label, s.id);
        }
        assert!(!shells.is_empty());
    }
}
