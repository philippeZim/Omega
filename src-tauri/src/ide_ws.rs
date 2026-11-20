//! Claude Code IDE integration: the same protocol the official VS Code / JetBrains extensions
//! speak. A WebSocket MCP server on 127.0.0.1:<random port>, announced via
//! `~/.claude/ide/<port>.lock`; `claude` started in our terminals finds it through
//! CLAUDE_CODE_SSE_PORT (set in pty.rs) and connects automatically.
//!
//! Protocol only lives here; tool calls are executed by the frontend (`ide-call` event →
//! `ide_reply`), notifications (selection_changed, at_mentioned) come from it via `ide_notify`.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

/// Port of the running server (0 = not running); read by pty.rs for the terminal env.
pub static PORT: AtomicU16 = AtomicU16::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct IdeState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    token: String,
    lock_file: Option<PathBuf>,
    tools: Value,
    folders: Vec<String>,
    /// connection id → outgoing message channel
    clients: HashMap<u64, (mpsc::UnboundedSender<String>, String)>,
    pending: HashMap<u64, oneshot::Sender<Value>>,
}

fn home_dir() -> PathBuf {
    crate::env::home()
}

fn lock_dir() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d).join("ide"),
        _ => home_dir().join(".claude").join("ide"),
    }
}

/// Removes lock files of Omega instances that are no longer running (killed / crashed).
fn remove_stale_locks() {
    remove_stale_locks_in(&lock_dir())
}

fn remove_stale_locks_in(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("lock") { continue }
        let Ok(v) = std::fs::read_to_string(&p).map(|t| serde_json::from_str::<Value>(&t).unwrap_or_default()) else { continue };
        if v["ideName"] != "Omega" { continue }
        let alive = v["pid"].as_u64().is_some_and(|pid| crate::env::pid_alive(pid as u32));
        if !alive {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn write_lock(port: u16, token: &str, folders: &[String]) -> Option<PathBuf> {
    write_lock_in(&lock_dir(), port, token, folders)
}

fn write_lock_in(dir: &std::path::Path, port: u16, token: &str, folders: &[String]) -> Option<PathBuf> {
    std::fs::create_dir_all(dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(format!("{port}.lock"));
    let body = json!({
        "pid": std::process::id(),
        "workspaceFolders": folders,
        "ideName": "Omega",
        "transport": "ws",
        "authToken": token,
    });
    let tmp = dir.join(format!(".{port}.lock.tmp"));
    std::fs::write(&tmp, body.to_string()).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).ok()?;
    Some(path)
}

/// Removes our lock file (called on exit).
pub fn cleanup(app: &AppHandle) {
    if let Some(p) = app.state::<IdeState>().inner.lock().unwrap().lock_file.take() {
        let _ = std::fs::remove_file(p);
    }
}

fn result(id: &Value, r: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": r }).to_string()
}
fn error(id: &Value, code: i64, msg: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }).to_string()
}

/// Starts the server once; `tools` = MCP tool definitions, `folders` = workspace folders.
#[tauri::command]
pub async fn ide_start(app: AppHandle, tools: Value, folders: Vec<String>) -> Result<u16, String> {
    if PORT.load(Ordering::SeqCst) != 0 {
        if tools.as_array().is_some_and(|t| !t.is_empty()) {
            app.state::<IdeState>().inner.lock().unwrap().tools = tools;
        }
        ide_set_folders(app, folders);
        return Ok(PORT.load(Ordering::SeqCst));
    }
    remove_stale_locks();
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();

    // Random port in 10000..65535, like the official extensions.
    let mut listener = None;
    for _ in 0..30 {
        let mut p = [0u8; 2];
        let _ = getrandom::fill(&mut p);
        let port = 10000 + (u16::from_le_bytes(p) % 55535);
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            listener = Some(l);
            break;
        }
    }
    let listener = listener.ok_or("Kein freier Port")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    {
        let st = app.state::<IdeState>();
        let mut inner = st.inner.lock().unwrap();
        inner.token = token.clone();
        inner.tools = tools;
        inner.lock_file = write_lock(port, &token, &folders);
        inner.folders = folders;
    }
    PORT.store(port, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move { serve(app, stream, token).await });
        }
    });
    Ok(port)
}

