//! Real terminals: each tab is a PTY running the user's login shell, or one command (Build/Run).
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(app: AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16, kind: Option<String>, shell: Option<String>, command: Option<String>) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let home = crate::env::home().display().to_string();
    let dir = cwd.filter(|d| std::path::Path::new(d).is_dir()).unwrap_or(home);
    let mut cmd = match command.as_deref() {
        Some(c) => single_command(&id, c)?,
        None => shell_command(kind.as_deref() == Some("run"), shell.as_deref(), &dir),
    };
    cmd.cwd(&dir);
    cmd.env("PATH", crate::env::path());
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
    let ide_port = crate::ide_ws::PORT.load(std::sync::atomic::Ordering::SeqCst);
    if ide_port != 0 {
        cmd.env("CLAUDE_CODE_SSE_PORT", ide_port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
        cmd.env("FORCE_CODE_TERMINAL", "true");
        let no_proxy = std::env::var("NO_PROXY").map(|v| format!("{v},127.0.0.1,localhost")).unwrap_or("127.0.0.1,localhost".into());
        cmd.env("NO_PROXY", &no_proxy);
        cmd.env("no_proxy", &no_proxy);
    }

    if let Some(t) = crate::mcp_control::TOKEN.lock().unwrap().clone() {
        cmd.env("OMEGA_MCP_TOKEN", t);
    }
    if cfg!(windows) {
        // Forward Omega's variables into WSL shells (Windows → Linux env bridging).
        let fwd = "TERM_PROGRAM:COLORTERM:CLAUDE_CODE_SSE_PORT:ENABLE_IDE_INTEGRATION:FORCE_CODE_TERMINAL:OMEGA_MCP_TOKEN";
        let wslenv = std::env::var("WSLENV").map(|v| format!("{v}:{fwd}")).unwrap_or(fwd.into());
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
        .insert(id.clone(), Session { master: pair.master, writer, child });

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
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
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
    for mut s in sessions {
        let _ = s.child.kill();
    }
}

#[tauri::command]
pub fn pty_kill(app: AppHandle, id: String) {
    if let Some(mut s) = app.state::<PtyState>().sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_shells() {
        let shells = super::list_shells();
        for s in &shells {
            println!("{} -> {}", s.label, s.id);
        }
        assert!(!shells.is_empty());
    }
}
