//! Several Omega instances side by side (one per AI agent / worktree, or host + guest for collab
//! tests). Started with `OMEGA_INSTANCE=<name>` (normally via `dev/omega-mcp.mjs`), an instance
//! gets its own webview data (localStorage = settings, layout, MCP token), the control MCP on a
//! free port and a window title with its name. Installed tools (LSP servers, debuggers) stay shared.
//!
//! Every running control MCP — also the one of a normal Omega — announces itself in
//! `<runtime dir>/omega/instances/<pid>.json` (port, token, worktree), so the stdio proxy
//! `dev/omega-mcp.mjs` can find the instance that belongs to an agent's worktree.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Name of this instance (`OMEGA_INSTANCE`), `None` for a normal Omega.
pub fn name() -> Option<String> {
    let n = std::env::var("OMEGA_INSTANCE").ok()?;
    let n: String = n.trim().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    (!n.is_empty()).then_some(n)
}

/// Adjusts the compiled-in config before the app starts: own webview data per instance and the
/// dev server URL of this instance's Vite (`OMEGA_DEV_URL`, each instance runs its own).
pub fn apply(config: &mut tauri::Config) {
    if let Some(url) = std::env::var("OMEGA_DEV_URL").ok().and_then(|u| u.parse().ok()) {
        config.build.dev_url = Some(url);
    }
    for w in config.app.windows.iter_mut() {
        // Created in `windows::restore`, which knows the last session's windows.
        w.create = false;
    }
    let Some(name) = name() else { return };
    for w in config.app.windows.iter_mut() {
        w.title = format!("Omega – {name}");
        w.data_store_identifier = Some(store_id(&name)); // macOS: own WKWebsiteDataStore
    }
}

/// Builder for a window from the config. In instance mode it gets the instance's own webview data
/// directory (`<app local data>/instances/<name>`: localStorage, caches); the config's relative
/// `dataDirectory` isn't resolved against the app's data dir.
pub fn window_builder<'a>(app: &'a tauri::AppHandle, w: &tauri::utils::config::WindowConfig) -> tauri::Result<tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>> {
    use tauri::Manager;
    let builder = tauri::WebviewWindowBuilder::from_config(app, w)?;
    let Some(name) = name() else { return Ok(builder) };
    let dir = app.path().app_local_data_dir()?.join("instances").join(&name);
    Ok(builder.data_directory(dir).initialization_script(FRAMES_WHEN_HIDDEN).focused(false))
}

/// Hyprland desktop of test instances (`OMEGA_TEST_WORKSPACE`, default 5; empty turns it off).
fn test_workspace() -> Option<String> {
    name()?;
    std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let ws = std::env::var("OMEGA_TEST_WORKSPACE").unwrap_or_else(|_| "5".into());
    (!ws.is_empty()).then_some(ws)
}

