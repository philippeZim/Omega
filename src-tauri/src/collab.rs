//! Peer-to-peer transport for "Zusammen coden" (Code With Me–style sessions).
//!
//! Uses iroh: direct QUIC connections with NAT hole punching, falling back to the public n0
//! relays over HTTPS/443 when that fails (e.g. eduroam). Everything is end-to-end encrypted;
//! relays only forward ciphertext. No server of our own.
//!
//! The backend is a dumb pipe: each peer gets one bidirectional stream carrying length-prefixed
//! JSON messages. All session logic (join requests, document sync, cursors) lives in the frontend.
use base64::Engine;
use iroh::endpoint::{presets, Connection, SendStream};
use iroh::{Endpoint, EndpointAddr};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

const ALPN: &[u8] = b"omega/collab/1";
const MAX_MSG: usize = 32 * 1024 * 1024;

struct Peer {
    conn: Connection,
    send: Mutex<SendStream>,
}

#[derive(Default)]
pub struct CollabState {
    endpoint: Mutex<Option<Endpoint>>,
    peers: Mutex<HashMap<String, Arc<Peer>>>,
    hosting: Mutex<bool>,
}

#[derive(Serialize, Clone)]
struct PeerEvent {
    peer: String,
}
#[derive(Serialize, Clone)]
struct MsgEvent {
    peer: String,
    msg: String,
}
#[derive(Serialize, Clone)]
struct ClosedEvent {
    peer: String,
    reason: String,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

async fn endpoint(app: &AppHandle) -> Result<Endpoint, String> {
    let state = app.state::<CollabState>();
    let mut guard = state.endpoint.lock().await;
    if let Some(ep) = guard.as_ref() {
        return Ok(ep.clone());
    }
    let mut builder = Endpoint::builder(presets::N0).alpns(vec![ALPN.to_vec()]);
    // Diagnostics: OMEGA_COLLAB_RELAY_ONLY=1 disables direct connections (simulates networks
    // like eduroam that block peer-to-peer traffic).
    if std::env::var("OMEGA_COLLAB_RELAY_ONLY").is_ok_and(|v| v == "1") {
        builder = builder.clear_ip_transports();
    }
    let ep = builder.bind().await.map_err(err)?;
    *guard = Some(ep.clone());
    Ok(ep)
}

/// Registers a peer and pumps its incoming messages into `collab-msg` events.
async fn register(app: AppHandle, peer_id: String, conn: Connection, send: SendStream, mut recv: iroh::endpoint::RecvStream) {
    let peer = Arc::new(Peer { conn: conn.clone(), send: Mutex::new(send) });
    app.state::<CollabState>().peers.lock().await.insert(peer_id.clone(), peer);
    let _ = app.emit("collab-connected", PeerEvent { peer: peer_id.clone() });

    let reason = loop {
        let mut len = [0u8; 4];
        if let Err(e) = recv.read_exact(&mut len).await {
            break e.to_string();
        }
        let n = u32::from_be_bytes(len) as usize;
        if n > MAX_MSG {
            break "collab:too_large".into();
        }
        let mut buf = vec![0u8; n];
        if let Err(e) = recv.read_exact(&mut buf).await {
            break e.to_string();
        }
        let _ = app.emit("collab-msg", MsgEvent { peer: peer_id.clone(), msg: String::from_utf8_lossy(&buf).into() });
    };
    app.state::<CollabState>().peers.lock().await.remove(&peer_id);
    conn.close(0u32.into(), b"bye");
    let _ = app.emit("collab-closed", ClosedEvent { peer: peer_id, reason });
}

fn short_id(conn: &Connection) -> String {
    conn.remote_id().to_string().chars().take(10).collect()
}

/// Starts hosting; returns the invite code (base64 of the endpoint address incl. relay URL).
#[tauri::command]
pub async fn collab_host(app: AppHandle) -> Result<String, String> {
    let ep = endpoint(&app).await?;
    // Wait (briefly) until we're reachable via a relay so the invite contains its URL.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), ep.online()).await;
    let addr = ep.addr();
    let json = serde_json::to_vec(&addr).map_err(err)?;
    let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);

