//! Keep the machine awake (also with the lid closed) while an AI agent – Claude Code, Codex or
//! OpenCode – runs in one of Omega's terminals.
//!
//! A background thread looks at the process trees of all terminal shells every few seconds and
//! holds a platform "inhibitor" while an agent is found:
//! - Linux: a logind block inhibitor (`systemd-inhibit --what=handle-lid-switch:sleep:idle`).
//! - Windows: lid action temporarily set to "do nothing" (powercfg) + `SetThreadExecutionState`.
//!   The previous lid values are saved to a file and restored, also after a crash.
//! - macOS: `caffeinate` against idle sleep; for the lid `pmset -a disablesleep 1`, which needs
//!   an admin password (asked via the system dialog, restored when the agent ends).
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static ENABLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<Status> = Mutex::new(Status { active: false, agent: None, lid: false, error: None });

const AGENTS: [&str; 3] = ["claude", "codex", "opencode"];
const POLL: Duration = Duration::from_secs(4);
/// Release only after the agent has been gone this long (avoids repeated password prompts on
/// macOS when an agent is restarted).
const GRACE: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone)]
pub struct Status {
    /// The inhibitor is held.
    active: bool,
    /// Name of the agent that keeps the machine awake.
    agent: Option<String>,
    /// Closing the lid is covered as well (not only idle sleep).
    lid: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn power_keep_awake(app: AppHandle, enabled: bool) -> Status {
    ENABLED.store(enabled, Ordering::SeqCst);
    if !STARTED.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || monitor(app));
    }
    STATUS.lock().unwrap().clone()
}

#[tauri::command]
pub fn power_status() -> Status {
    STATUS.lock().unwrap().clone()
}

/// Called on app exit: release everything (restores the Windows/macOS lid settings).
pub fn cleanup() {
    ENABLED.store(false, Ordering::SeqCst);
    if let Some(mut h) = HELD.lock().unwrap().take() {
        h.release();
    }
}

static HELD: Mutex<Option<Inhibitor>> = Mutex::new(None);

fn monitor(app: AppHandle) {
    let dir = app.path().app_data_dir().ok();
    platform::recover(dir.as_deref());
    let mut last_seen: Option<Instant> = None;
    loop {
        let agent = if ENABLED.load(Ordering::SeqCst) { find_agent(&crate::pty::shell_pids(&app)) } else { None };
        if agent.is_some() {
            last_seen = Some(Instant::now());
        }
        let want = ENABLED.load(Ordering::SeqCst) && last_seen.is_some_and(|t| t.elapsed() < GRACE);
        let mut held = HELD.lock().unwrap();
        let changed = match (want, held.is_some()) {
            (true, false) => {
                *held = Some(Inhibitor::acquire(dir.as_deref()));
                true
            }
            (false, true) => {
                held.take().unwrap().release();
                last_seen = None;
                true
            }
            _ => false,
        };
        if let Some(h) = held.as_mut() {
            h.tick();
        }
        let status = Status {
            active: held.is_some(),
            agent: if held.is_some() { agent.or_else(|| STATUS.lock().unwrap().agent.clone()) } else { None },
            lid: held.as_ref().is_some_and(|h| h.lid),
            error: held.as_ref().and_then(|h| h.error.clone()),
        };
        drop(held);
        let prev = std::mem::replace(&mut *STATUS.lock().unwrap(), status.clone());
        if changed || prev.agent != status.agent || prev.error != status.error {
            let _ = app.emit("power-status", status);
        }
        std::thread::sleep(POLL);
    }
}

/// First AI agent found below one of the given shell processes.
fn find_agent(roots: &[u32]) -> Option<String> {
    if roots.is_empty() {
        return None;
    }
    let procs = platform::processes();
    let mut stack: Vec<u32> = roots.to_vec();
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for p in procs.iter().filter(|p| p.ppid == pid) {
            if let Some(a) = agent_name(p) {
                return Some(a.to_string());
            }
            stack.push(p.pid);
        }
    }
    None
}

struct Proc {
    pid: u32,
    ppid: u32,
    name: String,
    /// Full command line (may be empty when unavailable).
    args: String,
}

fn agent_name(p: &Proc) -> Option<&'static str> {
    let name = p.name.to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    if let Some(a) = AGENTS.iter().find(|a| **a == name) {
        return Some(a);
    }
    // npm installs run under node/bun: look at the script path.
    if ["node", "bun", "deno"].contains(&name) {
        let args = p.args.to_lowercase().replace('\\', "/");
        if args.contains("@anthropic-ai/claude-code") || args.contains("/bin/claude") {
            return Some("claude");
        }
        if args.contains("@openai/codex") || args.contains("/bin/codex") {
            return Some("codex");
        }
        if args.contains("opencode") {
            return Some("opencode");
        }
    }
    None
}

