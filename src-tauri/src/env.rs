//! Process environment shared by everything Omega spawns: the effective `PATH` (login-shell PATH
//! on macOS/Linux, the registry PATH on Windows, common tool folders and the tools Omega manages
//! itself), executable lookup (incl. `.exe`/`.cmd` on Windows), and path normalisation.
//!
//! Paths handed to the frontend always use `/` as separator (Windows accepts it everywhere), so
//! the UI can treat paths uniformly.
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{OnceLock, RwLock};

static TOOLS_DIR: OnceLock<PathBuf> = OnceLock::new();
/// PATH inherited from the user's environment (login shell / registry), without our additions.
static BASE_PATH: RwLock<Option<OsString>> = RwLock::new(None);
/// Effective PATH for children (BASE_PATH + common folders + managed tools).
static PATH: RwLock<Option<OsString>> = RwLock::new(None);

pub fn home() -> PathBuf {
    let h = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).or_else(|| std::env::var_os("HOME"));
    h.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

/// Path as the frontend sees it (forward slashes on Windows, no `\\?\` prefix).
pub fn norm(p: impl AsRef<Path>) -> String {
    let s = p.as_ref().to_string_lossy().to_string();
    if cfg!(windows) {
        s.strip_prefix(r"\\?\").unwrap_or(&s).replace('\\', "/")
    } else {
        s
    }
}

pub fn tools_dir() -> PathBuf {
    TOOLS_DIR.get().cloned().unwrap_or_else(|| home().join(".omega-tools"))
}

/// Must be called once at startup (before any process is spawned).
pub fn init(tools: PathBuf) {
    let _ = std::fs::create_dir_all(&tools);
    let _ = TOOLS_DIR.set(tools);
    *BASE_PATH.write().unwrap() = Some(user_path());
    rebuild();
}

/// Re-reads the user's PATH (e.g. after something was installed from outside) and managed tools.
pub fn refresh() {
    *BASE_PATH.write().unwrap() = Some(user_path());
    rebuild();
}

/// Recomputes the effective PATH (after a managed tool was installed).
pub fn rebuild() {
    let base = BASE_PATH.read().unwrap().clone().unwrap_or_else(inherited_path);
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&base).collect();
    let mut add = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    let h = home();
    add(h.join(".cargo").join("bin"));
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            add(PathBuf::from(&local).join("Microsoft").join("WinGet").join("Links"));
            add(PathBuf::from(&local).join("Programs").join("Python").join("Launcher"));
        }
        add(PathBuf::from(r"C:\Program Files\Git\cmd"));
        add(PathBuf::from(r"C:\Program Files\CMake\bin"));
        add(PathBuf::from(r"C:\Program Files\LLVM\bin"));
        add(PathBuf::from(r"C:\Program Files\nodejs"));
    } else {
        add(h.join(".local").join("bin"));
        add(PathBuf::from("/opt/homebrew/bin"));
        add(PathBuf::from("/usr/local/bin"));
        add(PathBuf::from("/usr/bin"));
        add(PathBuf::from("/bin"));
        add(PathBuf::from("/Library/TeX/texbin"));
    }
    // Tools Omega installed itself come last: the user's own installations win.
    for d in crate::tools::managed_bin_dirs() {
        add(d);
    }
    *PATH.write().unwrap() = std::env::join_paths(dirs).ok();
}

pub fn path() -> OsString {
    PATH.read().unwrap().clone().unwrap_or_else(inherited_path)
}

#[cfg(unix)]
fn user_path() -> OsString {
    // GUI apps started from Finder / a desktop launcher don't get the PATH of the user's shell
    // profile (Homebrew, ~/.cargo/bin, uv, …). Ask the login shell, with a timeout.
    let current = inherited_path();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
    let child = process(&shell)
        .args(["-l", "-c", "printf '__OMEGA_PATH__%s__END__' \"$PATH\""])
        .envs(git_guard_env())
        .env_remove(GIT_PARAMETERS)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn();
    let Ok(child) = child else { return current };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let Ok(Ok(out)) = rx.recv_timeout(std::time::Duration::from_secs(4)) else { return current };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(p) = text.split("__OMEGA_PATH__").nth(1).and_then(|s| s.split("__END__").next()) else { return current };
    // Login PATH first, then whatever we inherited that it lacks.
    let mut dirs: Vec<PathBuf> = std::env::split_paths(OsStr::new(p)).collect();
    for d in std::env::split_paths(&current) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or(current)
}

