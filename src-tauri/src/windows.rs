//! Several windows in one process. Backend state that belongs to a window (terminals, language
//! servers, debuggers, Run tasks, the file watcher, searches) is keyed by the window's label, which
//! Tauri takes from the calling webview, so a frontend can't name another window's resources.
//!
//! Events for one window go through [`emit`]. Global on purpose: `tool-progress` (installed tools
//! are shared), `power-status` (one keep-awake state), `ide-clients` and `ide-connected` (one IDE
//! server).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// Separates owner and id in a scoped key; neither a label nor a frontend id contains it.
const SEP: char = '\u{1f}';

/// Key of resource `id` of window `owner`: two windows may use the same id.
pub fn key(owner: &str, id: &str) -> String {
    format!("{owner}{SEP}{id}")
}

pub fn is_owned(key: &str, owner: &str) -> bool {
    key.split_once(SEP).is_some_and(|(o, _)| o == owner)
}

pub fn owner_of(key: &str) -> Option<&str> {
    key.split_once(SEP).map(|(o, _)| o)
}

/// Removes and returns everything `owner` holds in a map with scoped keys.
pub fn take_owned<V>(map: &mut HashMap<String, V>, owner: &str) -> Vec<V> {
    let keys: Vec<String> = map.keys().filter(|k| is_owned(k, owner)).cloned().collect();
    keys.iter().filter_map(|k| map.remove(k)).collect()
}

/// Sends an event to one window only. Its listeners must be window-scoped (`lib/windowEvents.ts`):
/// a JS listener without a target receives events meant for any other window too.
pub fn emit<S: Serialize + Clone>(app: &AppHandle, owner: &str, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview_window(owner), event, payload);
}

/// Windows by last focus, most recent first.
#[derive(Default)]
pub struct FocusState {
    order: Mutex<Vec<String>>,
}

fn note_focus(order: &mut Vec<String>, label: &str) {
    order.retain(|l| l != label);
    order.insert(0, label.to_string());
}

/// The window that gets app-wide requests: the last focused one that still exists, else the first
/// by label. Test instances live on a hidden desktop and may never get the focus.
fn pick_target(order: &[String], open: &[String]) -> Option<String> {
    order.iter().find(|l| open.contains(l)).cloned().or_else(|| open.iter().min().cloned())
}

pub fn focused(app: &AppHandle, label: &str) {
    note_focus(&mut app.state::<FocusState>().order.lock().unwrap(), label);
}

pub fn target(app: &AppHandle) -> Option<String> {
    let open: Vec<String> = app.webview_windows().into_keys().collect();
    pick_target(&app.state::<FocusState>().order.lock().unwrap(), &open)
}

/// The window whose terminal `pid` runs in: walks up the parents to one of its shells.
fn window_of(pid: u32, parents: &HashMap<u32, u32>, shells: &[(u32, String)]) -> Option<String> {
    let mut seen = HashSet::new();
    let mut p = pid;
    while seen.insert(p) {
        if let Some((_, label)) = shells.iter().find(|(s, _)| *s == p) {
            return Some(label.clone());
        }
        p = *parents.get(&p)?;
    }
    None
}

/// The first of these processes that runs in a terminal of a window.
pub fn window_of_processes(app: &AppHandle, pids: &[u32]) -> Option<String> {
    let shells = crate::pty::shell_owners(app);
    if shells.is_empty() {
        return None;
    }
    let parents = crate::power::process_parents();
    pids.iter().find_map(|p| window_of(*p, &parents, &shells))
}

/// The window's page is (re)loading: what its old page started has no UI any more.
pub fn page_loading(app: &AppHandle, label: &str) {
    // Before the new page runs, so it can't get a folder that's about to be deleted.
    let private = crate::lang_shadow::detach_window(label);
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        crate::pty::kill_window(&app, &label);
        crate::proc::kill_window(&app, &label);
        crate::search::cancel_window(&label);
        if let Some(dir) = private {
            let _ = std::fs::remove_dir_all(dir);
        }
    });
}