    let state = app.state::<CollabState>();
    let mut hosting = state.hosting.lock().await;
    if !*hosting {
        *hosting = true;
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(incoming) = ep.accept().await {
                let app3 = app2.clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(conn) = incoming.await else { return };
                    let Ok((send, recv)) = conn.accept_bi().await else { return };
                    let id = short_id(&conn);
                    register(app3, id, conn, send, recv).await;
                });
            }
        });
    }
    Ok(format!("omega-{ticket}"))
}

/// Decodes an invite code. Errors are codes "collab:<code>[:<detail>]" that the frontend
/// translates (src/lib/collab/collabError.ts).
fn parse_ticket(ticket: &str) -> Result<EndpointAddr, String> {
    let raw = ticket.trim().trim_start_matches("omega-");
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw).map_err(|_| "collab:invalid_ticket".to_string())?;
    serde_json::from_slice(&json).map_err(|_| "collab:invalid_ticket".to_string())
}

/// Joins a session; returns the peer id of the host.
#[tauri::command]
pub async fn collab_join(app: AppHandle, ticket: String) -> Result<String, String> {
    let addr = parse_ticket(&ticket)?;
    let ep = endpoint(&app).await?;
    let conn = tokio::time::timeout(std::time::Duration::from_secs(25), ep.connect(addr, ALPN))
        .await
        .map_err(|_| "collab:timeout".to_string())?
        .map_err(|e| format!("collab:connect_failed:{e}"))?;
    let (send, recv) = conn.open_bi().await.map_err(err)?;
    let id = short_id(&conn);
    let app2 = app.clone();
    let id2 = id.clone();
    tauri::async_runtime::spawn(async move { register(app2, id2, conn, send, recv).await });
    // Give register() a moment to insert the peer before the frontend sends its first message.
    for _ in 0..50 {
        if app.state::<CollabState>().peers.lock().await.contains_key(&id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Ok(id)
}

#[tauri::command]
pub async fn collab_send(app: AppHandle, peer: String, msg: String) -> Result<(), String> {
    let p = app.state::<CollabState>().peers.lock().await.get(&peer).cloned().ok_or("collab:not_connected")?;
    let bytes = msg.into_bytes();
    let mut send = p.send.lock().await;
    send.write_all(&(bytes.len() as u32).to_be_bytes()).await.map_err(err)?;
    send.write_all(&bytes).await.map_err(err)
}

/// Disconnects one peer.
#[tauri::command]
pub async fn collab_kick(app: AppHandle, peer: String) {
    if let Some(p) = app.state::<CollabState>().peers.lock().await.remove(&peer) {
        p.conn.close(1u32.into(), b"removed");
    }
}

/// Ends the session: closes all connections and the endpoint.
#[tauri::command]
pub async fn collab_stop(app: AppHandle) {
    let state = app.state::<CollabState>();
    for (_, p) in state.peers.lock().await.drain() {
        p.conn.close(0u32.into(), b"session ended");
    }
    *state.hosting.lock().await = false;
    if let Some(ep) = state.endpoint.lock().await.take() {
        ep.close().await;
    }
}

/// Whether `path` stays inside `root` once symlinks are resolved (#138: a guest's request for
/// "ext/etc/passwd" with `ext -> /` in the shared folder). A path that doesn't exist yet is judged
/// by its nearest existing folder; a dangling symlink is refused (writing would follow it).
fn path_inside(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else { return false };
    if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) && path.canonicalize().is_err() {
        return false;
    }
    let mut p = Some(path);
    while let Some(c) = p {
        if let Ok(real) = c.canonicalize() {
            return real.starts_with(&root);
        }
        p = c.parent();
    }
    false
}

/// Host: checks a path a guest asked for against the shared folder (see `path_inside`).
#[tauri::command]
pub fn collab_path_inside(root: String, path: String) -> bool {
    path_inside(Path::new(&root), Path::new(&path))
}

#[derive(Serialize)]
pub struct ConnInfo {
    /// Address of the selected path ("192.168.1.5:1234" or the relay URL), for diagnostics.
    addr: String,
    direct: bool,
    rtt_ms: u64,
}

/// Whether the selected path to a peer is direct or via relay (+ round-trip time).
#[tauri::command]
pub async fn collab_conn_info(app: AppHandle, peer: String) -> Option<ConnInfo> {
    let p = app.state::<CollabState>().peers.lock().await.get(&peer).cloned()?;
    let paths = p.conn.paths();
    let sel = paths.iter().find(|x| x.is_selected())?;
    let addr = match sel.remote_addr() {
        iroh::TransportAddr::Ip(a) => a.to_string(),
        iroh::TransportAddr::Relay(u) => u.to_string(),
        other => format!("{other:?}"),
    };
    Some(ConnInfo { addr, direct: sel.is_ip(), rtt_ms: sel.rtt().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn guest_paths_through_symlinks_stay_inside_the_shared_folder() {
        let tmp = std::env::temp_dir().join(format!("omega-collab-inside-{}", std::process::id()));
        let root = tmp.join("proj");
        let outside = tmp.join("secret");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("src/a.rs"), "a").unwrap();
        std::fs::write(outside.join("key"), "k").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("ext")).unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("inner")).unwrap();
        std::os::unix::fs::symlink(outside.join("missing"), root.join("dangling")).unwrap();

        assert!(path_inside(&root, &root));
        assert!(path_inside(&root, &root.join("src/a.rs")));
        assert!(path_inside(&root, &root.join("src/new.rs")));
        assert!(path_inside(&root, &root.join("inner/a.rs")));
        assert!(!path_inside(&root, &root.join("ext")));
        assert!(!path_inside(&root, &root.join("ext/key")));
        assert!(!path_inside(&root, &root.join("ext/new.txt")));
        assert!(!path_inside(&root, &root.join("dangling")));
        assert!(!path_inside(&root, &root.join("../secret/key")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bad_invite_codes_give_a_code_not_german_text() {
        // #132: the frontend translates the code; it used to be "Ungültiger Einladungscode".
        assert_eq!(parse_ticket("hello world").unwrap_err(), "collab:invalid_ticket");
        assert_eq!(parse_ticket("omega-aGVsbG8").unwrap_err(), "collab:invalid_ticket");
    }

    async fn roundtrip(relay_only: bool) -> (bool, std::time::Duration) {
        roundtrip_mode(if relay_only { 1 } else { 0 }).await
    }

    /// mode 0 = full ticket, 1 = relay only (eduroam), 2 = local IPs only (same Wi-Fi/hotspot, no internet path)
    async fn roundtrip_mode(mode: u8) -> (bool, std::time::Duration) {
        let relay_only = mode == 1;
        let host = Endpoint::builder(presets::N0).alpns(vec![ALPN.to_vec()]).bind().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), host.online()).await.expect("host online (relay reachable?)");
        let mut addr = host.addr();
        if relay_only {
            // Simulate eduroam: strip direct IP addresses, only the relay URL remains.
            addr.addrs.retain(|a| a.is_relay());
        }
        if mode == 2 {
            // Same network without relay: only local IP addresses in the ticket.
            addr.addrs.retain(|a| a.is_ip());
        }
        let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&addr).unwrap());
        let addr: EndpointAddr = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(ticket).unwrap()).unwrap();

        let server = tokio::spawn(async move {
            let conn = host.accept().await.unwrap().await.unwrap();
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let mut buf = [0u8; 5];
            recv.read_exact(&mut buf).await.unwrap();
            send.write_all(b"pong!").await.unwrap();
            send.finish().unwrap();
            conn.closed().await;
        });

        let guest_builder = Endpoint::builder(presets::N0);
        let guest = guest_builder.bind().await.unwrap();
        let t = std::time::Instant::now();
        let conn = guest.connect(addr, ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        send.write_all(b"ping!").await.unwrap();
        let mut buf = [0u8; 5];
        recv.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"pong!");
        let rtt = t.elapsed();
        let direct = conn.paths().iter().find(|p| p.is_selected()).map(|p| p.is_ip()).unwrap_or(false);
        conn.close(0u32.into(), b"done");
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), server).await;
        (direct, rtt)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connects_direct_or_relay() {
        let (direct, t) = roundtrip(false).await;
        println!("normal: direct={direct} first roundtrip={t:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connects_lan_only() {
        let (direct, t) = roundtrip_mode(2).await;
        println!("lan-only ticket: direct={direct} first roundtrip={t:?}");
        assert!(direct);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connects_via_relay_only() {
        let (direct, t) = roundtrip(true).await;
        println!("relay-only ticket: direct={direct} first roundtrip={t:?}");
    }
}
