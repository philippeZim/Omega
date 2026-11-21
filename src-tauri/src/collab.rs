//! Peer-to-peer transport for "Zusammen coden" (Code With Me–style sessions).
//!
//! Uses iroh: direct QUIC connections with NAT hole punching, falling back to the public n0
//! relays over HTTPS/443 when that fails (e.g. eduroam). Everything is end-to-end encrypted;
//! relays only forward ciphertext. No server of our own.
//!
//! The backend is a dumb pipe: each peer gets one bidirectional stream carrying length-prefixed
//! JSON messages. All session logic (join requests, document sync, cursors) lives in the frontend.
use base64::Engine;
use iroh::endpoint::{presets, ConnectError, ConnectingError, Connection, ConnectionError, Incoming, RecvStream, SendStream, TransportErrorCode};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

const ALPN: &[u8] = b"omega/collab/1";
const MAX_MSG: usize = 32 * 1024 * 1024;

// Limits for connections the host has not approved. Approved guests are outside all of them.
/// QUIC handshake. Generous for a slow relay path; the guest itself gives up after 25 s.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// From the finished handshake to the guest's stream.
const FIRST_STREAM_TIMEOUT: Duration = Duration::from_secs(10);
/// From the stream to the join message, which a real guest sends right away.
const JOIN_MSG_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request may wait for the host, so abandoned ones can't hold a slot for good.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Connections between arrival and join message. Each lasts seconds, so this is plenty.
const MAX_HANDSHAKES: usize = 32;
/// Requests waiting for the host's decision (also the most the panel can usefully show).
const MAX_PENDING: usize = 16;
/// Largest message before approval. A join message is a 40-character name and a version.
const MAX_JOIN_MSG: usize = 4 * 1024;
/// Messages a connection may send before its join message (a presence update can overtake it).
const MAX_FRAMES_BEFORE_HELLO: usize = 8;
/// New connections at once: a whole large session reconnecting after a network drop fits.
///
/// Accepted limit: the rate is global, so during a sustained flood a new or returning guest can be
/// refused too (and told to retry). Exempting recently approved ids wouldn't help, because guests
/// get a new key per join. Guests already connected are never affected.
const JOIN_RATE_BURST: f64 = 32.0;
/// New connections per second, sustained.
const JOIN_RATE_PER_SEC: f64 = 4.0;
/// Refusals are summed up and reported to the host at most once per window.
const REFUSAL_NOTICE_WINDOW: Duration = Duration::from_secs(3);

const CLOSE_ALREADY_CONNECTED: u32 = 2;
const CLOSE_BUSY: u32 = 3;
const CLOSE_EXPIRED: u32 = 4;

/// What the host may send a peer it has not approved. "welcome" is the approval.
const SENDABLE_BEFORE_APPROVAL: [&str; 4] = ["welcome", "denied", "version", "busy"];

struct Peer {
    conn: Connection,
    send: Mutex<SendStream>,
    admission: Admission,
}

impl Peer {
    /// Not approved (waiting, or expired and about to be closed).
    fn is_pending(&self) -> bool {
        !self.admission.is_approved()
    }

    fn approve(&self) -> bool {
        self.admission.approve()
    }
}

enum AdmissionState {
    /// Waiting for the host, holding a request slot.
    Pending(#[allow(dead_code)] OwnedSemaphorePermit),
    Approved,
    Expired,
}

/// Where a peer stands. Approval and expiry are one decision under one lock: whichever comes first
/// wins, so a "welcome" at the deadline either approves the guest or is refused, never both.
struct Admission(std::sync::Mutex<AdmissionState>);

impl Admission {
    fn new(slot: Option<OwnedSemaphorePermit>) -> Self {
        Self(std::sync::Mutex::new(slot.map_or(AdmissionState::Approved, AdmissionState::Pending)))
    }

    fn is_approved(&self) -> bool {
        matches!(*self.0.lock().unwrap(), AdmissionState::Approved)
    }

    /// Approves a waiting peer and frees its slot; false if it has already expired.
    fn approve(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if matches!(*state, AdmissionState::Expired) {
            return false;
        }
        *state = AdmissionState::Approved;
        true
    }

    /// Expires a waiting peer and frees its slot; false if it was approved in time.
    fn expire(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if !matches!(*state, AdmissionState::Pending(_)) {
            return false;
        }
        *state = AdmissionState::Expired;
        true
    }
}

type SharedPeers = Arc<Mutex<PeerTable<Arc<Peer>>>>;

#[derive(Default)]
pub struct CollabState {
    endpoint: Mutex<Option<Endpoint>>,
    peers: SharedPeers,
    hosting: Mutex<bool>,
    /// The limits of the running hosting session.
    limits: Mutex<Option<Arc<JoinLimits>>>,
    /// The window that started the session. There is at most one session in the app.
    owner: std::sync::Mutex<Option<String>>,
}

/// Refills continuously up to `burst`; each connection takes one token.
struct TokenBucket {
    tokens: f64,
    burst: f64,
    per_sec: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(burst: f64, per_sec: f64, now: Instant) -> Self {
        Self { tokens: burst, burst, per_sec, last: now }
    }

    fn take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.burst);
        self.last = now;
        let ok = self.tokens >= 1.0;
        if ok {
            self.tokens -= 1.0;
        }
        ok
    }
}

/// The host's limits on unapproved connections, for one hosting session.
struct JoinLimits {
    rate: std::sync::Mutex<TokenBucket>,
    handshakes: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    refused: AtomicU64,
    notice_armed: AtomicBool,
    /// Set when this hosting session stops. A lock, so a notice is either out before that or never.
    ended: std::sync::Mutex<bool>,
}

impl JoinLimits {
    fn new() -> Self {
        Self {
            rate: std::sync::Mutex::new(TokenBucket::new(JOIN_RATE_BURST, JOIN_RATE_PER_SEC, Instant::now())),
            handshakes: Arc::new(Semaphore::new(MAX_HANDSHAKES)),
            pending: Arc::new(Semaphore::new(MAX_PENDING)),
            refused: AtomicU64::new(0),
            notice_armed: AtomicBool::new(false),
            ended: std::sync::Mutex::new(false),
        }
    }

    fn end(&self) {
        *self.ended.lock().unwrap() = true;
    }

    fn is_ended(&self) -> bool {
        *self.ended.lock().unwrap()
    }

    /// Reports the refusals since the last notice, unless there are none or the session is over.
    fn deliver_notice(&self, notify: impl Fn(u64)) {
        let ended = self.ended.lock().unwrap();
        let count = self.take_refused();
        if !*ended && count > 0 {
            notify(count);
        }
    }

    /// A slot for a new connection, or `None` if it has to be refused.
    fn screen(&self) -> Option<OwnedSemaphorePermit> {
        let slot = self.handshakes.clone().try_acquire_owned().ok()?;
        self.rate.lock().unwrap().take(Instant::now()).then_some(slot)
    }

    /// Counts a refusal; true for the one that has to schedule the next notice.
    fn note_refused(&self) -> bool {
        self.refused.fetch_add(1, Ordering::Relaxed);
        !self.notice_armed.swap(true, Ordering::AcqRel)
    }

    fn take_refused(&self) -> u64 {
        self.notice_armed.store(false, Ordering::Release);
        self.refused.swap(0, Ordering::Relaxed)
    }
}

/// Counts a refusal and reports the sum once the window is over: one task per window at most.
fn report_refusal<N: Fn(u64) + Send + Sync + 'static>(limits: &Arc<JoinLimits>, notify: &Arc<N>) {
    if limits.note_refused() {
        let (limits, notify) = (limits.clone(), notify.clone());
        tokio::spawn(async move {
            tokio::time::sleep(REFUSAL_NOTICE_WINDOW).await;
            limits.deliver_notice(|count| notify(count));
        });
    }
}

/// The connected peers. A peer *is* its full endpoint id, the key its connection authenticated. The
/// frontend and other guests only see a random per-connection handle, which says nothing about it.
struct PeerTable<P> {
    by_handle: HashMap<String, (String, P)>,
    handle_of: HashMap<String, String>,
}

impl<P> Default for PeerTable<P> {
    fn default() -> Self {
        Self { by_handle: HashMap::new(), handle_of: HashMap::new() }
    }
}