#[cfg(windows)]
fn user_path() -> OsString {
    // The registry holds the current PATH, including changes made after Omega started
    // (e.g. `winget install` in the terminal).
    let current = std::env::var_os("PATH").unwrap_or_default();
    let read = |key: &str| -> Option<String> {
        let out = command("reg").args(["query", key, "/v", "Path"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let line = text.lines().find(|l| l.trim_start().starts_with("Path") || l.trim_start().starts_with("PATH"))?;
        let value = line.split("REG_").nth(1)?.split_once(char::is_whitespace)?.1.trim().to_string();
        Some(expand_vars(&value))
    };
    let machine = read(r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
    let user = read(r"HKCU\Environment");
    let mut dirs: Vec<PathBuf> = Vec::new();
    for part in [machine, user].into_iter().flatten() {
        for d in std::env::split_paths(OsStr::new(&part)) {
            if !d.as_os_str().is_empty() && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    for d in std::env::split_paths(&current) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or(current)
}

#[cfg(windows)]
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                let name = &after[..j];
                out.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn exe_exts() -> Vec<String> {
    if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    } else {
        vec![]
    }
}

fn find_exe(p: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        // An extension-less file next to a .cmd is a shell script (node_modules/.bin) – skip it.
        for e in exe_exts() {
            let mut s = p.as_os_str().to_os_string();
            s.push(&e);
            let q = PathBuf::from(s);
            if q.is_file() {
                return Some(q);
            }
        }
        (p.extension().is_some() && p.is_file()).then(|| p.to_path_buf())
    } else {
        p.is_file().then(|| p.to_path_buf())
    }
}

/// Finds an executable: a path (with or without `.exe`) or a name looked up in the effective PATH.
pub fn which(cmd: &str) -> Option<PathBuf> {
    if cmd.is_empty() {
        return None;
    }
    if cmd.contains('/') || cmd.contains('\\') {
        return find_exe(Path::new(cmd));
    }
    std::env::split_paths(&path()).find_map(|d| find_exe(&d.join(cmd)))
}

/// A `Command` with the effective PATH and (on Windows) no console window popping up.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let name = program.as_ref().to_os_string();
    let mut c = process(program);
    c.env("PATH", path());
    c.envs(git_guard_env());
    c.env_remove(GIT_PARAMETERS);
    crate::tools::golang::apply_go_env(&mut c, &name);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// A bare `Command` with the user's environment instead of the AppImage's. Every process Omega
/// starts goes through this, `command` or `pty_command` (see the audit test below).
pub fn process(program: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(program);
    let fix = appimage_fix();
    for (k, v) in &fix.vars {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
    // AppRun changes into the AppDir, which is gone once this process ends.
    if fix.leave_cwd {
        c.current_dir(home());
    }
    c
}

/// `process` for a terminal.
pub fn pty_command(program: impl AsRef<OsStr>) -> portable_pty::CommandBuilder {
    let mut c = portable_pty::CommandBuilder::new(program);
    for (k, v) in &appimage_fix().vars {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        }
    }
    c
}

/// Set by the AppImage runtime about itself. Never meant for children.
const APPIMAGE_RUNTIME: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];
/// Overwritten by AppRun or its GTK hook: the earlier value only survives in the launch environment.
const APPIMAGE_REPLACED: [&str; 10] = ["PYTHONHOME", "GTK_DATA_PREFIX", "GTK_THEME", "GTK_EXE_PREFIX", "GTK_PATH", "GTK_IM_MODULE_FILE", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "GI_TYPELIB_PATH", "GIO_MODULE_DIR"];
/// AppRun puts its folders in front of these and keeps the earlier value behind them.
const APPIMAGE_PREPENDED: [&str; 8] = ["PATH", "LD_LIBRARY_PATH", "PYTHONPATH", "XDG_DATA_DIRS", "PERLLIB", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0"];

#[derive(Default)]
struct AppImageFix {
    /// What children need changed: a value to set, or `None` to remove the variable.
    vars: Vec<(String, Option<String>)>,
    leave_cwd: bool,
}

/// True for a folder of this AppImage or of an earlier one (a restart inherits its dead mount).
fn is_appimage_entry(entry: &str, appdir: &str) -> bool {
    let p = Path::new(entry);
    p.starts_with(appdir) || p.components().any(|c| c.as_os_str().to_str().is_some_and(|n| n.starts_with(".mount_") || n.starts_with("appimage_extracted_")))
}

/// Removes AppImage folders and the empty entries AppRun leaves (an empty entry means the current
/// directory). `None`: nothing is left of it.
pub(crate) fn strip_appdir(value: &str, appdir: &str) -> Option<String> {
    let kept: Vec<&str> = value.split(':').filter(|e| !e.is_empty() && !is_appimage_entry(e, appdir)).collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// The changes that give a child the user's environment. `launch` is the environment the AppImage
/// was started with, when it could be read; otherwise AppRun's edits are undone from the values.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn appimage_changes(appdir: &str, current: &dyn Fn(&str) -> Option<String>, launch: Option<&HashMap<String, String>>) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for name in APPIMAGE_RUNTIME.iter().chain(&APPIMAGE_REPLACED).chain(&APPIMAGE_PREPENDED) {
        let Some(now) = current(name) else { continue };
        let value = if APPIMAGE_RUNTIME.contains(name) {
            None
        } else if let Some(launch) = launch {
            launch.get(*name).and_then(|v| strip_appdir(v, appdir))
        } else if APPIMAGE_PREPENDED.contains(name) {
            let clean = strip_appdir(&now, appdir);
            // The GTK hook also adds one /usr/share in front of the user's value.
            if *name == "XDG_DATA_DIRS" {
                clean.and_then(|v| match v.strip_prefix("/usr/share") {
                    Some("") => None,
                    Some(rest) if rest.starts_with(':') => Some(rest[1..].to_string()),
                    _ => Some(v),
                })
            } else {
                clean
            }
        } else {
            None
        };
        if value.as_deref() != Some(now.as_str()) {
            out.push((name.to_string(), value));
        }
    }
    out
}

/// True if the value names the AppDir itself, not a neighbour that only shares its prefix.
fn mentions_appdir(value: &str, appdir: &str) -> bool {
    value.match_indices(appdir).any(|(i, _)| !value[i + appdir.len()..].starts_with(|c: char| c.is_alphanumeric() || matches!(c, '_' | '-' | '.')))
}

/// Variables outside the lists that still point into the AppDir (a GTK or GStreamer module path
/// from a newer linuxdeploy, say): AppDir entries leave a path list, anything else is removed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn appdir_leftovers(appdir: &str, vars: impl Iterator<Item = (String, String)>) -> Vec<(String, Option<String>)> {
    let listed = |k: &str| APPIMAGE_RUNTIME.contains(&k) || APPIMAGE_REPLACED.contains(&k) || APPIMAGE_PREPENDED.contains(&k);
    vars.filter(|(k, v)| !listed(k) && mentions_appdir(v, appdir))
        .map(|(k, v)| {
            let clean = strip_appdir(&v, appdir).filter(|c| !mentions_appdir(c, appdir));
            (k, clean)
        })
        .collect()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_environ(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|b| *b == 0)
        .filter_map(|e| std::str::from_utf8(e).ok()?.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The environment from before AppRun: the AppImage runtime keeps running next to Omega, as its
/// parent (extract-and-run) or its child (FUSE mount), with its original environment.
#[cfg(target_os = "linux")]
fn launch_env(appimage: &str) -> Option<HashMap<String, String>> {
    let target = std::fs::canonicalize(appimage).ok()?;
    let me = std::process::id();
    let mut pids = vec![unsafe { libc::getppid() } as u32];
    if let Ok(kids) = std::fs::read_to_string(format!("/proc/{me}/task/{me}/children")) {
        pids.extend(kids.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
    }
    let pid = pids.into_iter().find(|p| std::fs::read_link(format!("/proc/{p}/exe")).is_ok_and(|e| e == target))?;
    Some(parse_environ(&std::fs::read(format!("/proc/{pid}/environ")).ok()?))
}

#[cfg(target_os = "linux")]
fn detect_appimage_fix() -> AppImageFix {
    let (Ok(appdir), Ok(appimage)) = (std::env::var("APPDIR"), std::env::var("APPIMAGE")) else { return AppImageFix::default() };
    // A variable inherited from another AppImage says nothing about this binary.
    if !std::env::current_exe().is_ok_and(|e| e.starts_with(&appdir)) {
        return AppImageFix::default();
    }
    let launch = launch_env(&appimage);
    let mut vars = appimage_changes(&appdir, &|k| std::env::var(k).ok(), launch.as_ref());
    // A value that isn't UTF-8 can't be edited safely, so it goes if it names the AppDir.
    let all: Vec<(String, String, bool)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.to_string_lossy().into_owned(), v.to_str().is_some())))
        .collect();
    vars.extend(appdir_leftovers(&appdir, all.iter().filter(|e| e.2).map(|e| (e.0.clone(), e.1.clone()))));
    vars.extend(all.iter().filter(|e| !e.2 && mentions_appdir(&e.1, &appdir)).map(|e| (e.0.clone(), None)));
    AppImageFix {
        vars,
        leave_cwd: std::env::current_dir().is_ok_and(|d| d.starts_with(&appdir)),
    }
}

#[cfg(not(target_os = "linux"))]
fn detect_appimage_fix() -> AppImageFix {
    AppImageFix::default()
}

fn appimage_fix() -> &'static AppImageFix {
    static FIX: OnceLock<AppImageFix> = OnceLock::new();
    FIX.get_or_init(detect_appimage_fix)
}

