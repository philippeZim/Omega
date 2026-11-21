//! Process environment shared by everything Omega spawns: the effective `PATH` (login-shell PATH
//! on macOS/Linux, the registry PATH on Windows, common tool folders and the tools Omega manages
//! itself), executable lookup (incl. `.exe`/`.cmd` on Windows), and path normalisation.
//!
//! Paths handed to the frontend always use `/` as separator (Windows accepts it everywhere), so
//! the UI can treat paths uniformly.
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
    let base = BASE_PATH.read().unwrap().clone().unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
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
    PATH.read().unwrap().clone().unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default())
}

#[cfg(unix)]
fn user_path() -> OsString {
    // GUI apps started from Finder / a desktop launcher don't get the PATH of the user's shell
    // profile (Homebrew, ~/.cargo/bin, uv, …). Ask the login shell, with a timeout.
    let current = std::env::var_os("PATH").unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
    let child = Command::new(&shell)
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
    let mut c = Command::new(program);
    c.env("PATH", path());
    c.envs(git_guard_env());
    c.env_remove(GIT_PARAMETERS);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
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