impl<P> PeerTable<P> {
    /// Registers a connection under `handle`. A second one for an id that is still connected is
    /// refused and the first keeps working; one whose connection is gone (`alive`) makes room.
    fn claim(&mut self, id: &str, handle: String, peer: P, alive: impl Fn(&P) -> bool) -> Result<(), ()> {
        if let Some(old) = self.handle_of.get(id).cloned() {
            if self.by_handle.get(&old).is_some_and(|(_, p)| alive(p)) {
                return Err(());
            }
            self.by_handle.remove(&old);
        }
        self.handle_of.insert(id.to_string(), handle.clone());
        self.by_handle.insert(handle, (id.to_string(), peer));
        Ok(())
    }

    fn get(&self, handle: &str) -> Option<&P> {
        self.by_handle.get(handle).map(|(_, p)| p)
    }

    /// Removes this connection only: a newer one of the same id stays.
    fn remove(&mut self, handle: &str) -> Option<P> {
        let (id, peer) = self.by_handle.remove(handle)?;
        if self.handle_of.get(&id).is_some_and(|h| h == handle) {
            self.handle_of.remove(&id);
        }
        Some(peer)
    }

    fn drain(&mut self) -> Vec<P> {
        self.handle_of.clear();
        self.by_handle.drain().map(|(_, (_, p))| p).collect()
    }
}

fn new_handle() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(err)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Adds an authenticated connection to the table and returns its handle. `pending` is the slot of a
/// request that still needs approval.
async fn admit(peers: &Mutex<PeerTable<Arc<Peer>>>, conn: &Connection, send: SendStream, pending: Option<OwnedSemaphorePermit>) -> Result<String, String> {
    let handle = new_handle()?;
    let id = conn.remote_id().to_string();
    let peer = Arc::new(Peer { conn: conn.clone(), send: Mutex::new(send), admission: Admission::new(pending) });
    let claimed = peers.lock().await.claim(&id, handle.clone(), peer, |p| p.conn.close_reason().is_none());
    claimed.map_err(|_| "collab:already_connected".to_string())?;
    Ok(handle)
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
#[derive(Serialize, Clone)]
struct RefusedEvent {
    count: u64,
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

async fn read_len(recv: &mut RecvStream) -> Result<usize, String> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(err)?;
    Ok(u32::from_be_bytes(len) as usize)
}

async fn read_body(recv: &mut RecvStream, n: usize, limit: usize) -> Result<Vec<u8>, String> {
    if n > limit {
        return Err("collab:too_large".into());
    }
    let mut buf = vec![0u8; n];
    recv.read_exact(&mut buf).await.map_err(err)?;
    Ok(buf)
}

async fn read_frame(recv: &mut RecvStream, limit: usize) -> Result<Vec<u8>, String> {
    let n = read_len(recv).await?;
    read_body(recv, n, limit).await
}

/// The next message to pass on. Until approval the size limit is small and messages are dropped
/// (`None`). Approval is checked once a message has arrived, not before waiting for it: "welcome"
/// lifts the limit before it is written, so whatever the guest sends in reply always passes.
async fn next_frame(recv: &mut RecvStream, peer: &Peer) -> Result<Option<Vec<u8>>, String> {
    let n = read_len(recv).await?;
    let pending = peer.is_pending();
    let buf = read_body(recv, n, if pending { MAX_JOIN_MSG } else { MAX_MSG }).await?;
    Ok((!pending).then_some(buf))
}

/// Whether `msg` may go to this peer. Unapproved peers only get the answers to their request, and
/// the host's "welcome" is what approves them.
fn allow_outgoing(peer: &Peer, msg: &str) -> Result<(), String> {
    if !peer.is_pending() {
        return Ok(());
    }
    let kind = msg_type(msg.as_bytes());
    if !kind.as_deref().is_some_and(|k| SENDABLE_BEFORE_APPROVAL.contains(&k)) {
        return Err("collab:not_approved".into());
    }
    if kind.as_deref() == Some("welcome") && !peer.approve() {
        return Err("collab:not_approved".into());
    }
    Ok(())
}

fn msg_type(msg: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Tagged {
        t: String,
    }
    serde_json::from_slice::<Tagged>(msg).ok().map(|m| m.t)
}

async fn read_hello(recv: &mut RecvStream) -> Result<Vec<u8>, String> {
    for _ in 0..MAX_FRAMES_BEFORE_HELLO {
        let buf = read_frame(recv, MAX_JOIN_MSG).await?;
        if msg_type(&buf).as_deref() == Some("hello") {
            return Ok(buf);
        }
    }
    Err("collab:no_hello".into())
}

/// A connection that passed the join stage and now waits for the host.
struct Joined {
    handle: String,
    peer: Arc<Peer>,
    recv: RecvStream,
    hello: Vec<u8>,
}

/// Takes a connection from arrival to a pending request. `slot` is held until then, so a peer that
/// stalls at any step only ever occupies one bounded slot, for a bounded time.
async fn receive_join<N: Fn(u64) + Send + Sync + 'static>(incoming: Incoming, slot: OwnedSemaphorePermit, limits: &Arc<JoinLimits>, peers: &SharedPeers, notify: &Arc<N>) -> Option<Joined> {
    let conn = timeout(HANDSHAKE_TIMEOUT, incoming).await.ok()?.ok()?;
    let Ok(Ok((send, mut recv))) = timeout(FIRST_STREAM_TIMEOUT, conn.accept_bi()).await else {
        conn.close(CLOSE_EXPIRED.into(), b"expired");
        return None;
    };
    let Ok(Ok(hello)) = timeout(JOIN_MSG_TIMEOUT, read_hello(&mut recv)).await else {
        conn.close(CLOSE_EXPIRED.into(), b"expired");
        return None;
    };
    let Ok(pending) = limits.pending.clone().try_acquire_owned() else {
        conn.close(CLOSE_BUSY.into(), b"busy");
        report_refusal(limits, notify);
        return None;
    };
    drop(slot);
    if limits.is_ended() {
        conn.close(0u32.into(), b"session ended");
        return None;
    }
    let Ok(handle) = admit(peers, &conn, send, Some(pending)).await else {
        conn.close(CLOSE_ALREADY_CONNECTED.into(), b"already connected");
        return None;
    };
    // `end_session` marks the end before it empties the table, so an entry it missed is caught here.
    if limits.is_ended() {
        peers.lock().await.remove(&handle);
        conn.close(0u32.into(), b"session ended");
        return None;
    }
    let peer = peers.lock().await.get(&handle).cloned()?;
    tokio::spawn(expire_pending(peer.clone(), PENDING_TTL));
    Some(Joined { handle, peer, recv, hello })
}

/// Closes a request the host hasn't decided on in time.
async fn expire_pending(peer: Arc<Peer>, ttl: Duration) {
    tokio::select! {
        _ = peer.conn.closed() => {}
        _ = tokio::time::sleep(ttl) => {
            if peer.admission.expire() {
                peer.conn.close(CLOSE_EXPIRED.into(), b"expired");
            }
        }
    }
}

/// Ends a hosting session: nothing still in flight can join it or report to the next one.
async fn end_session(limits: Option<Arc<JoinLimits>>, peers: &Mutex<PeerTable<Arc<Peer>>>) {
    if let Some(limits) = limits {
        limits.end();
    }
    for p in peers.lock().await.drain() {
        p.conn.close(0u32.into(), b"session ended");
    }
}

/// The host's accept loop. Connections over a limit are refused here, before any task or per-peer
/// state exists for them; connections already in the table are never touched.
async fn accept_joins<J, N>(ep: Endpoint, limits: Arc<JoinLimits>, peers: SharedPeers, on_join: J, notify: N)
where
    J: Fn(Joined) + Send + Sync + 'static,
    N: Fn(u64) + Send + Sync + 'static,
{
    let (on_join, notify) = (Arc::new(on_join), Arc::new(notify));
    while let Some(incoming) = ep.accept().await {
        let Some(slot) = limits.screen() else {
            incoming.refuse();
            report_refusal(&limits, &notify);
            continue;
        };
        let (limits, peers, on_join, notify) = (limits.clone(), peers.clone(), on_join.clone(), notify.clone());
        tokio::spawn(async move {
            if let Some(joined) = receive_join(incoming, slot, &limits, &peers, &notify).await {
                on_join(joined);
            }
        });
    }
}

/// The error code for a close the other side explained (shown to a refused guest).
fn close_code(conn: &Connection) -> Option<String> {
    let Some(ConnectionError::ApplicationClosed(c)) = conn.close_reason() else { return None };
    if c.error_code == CLOSE_BUSY.into() {
        Some("collab:busy".into())
    } else if c.error_code == CLOSE_EXPIRED.into() {
        Some("collab:expired".into())
    } else {
        None
    }
}