/// Updates workspaceFolders in the lock file (project switched).
#[tauri::command]
pub fn ide_set_folders(app: AppHandle, folders: Vec<String>) {
    let st = app.state::<IdeState>();
    let mut inner = st.inner.lock().unwrap();
    let port = PORT.load(Ordering::SeqCst);
    if port != 0 && inner.folders != folders {
        inner.lock_file = write_lock(port, &inner.token.clone(), &folders);
        inner.folders = folders;
    }
}

/// uid owning the client end of a local TCP connection (from /proc/net/tcp), to recognise
/// processes of the same user.
fn peer_uid(peer_port: u16) -> Option<u32> {
    let want = format!(":{peer_port:04X}");
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(t) = std::fs::read_to_string(file) else { continue };
        for line in t.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() > 7 && f[1].ends_with(&want) {
                return f[7].parse().ok();
            }
        }
    }
    None
}

fn my_uid() -> Option<u32> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    s.lines().find(|l| l.starts_with("Uid:"))?.split_whitespace().nth(1)?.parse().ok()
}

async fn serve(app: AppHandle, stream: tokio::net::TcpStream, token: String) {
    // OpenCode connects without a token when it found the port via CLAUDE_CODE_SSE_PORT; allow
    // that for processes of the same user (they could read the 0600 lock file anyway).
    let same_user = stream.peer_addr().ok().and_then(|a| peer_uid(a.port())).is_some_and(|u| Some(u) == my_uid());
    let check = |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        let h = req.headers();
        let given = h.get("x-claude-code-ide-authorization").and_then(|v| v.to_str().ok());
        let ok = given == Some(token.as_str()) || (given.is_none() && same_user);
        // Browsers always send Origin, the CLI doesn't → refuse cross-site WebSocket attempts.
        if !ok || h.contains_key("origin") {
            let mut e = ErrorResponse::new(Some("unauthorized".into()));
            *e.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(e);
        }
        if let Some(p) = h.get("sec-websocket-protocol").and_then(|v| v.to_str().ok()) {
            if p.split(',').any(|s| s.trim() == "mcp") {
                resp.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_static("mcp"));
            }
        }
        Ok(resp)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { return };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn = NEXT.fetch_add(1, Ordering::SeqCst);
    app.state::<IdeState>().inner.lock().unwrap().clients.insert(conn, (tx.clone(), String::new()));
    emit_clients(&app);

    // Writer task: outgoing messages + keepalive pings.
    let writer = tauri::async_runtime::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        ping.tick().await;
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                    None => break,
                },
                _ = ping.tick() => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break },
            }
        }
    });

    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let app = app.clone();
        let tx = tx.clone();
        // Each request runs on its own task: openDiff blocks until the user decides.
        tauri::async_runtime::spawn(async move {
            if let Some(out) = handle(&app, conn, &v).await {
                let _ = tx.send(out);
            }
        });
    }
    writer.abort();
    app.state::<IdeState>().inner.lock().unwrap().clients.remove(&conn);
    emit_clients(&app);
}

/// Names of the connected agents (clientInfo.name from initialize, e.g. "claude-code", "opencode").
fn client_names(app: &AppHandle) -> Vec<String> {
    app.state::<IdeState>().inner.lock().unwrap().clients.values().map(|(_, n)| n.clone()).collect()
}

fn emit_clients(app: &AppHandle) {
    let _ = app.emit("ide-clients", client_names(app));
}