/// PATH as the user had it, without the AppImage's folders.
fn inherited_path() -> OsString {
    match appimage_fix().vars.iter().find(|(k, _)| k == "PATH") {
        Some((_, v)) => v.clone().map(OsString::from).unwrap_or_default(),
        None => std::env::var_os("PATH").unwrap_or_default(),
    }
}

/// Opens a link in the default application, outside the AppImage's environment. Same schemes as
/// the opener plugin's default scope.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !["http://", "https://", "mailto:", "tel:"].iter().any(|s| lower.starts_with(s)) {
        return Err(format!("not allowed: {url}"));
    }
    if appimage_fix().vars.is_empty() {
        return tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string());
    }
    let launchers: [(&str, &[&str]); 2] = [("xdg-open", &[]), ("gio", &["open"])];
    for (program, args) in launchers {
        let mut c = command(program);
        c.args(args).arg(&url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Ok(mut child) = c.spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
    }
    Err("no program to open links found".into())
}

pub const GIT_PARAMETERS: &str = "GIT_CONFIG_PARAMETERS";

/// Environment that makes every git started by Omega (or by a tool, shell prompt or language server
/// it starts) refuse a bare repository it merely discovered. Otherwise a folder holding `HEAD`,
/// `config`, `objects/` and `refs/` is a repository whose `core.fsmonitor` runs on the next
/// `git status`, and a Code Together guest can create those files. Normal repositories, worktrees
/// and submodules aren't affected. Added after the user's own GIT_CONFIG_* entries.
///
/// Spawns must also remove `GIT_PARAMETERS`: git reads it after GIT_CONFIG_*, so an inherited
/// `safe.bareRepository=all` would win. Git sets it again itself for the children of a `git -c`.
pub fn git_guard_env() -> Vec<(String, String)> {
    git_guard_after(std::env::var("GIT_CONFIG_COUNT").ok().as_deref())
}