/// Whether a failed connect means the host refused it (its limits, see `accept_joins`).
fn connect_refused(e: &ConnectError) -> bool {
    let source = match e {
        ConnectError::Connection { source, .. } | ConnectError::Connecting { source: ConnectingError::ConnectionError { source, .. }, .. } => source,
        _ => return false,
    };
    matches!(source, ConnectionError::ConnectionClosed(c) if c.error_code == TransportErrorCode::CONNECTION_REFUSED)
}

/// Pumps an admitted peer's incoming messages into `collab-msg` events until it disconnects.
/// `first` is a message already read from the stream (the join message).
async fn pump(app: AppHandle, owner: String, peer_id: String, peer: Arc<Peer>, mut recv: RecvStream, first: Option<Vec<u8>>) {
    crate::windows::emit(&app, &owner, "collab-connected", PeerEvent { peer: peer_id.clone() });
    if let Some(buf) = first {
        crate::windows::emit(&app, &owner, "collab-msg", MsgEvent { peer: peer_id.clone(), msg: String::from_utf8_lossy(&buf).into() });
    }

    let reason = loop {
        match next_frame(&mut recv, &peer).await {
            Ok(Some(buf)) => {
                crate::windows::emit(&app, &owner, "collab-msg", MsgEvent { peer: peer_id.clone(), msg: String::from_utf8_lossy(&buf).into() });
            }
            Ok(None) => {}
            Err(e) => break close_code(&peer.conn).unwrap_or(e),
        }
    };
    app.state::<CollabState>().peers.lock().await.remove(&peer_id);
    peer.conn.close(0u32.into(), b"bye");
    crate::windows::emit(&app, &owner, "collab-closed", ClosedEvent { peer: peer_id, reason });
}

/// Marks `ep` as hosting and returns the limits for a new accept loop (None: it already runs). A
/// session stopped while `ep` was coming online must not be revived on its closed endpoint.
async fn claim_hosting(state: &CollabState, ep: &Endpoint) -> Result<Option<Arc<JoinLimits>>, String> {
    let mut hosting = state.hosting.lock().await;
    if !state.endpoint.lock().await.as_ref().is_some_and(|current| current.id() == ep.id()) {
        return Err("collab:not_connected".into());
    }
    if *hosting {
        return Ok(None);
    }
    *hosting = true;
    let limits = Arc::new(JoinLimits::new());
    *state.limits.lock().await = Some(limits.clone());
    Ok(Some(limits))
}

/// Starts hosting; returns the invite code (base64 of the endpoint address incl. relay URL).
#[tauri::command]
pub async fn collab_host(app: AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    let owner = window.label().to_string();
    let claimed = claim(&mut app.state::<CollabState>().owner.lock().unwrap(), &owner)?;
    let r = host(&app, &owner).await;
    if r.is_err() && claimed {
        release(&app, &owner);
    }
    r
}

/// Takes the session for `label`. True if it wasn't this window's already.
fn claim(slot: &mut Option<String>, label: &str) -> Result<bool, String> {
    match slot.as_deref() {
        Some(o) if o == label => Ok(false),
        Some(_) => Err("collab:other_window".into()),
        None => {
            *slot = Some(label.to_string());
            Ok(true)
        }
    }
}

fn release(app: &AppHandle, label: &str) {
    let state = app.state::<CollabState>();
    let mut owner = state.owner.lock().unwrap();
    if owner.as_deref() == Some(label) {
        *owner = None;
    }
}

fn is_owner(app: &AppHandle, label: &str) -> bool {
    app.state::<CollabState>().owner.lock().unwrap().as_deref() == Some(label)
}

/// Whether a request served for a guest may run: only the session's window, and only on the
/// project that window has open now, so a guest can never reach another window's project.
fn may_serve(owner: Option<&str>, label: &str, open_root: Option<&Path>, requested: Option<&Path>) -> bool {
    owner == Some(label) && requested.is_none_or(|r| open_root == Some(r))
}

/// Cancelling a guest's job: the session's window, or anyone once no session is left to protect.
fn may_cancel(owner: Option<&str>, label: &str) -> bool {
    owner.is_none_or(|o| o == label)
}

pub fn can_cancel(app: &AppHandle, window: &tauri::WebviewWindow) -> bool {
    may_cancel(app.state::<CollabState>().owner.lock().unwrap().as_deref(), window.label())
}

/// `may_serve` for a command. `root` is the project the request names; `None`: no project (an unsaved tab).
pub fn guard(app: &AppHandle, window: &tauri::WebviewWindow, root: Option<&str>) -> Result<(), String> {
    let owner = app.state::<CollabState>().owner.lock().unwrap().clone();
    let open = crate::fs::root_of(window.label());
    if may_serve(owner.as_deref(), window.label(), open.as_deref(), root.map(Path::new)) { Ok(()) } else { Err("collab:not_owner".into()) }
}

async fn host(app: &AppHandle, owner: &str) -> Result<String, String> {
    let ep = endpoint(app).await?;
    // Wait (briefly) until we're reachable via a relay so the invite contains its URL.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), ep.online()).await;
    let addr = ep.addr();
    let json = serde_json::to_vec(&addr).map_err(err)?;
    let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);

    let state = app.state::<CollabState>();
    if let Some(limits) = claim_hosting(&state, &ep).await? {
        let (app2, app3, owner2, owner3) = (app.clone(), app.clone(), owner.to_string(), owner.to_string());
        let peers = state.peers.clone();
        tauri::async_runtime::spawn(accept_joins(
            ep,
            limits,
            peers,
            move |j: Joined| {
                tauri::async_runtime::spawn(pump(app2.clone(), owner2.clone(), j.handle, j.peer, j.recv, Some(j.hello)));
            },
            move |count| {
                crate::windows::emit(&app3, &owner3, "collab-refused", RefusedEvent { count });
            },
        ));
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
pub async fn collab_join(app: AppHandle, window: tauri::WebviewWindow, ticket: String) -> Result<String, String> {
    let owner = window.label().to_string();
    let claimed = claim(&mut app.state::<CollabState>().owner.lock().unwrap(), &owner)?;
    let r = join(&app, &owner, &ticket).await;
    if r.is_err() && claimed {
        release(&app, &owner);
    }
    r
}

async fn join(app: &AppHandle, owner: &str, ticket: &str) -> Result<String, String> {
    let addr = parse_ticket(ticket)?;
    let ep = endpoint(app).await?;
    let conn = tokio::time::timeout(std::time::Duration::from_secs(25), ep.connect(addr, ALPN))
        .await
        .map_err(|_| "collab:timeout".to_string())?
        .map_err(|e| if connect_refused(&e) { "collab:busy".to_string() } else { format!("collab:connect_failed:{e}") })?;
    let (send, recv) = conn.open_bi().await.map_err(err)?;
    let state = app.state::<CollabState>();
    let handle = match admit(&state.peers, &conn, send, None).await {
        Ok(handle) => handle,
        Err(e) => {
            conn.close(CLOSE_ALREADY_CONNECTED.into(), b"already connected");
            return Err(e);
        }
    };
    let peer = state.peers.lock().await.get(&handle).cloned().ok_or("collab:not_connected")?;
    let (app2, handle2, owner2) = (app.clone(), handle.clone(), owner.to_string());
    tauri::async_runtime::spawn(async move { pump(app2, owner2, handle2, peer, recv, None).await });
    Ok(handle)
}

#[tauri::command]
pub async fn collab_send(app: AppHandle, window: tauri::WebviewWindow, peer: String, msg: String) -> Result<(), String> {
    if !is_owner(&app, window.label()) {
        return Err("collab:not_connected".into());
    }
    let p = app.state::<CollabState>().peers.lock().await.get(&peer).cloned().ok_or("collab:not_connected")?;
    allow_outgoing(&p, &msg)?;
    let bytes = msg.into_bytes();
    let mut send = p.send.lock().await;
    send.write_all(&(bytes.len() as u32).to_be_bytes()).await.map_err(err)?;
    send.write_all(&bytes).await.map_err(err)
}

/// Disconnects one peer.
#[tauri::command]
pub async fn collab_kick(app: AppHandle, window: tauri::WebviewWindow, peer: String) {
    if !is_owner(&app, window.label()) {
        return;
    }
    if let Some(p) = app.state::<CollabState>().peers.lock().await.remove(&peer) {
        p.conn.close(1u32.into(), b"removed");
    }
}

/// Ends the session: closes all connections and the endpoint.
#[tauri::command]
pub async fn collab_stop(app: AppHandle, window: tauri::WebviewWindow) {
    if is_owner(&app, window.label()) {
        stop_session(&app.state::<CollabState>()).await;
        release(&app, window.label());
    }
}

/// Closes every connection and the endpoint. The hosting lock is held until the session is gone,
/// so a `collab_host` in flight sees either the whole session or none of it.
async fn stop_session(state: &CollabState) {
    let mut hosting = state.hosting.lock().await;
    let ep = state.endpoint.lock().await.take();
    let limits = state.limits.lock().await.take();
    end_session(limits, &state.peers).await;
    *hosting = false;
    drop(hosting);
    if let Some(ep) = ep {
        ep.close().await;
    }
}

/// A window is (re)loading or closed. If it owns the session, the UI that controlled it is gone:
/// ends the session instead of leaving guests attached to a host nobody can control. Any other
/// window's load leaves the session alone.
pub fn frontend_loading(app: &AppHandle, label: &str) {
    if !is_owner(app, label) {
        return;
    }
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        stop_session(&app.state::<CollabState>()).await;
        release(&app, &label);
    });
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