async fn handle(app: &AppHandle, conn: u64, msg: &Value) -> Option<String> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let Some(id) = msg.get("id").cloned() else {
        if method == "ide_connected" || method == "notifications/initialized" {
            let _ = app.emit("ide-connected", conn);
        }
        return None;
    };
    Some(match method {
        "initialize" => {
            let name = msg.pointer("/params/clientInfo/name").and_then(Value::as_str).unwrap_or("unbekannt").to_string();
            if let Some(c) = app.state::<IdeState>().inner.lock().unwrap().clients.get_mut(&conn) {
                c.1 = name;
            }
            emit_clients(app);
            result(&id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "logging": {}, "prompts": { "listChanged": true }, "tools": { "listChanged": true } },
            "serverInfo": { "name": "omega", "version": env!("CARGO_PKG_VERSION") },
        }))
        }
        "ping" => result(&id, json!({})),
        "prompts/list" => result(&id, json!({ "prompts": [] })),
        "resources/list" => result(&id, json!({ "resources": [] })),
        "tools/list" => {
            let tools = app.state::<IdeState>().inner.lock().unwrap().tools.clone();
            result(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let call = NEXT.fetch_add(1, Ordering::SeqCst);
            let (otx, orx) = oneshot::channel();
            app.state::<IdeState>().inner.lock().unwrap().pending.insert(call, otx);
            let _ = app.emit("ide-call", json!({ "call": call, "conn": conn, "name": name, "args": args }));
            match orx.await {
                Ok(r) if r.get("__error").is_some() => error(&id, -32000, r["__error"].as_str().unwrap_or("Fehler")),
                Ok(r) => result(&id, r),
                Err(_) => error(&id, -32000, "abgebrochen"),
            }
        }
        _ => error(&id, -32601, "Method not found"),
    })
}

#[tauri::command]
pub fn ide_reply(app: AppHandle, call: u64, result: Value) {
    if let Some(tx) = app.state::<IdeState>().inner.lock().unwrap().pending.remove(&call) {
        let _ = tx.send(result);
    }
}

/// Sends a notification (selection_changed, at_mentioned …) to all connected Claude sessions.
#[tauri::command]
pub fn ide_notify(app: AppHandle, method: String, params: Value) {
    let text = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
    for (tx, _) in app.state::<IdeState>().inner.lock().unwrap().clients.values() {
        let _ = tx.send(text.clone());
    }
}

#[tauri::command]
pub fn ide_info(app: AppHandle) -> Value {
    json!({ "port": PORT.load(Ordering::SeqCst), "clients": client_names(&app) })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn result_shape() {
        let v = parse(&result(&json!(7), json!({ "ok": true })));
        assert_eq!(v, json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": true } }));
        let v = parse(&result(&json!("abc"), json!(null)));
        assert_eq!(v["id"], "abc");
        assert!(v.as_object().unwrap().contains_key("result"));
        assert!(v.get("error").is_none());
    }

    #[test]
    fn error_shape() {
        let v = parse(&error(&json!(1), -32601, "Method not found"));
        assert_eq!(v, json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } }));
        assert!(v.get("result").is_none());
    }

    #[test]
    fn write_lock_contents_and_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ide");
        let folders = vec!["/a".to_string(), "/b c".to_string()];
        let p = write_lock_in(&dir, 4242, "tok", &folders).unwrap();
        assert_eq!(p, dir.join("4242.lock"));
        assert!(!dir.join(".4242.lock.tmp").exists());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["pid"], std::process::id());
        assert_eq!(v["workspaceFolders"], json!(["/a", "/b c"]));
        assert_eq!(v["ideName"], "Omega");
        assert_eq!(v["transport"], "ws");
        assert_eq!(v["authToken"], "tok");
    }

    #[cfg(unix)]
    #[test]
    fn write_lock_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ide");
        let p = write_lock_in(&dir, 1, "t", &[]).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&p), 0o600);
    }

    #[test]
    fn remove_stale_locks_only_removes_dead_omega_locks() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        let w = |name: &str, v: Value| std::fs::write(d.join(name), v.to_string()).unwrap();
        let dead = 999_999_999u32; // above any pid_max
        w("1.lock", json!({ "pid": dead, "ideName": "Omega" }));
        w("2.lock", json!({ "pid": std::process::id(), "ideName": "Omega" }));
        w("3.lock", json!({ "pid": dead, "ideName": "Visual Studio Code" }));
        w("4.lock", json!({ "ideName": "Omega" })); // no pid → treated as dead
        w("5.json", json!({ "pid": dead, "ideName": "Omega" })); // not a .lock file
        std::fs::write(d.join("6.lock"), "garbage").unwrap(); // unparsable → no ideName → kept
        remove_stale_locks_in(d);
        assert!(!d.join("1.lock").exists());
        assert!(d.join("2.lock").exists());
        assert!(d.join("3.lock").exists());
        assert!(!d.join("4.lock").exists());
        assert!(d.join("5.json").exists());
        assert!(d.join("6.lock").exists());
    }

    #[test]
    fn remove_stale_locks_missing_dir_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        remove_stale_locks_in(&tmp.path().join("nope"));
    }
}
