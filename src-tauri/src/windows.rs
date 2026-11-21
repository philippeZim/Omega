//! Several windows in one process. Backend state that belongs to a window (terminals, language
//! servers, debuggers, Run tasks, the file watcher, searches) is keyed by the window's label, which
//! Tauri takes from the calling webview, so a frontend can't name another window's resources.
//!
//! Events for one window go through [`emit`]. Global on purpose: `tool-progress` (installed tools
//! are shared), `power-status` (one keep-awake state), `ide-clients` and `ide-connected` (one IDE
//! server).
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
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

/// The window's page is (re)loading: what its old page started has no UI any more.
pub fn page_loading(app: &AppHandle, label: &str) {
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        crate::pty::kill_window(&app, &label);
        crate::proc::kill_window(&app, &label);
        crate::search::cancel_window(&label);
    });
}

/// The window is gone: ends its processes and drops everything kept for it.
pub fn destroyed(app: &AppHandle, label: &str) {
    app.state::<FocusState>().order.lock().unwrap().retain(|l| l != label);
    crate::fs::forget_window(label);
    crate::ide_ws::forget_window(app, label);
    crate::codex_ipc::forget_window(app, label);
    crate::mcp_control::forget_window(app, label);
    page_loading(app, label);
}

#[cfg(test)]
mod tests {
    use super::*;

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
