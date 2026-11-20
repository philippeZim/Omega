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
    let Some(name) = name() else { return };
    for w in config.app.windows.iter_mut() {
        w.title = format!("Omega – {name}");
        w.data_store_identifier = Some(store_id(&name)); // macOS: own WKWebsiteDataStore
        // Created in `create_windows` instead, with an absolute data directory (the config's
        // relative `dataDirectory` isn't resolved against the app's data dir).
        w.create = false;
    }
}

/// Instance mode: creates the config windows with their own webview data directory
/// (`<app local data>/instances/<name>`: localStorage, caches).
pub fn create_windows(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    let Some(name) = name() else { return Ok(()) };
    let dir = app.path().app_local_data_dir()?.join("instances").join(&name);
    for w in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &w)?.data_directory(dir.clone()).build()?;
    }
    Ok(())
}

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