/// The window is gone: ends its processes and drops everything kept for it. A window closed on
/// its own is forgotten; the last one, and all of them at app exit, are restored on the next start.
pub fn destroyed(app: &AppHandle, label: &str) {
    let reg = app.state::<Registry>();
    reg.boot.lock().unwrap().remove(label);
    reg.booted.lock().unwrap().remove(label);
    if !reg.exiting.load(Ordering::SeqCst) && remove_closed(&mut reg.entries.lock().unwrap(), label) {
        save(app);
        let _ = app.emit("windows-changed", ());
    }
    app.state::<FocusState>().order.lock().unwrap().retain(|l| l != label);
    crate::fs::forget_window(label);
    crate::ide_ws::forget_window(app, label);
    crate::codex_ipc::forget_window(app, label);
    crate::mcp_control::forget_window(app, label);
    crate::collab::frontend_loading(app, label);
    page_loading(app, label);
}

// ------------------------------------------------------------------ open windows

/// A window that's open now and comes back on the next start.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    label: String,
    root: Option<String>,
}

/// What a new window opens once its page has loaded.
#[derive(Default, Clone, Serialize)]
pub struct Boot {
    pub root: Option<String>,
    pub files: Vec<String>,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<Vec<Entry>>,
    exiting: AtomicBool,
    boot: Mutex<HashMap<String, Boot>>,
    /// Windows whose page has asked for its `Boot`: they get new paths as an event.
    booted: Mutex<HashSet<String>>,
    /// Open "how many unsaved tabs?" rounds: who still has to answer, and where answers go.
    queries: Mutex<HashMap<u64, (HashSet<String>, Sender<(String, usize)>)>>,
}

static NEXT_QUERY: AtomicU64 = AtomicU64::new(1);
/// How long a window gets to answer before it counts as holding unsaved work.
const UNSAVED_WAIT: Duration = Duration::from_secs(5);