fn hypr_json(what: &str) -> Option<Value> {
    let out = std::process::Command::new("hyprctl").args([what, "-j"]).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

fn hypr_dispatch(arg: String) {
    let _ = std::process::Command::new("hyprctl").args(["dispatch", &arg]).output();
}

/// This process's windows that aren't on the test desktop yet.
fn stray_windows(clients: &Value, pid: u64, ws: &str) -> Vec<String> {
    clients.as_array().into_iter().flatten()
        .filter(|c| c["pid"].as_u64() == Some(pid))
        .filter(|c| c["workspace"]["id"].as_i64().map(|i| i.to_string()).as_deref() != Some(ws) && c["workspace"]["name"].as_str() != Some(ws))
        .filter_map(|c| c["address"].as_str().map(str::to_string))
        .collect()
}

/// A test instance's new window never stays on the user's desktop: it moves to the test desktop
/// without following it, and the focus goes back to where it was.
pub fn to_test_desktop() {
    let Some(ws) = test_workspace() else { return };
    let pid = std::process::id() as u64;
    let before = hypr_json("activewindow").filter(|w| w["pid"].as_u64() != Some(pid)).and_then(|w| w["address"].as_str().map(str::to_string));
    std::thread::spawn(move || {
        for _ in 0..50 {
            let stray = hypr_json("clients").map(|c| stray_windows(&c, pid, &ws)).unwrap_or_default();
            for addr in &stray {
                hypr_dispatch(format!(r#"hl.dsp.window.move({{ workspace = "{ws}", follow = false, window = "address:{addr}" }})"#));
            }
            if !stray.is_empty() {
                if let Some(prev) = &before {
                    hypr_dispatch(format!(r#"hl.dsp.focus({{ window = "address:{prev}" }})"#));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

/// Test instances run on a desktop nobody looks at (Hyprland workspace 5). WebKit then pauses
/// `requestAnimationFrame`, which stalls screenshots (html-to-image waits for a frame) and
/// CodeMirror's layout measuring. In instances only, a frame callback therefore also runs after
/// 100 ms without a frame; when the window is visible the real frame comes first.
const FRAMES_WHEN_HIDDEN: &str = r#"(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const live = new Map();
  let next = 1;
  const drop = (id) => { const e = live.get(id); if (e) { live.delete(id); caf(e.r); clearTimeout(e.t); } return e; };
  window.requestAnimationFrame = (cb) => {
    const id = next++;
    const run = (t) => { if (drop(id)) cb(typeof t === "number" ? t : performance.now()); };
    live.set(id, { r: raf(run), t: setTimeout(run, 100) });
    return id;
  };
  window.cancelAnimationFrame = (id) => { drop(id); };
})();"#;

/// Stable 16-byte identifier for the macOS data store (FNV-1a over the name, twice).
fn store_id(name: &str) -> [u8; 16] {
    let fnv = |seed: u64| {
        name.bytes().fold(seed, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
    };
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&fnv(0xcbf29ce484222325).to_le_bytes());
    id[8..].copy_from_slice(&fnv(0x84222325cbf29ce4).to_le_bytes());
    id
}

/// SIGTERM / SIGINT (e.g. `omega-mcp.mjs stop`, Ctrl+C) → regular exit, so the webview writes
/// its localStorage and the exit cleanup (registry entry, IDE lock file) runs.
pub fn exit_on_signal(app: &tauri::AppHandle) {
    #[cfg(unix)]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
            crate::windows::exiting(&app);
            app.exit(0);
        });
    }
    #[cfg(not(unix))]
    let _ = app;
}

/// What the frontend needs to know at startup.
#[tauri::command]
pub fn instance_info() -> Value {
    json!({
        "name": name(),
        // A fixed port for the control MCP of this instance; otherwise a free one is picked.
        "mcpPort": std::env::var("OMEGA_MCP_PORT").ok().and_then(|p| p.parse::<u16>().ok()),
    })
}

pub fn registry_dir() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir);
    base.join("omega").join("instances")
}

/// Git worktree the instance belongs to: `OMEGA_WORKTREE`, else the repo around the working dir.
fn worktree() -> Option<String> {
    if let Ok(w) = std::env::var("OMEGA_WORKTREE") {
        return Some(w);
    }
    let cwd = std::env::current_dir().ok()?;
    let root = cwd.ancestors().find(|d| d.join(".git").exists()).unwrap_or(&cwd);
    Some(crate::env::norm(root.to_path_buf()))
}

fn entry_path(dir: &Path) -> PathBuf {
    dir.join(format!("{}.json", std::process::id()))
}

/// Announces the running control MCP (port + token); replaces an earlier announcement.
pub fn announce(port: u16, token: &str) {
    announce_in(&registry_dir(), port, token);
}

fn announce_in(dir: &Path, port: u16, token: &str) {
    remove_stale_in(dir);
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let entry = json!({
        "pid": std::process::id(),
        "name": name().unwrap_or_else(|| "default".into()),
        "port": port,
        "token": token,
        "worktree": worktree(),
        "devUrl": std::env::var("OMEGA_DEV_URL").ok(),
        "version": env!("CARGO_PKG_VERSION"),
        "started": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    // Write to a temp file first: the proxy must never read a half-written token.
    let tmp = dir.join(format!(".{}.json.tmp", std::process::id()));
    if std::fs::write(&tmp, entry.to_string()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, entry_path(dir));
    }
}

/// Removes our announcement (control MCP stopped / app exits).
pub fn withdraw() {
    let _ = std::fs::remove_file(entry_path(&registry_dir()));
}

/// Removes announcements of instances that are gone (killed / crashed).
fn remove_stale_in(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let pid = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_u64());
        if !pid.is_some_and(|pid| crate::env::pid_alive(pid as u32)) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_this_process_windows_off_the_test_desktop() {
        let clients = json!([
            { "pid": 7, "address": "0xa", "workspace": { "id": 1, "name": "1" } },
            { "pid": 7, "address": "0xb", "workspace": { "id": 5, "name": "5" } },
            { "pid": 8, "address": "0xc", "workspace": { "id": 1, "name": "1" } },
        ]);
        assert_eq!(stray_windows(&clients, 7, "5"), ["0xa"]);
    }

    #[test]
    fn store_id_is_stable_and_distinct() {
        assert_eq!(store_id("a"), store_id("a"));
        assert_ne!(store_id("a"), store_id("b"));
        assert_ne!(store_id("host")[..8], store_id("host")[8..]);
    }

    #[test]
    fn announce_writes_entry_and_cleans_stale() {
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("instances");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(reg.join("999999999.json"), r#"{"pid":999999999}"#).unwrap(); // dead
        std::fs::write(reg.join("broken.json"), "{").unwrap();
        announce_in(&reg, 4242, "secret");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(entry_path(&reg)).unwrap()).unwrap();
        assert_eq!(v["port"], 4242);
        assert_eq!(v["token"], "secret");
        assert_eq!(v["pid"], std::process::id());
        assert!(!reg.join("999999999.json").exists());
        assert!(!reg.join("broken.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(entry_path(&reg)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Re-announcing (port change) replaces the entry instead of adding a second one.
        announce_in(&reg, 4343, "secret");
        assert_eq!(std::fs::read_dir(&reg).unwrap().count(), 1);
    }
}