/// Whether a file name means the git folder, also in the spellings Windows and macOS resolve to it:
/// any case, trailing dots/spaces, an NTFS stream (".git::$INDEX_ALLOCATION"), the 8.3 short name
/// and characters HFS+ ignores.
pub(crate) fn is_git_name(name: &str) -> bool {
    name.split('\\').any(|part| {
        let visible: String = part.chars().filter(|c| !matches!(*c, '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}')).collect();
        let base = visible.split(':').next().unwrap_or("").trim_end_matches(['.', ' ']).to_lowercase();
        base == ".git" || base == "git~1"
    })
}

fn has_git_part(path: &Path) -> bool {
    path.components().any(|c| is_git_name(&c.as_os_str().to_string_lossy()))
}

/// Whether a guest may use `path`: inside `root` and not in a git folder, neither as written nor
/// after resolving symlinks (`cfg -> .git/config`). Git config can run commands on the host.
pub(crate) fn guest_path_ok(root: &Path, path: &Path) -> bool {
    if !path_inside(root, path) || path.strip_prefix(root).is_ok_and(has_git_part) {
        return false;
    }
    let Ok(real_root) = root.canonicalize() else { return false };
    let mut p = Some(path);
    while let Some(c) = p {
        if let Ok(real) = c.canonicalize() {
            return real.strip_prefix(&real_root).is_ok_and(|rel| !has_git_part(rel));
        }
        p = c.parent();
    }
    false
}

/// Host: checks a path a guest asked for against the shared folder (see `guest_path_ok`).
#[tauri::command]
pub fn collab_path_inside(app: AppHandle, window: tauri::WebviewWindow, root: String, path: String) -> bool {
    guard(&app, &window, Some(&root)).is_ok() && guest_path_ok(Path::new(&root), Path::new(&path))
}

/// The most `collab_read_bounded` reads, whatever the caller asks for.
const MAX_BOUNDED_READ: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoundedRead {
    Text { text: String },
    TooLarge,
    Binary,
    Missing,
}

/// Reads a regular file of at most `max` bytes. The size is checked first and the read is bounded
/// too, because the file can grow in between.
fn read_bounded(path: &Path, max: u64) -> BoundedRead {
    use std::io::Read;
    let max = max.min(MAX_BOUNDED_READ);
    let Ok(meta) = std::fs::metadata(path) else { return BoundedRead::Missing };
    if !meta.is_file() {
        return BoundedRead::Binary;
    }
    if meta.len() > max {
        return BoundedRead::TooLarge;
    }
    let Ok(file) = std::fs::File::open(path) else { return BoundedRead::Missing };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return BoundedRead::Binary;
    }
    let mut bytes = Vec::new();
    if file.take(max + 1).read_to_end(&mut bytes).is_err() {
        return BoundedRead::Binary;
    }
    if bytes.len() as u64 > max {
        return BoundedRead::TooLarge;
    }
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => BoundedRead::Text { text },
        _ => BoundedRead::Binary,
    }
}

/// Host: a project file for a guest, with the same path check as every guest path.
#[tauri::command]
pub async fn collab_read_bounded(app: AppHandle, window: tauri::WebviewWindow, root: String, path: String, max: u64) -> Result<BoundedRead, String> {
    guard(&app, &window, Some(&root))?;
    tauri::async_runtime::spawn_blocking(move || {
        if !guest_path_ok(Path::new(&root), Path::new(&path)) {
            return BoundedRead::Missing;
        }
        read_bounded(Path::new(&path), max)
    })
    .await
    .map_err(|e| e.to_string())
}

/// A path with symlinks resolved as far as it exists; the missing rest is appended as written.
fn resolve_lenient(path: &Path) -> std::path::PathBuf {
    let mut rest = Vec::new();
    let mut cur = path;
    loop {
        if let Ok(mut real) = cur.canonicalize() {
            for part in rest.iter().rev() {
                match part {
                    std::path::Component::ParentDir => {
                        real.pop();
                    }
                    std::path::Component::CurDir => {}
                    other => real.push(other.as_os_str()),
                }
            }
            return real;
        }
        let (Some(last), Some(parent)) = (cur.components().next_back(), cur.parent()) else { return path.to_path_buf() };
        rest.push(last);
        cur = parent;
    }
}

/// Hook entries looked at for symlinks to scripts elsewhere.
const HOOK_SCAN_LIMIT: usize = 256;

/// What running a hook executes: the folder, husky's real scripts one level above its `_` folder,
/// and the targets of symlinked hooks (`.git/hooks/pre-commit -> ../../scripts/check`).
fn hook_roots(dir: &Path) -> Vec<std::path::PathBuf> {
    let real = resolve_lenient(dir);
    let mut roots = vec![real.clone()];
    if real.file_name().is_some_and(|n| n == "_") {
        if let Some(parent) = real.parent().filter(|p| p.file_name().is_some_and(|n| n == ".husky")) {
            roots.push(parent.to_path_buf());
        }
    }
    for folder in roots.clone() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten().take(HOOK_SCAN_LIMIT) {
            if let Ok(target) = std::fs::read_link(entry.path()) {
                roots.push(resolve_lenient(&folder.join(target)));
            }
        }
    }
    roots
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksCheck {
    /// False if the hooks can't be determined: treat everything as protected.
    ok: bool,
    in_project: bool,
    locked: Vec<bool>,
    structural: Vec<bool>,
}

fn hooks_check(root: &str, paths: &[String]) -> HooksCheck {
    let closed = || HooksCheck { ok: false, in_project: true, locked: vec![true; paths.len()], structural: vec![true; paths.len()] };
    let Ok(dir) = crate::git::hooks_dir(root) else { return closed() };
    let Ok(real_root) = Path::new(root).canonicalize() else { return closed() };
    let mut roots = Vec::new();
    if let Some(d) = dir {
        roots = hook_roots(&d);
        // A file the repository's config includes can set the hooks folder, or any command.
        let Ok(includes) = crate::git::config_include_files(root) else { return closed() };
        roots.extend(includes.iter().map(|f| resolve_lenient(f)));
    }
    let in_project = roots.iter().any(|r| r.strip_prefix(&real_root).is_ok_and(|rel| !has_git_part(rel)));
    let real: Vec<_> = paths.iter().map(|p| resolve_lenient(Path::new(p))).collect();
    let locked: Vec<bool> = real.iter().map(|p| roots.iter().any(|r| p.starts_with(r))).collect();
    let structural = real.iter().zip(&locked).map(|(p, l)| *l || roots.iter().any(|r| r.starts_with(p))).collect();
    HooksCheck { ok: true, in_project, locked, structural }
}

/// Host: which of these paths are the repository's effective hooks, by resolved path.
#[tauri::command]
pub async fn collab_hooks_check(app: AppHandle, window: tauri::WebviewWindow, root: String, paths: Vec<String>) -> Result<HooksCheck, String> {
    guard(&app, &window, Some(&root))?;
    tauri::async_runtime::spawn_blocking(move || hooks_check(&root, &paths)).await.map_err(|e| e.to_string())
}

/// Entries `tree_has_git` looks at before it gives up and answers "yes".
const GIT_SCAN_LIMIT: usize = 200_000;

/// Whether a folder holds a git folder at any depth, so deleting or moving it would change a nested
/// repository. Symlinks aren't followed; what can't be read or scanned counts as "yes".
fn tree_has_git(path: &Path, limit: usize) -> bool {
    let Ok(meta) = path.symlink_metadata() else { return false };
    if !meta.is_dir() {
        return false;
    }
    let mut stack = vec![path.to_path_buf()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { return true };
        for entry in entries {
            let Ok(entry) = entry else { return true };
            seen += 1;
            if seen > limit || is_git_name(&entry.file_name().to_string_lossy()) {
                return true;
            }
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(entry.path());
            }
        }
    }
    false
}