fn git_config_count(existing: Option<&str>) -> u32 {
    existing.and_then(|v| v.parse::<u32>().ok()).filter(|n| *n < i32::MAX as u32).unwrap_or(0)
}

fn git_guard_after(existing: Option<&str>) -> Vec<(String, String)> {
    let n = git_config_count(existing);
    vec![
        ("GIT_CONFIG_COUNT".into(), (n + 1).to_string()),
        (format!("GIT_CONFIG_KEY_{n}"), "safe.bareRepository".into()),
        (format!("GIT_CONFIG_VALUE_{n}"), "explicit".into()),
    ]
}

/// The GIT_CONFIG_* names a WSL shell needs forwarded for `git_guard_env` to hold there.
pub fn git_guard_wslenv() -> String {
    let n = git_config_count(std::env::var("GIT_CONFIG_COUNT").ok().as_deref());
    let mut names = vec!["GIT_CONFIG_COUNT".to_string()];
    for i in 0..=n {
        names.push(format!("GIT_CONFIG_KEY_{i}"));
        names.push(format!("GIT_CONFIG_VALUE_{i}"));
    }
    names.join(":")
}

/// `command` for a tool resolved via `which` (clear error if it isn't installed).
pub fn tool(cmd: &str) -> Result<Command, String> {
    which(cmd).map(command).ok_or_else(|| format!("{cmd}: not found"))
}

