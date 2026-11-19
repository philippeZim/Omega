//! Real terminals: each tab is a PTY running the user's login shell.
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

#[tauri::command]
pub fn pty_spawn(app: AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let dir = cwd.filter(|d| std::path::Path::new(d).is_dir()).unwrap_or(home);
    cmd.cwd(dir);
    // Don't leak a parent Claude Code session's markers (e.g. Studio started from `claude`) into
    // the user's shells; the login shell re-reads the user's own profile anyway.
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_AGENT_SDK_VERSION" {
            cmd.env_remove(&k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Studio");
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
        cmd.env("STUDIO_MCP_TOKEN", t);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("pty-data", PtyData { id: id2.clone(), data });
                }
            }
        }
        let _ = app2.emit("pty-exit", id2.clone());
        app2.state::<PtyState>().sessions.lock().unwrap().remove(&id2);
    });

    app.state::<PtyState>()
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("Terminal existiert nicht")?;
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
