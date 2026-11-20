//! Codex CLI IDE context (`/ide` in the Codex TUI): Codex connects to
//! `$CODEX_HOME/ipc/ipc.sock` before each prompt, sends an `ide-context` request (u32 LE length +
//! JSON frames) and prepends our answer (active file, selection, open tabs) to the prompt.
//! The frontend keeps the context current via `codex_set_context`.
use serde_json::{json, Value};
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Mutex;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct CodexState {
    context: Mutex<Value>,
    /// Socket we own (removed on exit); None if another IDE already serves it.
    socket: Mutex<Option<PathBuf>>,
    status: Mutex<String>,
}

#[cfg(unix)]
fn socket_path() -> PathBuf {
    let home = match std::env::var("CODEX_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => crate::env::home().join(".codex"),
    };
    home.join("ipc").join("ipc.sock")
}

#[cfg(unix)]
fn read_frame(s: &mut UnixStream) -> Option<Value> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).ok()?;
    let len = u32::from_le_bytes(len) as usize;
    if len > 16 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

#[cfg(unix)]
fn write_frame(s: &mut UnixStream, v: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(v)?;
    s.write_all(&(body.len() as u32).to_le_bytes())?;
    s.write_all(&body)?;
    s.flush()
}

#[cfg(unix)]
fn serve(app: AppHandle, mut s: UnixStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    while let Some(msg) = read_frame(&mut s) {
        if msg["type"] != "request" {
            continue;
        }
        let id = msg["requestId"].clone();
        let reply = if msg["method"] == "ide-context" {
            let ctx = app.state::<CodexState>().context.lock().unwrap().clone();
            let _ = app.emit("codex-ide-request", ());
            json!({
                "type": "response", "requestId": id, "resultType": "success", "method": "ide-context",
                "handledByClientId": "omega",
                "result": { "type": "broadcast", "ideContext": if ctx.is_null() { json!({ "openTabs": [] }) } else { ctx } },
            })
        } else {
            json!({ "type": "response", "requestId": id, "resultType": "error", "error": "no-handler-for-request" })
        };
        if write_frame(&mut s, &reply).is_err() {
            break;
        }
    }
}

#[cfg(unix)]
/// Binds the socket (unless another IDE, e.g. VS Code with the Codex extension, serves it).
pub fn start(app: &AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    let path = socket_path();
    let state = app.state::<CodexState>();
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    // Codex refuses directories writable by others.
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            *state.status.lock().unwrap() = "busy".into();
            return;
        }
        let _ = std::fs::remove_file(&path); // stale socket of a crashed instance
    }
    let Ok(listener) = UnixListener::bind(&path) else {
        *state.status.lock().unwrap() = "error".into();
        return;
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    *state.socket.lock().unwrap() = Some(path);
    *state.status.lock().unwrap() = "listening".into();
    let app = app.clone();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, s));
        }
    });
}

/// Codex's IPC uses a Unix domain socket; not available on Windows.
#[cfg(not(unix))]
pub fn start(app: &AppHandle) {
    *app.state::<CodexState>().status.lock().unwrap() = "unsupported".into();
}

pub fn cleanup(app: &AppHandle) {
    if let Some(p) = app.state::<CodexState>().socket.lock().unwrap().take() {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn codex_set_context(app: AppHandle, context: Value) {
    *app.state::<CodexState>().context.lock().unwrap() = context;
}

#[tauri::command]
pub fn codex_status(app: AppHandle) -> String {
    app.state::<CodexState>().status.lock().unwrap().clone()
}
