//! "Steuerungs-MCP": an MCP server (Streamable HTTP, JSON responses) on 127.0.0.1 that lets AI
//! agents operate the app. Off by default (Einstellungen → KI), bearer-token protected.
//!
//! Rust only speaks the protocol; every tool call is forwarded to the frontend (`mcp-call`
//! event), which executes it against the live app state and answers via `mcp_reply`.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct McpControlState {
    /// (port, server) – kept for the app's lifetime; disabling only rejects requests, because
    /// tiny_http doesn't reliably release the port on unblock().
    server: Mutex<Option<(u16, Arc<tiny_http::Server>)>>,
    enabled: std::sync::atomic::AtomicBool,
    token: Mutex<String>,
    tools: Mutex<Value>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
}

static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
/// Token of the running control server; exported as OMEGA_MCP_TOKEN in our terminals.
pub static TOKEN: Mutex<Option<String>> = Mutex::new(None);

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn rpc_error(id: &Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

/// Handles one JSON-RPC message; `None` for notifications.
fn handle(app: &AppHandle, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?; // notifications have no id → no response
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let state = app.state::<McpControlState>();
    Some(match method {
        "initialize" => {
            let version = msg.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18");
            rpc_result(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "omega", "title": "Omega IDE", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Steuert die laufende Omega-IDE. Mit get_state den Zustand lesen, mit list_commands verfügbare Befehle sehen, mit click/type_text/press_key die Oberfläche bedienen und mit screenshot das Ergebnis prüfen."
            }))
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => rpc_result(&id, json!({ "tools": state.tools.lock().unwrap().clone() })),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let call = NEXT_CALL.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = channel();
            state.pending.lock().unwrap().insert(call, tx);
            let _ = app.emit("mcp-call", json!({ "call": call, "name": name, "args": args }));
            match rx.recv_timeout(Duration::from_secs(120)) {
                Ok(result) => rpc_result(&id, result),
                Err(_) => {
                    state.pending.lock().unwrap().remove(&call);
                    rpc_result(&id, json!({ "content": [{ "type": "text", "text": "Timeout: the app did not answer" }], "isError": true }))
                }
            }
        }
        _ => rpc_error(&id, -32601, "Method not found"),
    })
}

fn respond(req: tiny_http::Request, status: u16, body: Option<Value>, extra: &[(&str, String)]) {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let mut resp = tiny_http::Response::from_string(text).with_status_code(status);
    let mut headers = vec![("Content-Type", "application/json".to_string())];
    headers.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
    for (k, v) in headers {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            resp.add_header(h);
        }
    }
    let _ = req.respond(resp);
}

/// Starts the server on 127.0.0.1:`port` (0 = any free port) and returns the port it listens on.
/// `tools` = MCP tool definitions (from the frontend).
#[tauri::command]
pub async fn mcp_control_start(app: AppHandle, port: u16, token: String, tools: Value) -> Result<u16, String> {
    let state = app.state::<McpControlState>();
    *state.tools.lock().unwrap() = tools;
    *state.token.lock().unwrap() = token.clone();
    *TOKEN.lock().unwrap() = Some(token.clone());
    let running_port = state.server.lock().unwrap().as_ref().map(|(p, _)| *p);
    if let Some(running) = running_port.filter(|&p| p == port || port == 0) {
        state.enabled.store(true, Ordering::SeqCst);
        crate::instance::announce(running, &token);
        return Ok(running);
    }
    if let Some((_, old)) = state.server.lock().unwrap().take() {
        old.unblock();
    }
    // The previous server (page reload / port change) may need a moment to release the port.
    let mut last_err = String::new();
    let mut server = None;
    for _ in 0..30 {
        match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => {
                server = Some(Arc::new(s));
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    let server = server.ok_or_else(|| format!("Port {port}: {last_err}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    *state.server.lock().unwrap() = Some((port, server.clone()));
    state.enabled.store(true, Ordering::SeqCst);
    crate::instance::announce(port, &token);

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || {
                let st = app.state::<McpControlState>();
                if !st.enabled.load(Ordering::SeqCst) {
                    return respond(req, 503, Some(json!({ "error": "The control MCP is turned off" })), &[]);
                }
                let token = st.token.lock().unwrap().clone();
                let authorized = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}"));
                // Reject browser requests from other origins (DNS-rebinding / CSRF protection).
                let foreign_origin = req.headers().iter().any(|h| {
                    h.field.equiv("Origin") && !h.value.as_str().starts_with("http://127.0.0.1") && !h.value.as_str().starts_with("http://localhost")
                });
                if !authorized || foreign_origin {
                    return respond(req, 401, Some(json!({ "error": "unauthorized" })), &[]);
                }
                if req.url() != "/mcp" {
                    return respond(req, 404, None, &[]);
                }
                match req.method() {
                    tiny_http::Method::Post => {}
                    tiny_http::Method::Delete => return respond(req, 200, None, &[]),
                    _ => return respond(req, 405, None, &[("Allow", "POST".into())]),
                }
                let mut body = String::new();
                if req.as_reader().read_to_string(&mut body).is_err() {
                    return respond(req, 400, None, &[]);
                }
                let Ok(msg) = serde_json::from_str::<Value>(&body) else {
                    return respond(req, 400, Some(rpc_error(&Value::Null, -32700, "Parse error")), &[]);
                };
                let session = ("Mcp-Session-Id", "omega".to_string());
                if let Some(batch) = msg.as_array() {
                    let out: Vec<Value> = batch.iter().filter_map(|m| handle(&app, m)).collect();
                    if out.is_empty() { respond(req, 202, None, &[session]) } else { respond(req, 200, Some(Value::Array(out)), &[session]) }
                } else {
                    match handle(&app, &msg) {
                        Some(r) => respond(req, 200, Some(r), &[session]),
                        None => respond(req, 202, None, &[session]),
                    }
                }
            });
        }
    });
    Ok(port)
}

#[tauri::command]
pub fn mcp_control_stop(app: AppHandle) {
    crate::instance::withdraw();
    *TOKEN.lock().unwrap() = None;
    app.state::<McpControlState>().enabled.store(false, Ordering::SeqCst);
}

/// Frontend answer to an `mcp-call` event.
#[tauri::command]
pub fn mcp_reply(app: AppHandle, call: u64, result: Value) {
    if let Some(tx) = app.state::<McpControlState>().pending.lock().unwrap().remove(&call) {
        let _ = tx.send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_result_shape() {
        assert_eq!(rpc_result(&json!(3), json!({ "tools": [] })), json!({ "jsonrpc": "2.0", "id": 3, "result": { "tools": [] } }));
        let v = rpc_result(&json!("x"), json!(null));
        assert_eq!(v["id"], "x");
        assert!(v.as_object().unwrap().contains_key("result"));
        assert!(v.get("error").is_none());
    }

    #[test]
    fn rpc_error_shape() {
        assert_eq!(
            rpc_error(&json!(null), -32700, "Parse error"),
            json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })
        );
        assert!(rpc_error(&json!(1), -1, "m").get("result").is_none());
    }
}