fn valid_label(l: &str) -> bool {
    l == "main" || l.strip_prefix("w-").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// A label only the backend makes up.
fn new_label() -> Result<String, String> {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(format!("w-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()))
}

/// The saved windows; a damaged or empty file means one fresh main window.
fn parse_entries(text: &str) -> Vec<Entry> {
    let mut seen = HashSet::new();
    let list: Vec<Entry> = serde_json::from_str::<Vec<Entry>>(text).unwrap_or_default().into_iter().filter(|e| valid_label(&e.label) && seen.insert(e.label.clone())).collect();
    if list.is_empty() { vec![Entry { label: "main".into(), root: None }] } else { list }
}

/// Forgets a closed window, unless it's the last: that one is what the next start restores.
fn remove_closed(entries: &mut Vec<Entry>, label: &str) -> bool {
    if entries.len() <= 1 || !entries.iter().any(|e| e.label == label) {
        return false;
    }
    entries.retain(|e| e.label != label);
    true
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    Some(match crate::instance::name() {
        Some(n) => dir.join("instances").join(n).join("windows.json"),
        None => dir.join("windows.json"),
    })
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

fn save(app: &AppHandle) {
    let text = serde_json::to_string(&*app.state::<Registry>().entries.lock().unwrap()).unwrap_or_default();
    if let Some(p) = store_path(app) {
        let _ = write_atomic(&p, &text);
    }
}

fn build(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    let mut cfg = app.config().app.windows.first().cloned().ok_or("no window config")?;
    cfg.label = label.to_string();
    let window = crate::instance::window_builder(app, &cfg).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    crate::instance::to_test_desktop();
    Ok(window)
}

/// Startup: opens the windows of the last session, or one main window.
pub fn restore(app: &AppHandle) -> Result<(), String> {
    let saved = store_path(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let entries = parse_entries(&saved);
    *app.state::<Registry>().entries.lock().unwrap() = entries.clone();
    for e in &entries {
        build(app, &e.label)?;
        apply_title(app, &e.label, e.root.as_deref());
    }
    save(app);
    Ok(())
}

/// Opens a new window; `boot` is what it shows once loaded.
pub fn open(app: &AppHandle, boot: Boot) -> Result<String, String> {
    let label = new_label()?;
    let reg = app.state::<Registry>();
    reg.entries.lock().unwrap().push(Entry { label: label.clone(), root: boot.root.clone() });
    reg.boot.lock().unwrap().insert(label.clone(), boot);
    save(app);
    if let Err(e) = build(app, &label) {
        reg.entries.lock().unwrap().retain(|x| x.label != label);
        reg.boot.lock().unwrap().remove(&label);
        save(app);
        return Err(e);
    }
    Ok(label)
}

fn apply_title(app: &AppHandle, label: &str, root: Option<&str>) {
    let Some(w) = app.get_webview_window(label) else { return };
    let base = crate::instance::name().map_or("Omega".to_string(), |n| format!("Omega – {n}"));
    let folder = root.and_then(|r| Path::new(r).file_name()).map(|n| n.to_string_lossy().into_owned());
    let _ = w.set_title(&folder.map_or(base.clone(), |f| format!("{f} – {base}")));
}

/// The window's folder changed (from `watch_dir`).
pub fn set_root(app: &AppHandle, label: &str, root: Option<&str>) {
    let changed = {
        let reg = app.state::<Registry>();
        let mut entries = reg.entries.lock().unwrap();
        match entries.iter_mut().find(|e| e.label == label) {
            Some(e) if e.root.as_deref() != root => {
                e.root = root.map(str::to_string);
                true
            }
            _ => false,
        }
    };
    if changed {
        save(app);
    }
    apply_title(app, label, root);
}

/// The app is about to quit: every open window stays in the saved session.
pub fn exiting(app: &AppHandle) {
    app.state::<Registry>().exiting.store(true, Ordering::SeqCst);
}

// ------------------------------------------------------------------ `omega <paths>`

/// One thing to do for a request. `label: None` is a new window.
#[derive(Debug, Default, PartialEq, Clone)]
struct Act {
    label: Option<String>,
    root: Option<String>,
    files: Vec<String>,
    focus: bool,
}

/// How a request at app start may use the windows that were just restored.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Start {
    /// The app was already running.
    Running,
    /// Takes a window without a folder before opening another.
    Cold,
    /// A test instance: the first folder replaces the first window's, as `instance_launch` expects.
    ColdInstance,
}

/// Folder open → its window; else a new window. Files go to the window of the last folder named,
/// else the active one. `open`: (label, resolved root), `active`: the focused window.
fn plan(dirs: &[String], files: &[String], open: &[(String, Option<String>)], active: Option<&str>, start: Start) -> Vec<Act> {
    let mut acts: Vec<Act> = Vec::new();
    let mut last = None;
    for (i, dir) in dirs.iter().enumerate() {
        if let Some(n) = acts.iter().position(|a| a.root.as_ref() == Some(dir)) {
            last = Some(n);
            continue;
        }
        let free = |l: &String| !acts.iter().any(|a| a.label.as_ref() == Some(l));
        let act = if let Some((l, _)) = open.iter().find(|(_, r)| r.as_ref() == Some(dir)) {
            Act { label: Some(l.clone()), ..Act::default() }
        } else if let (Start::ColdInstance, 0, Some(l)) = (start, i, active.map(str::to_string).or_else(|| open.first().map(|o| o.0.clone()))) {
            Act { label: Some(l), root: Some(dir.clone()), ..Act::default() }
        } else if let (true, Some((l, _))) = (start != Start::Running, open.iter().find(|(l, r)| r.is_none() && free(l))) {
            Act { label: Some(l.clone()), root: Some(dir.clone()), ..Act::default() }
        } else {
            Act { root: Some(dir.clone()), ..Act::default() }
        };
        acts.push(act);
        last = Some(acts.len() - 1);
    }
    if !files.is_empty() {
        let n = last.unwrap_or_else(|| {
            acts.push(Act { label: active.map(str::to_string).or_else(|| open.first().map(|o| o.0.clone())), ..Act::default() });
            acts.len() - 1
        });
        acts[n].files = files.to_vec();
        last = Some(n);
    }
    if dirs.is_empty() && files.is_empty() && start == Start::Running {
        acts.push(Act { label: active.map(str::to_string).or_else(|| open.first().map(|o| o.0.clone())), ..Act::default() });
        last = Some(0);
    }
    if let Some(n) = last {
        acts[n].focus = true;
    }
    acts
}

/// Opens what `omega` was asked for.
pub fn route(app: &AppHandle, req: crate::cli::Request, cold: bool) {
    let reg = app.state::<Registry>();
    let open: Vec<(String, Option<String>)> = reg.entries.lock().unwrap().iter()
        .map(|e| (e.label.clone(), e.root.as_ref().map(|r| Path::new(r).canonicalize().map_or(r.clone(), crate::env::norm))))
        .collect();
    let active = target(app);
    let start = match (cold, crate::instance::name().is_some()) {
        (false, _) => Start::Running,
        (true, true) => Start::ColdInstance,
        (true, false) => Start::Cold,
    };
    for act in plan(&req.dirs, &req.files, &open, active.as_deref(), start) {
        let boot = Boot { root: act.root, files: act.files };
        let label = match act.label {
            Some(l) => {
                if boot.root.is_some() || !boot.files.is_empty() {
                    deliver(app, &l, boot);
                }
                l
            }
            None => match self::open(app, boot) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("omega: {e}");
                    continue;
                }
            },
        };
        if act.focus {
            focus(app, &label);
        }
    }
}

/// Hands paths to a window: as an event once its page runs, else with its boot.
fn deliver(app: &AppHandle, label: &str, boot: Boot) {
    let reg = app.state::<Registry>();
    let mut pending = reg.boot.lock().unwrap();
    if reg.booted.lock().unwrap().contains(label) {
        drop(pending);
        emit(app, label, "window-open", boot);
    } else {
        let slot = pending.entry(label.to_string()).or_default();
        slot.root = boot.root.or(slot.root.take());
        slot.files.extend(boot.files);
    }
}

/// Brings a window to the front. A test instance only makes it the target: it stays on its
/// hidden desktop and never takes the user's focus.
fn focus(app: &AppHandle, label: &str) {
    focused(app, label);
    if crate::instance::name().is_some() {
        return;
    }
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    // Wayland compositors ignore a window's own request for focus.
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        if let Ok(title) = w.title() {
            crate::instance::hypr_focus(&title);
        }
    }
}

/// An update is about to restart the app.
#[tauri::command]
pub fn windows_prepare_exit(app: AppHandle) {
    exiting(&app);
    crate::cli::mark_relaunch();
}

/// The restart failed and the app keeps running: closing a window forgets it again.
#[tauri::command]
pub fn windows_cancel_exit(app: AppHandle) {
    app.state::<Registry>().exiting.store(false, Ordering::SeqCst);
    crate::cli::clear_relaunch();
}

#[tauri::command]
pub async fn window_new(app: AppHandle) -> Result<String, String> {
    open(&app, Boot::default())
}

/// What this window should open, once; and the windows that are open, to prune stale state.
#[tauri::command]
pub fn window_boot(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    let reg = app.state::<Registry>();
    // One lock over both, so `deliver` either adds to this boot or sends an event.
    let mut pending = reg.boot.lock().unwrap();
    reg.booted.lock().unwrap().insert(window.label().to_string());
    let boot = pending.remove(window.label()).unwrap_or_default();
    drop(pending);
    json!({ "root": boot.root, "files": boot.files, "windows": labels(&app) })
}

fn labels(app: &AppHandle) -> Vec<String> {
    app.state::<Registry>().entries.lock().unwrap().iter().map(|e| e.label.clone()).collect()
}

#[tauri::command]
pub fn window_labels(app: AppHandle) -> Vec<String> {
    labels(&app)
}

/// Adds up the answers of one round; a window that didn't answer counts as unsaved work.
fn tally(expected: &HashSet<String>, answers: &HashMap<String, usize>) -> usize {
    expected.iter().map(|l| answers.get(l).copied().unwrap_or(1)).sum()
}

/// Unsaved tabs in all windows, after each has flushed its autosave (before an update restarts the app).
#[tauri::command]
pub async fn windows_unsaved(app: AppHandle) -> usize {
    let expected: HashSet<String> = app.webview_windows().into_keys().collect();
    let call = NEXT_QUERY.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    app.state::<Registry>().queries.lock().unwrap().insert(call, (expected.clone(), tx));
    for l in &expected {
        emit(&app, l, "window-unsaved-query", call);
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + UNSAVED_WAIT;
        let mut answers = HashMap::new();
        while answers.len() < expected.len() {
            let Ok((label, n)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) else { break };
            answers.insert(label, n);
        }
        app2.state::<Registry>().queries.lock().unwrap().remove(&call);
        tally(&expected, &answers)
    })
    .await
    .unwrap_or(1)
}