struct Inhibitor {
    lid: bool,
    error: Option<String>,
    inner: platform::Handle,
}

impl Inhibitor {
    fn acquire(dir: Option<&std::path::Path>) -> Self {
        let (inner, lid, error) = platform::acquire(dir);
        Inhibitor { lid, error, inner }
    }
    fn tick(&mut self) {
        platform::tick(&mut self.inner);
    }
    fn release(&mut self) {
        platform::release(&mut self.inner);
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::Proc;
    use std::path::Path;
    use std::process::{Child, Stdio};

    pub type Handle = Option<Child>;

    pub fn recover(_: Option<&Path>) {}

    pub fn processes() -> Vec<Proc> {
        let mut v = Vec::new();
        let Ok(dir) = std::fs::read_dir("/proc") else { return v };
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
            // "pid (comm) state ppid …" – comm may contain spaces/parentheses.
            let Some(close) = stat.rfind(')') else { continue };
            let name = stat[stat.find('(').map_or(0, |i| i + 1)..close].to_string();
            let Some(ppid) = stat[close + 1..].split_whitespace().nth(1).and_then(|s| s.parse().ok()) else { continue };
            let args = if ["node", "bun", "deno"].contains(&name.as_str()) {
                std::fs::read(e.path().join("cmdline")).map(|b| String::from_utf8_lossy(&b).replace('\0', " ")).unwrap_or_default()
            } else {
                String::new()
            };
            v.push(Proc { pid, ppid, name, args });
        }
        v
    }