/// Host: whether a guest's delete or rename of `path` would touch a nested git folder.
#[tauri::command]
pub async fn collab_tree_has_git(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || tree_has_git(Path::new(&path), GIT_SCAN_LIMIT)).await.unwrap_or(true)
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
pub async fn collab_conn_info(app: AppHandle, window: tauri::WebviewWindow, peer: String) -> Option<ConnInfo> {
    if !is_owner(&app, window.label()) {
        return None;
    }
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

    #[test]
    fn another_window_cannot_cancel_a_guests_job() {
        assert!(may_cancel(Some("main"), "main"));
        assert!(!may_cancel(Some("main"), "w-b"));
        assert!(may_cancel(None, "w-b"));
    }

    #[test]
    fn one_session_belongs_to_one_window() {
        let mut slot = None;
        assert_eq!(claim(&mut slot, "main"), Ok(true));
        assert_eq!(claim(&mut slot, "main"), Ok(false));
        assert_eq!(claim(&mut slot, "w-b"), Err("collab:other_window".to_string()));
        assert_eq!(slot.as_deref(), Some("main"));
    }

    #[test]
    fn a_guest_request_only_reaches_the_owner_windows_open_project() {
        let (a, b) = (Path::new("/p/a"), Path::new("/p/b"));
        assert!(may_serve(Some("main"), "main", Some(a), Some(a)));
        assert!(may_serve(Some("main"), "main", Some(a), None));
        // Another window's project, from the owner.
        assert!(!may_serve(Some("main"), "main", Some(a), Some(b)));
        // Another window asking, also for its own project.
        assert!(!may_serve(Some("main"), "w-b", Some(b), Some(b)));
        assert!(!may_serve(None, "main", Some(a), Some(a)));
        assert!(!may_serve(Some("main"), "main", None, Some(a)));
    }

    /// Windows opens all of these as `later/hooks/pre-commit`, also while the folder doesn't exist.
    #[cfg(windows)]
    #[test]
    fn a_hooks_folder_is_found_in_every_windows_spelling() {
        let dir = std::env::temp_dir().join(format!("omega-hooks-spelling-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["config", "core.hooksPath", "later/hooks"]);
        let root = dir.to_str().unwrap();
        let spellings = ["LATER/hooks/pre-commit", "later/HOOKS/pre-commit", "later./hooks/pre-commit", "later /hooks/pre-commit", "later/hooks./pre-commit", "later/hooks::$INDEX_ALLOCATION/pre-commit"];
        let paths: Vec<String> = spellings.iter().map(|s| format!("{root}/{s}")).collect();
        assert_eq!(hooks_check(root, &paths).locked, [true; 6], "{spellings:?}");
        assert_eq!(hooks_check(root, &[format!("{root}/LATER")]).structural, [true]);
        assert_eq!(hooks_check(root, &[format!("{root}/other/pre-commit")]).locked, [false]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn hook_paths_are_found_by_resolved_path() {
        let dir = std::env::temp_dir().join(format!("omega-hooks-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("tools/hooks")).unwrap();
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let root = dir.to_str().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(&dir).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        let p = |r: &str| format!("{root}/{r}");
        assert!(!hooks_check(root, &[]).in_project, "the default hooks are in .git");
        git(&["config", "core.hooksPath", "tools/hooks"]);
        std::os::unix::fs::symlink("tools/hooks", dir.join("alias")).unwrap();
        std::fs::write(dir.join("scripts/check"), "x").unwrap();
        std::os::unix::fs::symlink("../../scripts/check", dir.join("tools/hooks/pre-commit")).unwrap();
        let c = hooks_check(root, &[p("tools/hooks/new"), p("alias/new"), p("scripts/check"), p("tools"), p("scripts/other")]);
        assert!(c.ok && c.in_project);
        assert_eq!(c.locked, [true, true, true, false, false]);
        assert_eq!(c.structural, [true, true, true, true, false]);
        // husky: git runs `.husky/_/x`, which runs the script one level up.
        git(&["config", "core.hooksPath", ".husky/_"]);
        assert_eq!(hooks_check(root, &[p(".husky/pre-commit")]).locked, [true]);
        // A folder that doesn't exist yet is protected too, and a broken config fails closed.
        git(&["config", "core.hooksPath", "later/hooks"]);
        assert_eq!(hooks_check(root, &[p("later/hooks/pre-commit")]).locked, [true]);
        std::fs::write(dir.join(".git/config"), "[broken").unwrap();
        let c = hooks_check(root, &[p("a.txt")]);
        assert!(!c.ok && c.in_project);
        assert_eq!(c.locked, [true]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn files_the_repo_config_includes_are_protected() {
        let dir = std::env::temp_dir().join(format!("omega-hooks-include-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("cfg")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let root = dir.to_str().unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").current_dir(&dir).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        let p = |r: &str| format!("{root}/{r}");
        assert!(!hooks_check(root, &[p("cfg/shared")]).locked[0]);
        std::fs::write(dir.join("cfg/shared"), "[include]\n\tpath = nested\n").unwrap();
        std::fs::write(dir.join("cfg/nested"), "").unwrap(); // empty: git lists no setting from it
        git(&["config", "--add", "include.path", "../cfg/shared"]);
        git(&["config", "--add", "includeIf.gitdir:/nowhere/.path", "../cfg/conditional"]);
        let c = hooks_check(root, &[p("cfg/shared"), p("cfg/nested"), p("cfg/conditional"), p("cfg"), p("cfg/other")]);
        assert!(c.ok && c.in_project);
        assert_eq!(c.locked, [true, true, true, false, false]);
        assert_eq!(c.structural, [true, true, true, true, false]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bounded_read_stops_at_the_limit() {
        let dir = std::env::temp_dir().join(format!("omega-bounded-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f");
        std::fs::write(&file, "12345").unwrap();
        assert_eq!(read_bounded(&file, 5), BoundedRead::Text { text: "12345".into() });
        assert_eq!(read_bounded(&file, 4), BoundedRead::TooLarge);
        std::fs::write(&file, b"a\0b").unwrap();
        assert_eq!(read_bounded(&file, 10), BoundedRead::Binary);
        std::fs::write(&file, [0xff, 0xfe]).unwrap();
        assert_eq!(read_bounded(&file, 10), BoundedRead::Binary);
        assert_eq!(read_bounded(&dir, 10), BoundedRead::Binary);
        assert_eq!(read_bounded(&dir.join("gone"), 10), BoundedRead::Missing);
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
    fn git_folder_spellings_are_recognized() {
        for name in [".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", ".git::$INDEX_ALLOCATION", ".git:x", "git~1", "GIT~1", ".g\u{200c}it", "a\\.git"] {
            assert!(is_git_name(name), "{name:?}");
        }
        for name in [".github", ".gitignore", ".gitattributes", "git", "x.git", ".gitlab-ci.yml", "git~2"] {
            assert!(!is_git_name(name), "{name:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn guests_cannot_reach_the_git_folder() {
        let tmp = std::env::temp_dir().join(format!("omega-collab-git-{}", std::process::id()));
        let root = tmp.join("proj");
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(root.join("sub/.git")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".git/config"), "").unwrap();
        std::fs::write(root.join("src/a.rs"), "a").unwrap();
        std::fs::write(root.join(".gitignore"), "").unwrap();
        std::os::unix::fs::symlink(root.join(".git"), root.join("gitlink")).unwrap();
        std::os::unix::fs::symlink(root.join(".git/config"), root.join("cfg")).unwrap();

        for bad in [".git", ".git/config", ".GIT/config", ".git./config", "new/.git/config", "sub/.git", "gitlink", "gitlink/config", "gitlink/new", "cfg"] {
            assert!(!guest_path_ok(&root, &root.join(bad)), "{bad}");
        }
        for good in ["", "src/a.rs", "src/new.rs", ".gitignore", "sub"] {
            assert!(guest_path_ok(&root, &root.join(good)), "{good}");
        }

        assert!(tree_has_git(&root.join("sub"), GIT_SCAN_LIMIT));
        assert!(!tree_has_git(&root.join("src"), GIT_SCAN_LIMIT));
        assert!(!tree_has_git(&root.join("src/a.rs"), GIT_SCAN_LIMIT));
        assert!(!tree_has_git(&root.join("gitlink"), GIT_SCAN_LIMIT), "a symlink is moved, not its target");
        assert!(tree_has_git(&root.join("src"), 0), "too large to scan counts as containing one");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    const A: &str = "abcdef0123aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "abcdef0123bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn ids_sharing_their_first_characters_are_different_peers() {
        let mut t = PeerTable::default();
        t.claim(A, "h-a".into(), "first", |_| true).unwrap();
        t.claim(B, "h-b".into(), "second", |_| true).unwrap();
        assert_eq!(t.get("h-a"), Some(&"first"));
        assert_eq!(t.get("h-b"), Some(&"second"));
    }

    #[test]
    fn a_second_connection_of_a_connected_id_is_refused() {
        let mut t = PeerTable::default();
        t.claim(A, "h1".into(), "first", |_| true).unwrap();
        assert!(t.claim(A, "h2".into(), "second", |_| true).is_err());
        assert_eq!(t.get("h1"), Some(&"first"));
        assert_eq!(t.get("h2"), None);
    }

    #[test]
    fn a_reconnect_replaces_a_dead_entry_and_its_late_cleanup_keeps_the_new_one() {
        let mut t = PeerTable::default();
        t.claim(A, "old".into(), "old", |_| true).unwrap();
        t.claim(A, "new".into(), "new", |_| false).unwrap();
        assert_eq!(t.get("old"), None);
        assert_eq!(t.remove("old"), None);
        assert_eq!(t.get("new"), Some(&"new"));
        // Still the registered connection of this id.
        assert!(t.claim(A, "third".into(), "third", |_| true).is_err());
    }

    #[test]
    fn a_peer_that_left_can_come_back() {
        let mut t = PeerTable::default();
        t.claim(A, "h1".into(), "first", |_| true).unwrap();
        assert_eq!(t.remove("h1"), Some("first"));
        t.claim(A, "h2".into(), "again", |_| true).unwrap();
        assert_eq!(t.drain(), vec!["again"]);
        t.claim(A, "h3".into(), "after stop", |_| true).unwrap();
    }

    #[test]
    fn handles_are_random_and_unrelated_to_the_id() {
        let (a, b) = (new_handle().unwrap(), new_handle().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    /// Accepts one connection on `host` and admits it, after the guest opened its stream.
    async fn connect(host: &Endpoint, guest: &Endpoint, peers: &Mutex<PeerTable<Arc<Peer>>>) -> (Connection, SendStream, iroh::endpoint::RecvStream, Connection, Result<String, String>) {
        let addr = host.addr();
        let (out, incoming) = tokio::join!(guest.connect(addr, ALPN), async { host.accept().await.unwrap().await.unwrap() });
        let out = out.unwrap();
        let (mut gsend, grecv) = out.open_bi().await.unwrap();
        gsend.write_all(b"hi").await.unwrap();
        let (hsend, mut hrecv) = incoming.accept_bi().await.unwrap();
        let mut buf = [0u8; 2];
        hrecv.read_exact(&mut buf).await.unwrap();
        let admitted = admit(peers, &incoming, hsend, None).await;
        (out, gsend, grecv, incoming, admitted)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn real_connections_with_one_key_duplicate_refused_first_keeps_working_reconnect_works() {
        let bind = |key: Option<iroh::SecretKey>| async move {
            let b = Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]);
            match key {
                Some(k) => b.secret_key(k),
                None => b,
            }
            .bind()
            .await
            .unwrap()
        };
        let key = iroh::SecretKey::generate();
        let host = bind(None).await;
        let (first, second) = (bind(Some(key.clone())).await, bind(Some(key.clone())).await);
        let peers = Mutex::new(PeerTable::default());

        let (conn1, _s1, mut r1, hconn1, h1) = connect(&host, &first, &peers).await;
        let h1 = h1.unwrap();
        assert!(!h1.contains(&key.public().to_string()[..10]));

        let (_conn2, _s2, _r2, hconn2, dup) = connect(&host, &second, &peers).await;
        assert_eq!(dup.unwrap_err(), "collab:already_connected");
        hconn2.close(2u32.into(), b"already connected");

        // The first connection is still the registered one, and it still delivers.
        let p = peers.lock().await.get(&h1).cloned().unwrap();
        p.send.lock().await.write_all(b"ok").await.unwrap();
        let mut buf = [0u8; 2];
        r1.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ok");
        drop(p);

        // A real disconnect whose cleanup hasn't run yet doesn't block the reconnect.
        conn1.close(0u32.into(), b"gone");
        tokio::time::timeout(std::time::Duration::from_secs(5), hconn1.closed()).await.unwrap();
        let third = bind(Some(key)).await;
        let (_c3, _s3, _r3, _h3, again) = connect(&host, &third, &peers).await;
        let again = again.unwrap();
        assert_ne!(again, h1);
        assert!(peers.lock().await.remove(&h1).is_none());
        assert!(peers.lock().await.get(&again).is_some());
    }

    #[test]
    fn the_rate_limit_allows_a_burst_then_refills_slowly() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(JOIN_RATE_BURST, JOIN_RATE_PER_SEC, t0);
        for _ in 0..JOIN_RATE_BURST as usize {
            assert!(b.take(t0));
        }
        assert!(!b.take(t0));
        assert!(!b.take(t0 + Duration::from_millis(100)));
        assert!(b.take(t0 + Duration::from_millis(300)));
        // A long quiet time refills to the burst, not beyond it.
        let later = t0 + Duration::from_secs(3600);
        for _ in 0..JOIN_RATE_BURST as usize {
            assert!(b.take(later));
        }
        assert!(!b.take(later));
    }

    #[test]
    fn refusals_are_reported_as_one_sum_per_window() {
        let l = JoinLimits::new();
        assert!(l.note_refused());
        assert!(!l.note_refused());
        assert!(!l.note_refused());
        assert_eq!(l.take_refused(), 3);
        assert!(l.note_refused());
        assert_eq!(l.take_refused(), 1);
    }

    fn frame(msg: &[u8]) -> Vec<u8> {
        let mut out = (msg.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(msg);
        out
    }

    async fn test_endpoint() -> Endpoint {
        Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.unwrap()
    }

    /// A host running the real accept loop; joins arrive on the channel.
    async fn test_host() -> (Endpoint, Arc<JoinLimits>, SharedPeers, tokio::sync::mpsc::UnboundedReceiver<Joined>) {
        test_host_on(Default::default()).await
    }

    async fn test_host_on(peers: SharedPeers) -> (Endpoint, Arc<JoinLimits>, SharedPeers, tokio::sync::mpsc::UnboundedReceiver<Joined>) {
        let host = test_endpoint().await;
        let limits = Arc::new(JoinLimits::new());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(accept_joins(host.clone(), limits.clone(), peers.clone(), move |j| drop(tx.send(j)), |_| {}));
        (host, limits, peers, rx)
    }

    const HELLO: &[u8] = br#"{"t":"hello","name":"Gast","version":2}"#;

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_on_a_reload_disconnects_guests_and_the_same_guest_can_join_again() {
        let state = CollabState::default();
        let (host, limits, _peers, mut joins) = test_host_on(state.peers.clone()).await;
        *state.endpoint.lock().await = Some(host.clone());
        *state.limits.lock().await = Some(limits);
        *state.hosting.lock().await = true;
        let (guest, conn, _send, _recv) = join_as_guest(&host).await;
        timeout(Duration::from_secs(10), joins.recv()).await.unwrap().unwrap();

        stop_session(&state).await;
        timeout(Duration::from_secs(5), conn.closed()).await.unwrap();
        assert!(state.endpoint.lock().await.is_none());
        assert!(!*state.hosting.lock().await);
        assert!(state.limits.lock().await.is_none());

        // The key that was connected is not "already connected" to the next session.
        let (next, next_limits, _peers, mut next_joins) = test_host_on(state.peers.clone()).await;
        *state.endpoint.lock().await = Some(next.clone());
        assert!(claim_hosting(&state, &next).await.unwrap().is_some());
        drop(next_limits);
        let again = guest.connect(next.addr(), ALPN).await.unwrap();
        let (mut send, _recv) = again.open_bi().await.unwrap();
        send.write_all(&frame(HELLO)).await.unwrap();
        timeout(Duration::from_secs(10), next_joins.recv()).await.unwrap().expect("the guest joins again");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_stopped_while_coming_online_does_not_start_hosting() {
        let state = CollabState::default();
        let ep = test_endpoint().await;
        *state.endpoint.lock().await = Some(ep.clone());
        stop_session(&state).await; // the reload, during collab_host's wait for the relay
        assert_eq!(claim_hosting(&state, &ep).await.err().as_deref(), Some("collab:not_connected"));
        assert!(!*state.hosting.lock().await, "a later session must still start its accept loop");
        assert!(state.limits.lock().await.is_none());

        let fresh = test_endpoint().await;
        *state.endpoint.lock().await = Some(fresh.clone());
        assert!(claim_hosting(&state, &fresh).await.unwrap().is_some());
        assert!(claim_hosting(&state, &fresh).await.unwrap().is_none(), "already hosting");
    }

    async fn join_as_guest(host: &Endpoint) -> (Endpoint, Connection, SendStream, RecvStream) {
        let guest = test_endpoint().await;
        let conn = guest.connect(host.addr(), ALPN).await.unwrap();
        let (mut send, recv) = conn.open_bi().await.unwrap();
        send.write_all(&frame(HELLO)).await.unwrap();
        (guest, conn, send, recv)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_flood_of_unapproved_keys_is_bounded_and_an_approved_guest_keeps_working() {
        let (host, limits, peers, mut joins) = test_host().await;

        // A real guest joins and is approved, the way collab_send does it on "welcome".
        let (_g, gconn, mut gsend, mut grecv) = join_as_guest(&host).await;
        let mut approved = timeout(Duration::from_secs(10), joins.recv()).await.unwrap().unwrap();
        assert_eq!(approved.hello, HELLO);
        assert!(approved.peer.is_pending());
        allow_outgoing(&approved.peer, r#"{"t":"welcome"}"#).unwrap();
        assert_eq!(limits.pending.available_permits(), MAX_PENDING, "an approved guest holds no slot");

        // Far more distinct keys than any limit, all sending a valid join message and staying.
        let flood = (MAX_PENDING + MAX_HANDSHAKES) * 2;
        let mut attackers = tokio::task::JoinSet::new();
        for _ in 0..flood {
            let addr = host.addr();
            attackers.spawn(async move {
                let ep = test_endpoint().await;
                let refused = match timeout(Duration::from_secs(15), ep.connect(addr, ALPN)).await {
                    Ok(Ok(conn)) => {
                        if let Ok((mut s, _r)) = conn.open_bi().await {
                            let _ = s.write_all(&frame(HELLO)).await;
                            tokio::time::sleep(Duration::from_secs(4)).await;
                        }
                        drop(conn);
                        false
                    }
                    Ok(Err(e)) => connect_refused(&e),
                    Err(_) => false,
                };
                (ep, refused)
            });
        }
        let mut waiting = Vec::new();
        let mut refused = 0;
        let mut eps = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
        while !attackers.is_empty() && tokio::time::Instant::now() < deadline {
            tokio::select! {
                Some(j) = joins.recv() => waiting.push(j),
                Some(done) = attackers.join_next() => {
                    let (ep, was_refused) = done.unwrap();
                    refused += was_refused as usize;
                    eps.push(ep);
                }
            }
            assert!(peers.lock().await.by_handle.len() <= MAX_PENDING + 1, "the table stays bounded");
        }
        assert!(attackers.is_empty(), "the flood finished");
        while let Ok(j) = joins.try_recv() {
            waiting.push(j);
        }
        assert!(waiting.len() <= MAX_PENDING, "{} requests", waiting.len());
        assert!(refused > 0, "excess connections are refused");

        // The approved guest was neither evicted nor disturbed, in both directions.
        assert!(gconn.close_reason().is_none());
        assert!(peers.lock().await.get(&approved.handle).is_some());
        gsend.write_all(&frame(b"{\"t\":\"doc.open\"}")).await.unwrap();
        let got = timeout(Duration::from_secs(5), next_frame(&mut approved.recv, &approved.peer)).await.unwrap().unwrap();
        assert_eq!(got.as_deref(), Some(&b"{\"t\":\"doc.open\"}"[..]));
        approved.peer.send.lock().await.write_all(&frame(b"ok")).await.unwrap();
        assert_eq!(timeout(Duration::from_secs(5), read_frame(&mut grecv, 16)).await.unwrap().unwrap(), b"ok");
        for ep in eps {
            ep.close().await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_guest_can_tell_and_a_full_queue_closes_with_busy() {
        let (host, limits, _peers, mut joins) = test_host().await;

        // Rate limit used up: refused during the handshake, recognizably.
        let drained: Vec<_> = std::iter::from_fn(|| limits.rate.lock().unwrap().take(Instant::now()).then_some(())).collect();
        assert!(!drained.is_empty());
        let guest = test_endpoint().await;
        let e = guest.connect(host.addr(), ALPN).await.unwrap_err();
        assert!(connect_refused(&e), "{e}");

        // Every request slot taken: refused after the join message, with the busy code.
        *limits.rate.lock().unwrap() = TokenBucket::new(JOIN_RATE_BURST, JOIN_RATE_PER_SEC, Instant::now());
        let held = limits.pending.clone().acquire_many_owned(MAX_PENDING as u32).await.unwrap();
        let (_g, conn, _s, _r) = join_as_guest(&host).await;
        timeout(Duration::from_secs(5), conn.closed()).await.unwrap();
        assert_eq!(close_code(&conn).as_deref(), Some("collab:busy"));
        assert!(joins.try_recv().is_err());
        drop(held);

        // With a slot free the next guest gets through.
        let (_g2, _c2, _s2, _r2) = join_as_guest(&host).await;
        assert!(timeout(Duration::from_secs(5), joins.recv()).await.unwrap().is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn before_approval_messages_are_small_and_dropped_after_it_they_pass() {
        let (host, limits, _peers, mut joins) = test_host().await;
        let (_g, _conn, mut gsend, _grecv) = join_as_guest(&host).await;
        let mut j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();

        gsend.write_all(&frame(b"{\"t\":\"presence\"}")).await.unwrap();
        assert_eq!(next_frame(&mut j.recv, &j.peer).await.unwrap(), None);

        j.peer.approve();
        assert_eq!(limits.pending.available_permits(), MAX_PENDING);
        let big = vec![b'x'; MAX_JOIN_MSG + 1];
        gsend.write_all(&frame(&big)).await.unwrap();
        assert_eq!(next_frame(&mut j.recv, &j.peer).await.unwrap(), Some(big));

        // A second request over the size limit is cut off while it is pending.
        let (_g2, _c2, mut s2, _r2) = join_as_guest(&host).await;
        let mut j2 = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        s2.write_all(&((MAX_JOIN_MSG + 1) as u32).to_be_bytes()).await.unwrap();
        assert_eq!(next_frame(&mut j2.recv, &j2.peer).await.unwrap_err(), "collab:too_large");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_full_queue_of_real_guests_joining_at_once_is_not_refused() {
        let (host, limits, _peers, mut joins) = test_host().await;
        let mut guests = tokio::task::JoinSet::new();
        for _ in 0..MAX_PENDING {
            let host = host.clone();
            guests.spawn(async move { join_as_guest(&host).await });
        }
        let mut kept = Vec::new();
        while let Some(g) = guests.join_next().await {
            kept.push(g.unwrap());
        }
        for _ in 0..MAX_PENDING {
            assert!(timeout(Duration::from_secs(10), joins.recv()).await.unwrap().is_some());
        }
        assert_eq!(limits.refused.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_peer_that_stalls_before_its_join_message_is_closed_and_frees_its_slot() {
        let (host, limits, peers, mut joins) = test_host().await;
        // One never opens a stream, the other stops in the middle of its join message.
        let (a, b) = (test_endpoint().await, test_endpoint().await);
        let no_stream = a.connect(host.addr(), ALPN).await.unwrap();
        let half = b.connect(host.addr(), ALPN).await.unwrap();
        let (mut s, _r) = half.open_bi().await.unwrap();
        s.write_all(&(HELLO.len() as u32).to_be_bytes()).await.unwrap();

        let limit = FIRST_STREAM_TIMEOUT.max(JOIN_MSG_TIMEOUT) + Duration::from_secs(3);
        timeout(limit, no_stream.closed()).await.expect("no stream: closed in time");
        timeout(limit, half.closed()).await.expect("half a message: closed in time");
        assert_eq!(close_code(&no_stream).as_deref(), Some("collab:expired"));
        assert_eq!(close_code(&half).as_deref(), Some("collab:expired"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(limits.handshakes.available_permits(), MAX_HANDSHAKES);
        assert!(peers.lock().await.by_handle.is_empty());
        assert!(joins.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_to_welcome_passes_even_if_the_read_was_already_waiting() {
        let (host, _limits, _peers, mut joins) = test_host().await;
        let (_g, _conn, mut gsend, _grecv) = join_as_guest(&host).await;
        let mut j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        let peer = j.peer.clone();
        let reader = tokio::spawn(async move { next_frame(&mut j.recv, &j.peer).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        allow_outgoing(&peer, r#"{"t":"welcome"}"#).unwrap();
        gsend.write_all(&frame(br#"{"t":"hello-ready"}"#)).await.unwrap();
        let got = timeout(Duration::from_secs(5), reader).await.unwrap().unwrap().unwrap();
        assert_eq!(got.as_deref(), Some(&br#"{"t":"hello-ready"}"#[..]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unapproved_peers_only_get_the_answers_to_their_request() {
        let (host, _limits, _peers, mut joins) = test_host().await;
        let (_g, _conn, _s, _r) = join_as_guest(&host).await;
        let j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        for msg in [r#"{"t":"doc.state","update":"secret"}"#, r#"{"t":"participants"}"#, r#"{"t":"rpc.res"}"#, "not json", r#"{"x":1}"#] {
            assert_eq!(allow_outgoing(&j.peer, msg).unwrap_err(), "collab:not_approved", "{msg}");
        }
        for msg in [r#"{"t":"denied"}"#, r#"{"t":"version","version":2}"#, r#"{"t":"busy"}"#] {
            allow_outgoing(&j.peer, msg).unwrap();
            assert!(j.peer.is_pending(), "{msg} is no approval");
        }
        allow_outgoing(&j.peer, r#"{"t":"welcome"}"#).unwrap();
        assert!(!j.peer.is_pending());
        allow_outgoing(&j.peer, r#"{"t":"doc.state"}"#).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_connection_without_a_join_message_gets_no_request() {
        let (host, _limits, peers, mut joins) = test_host().await;
        let guest = test_endpoint().await;
        let conn = guest.connect(host.addr(), ALPN).await.unwrap();
        let (mut s, _r) = conn.open_bi().await.unwrap();
        for _ in 0..MAX_FRAMES_BEFORE_HELLO {
            s.write_all(&frame(b"{\"t\":\"presence\"}")).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(joins.try_recv().is_err());
        assert!(peers.lock().await.by_handle.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_undecided_request_expires_and_frees_its_slot() {
        let (host, limits, _peers, mut joins) = test_host().await;
        let (_g, conn, _s, _r) = join_as_guest(&host).await;
        let j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        assert_eq!(limits.pending.available_permits(), MAX_PENDING - 1);
        expire_pending(j.peer.clone(), Duration::from_millis(10)).await;
        timeout(Duration::from_secs(5), conn.closed()).await.unwrap();
        assert_eq!(close_code(&conn).as_deref(), Some("collab:expired"));
        // The slot is back even while something still holds the peer.
        assert_eq!(limits.pending.available_permits(), MAX_PENDING);
        assert_eq!(allow_outgoing(&j.peer, r#"{"t":"welcome"}"#).unwrap_err(), "collab:not_approved");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_welcome_just_before_the_deadline_keeps_the_guest() {
        let (host, limits, _peers, mut joins) = test_host().await;
        let (_g, conn, _s, _r) = join_as_guest(&host).await;
        let j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        allow_outgoing(&j.peer, r#"{"t":"welcome"}"#).unwrap();
        expire_pending(j.peer.clone(), Duration::from_millis(10)).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(conn.close_reason().is_none());
        assert!(j.peer.conn.close_reason().is_none());
        assert!(!j.peer.is_pending());
        assert_eq!(limits.pending.available_permits(), MAX_PENDING);
    }

    #[test]
    fn approval_and_expiry_racing_have_exactly_one_winner() {
        for _ in 0..2000 {
            let slots = Arc::new(Semaphore::new(1));
            let a = Arc::new(Admission::new(Some(slots.clone().try_acquire_owned().unwrap())));
            let start = Arc::new(std::sync::Barrier::new(2));
            let (a2, start2) = (a.clone(), start.clone());
            let expirer = std::thread::spawn(move || {
                start2.wait();
                a2.expire()
            });
            start.wait();
            let approved = a.approve();
            let expired = expirer.join().unwrap();
            assert_ne!(approved, expired, "exactly one decision wins");
            assert_eq!(a.is_approved(), approved);
            assert_eq!(slots.available_permits(), 1);
        }
    }

    #[test]
    fn a_notice_is_not_delivered_when_empty_or_after_the_session_ended() {
        let calls = std::sync::Mutex::new(Vec::new());
        let l = JoinLimits::new();
        l.deliver_notice(|n| calls.lock().unwrap().push(n));
        assert!(calls.lock().unwrap().is_empty(), "a zero count is not emitted");
        l.note_refused();
        l.note_refused();
        l.deliver_notice(|n| calls.lock().unwrap().push(n));
        assert_eq!(*calls.lock().unwrap(), vec![2]);
        l.note_refused();
        l.end();
        l.deliver_notice(|n| calls.lock().unwrap().push(n));
        assert_eq!(*calls.lock().unwrap(), vec![2], "nothing after the session ended");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_notice_waiting_when_the_session_stops_never_arrives() {
        let limits = Arc::new(JoinLimits::new());
        let seen = Arc::new(AtomicU64::new(0));
        let seen2 = seen.clone();
        let notify = Arc::new(move |n: u64| {
            seen2.fetch_add(n, Ordering::Relaxed);
        });
        report_refusal(&limits, &notify);
        end_session(Some(limits.clone()), &Mutex::new(PeerTable::default())).await;
        tokio::time::sleep(REFUSAL_NOTICE_WINDOW + Duration::from_millis(300)).await;
        assert_eq!(seen.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_denied_guest_can_reconnect_at_once_with_the_same_key() {
        let (host, limits, peers, mut joins) = test_host().await;
        let key = iroh::SecretKey::generate();
        let bind = |k: iroh::SecretKey| async move { Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).secret_key(k).bind().await.unwrap() };

        let first = bind(key.clone()).await;
        let conn = first.connect(host.addr(), ALPN).await.unwrap();
        let (mut s, _r) = conn.open_bi().await.unwrap();
        s.write_all(&frame(HELLO)).await.unwrap();
        let j = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();

        // What deny does: answer, then kick.
        allow_outgoing(&j.peer, r#"{"t":"denied"}"#).unwrap();
        peers.lock().await.remove(&j.handle).unwrap().conn.close(1u32.into(), b"removed");
        let old_handle = j.handle.clone();
        drop(j);
        timeout(Duration::from_secs(5), conn.closed()).await.unwrap();

        let second = bind(key).await;
        let again = second.connect(host.addr(), ALPN).await.unwrap();
        let (mut s2, _r2) = again.open_bi().await.unwrap();
        s2.write_all(&frame(HELLO)).await.unwrap();
        let j2 = timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        assert_ne!(j2.handle, old_handle);
        assert!(j2.peer.is_pending(), "it has to be approved again");
        assert_eq!(limits.pending.available_permits(), MAX_PENDING - 1, "the denied request's slot came back");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_with_connections_in_flight_leaves_nothing_for_the_next_session() {
        let (host, limits, peers, mut joins) = test_host().await;

        // One request is waiting, another connection is still before its join message.
        let (_g1, waiting, _s1, _r1) = join_as_guest(&host).await;
        timeout(Duration::from_secs(5), joins.recv()).await.unwrap().unwrap();
        let late = test_endpoint().await;
        let in_flight = late.connect(host.addr(), ALPN).await.unwrap();
        let (mut late_send, _late_recv) = in_flight.open_bi().await.unwrap();
        late_send.write_all(&(HELLO.len() as u32).to_be_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        end_session(Some(limits.clone()), &peers).await;
        assert!(peers.lock().await.by_handle.is_empty());
        timeout(Duration::from_secs(5), waiting.closed()).await.unwrap();

        // The rest of its join message arrives after the stop: it joins nothing.
        late_send.write_all(HELLO).await.unwrap();
        timeout(Duration::from_secs(5), in_flight.closed()).await.unwrap();
        assert!(joins.try_recv().is_err());
        assert!(peers.lock().await.by_handle.is_empty());
        host.close().await;

        // A new session on the same table starts clean and works.
        let (host2, limits2, peers2, mut joins2) = test_host_on(peers.clone()).await;
        assert_eq!(limits2.pending.available_permits(), MAX_PENDING);
        let (_g3, _c3, _s3, _r3) = join_as_guest(&host2).await;
        let j = timeout(Duration::from_secs(5), joins2.recv()).await.unwrap().unwrap();
        assert_eq!(peers2.lock().await.by_handle.len(), 1);
        assert!(peers2.lock().await.get(&j.handle).is_some());
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