#[tauri::command]
pub fn window_unsaved_reply(app: AppHandle, window: tauri::WebviewWindow, call: u64, count: usize) {
    let reg = app.state::<Registry>();
    let queries = reg.queries.lock().unwrap();
    if let Some((expected, tx)) = queries.get(&call) {
        if expected.contains(window.label()) {
            let _ = tx.send((window.label().to_string(), count));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(list: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        list.iter().map(|(l, r)| (l.to_string(), r.map(str::to_string))).collect()
    }
    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_open_folder_gets_focus_and_another_a_new_window() {
        let w = open(&[("main", Some("/a")), ("w-b", Some("/b"))]);
        assert_eq!(plan(&v(&["/b"]), &[], &w, Some("main"), Start::Running), [Act { label: Some("w-b".into()), focus: true, ..Act::default() }]);
        assert_eq!(plan(&v(&["/c"]), &[], &w, Some("main"), Start::Running), [Act { root: Some("/c".into()), focus: true, ..Act::default() }]);
    }

    #[test]
    fn a_file_goes_to_the_active_window() {
        let w = open(&[("main", Some("/a")), ("w-b", Some("/b"))]);
        assert_eq!(plan(&[], &v(&["/x/f"]), &w, Some("w-b"), Start::Running), [Act { label: Some("w-b".into()), files: v(&["/x/f"]), focus: true, ..Act::default() }]);
    }

    #[test]
    fn a_file_named_with_a_folder_goes_to_that_folders_window() {
        let w = open(&[("main", Some("/a"))]);
        assert_eq!(plan(&v(&["/c"]), &v(&["/c/f"]), &w, Some("main"), Start::Running), [Act { root: Some("/c".into()), files: v(&["/c/f"]), focus: true, ..Act::default() }]);
    }

    #[test]
    fn nothing_named_focuses_the_active_window() {
        let w = open(&[("main", Some("/a"))]);
        assert_eq!(plan(&[], &[], &w, Some("main"), Start::Running), [Act { label: Some("main".into()), focus: true, ..Act::default() }]);
        assert!(plan(&[], &[], &w, Some("main"), Start::Cold).is_empty());
    }

    #[test]
    fn a_cold_start_uses_an_empty_window_first() {
        let w = open(&[("main", None)]);
        assert_eq!(plan(&v(&["/a", "/b"]), &[], &w, Some("main"), Start::Cold), [
            Act { label: Some("main".into()), root: Some("/a".into()), ..Act::default() },
            Act { root: Some("/b".into()), focus: true, ..Act::default() },
        ]);
        // A restored folder isn't replaced by a normal start, but is by a test instance.
        let w = open(&[("main", Some("/old"))]);
        assert_eq!(plan(&v(&["/a"]), &[], &w, Some("main"), Start::Cold)[0].label, None);
        assert_eq!(plan(&v(&["/a"]), &[], &w, Some("main"), Start::ColdInstance)[0].label.as_deref(), Some("main"));
    }

    #[test]
    fn the_same_folder_twice_is_one_window() {
        assert_eq!(plan(&v(&["/c", "/c"]), &[], &open(&[("main", Some("/a"))]), Some("main"), Start::Running).len(), 1);
    }

    #[test]
    fn a_process_belongs_to_the_window_of_its_terminal() {
        let parents: HashMap<u32, u32> = [(30, 20), (20, 10), (10, 1), (40, 11), (11, 1), (50, 1), (60, 61), (61, 60)].into();
        let shells = vec![(10, "main".to_string()), (11, "w-b".to_string())];
        assert_eq!(window_of(30, &parents, &shells).as_deref(), Some("main"));
        assert_eq!(window_of(40, &parents, &shells).as_deref(), Some("w-b"));
        assert_eq!(window_of(10, &parents, &shells).as_deref(), Some("main"));
        assert_eq!(window_of(50, &parents, &shells), None, "started outside Omega");
        assert_eq!(window_of(60, &parents, &shells), None, "a parent loop ends");
    }

    #[test]
    fn labels_are_generated_and_checked() {
        let l = new_label().unwrap();
        assert!(valid_label(&l) && valid_label("main"));
        assert_ne!(l, new_label().unwrap());
        for bad in ["", "w-", "w-xyz", "../x", "w-0123456789abcdeg", "w-0123456789ABCDEF", "other"] {
            assert!(!valid_label(bad), "{bad}");
        }
    }

    #[test]
    fn a_damaged_session_opens_one_main_window() {
        let main = vec![Entry { label: "main".into(), root: None }];
        assert_eq!(parse_entries(""), main);
        assert_eq!(parse_entries("{"), main);
        assert_eq!(parse_entries(r#"[{"label":"../evil","root":"/x"}]"#), main);
        let two = parse_entries(r#"[{"label":"w-0123456789abcdef","root":"/a"},{"label":"w-0123456789abcdef","root":"/b"},{"label":"main","root":null}]"#);
        assert_eq!(two.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["w-0123456789abcdef", "main"]);
    }

    #[test]
    fn closing_forgets_a_window_but_keeps_the_last() {
        let e = |l: &str| Entry { label: l.into(), root: None };
        let mut list = vec![e("main"), e("w-a")];
        assert!(!remove_closed(&mut list, "nope"));
        assert!(remove_closed(&mut list, "main"));
        assert_eq!(list, [e("w-a")]);
        assert!(!remove_closed(&mut list, "w-a"));
        assert_eq!(list, [e("w-a")]);
    }

    #[test]
    fn a_silent_window_counts_as_unsaved_work() {
        let expected: HashSet<String> = ["main".to_string(), "w-a".to_string()].into();
        let mut answers = HashMap::new();
        answers.insert("main".to_string(), 2);
        assert_eq!(tally(&expected, &answers), 3);
        answers.insert("w-a".to_string(), 0);
        assert_eq!(tally(&expected, &answers), 2);
    }

    #[test]
    fn same_id_in_two_windows_stays_apart() {
        let mut m = HashMap::new();
        m.insert(key("main", "t1"), 1);
        m.insert(key("w-a", "t1"), 2);
        m.insert(key("main", "t2"), 3);
        let mut gone = take_owned(&mut m, "main");
        gone.sort();
        assert_eq!(gone, [1, 3]);
        assert_eq!(m.get(&key("w-a", "t1")), Some(&2));
    }

    #[test]
    fn a_label_prefix_is_not_ownership() {
        assert!(is_owned(&key("w-a", "x"), "w-a"));
        assert!(!is_owned(&key("w-ab", "x"), "w-a"));
        assert!(!is_owned("w-a", "w-a"));
    }

    #[test]
    fn requests_go_to_the_last_focused_open_window() {
        let open = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut order = Vec::new();
        assert_eq!(pick_target(&order, &open(&["w-b", "main"])).as_deref(), Some("main"));
        note_focus(&mut order, "main");
        note_focus(&mut order, "w-b");
        note_focus(&mut order, "main");
        note_focus(&mut order, "w-b");
        assert_eq!(order, ["w-b", "main"]);
        assert_eq!(pick_target(&order, &open(&["main", "w-b"])).as_deref(), Some("w-b"));
        assert_eq!(pick_target(&order, &open(&["main"])).as_deref(), Some("main"));
        assert_eq!(pick_target(&order, &[]), None);
    }
}