    pub fn acquire(_: Option<&Path>) -> (Handle, bool, Option<String>) {
        // `tail --pid` ends together with Omega, so a crash can't leave the inhibitor behind.
        let me = std::process::id().to_string();
        let child = std::process::Command::new("systemd-inhibit")
            .args(["--what=handle-lid-switch:sleep:idle", "--who=Omega", "--why=AI agent running in a terminal", "--mode=block"])
            .args(["tail", "--pid", &me, "-f", "/dev/null"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match child {
            Ok(c) => (Some(c), true, None),
            Err(e) => (None, false, Some(format!("systemd-inhibit: {e}"))),
        }
    }

    pub fn tick(_: &mut Handle) {}

    pub fn release(h: &mut Handle) {
        if let Some(mut c) = h.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Proc;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Stdio};

    pub struct Handle {
        caffeinate: Option<Child>,
        marker: Option<PathBuf>,
    }

    fn marker(dir: Option<&Path>) -> Option<PathBuf> {
        dir.map(|d| d.join("pmset-disablesleep"))
    }

    /// `pmset` needs root: ask for the admin password with the system dialog.
    fn pmset(value: u8) -> Result<(), String> {
        let script = format!("do shell script \"/usr/bin/pmset -a disablesleep {value}\" with administrator privileges with prompt \"Omega: keep the Mac awake with the lid closed while an AI agent is running\"");
        let out = std::process::Command::new("osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    }

    /// Omega crashed while the lid setting was changed: turn it back.
    pub fn recover(dir: Option<&Path>) {
        if let Some(m) = marker(dir).filter(|m| m.exists()) {
            if pmset(0).is_ok() {
                let _ = std::fs::remove_file(m);
            }
        }
    }

    pub fn processes() -> Vec<Proc> {
        let Ok(out) = std::process::Command::new("ps").args(["-Ao", "pid=,ppid=,comm=,args="]).output() else { return vec![] };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                let pid = it.next()?.parse().ok()?;
                let ppid = it.next()?.parse().ok()?;
                let comm = it.next()?;
                let name = comm.rsplit('/').next().unwrap_or(comm).to_string();
                Some(Proc { pid, ppid, name, args: it.collect::<Vec<_>>().join(" ") })
            })
            .collect()
    }

    pub fn acquire(dir: Option<&Path>) -> (Handle, bool, Option<String>) {
        let me = std::process::id().to_string();
        let caffeinate = std::process::Command::new("caffeinate")
            .args(["-ims", "-w", &me])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
        let (marker, error) = match pmset(1) {
            Ok(()) => {
                let m = marker(dir);
                if let Some(m) = &m {
                    let _ = std::fs::write(m, "1");
                }
                (m.or(Some(PathBuf::new())), None)
            }
            Err(e) => (None, Some(format!("pmset: {e}"))),
        };
        let lid = marker.is_some();
        (Handle { caffeinate, marker }, lid, error)
    }

    pub fn tick(_: &mut Handle) {}

    pub fn release(h: &mut Handle) {
        if let Some(mut c) = h.caffeinate.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(m) = h.marker.take() {
            if pmset(0).is_ok() && !m.as_os_str().is_empty() {
                let _ = std::fs::remove_file(m);
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::Proc;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

    pub struct Handle {
        /// Lid values (AC, DC) before Omega changed them.
        saved: Option<(u32, u32)>,
        marker: Option<PathBuf>,
    }

    fn marker(dir: Option<&Path>) -> Option<PathBuf> {
        dir.map(|d| d.join("lidaction-saved"))
    }

    fn powercfg(args: &[&str]) -> Result<String, String> {
        let out = crate::env::command("powercfg").args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
    }

    /// Current (AC, DC) lid action. The output is localized, but the last two hex numbers are
    /// always the AC and DC index.
    fn lid_values() -> Result<(u32, u32), String> {
        let out = powercfg(&["/query", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION"])?;
        let hex: Vec<u32> = out
            .lines()
            .filter_map(|l| l.trim().rsplit(' ').next())
            .filter(|w| w.starts_with("0x") && w.len() == 10)
            .filter_map(|w| u32::from_str_radix(&w[2..], 16).ok())
            .collect();
        match hex.as_slice() {
            [.., ac, dc] => Ok((*ac, *dc)),
            _ => Err("powercfg: unexpected output".into()),
        }
    }

    fn set_lid(ac: u32, dc: u32) -> Result<(), String> {
        powercfg(&["/setacvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", &ac.to_string()])?;
        powercfg(&["/setdcvalueindex", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", &dc.to_string()])?;
        powercfg(&["/setactive", "SCHEME_CURRENT"]).map(|_| ())
    }

    pub fn recover(dir: Option<&Path>) {
        let Some(m) = marker(dir) else { return };
        let Ok(s) = std::fs::read_to_string(&m) else { return };
        let v: Vec<u32> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if let [ac, dc] = v[..] {
            if set_lid(ac, dc).is_ok() {
                let _ = std::fs::remove_file(m);
            }
        }
    }

    pub fn processes() -> Vec<Proc> {
        let mut v = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return v;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e) != 0;
            while ok {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]);
                v.push(Proc { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name, args: String::new() });
                ok = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        // The snapshot has no command lines; npm-installed agents run as node.exe, so look up
        // those (once per process) to see which script they run.
        let mut cache = CMDLINES.lock().unwrap();
        cache.retain(|pid, _| v.iter().any(|p| p.pid == *pid));
        for p in v.iter_mut().filter(|p| ["node.exe", "bun.exe", "deno.exe"].contains(&p.name.to_lowercase().as_str())) {
            let pid = p.pid;
            p.args = cache
                .entry(pid)
                .or_insert_with(|| {
                    let filter = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
                    crate::env::command("powershell.exe")
                        .args(["-NoProfile", "-NonInteractive", "-Command", &filter])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                        .unwrap_or_default()
                })
                .clone();
        }
        v
    }

    static CMDLINES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<u32, String>>> = std::sync::LazyLock::new(Default::default);

    pub fn acquire(dir: Option<&Path>) -> (Handle, bool, Option<String>) {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        let mut h = Handle { saved: None, marker: marker(dir) };
        let res = lid_values().and_then(|(ac, dc)| {
            if let Some(m) = &h.marker {
                let _ = std::fs::write(m, format!("{ac} {dc}"));
            }
            h.saved = Some((ac, dc));
            set_lid(0, 0)
        });
        match res {
            Ok(()) => (h, true, None),
            Err(e) => (h, false, Some(e)),
        }
    }

    /// `SetThreadExecutionState` belongs to the calling thread – the monitor thread – and is
    /// refreshed on every poll.
    pub fn tick(_: &mut Handle) {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
    }

    pub fn release(h: &mut Handle) {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        if let Some((ac, dc)) = h.saved.take() {
            if set_lid(ac, dc).is_ok() {
                if let Some(m) = h.marker.take() {
                    let _ = std::fs::remove_file(m);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_processes() {
        let procs = super::platform::processes();
        assert!(procs.iter().any(|p| p.pid == std::process::id()));
    }
}