#[derive(serde::Serialize)]
pub struct Platform {
    os: &'static str,
    arch: &'static str,
    home: String,
    tmp: String,
    tools: String,
}

#[tauri::command]
pub fn platform_info() -> Platform {
    Platform {
        os: if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
        arch: std::env::consts::ARCH,
        home: norm(home()),
        tmp: norm(std::env::temp_dir()),
        tools: norm(tools_dir()),
    }
}

#[tauri::command]
pub fn refresh_path() {
    refresh();
}

/// True if a process with this pid exists (used to clean up stale lock files).
pub fn pid_alive(pid: u32) -> bool {
    if cfg!(target_os = "linux") {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    if cfg!(windows) {
        return command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()));
    }
    command("kill").args(["-0", &pid.to_string()]).output().is_ok_and(|o| o.status.success())
}

/// Writes an executable script for a test. A child process writes it: if this multi-threaded
/// test binary held the write handle, a `fork` on another thread could inherit it for a moment,
/// and running the script then fails with ETXTBSY ("Text file busy").
#[cfg(all(test, unix))]
pub(crate) fn write_test_script(path: &Path, text: &str) {
    use std::io::Write;
    let mut c = Command::new("sh").arg("-c").arg(r#"cat > "$1" && chmod 755 "$1""#).arg("sh").arg(path).stdin(std::process::Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    assert!(c.wait().unwrap().success());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_guard_comes_after_the_users_own_git_config() {
        let pairs = |v: Vec<(String, String)>| v.into_iter().map(|(a, b)| format!("{a}={b}")).collect::<Vec<_>>();
        assert_eq!(pairs(git_guard_after(None)), ["GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.bareRepository", "GIT_CONFIG_VALUE_0=explicit"]);
        assert_eq!(pairs(git_guard_after(Some("2"))), ["GIT_CONFIG_COUNT=3", "GIT_CONFIG_KEY_2=safe.bareRepository", "GIT_CONFIG_VALUE_2=explicit"]);
        assert_eq!(pairs(git_guard_after(Some("junk")))[0], "GIT_CONFIG_COUNT=1");
    }

    #[test]
    fn commands_carry_the_git_guard() {
        let c = command("anything");
        let keys: Vec<_> = c.get_envs().filter_map(|(k, v)| Some(format!("{}={}", k.to_str()?, v?.to_str()?))).collect();
        assert!(keys.iter().any(|k| k.ends_with("=safe.bareRepository")), "{keys:?}");
        assert!(keys.iter().any(|k| k.ends_with("=explicit")), "{keys:?}");
    }

    #[test]
    fn commands_drop_inherited_git_parameters() {
        let c = command("anything");
        assert!(c.get_envs().any(|(k, v)| k == GIT_PARAMETERS && v.is_none()), "must be removed, an inherited value beats the guard");
    }

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn changes(now: &[(&str, &str)], launch: Option<&[(&str, &str)]>) -> HashMap<String, Option<String>> {
        let now = vars(now);
        let launch = launch.map(vars);
        appimage_changes("/tmp/appimage_extracted_a", &|k| now.get(k).cloned(), launch.as_ref()).into_iter().collect()
    }

    #[test]
    fn strip_appdir_keeps_only_the_users_entries() {
        assert_eq!(strip_appdir("/tmp/.mount_x/usr/bin:/usr/bin", "/tmp/.mount_x").as_deref(), Some("/usr/bin"));
        assert_eq!(strip_appdir("/tmp/.mount_x/usr/lib", "/tmp/.mount_x"), None);
        // AppRun's trailing ":" would put the current directory on PYTHONPATH.
        assert_eq!(strip_appdir("/tmp/.mount_x/usr/share/pyshared/:", "/tmp/.mount_x"), None);
        // A dead mount inherited through a restart, and a neighbour that only shares the prefix.
        assert_eq!(strip_appdir("/tmp/.mount_old/usr/bin:/tmp/appimage_extracted_a2/x:/opt/b", "/tmp/.mount_new").as_deref(), Some("/opt/b"));
        assert_eq!(strip_appdir("/data/app/bin", "/data/app/b").as_deref(), Some("/data/app/bin"));
    }

    #[test]
    fn the_real_apprun_values_are_undone_without_a_launch_environment() {
        let a = "/tmp/appimage_extracted_a";
        let c = changes(
            &[
                ("APPDIR", a),
                ("APPIMAGE", "/h/Omega.AppImage"),
                ("PYTHONHOME", "/tmp/appimage_extracted_a/usr/"),
                ("PYTHONPATH", "/tmp/appimage_extracted_a/usr/share/pyshared/:"),
                ("GTK_THEME", "Adwaita:dark"),
                ("PATH", "/tmp/appimage_extracted_a/usr/bin/:/tmp/appimage_extracted_a/bin/:/home/u/bin:/usr/bin"),
                ("LD_LIBRARY_PATH", "/tmp/appimage_extracted_a/usr/lib/:/opt/lib"),
                ("XDG_DATA_DIRS", "/tmp/appimage_extracted_a/usr/share/:/tmp/appimage_extracted_a/usr/share:/usr/share:/usr/local/share:/usr/share"),
                ("HOME", "/home/u"),
            ],
            None,
        );
        for gone in ["APPDIR", "APPIMAGE", "PYTHONHOME", "PYTHONPATH", "GTK_THEME"] {
            assert_eq!(c[gone], None, "{gone}");
        }
        assert_eq!(c["PATH"].as_deref(), Some("/home/u/bin:/usr/bin"));
        assert_eq!(c["LD_LIBRARY_PATH"].as_deref(), Some("/opt/lib"));
        assert_eq!(c["XDG_DATA_DIRS"].as_deref(), Some("/usr/local/share:/usr/share"));
        assert!(!c.contains_key("HOME"));
    }

    #[test]
    fn the_launch_environment_restores_what_apprun_overwrote() {
        let c = changes(
            &[("APPDIR", "/tmp/appimage_extracted_a"), ("GTK_THEME", "Adwaita:dark"), ("PYTHONHOME", "/tmp/appimage_extracted_a/usr/"), ("PYTHONPATH", "/tmp/appimage_extracted_a/usr/share/pyshared/:/mine"), ("XDG_DATA_DIRS", "/tmp/appimage_extracted_a/usr/share/:/usr/share:/custom")],
            Some(&[("GTK_THEME", "Nord"), ("PYTHONHOME", "/opt/py"), ("PYTHONPATH", "/mine"), ("XDG_DATA_DIRS", "/custom")]),
        );
        assert_eq!(c["GTK_THEME"].as_deref(), Some("Nord"));
        assert_eq!(c["PYTHONHOME"].as_deref(), Some("/opt/py"));
        assert_eq!(c["PYTHONPATH"].as_deref(), Some("/mine"));
        assert_eq!(c["XDG_DATA_DIRS"].as_deref(), Some("/custom"));
        assert_eq!(c["APPDIR"], None);
    }

    #[test]
    fn a_value_the_user_set_and_apprun_kept_is_left_alone() {
        let c = changes(&[("APPDIR", "/tmp/appimage_extracted_a"), ("PERLLIB", "/mine")], Some(&[("PERLLIB", "/mine")]));
        assert!(!c.contains_key("PERLLIB"));
    }

    #[test]
    fn any_other_variable_pointing_into_the_appdir_is_cleaned() {
        let a = "/tmp/appimage_extracted_a";
        let env = [
            ("GIO_EXTRA_MODULES", "/tmp/appimage_extracted_a/usr/lib/gio:/opt/gio"),
            ("GST_PLUGIN_PATH", "/tmp/appimage_extracted_a/usr/lib/gst"),
            ("GDK_FLAGS", "--dir=/tmp/appimage_extracted_a/usr/share"),
            ("NEIGHBOUR", "/tmp/appimage_extracted_ab/bin"),
            ("EDITOR", "vim"),
            ("PATH", "/tmp/appimage_extracted_a/usr/bin:/usr/bin"),
        ];
        let got: HashMap<_, _> = appdir_leftovers(a, env.iter().map(|(k, v)| (k.to_string(), v.to_string()))).into_iter().collect();
        assert_eq!(got["GIO_EXTRA_MODULES"].as_deref(), Some("/opt/gio"));
        assert_eq!(got["GST_PLUGIN_PATH"], None);
        assert_eq!(got["GDK_FLAGS"], None);
        assert_eq!(got.len(), 3, "the lists handle PATH, others stay: {got:?}");
    }

    #[test]
    fn environ_is_parsed_with_equals_signs_in_values() {
        let e = parse_environ(b"A=1\0B=x=y\0broken\0");
        assert_eq!((e["A"].as_str(), e["B"].as_str(), e.len()), ("1", "x=y", 2));
    }

    /// Every process must get the user's environment, so spawning directly is a bug outside env.rs.
    #[test]
    fn no_process_is_started_around_the_central_helpers() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut bad = Vec::new();
        let mut dirs = vec![src];
        while let Some(d) = dirs.pop() {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") && p.file_name().unwrap() != "env.rs" {
                    let text = std::fs::read_to_string(&p).unwrap();
                    let code = text.split("mod tests {").next().unwrap();
                    for (i, l) in code.lines().enumerate() {
                        if l.contains("Command::new(") || l.contains("CommandBuilder::new(") {
                            bad.push(format!("{}:{}", p.display(), i + 1));
                        }
                    }
                }
            }
        }
        assert!(bad.is_empty(), "use env::process, env::command or env::pty_command: {bad:?}");
    }

    #[test]
    fn which_empty_is_none() {
        assert_eq!(which(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn which_direct_path() {
        assert_eq!(which("/bin/sh"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(which("/definitely/not/here/sh"), None);
        // A directory isn't an executable.
        assert_eq!(which("/bin"), None);
    }

    #[cfg(unix)]
    #[test]
    fn which_name_on_path() {
        assert!(which("sh").is_some_and(|p| p.is_absolute() && p.ends_with("sh")));
        assert_eq!(which("omega-surely-not-an-executable-xyz"), None);
    }

    #[cfg(unix)]
    #[test]
    fn norm_is_identity_on_unix() {
        for s in ["/home/u/a b/c.txt", "rel/path", "with\\backslash", ""] {
            assert_eq!(norm(s), s);
        }
    }

    #[cfg(windows)]
    #[test]
    fn norm_windows() {
        assert_eq!(norm(r"\\?\C:\Users\u\x.txt"), "C:/Users/u/x.txt");
        assert_eq!(norm(r"C:\a\b"), "C:/a/b");
    }

    #[cfg(windows)]
    #[test]
    fn expand_vars_cases() {
        let root = std::env::var("SystemRoot").expect("SystemRoot set on Windows");
        assert_eq!(expand_vars(r"%SystemRoot%\System32"), format!(r"{root}\System32"));
        assert_eq!(expand_vars("%SystemRoot%;%SystemRoot%"), format!("{root};{root}"));
        assert_eq!(expand_vars(r"C:\plain"), r"C:\plain");
        assert_eq!(expand_vars("%OMEGA_SURELY_UNSET_VAR%\\x"), "%OMEGA_SURELY_UNSET_VAR%\\x");
        assert_eq!(expand_vars("100% sure"), "100% sure");
        assert_eq!(expand_vars("a%b"), "a%b");
        assert_eq!(expand_vars(""), "");
    }
}
