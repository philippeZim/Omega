//! The `omega` command: `omega [--] [folder|file]…`.
//!
//! One running app per profile. The first process holds a lock and listens on a private channel;
//! later ones check their paths against their own working directory, hand them over and exit, so
//! the terminal is free at once. Started from a terminal with nothing running, the process starts
//! a detached copy of itself and exits.
//!
//! The profile is the instance (`OMEGA_INSTANCE` + worktree), so a test instance never reaches the
//! user's Omega or another worktree's. The channel is private to the user: a Unix socket in a 0700
//! folder whose peer's uid is checked; on Windows a loopback port with a secret token in the
//! user's local app data.
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const DETACHED_ENV: &str = "OMEGA_DETACHED";
/// Set only on the process a restart starts: the pid of the process it replaces.
const RELAUNCH_ENV: &str = "OMEGA_RELAUNCH_PID";
const MAX_PATHS: usize = 256;
const MAX_REQUEST: u64 = 1024 * 1024;
/// How long a second process waits for a first one that is still starting.
const WAIT_FOR_APP: Duration = Duration::from_secs(15);
/// A mark older than this is from a restart that never happened.
const RELAUNCH_MARK_AGE: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(5);

const USAGE: &str = "Usage: omega [--] [folder|file]...\n\n  omega            open Omega\n  omega .          open the current folder\n  omega <folder>   focus its window, or open a new one\n  omega <file>     open it as a tab in the active window\n  omega -- -name   open a path that starts with a dash\n";

/// Absolute, resolved paths to open.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Parsed {
    Help,
    Version,
    Open(Request),
}

fn resolve(arg: &OsStr, cwd: &Path, req: &mut Request) -> Result<(), String> {
    let shown = arg.to_string_lossy();
    let real = cwd.join(arg).canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { format!("no such file or folder: {shown}") } else { format!("{shown}: {e}") }
    })?;
    if real.to_str().is_none() {
        return Err(format!("path is not valid UTF-8, which Omega can't open: {shown}"));
    }
    let meta = real.metadata().map_err(|e| format!("{shown}: {e}"))?;
    let path = crate::env::norm(&real);
    if meta.is_dir() {
        req.dirs.push(path);
    } else if meta.is_file() {
        req.files.push(path);
    } else {
        return Err(format!("not a file or folder: {shown}"));
    }
    Ok(())
}

/// `lenient`: a detached copy has no terminal to complain to, so it skips what it can't open.
fn parse(args: Vec<OsString>, cwd: &Path, lenient: bool) -> Result<Parsed, String> {
    let mut req = Request::default();
    let mut only_paths = false;
    for arg in args {
        if !only_paths {
            match arg.to_str() {
                Some("--") => {
                    only_paths = true;
                    continue;
                }
                Some("-h" | "--help") => return Ok(Parsed::Help),
                Some("-v" | "--version") => return Ok(Parsed::Version),
                // Finder's process serial number on older macOS.
                Some(a) if a.starts_with("-psn_") => continue,
                _ => {}
            }
            if arg.as_encoded_bytes().first() == Some(&b'-') {
                if lenient {
                    continue;
                }
                return Err(format!("unknown option: {} (use `omega -- {0}` for a path)", arg.to_string_lossy()));
            }
        }
        match resolve(&arg, cwd, &mut req) {
            Err(_) if lenient => continue,
            r => r?,
        }
        if req.dirs.len() + req.files.len() > MAX_PATHS {
            return Err(format!("too many paths (at most {MAX_PATHS})"));
        }
    }
    Ok(Parsed::Open(req))
}

/// The receiver doesn't trust the sender's paths: absolute, still there, of the right kind.
pub fn validated(req: Request) -> Request {
    let check = |list: Vec<String>, want_dir: bool| -> Vec<String> {
        list.into_iter()
            .take(MAX_PATHS)
            .filter(|p| Path::new(p).is_absolute())
            .filter_map(|p| {
                let real = Path::new(&p).canonicalize().ok()?;
                real.to_str()?;
                let m = real.metadata().ok()?;
                (if want_dir { m.is_dir() } else { m.is_file() }).then(|| crate::env::norm(&real))
            })
            .collect()
    };
    Request { dirs: check(req.dirs, true), files: check(req.files, false) }
}

fn read_request<R: Read>(stream: R) -> Option<Request> {
    let mut line = String::new();
    BufReader::new(stream.take(MAX_REQUEST)).read_line(&mut line).ok()?;
    if !line.ends_with('\n') {
        return None; // cut off at the limit, or the sender went away
    }
    serde_json::from_str(&line).ok()
}

// ------------------------------------------------------------------ profile and private folder

fn fnv(parts: &[&str]) -> u64 {
    parts.iter().flat_map(|p| p.bytes().chain([0])).fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

/// File name stem of this profile's lock and channel. Instances are keyed by name and worktree; a
/// debug build outside an instance by its binary, so it can't reach an installed Omega.
fn profile_key(instance: Option<&str>, worktree: Option<&str>, debug_exe: Option<&str>) -> String {
    let h = match (instance, debug_exe) {
        (Some(n), _) => fnv(&["instance", n, worktree.unwrap_or("")]),
        (None, Some(exe)) => fnv(&["debug", exe]),
        (None, None) => fnv(&["default"]),
    };
    format!("cli-{h:016x}")
}

fn this_profile() -> String {
    let worktree = std::env::var("OMEGA_WORKTREE").ok();
    let exe = cfg!(debug_assertions).then(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())).flatten();
    profile_key(crate::instance::name().as_deref(), worktree.as_deref(), Some(exe.as_deref().unwrap_or("")).filter(|_| cfg!(debug_assertions)))
}

/// A folder only this user can use: created 0700; anything else there is refused.
#[cfg(unix)]
fn private_dir(dir: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir);
    let m = std::fs::symlink_metadata(dir).ok()?;
    let uid = unsafe { libc::geteuid() };
    (m.is_dir() && m.uid() == uid && m.mode() & 0o077 == 0).then(|| dir.to_path_buf())
}

/// Where the lock and channel live. On macOS `TMPDIR` differs between a terminal and a launched
/// app, so two starts would miss each other there: it uses a folder in the home instead.
#[cfg(unix)]
fn runtime_path(xdg: Option<PathBuf>, home: &Path, temp: &Path, macos: bool, uid: u32) -> PathBuf {
    match xdg {
        Some(b) => b.join("omega").join("cli"),
        None if macos => home.join("Library").join("Application Support").join("Omega").join("cli"),
        None => temp.join(format!("omega-{uid}")),
    }
}

#[cfg(unix)]
fn runtime_dir() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir());
    private_dir(&runtime_path(xdg, &crate::env::home(), &std::env::temp_dir(), cfg!(target_os = "macos"), unsafe { libc::geteuid() }))
}

#[cfg(windows)]
fn runtime_dir() -> Option<PathBuf> {
    // The profile's local app data is only accessible to this user.
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Omega").join("cli");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

// ------------------------------------------------------------------ channel

#[cfg(unix)]
mod channel {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub type Listener = UnixListener;
    pub type Stream = UnixStream;

    fn path(dir: &Path, key: &str) -> PathBuf {
        dir.join(format!("{key}.sock"))
    }

    pub fn bind(dir: &Path, key: &str) -> std::io::Result<Listener> {
        use std::os::unix::fs::PermissionsExt;
        let p = path(dir, key);
        // We hold the profile's lock, so whatever is here is left over from a crash.
        let _ = std::fs::remove_file(&p);
        let l = UnixListener::bind(&p)?;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
        Ok(l)
    }

    pub fn connect(dir: &Path, key: &str) -> std::io::Result<Stream> {
        UnixStream::connect(path(dir, key))
    }

    pub fn remove(dir: &Path, key: &str) {
        let _ = std::fs::remove_file(path(dir, key));
    }

    #[cfg(target_os = "linux")]
    pub fn peer_uid(s: &Stream) -> Option<u32> {
        use std::os::fd::AsRawFd;
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let r = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
        (r == 0).then_some(cred.uid)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn peer_uid(s: &Stream) -> Option<u32> {
        use std::os::fd::AsRawFd;
        let (mut uid, mut gid) = (0, 0);
        (unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
    }

    /// Only the same user may hand over paths.
    pub fn admit(s: &mut Stream, _key: &str, _dir: &Path) -> bool {
        peer_uid(s) == Some(unsafe { libc::geteuid() })
    }

    pub fn introduce(_s: &mut Stream, _dir: &Path, _key: &str) -> std::io::Result<()> {
        Ok(())
    }

    pub fn timeouts(s: &Stream) {
        let _ = s.set_read_timeout(Some(IO_TIMEOUT));
        let _ = s.set_write_timeout(Some(IO_TIMEOUT));
    }
}

#[cfg(windows)]
mod channel {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener, TcpStream};

    pub type Listener = TcpListener;
    pub type Stream = TcpStream;

    fn path(dir: &Path, key: &str) -> PathBuf {
        dir.join(format!("{key}.port"))
    }

    pub fn bind(dir: &Path, key: &str) -> std::io::Result<Listener> {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let mut b = [0u8; 24];
        getrandom::fill(&mut b).map_err(std::io::Error::other)?;
        let token: String = b.iter().map(|x| format!("{x:02x}")).collect();
        std::fs::write(path(dir, key), format!("{} {token}", l.local_addr()?.port()))?;
        Ok(l)
    }

    fn read_info(dir: &Path, key: &str) -> std::io::Result<(u16, String)> {
        let text = std::fs::read_to_string(path(dir, key))?;
        let (port, token) = text.trim().split_once(' ').ok_or(std::io::ErrorKind::InvalidData)?;
        Ok((port.parse().map_err(|_| std::io::ErrorKind::InvalidData)?, token.to_string()))
    }

    pub fn connect(dir: &Path, key: &str) -> std::io::Result<Stream> {
        let (port, _) = read_info(dir, key)?;
        TcpStream::connect((Ipv4Addr::LOCALHOST, port))
    }

    pub fn remove(dir: &Path, key: &str) {
        let _ = std::fs::remove_file(path(dir, key));
    }

    /// The first line must be the token from the user's private folder.
    pub fn admit(s: &mut Stream, key: &str, dir: &Path) -> bool {
        let Ok((_, token)) = read_info(dir, key) else { return false };
        let mut got = vec![0u8; token.len() + 1];
        if s.read_exact(&mut got).is_err() || got.pop() != Some(b'\n') || got.len() != token.len() {
            return false;
        }
        got.iter().zip(token.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
    }

    pub fn introduce(s: &mut Stream, dir: &Path, key: &str) -> std::io::Result<()> {
        let (_, token) = read_info(dir, key)?;
        s.write_all(format!("{token}\n").as_bytes())
    }

    pub fn timeouts(s: &Stream) {
        let _ = s.set_read_timeout(Some(IO_TIMEOUT));
        let _ = s.set_write_timeout(Some(IO_TIMEOUT));
    }
}

fn forward(dir: &Path, key: &str, req: &Request) -> std::io::Result<()> {
    let mut s = channel::connect(dir, key)?;
    channel::timeouts(&s);
    channel::introduce(&mut s, dir, key)?;
    let mut line = serde_json::to_vec(req).map_err(std::io::Error::other)?;
    line.push(b'\n');
    s.write_all(&line)?;
    let mut ack = [0u8; 3];
    s.read_exact(&mut ack)?;
    if &ack == b"ok\n" { Ok(()) } else { Err(std::io::ErrorKind::InvalidData.into()) }
}

// ------------------------------------------------------------------ detaching

#[cfg(unix)]
fn from_terminal() -> bool {
    [0, 1, 2].iter().any(|fd| unsafe { libc::isatty(*fd) } == 1)
}

#[cfg(windows)]
fn from_terminal() -> bool {
    use windows_sys::Win32::System::Console::{AttachConsole, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    use std::os::windows::io::IntoRawHandle;
    // A GUI program has no console; attach to the caller's so messages reach its terminal.
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
        return false;
    }
    if let Ok(out) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
        let h = out.into_raw_handle();
        unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, h as _);
            SetStdHandle(STD_ERROR_HANDLE, h as _);
        }
    }
    true
}

/// The app bundle around this binary (macOS), launched through LaunchServices.
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

fn detached_command(req: &Request) -> std::io::Result<std::process::Command> {
    let exe = std::env::current_exe()?;
    let paths = req.dirs.iter().chain(&req.files);
    let mut c;
    if let (true, Some(bundle)) = (cfg!(target_os = "macos"), app_bundle(&exe)) {
        c = crate::env::process("/usr/bin/open");
        c.arg("-a").arg(bundle).arg("--args").arg("--").args(paths);
    } else {
        // Inside an AppImage the binary lives in a mount that ends with this process.
        c = crate::env::process(std::env::var_os("APPIMAGE").unwrap_or_else(|| exe.into_os_string()));
        c.arg("--").args(paths);
    }
    c.env(DETACHED_ENV, "1").current_dir(crate::env::home()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        c.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x8;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
        c.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    Ok(c)
}

/// Whether to start a detached copy: from a terminal, unless this already is one or a restart.
/// Debug builds stay attached so `cargo run` keeps its logs; `OMEGA_DETACH=1` tests the real path.
fn should_detach(terminal: bool, detached: bool, relaunch: bool, debug: bool, no_detach: bool, force: bool) -> bool {
    terminal && !detached && !relaunch && !no_detach && (!debug || force)
}

// ------------------------------------------------------------------ restart after an update

fn relaunch_mark(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.relaunch"))
}

/// The mark names the old process. Only what that process started itself counts as its restart.
fn mark_is_for(text: &str, starters: &[u32], by_launchd: bool) -> bool {
    text.trim().parse::<u32>().is_ok_and(|pid| pid != 0 && (by_launchd || starters.contains(&pid)))
}

/// Consumes the mark the old process left. Tauri's restart starts the new process while the old
/// one still holds the lock; without the mark it would hand over to the dying process and exit.
/// Any other `omega` leaves the mark alone and starts normally; a stale one is removed.
fn take_relaunch_mark(dir: &Path, key: &str, max_age: Duration, starters: impl FnOnce() -> Vec<u32>, by_launchd: bool) -> bool {
    let path = relaunch_mark(dir, key);
    let Ok(meta) = std::fs::symlink_metadata(&path) else { return false };
    if !meta.is_file() || !meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age <= max_age) {
        let _ = std::fs::remove_file(&path);
        return false;
    }
    let ours = std::fs::read_to_string(&path).is_ok_and(|t| mark_is_for(&t, &starters(), by_launchd));
    if ours {
        let _ = std::fs::remove_file(&path);
    }
    ours
}

/// The process this one replaces, as told by the restart. The parent can't say: the old process
/// exits right after starting this one, often before this line runs.
fn restart_starters(value: Option<&OsStr>) -> Vec<u32> {
    value.and_then(OsStr::to_str).and_then(|v| v.parse().ok()).into_iter().collect()
}

/// Starts the replacement of this process, detached from it. An AppImage's mount ends with the old
/// process, so the new one must not depend on anything of it.
#[cfg(not(target_os = "macos"))]
pub fn spawn_relaunch() -> std::io::Result<()> {
    let mut c = detached_command(&Request::default())?;
    c.env(RELAUNCH_ENV, std::process::id().to_string());
    c.spawn().map(drop)
}

/// macOS restarts through LaunchServices, so launchd is the parent.
#[cfg(target_os = "macos")]
fn started_by_launchd(terminal: bool) -> bool {
    !terminal && unsafe { libc::getppid() } == 1
}

#[cfg(not(target_os = "macos"))]
fn started_by_launchd(_terminal: bool) -> bool {
    false
}

/// `--help` / `--version` among the options, which only print and never touch the app's state.
fn info_request(args: &[OsString]) -> Option<Parsed> {
    for a in args {
        match a.to_str() {
            Some("--") => return None,
            Some("-h" | "--help") => return Some(Parsed::Help),
            Some("-v" | "--version") => return Some(Parsed::Version),
            _ => {}
        }
    }
    None
}

fn print_info(info: Parsed) -> ! {
    if info == Parsed::Help {
        print!("{USAGE}");
    } else {
        println!("Omega {}", env!("CARGO_PKG_VERSION"));
    }
    std::process::exit(0)
}

/// The app is about to restart itself.
pub fn mark_relaunch() {
    if let Some((dir, key)) = PROFILE.get() {
        let _ = std::fs::write(relaunch_mark(dir, key), std::process::id().to_string());
    }
}

/// The restart didn't happen.
pub fn clear_relaunch() {
    if let Some((dir, key)) = PROFILE.get() {
        let _ = std::fs::remove_file(relaunch_mark(dir, key));
    }
}

// ------------------------------------------------------------------ startup

/// What the first process keeps: the lock (for its lifetime), the channel and its own request.
pub struct Startup {
    listener: Option<channel::Listener>,
    request: Request,
}

static PROFILE: OnceLock<(PathBuf, String)> = OnceLock::new();
static LOCK: OnceLock<File> = OnceLock::new();

fn fail(msg: &str) -> ! {
    eprintln!("omega: {msg}");
    std::process::exit(1)
}

/// Runs before anything else. Returns only in the process that becomes the app.
pub fn startup() -> Startup {
    let terminal = from_terminal();
    let detached = std::env::var_os(DETACHED_ENV).is_some();
    if detached {
        // Terminals opened in the app must not inherit it. No other thread runs yet.
        unsafe { std::env::remove_var(DETACHED_ENV) };
    }
    let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
    if let Some(info) = info_request(&argv) {
        print_info(info);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| crate::env::home());
    let key = this_profile();
    let private = runtime_dir();
    let told = std::env::var_os(RELAUNCH_ENV);
    if told.is_some() {
        // Terminals opened in the app must not inherit it. No other thread runs yet.
        unsafe { std::env::remove_var(RELAUNCH_ENV) };
    }
    let relaunch = private.as_deref().is_some_and(|d| take_relaunch_mark(d, &key, RELAUNCH_MARK_AGE, || restart_starters(told.as_deref()), started_by_launchd(terminal)));
    // A restart brings back the session; the paths of the original command may be long gone.
    let args = if relaunch { Vec::new() } else { argv };
    let request = match parse(args, &cwd, detached) {
        Ok(Parsed::Open(r)) => r,
        Ok(info) => print_info(info),
        Err(e) => fail(&e),
    };
    let Some(dir) = private else {
        // No private place for the channel: run as a plain single process.
        return Startup { listener: None, request };
    };
    let Ok(lock) = File::options().create(true).truncate(false).write(true).open(dir.join(format!("{key}.lock"))) else {
        return Startup { listener: None, request };
    };
    let deadline = Instant::now() + WAIT_FOR_APP;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                // After an update the holder is the old process, on its way out: wait for it.
                if !relaunch && forward(&dir, &key, &request).is_ok() {
                    std::process::exit(0);
                }
                if Instant::now() > deadline {
                    fail(if relaunch { "the previous Omega did not exit" } else { "the running Omega does not respond" });
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Startup { listener: None, request },
        }
    }
    let env_set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if should_detach(terminal, detached, relaunch, cfg!(debug_assertions), env_set("OMEGA_NO_DETACH"), env_set("OMEGA_DETACH")) {
        let _ = lock.unlock();
        match detached_command(&request).and_then(|mut c| c.spawn()) {
            Ok(_) => std::process::exit(0),
            Err(e) => fail(&format!("can't start Omega: {e}")),
        }
    }
    let listener = channel::bind(&dir, &key).ok();
    let _ = LOCK.set(lock);
    let _ = PROFILE.set((dir, key));
    Startup { listener, request }
}

/// Opens what the first process was started with and serves later ones.
pub fn begin(app: &tauri::AppHandle, s: Startup) {
    crate::windows::route(app, s.request, true);
    let Some(listener) = s.listener else { return };
    let Some((dir, key)) = PROFILE.get().cloned() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let (app, dir, key) = (app.clone(), dir.clone(), key.clone());
            std::thread::spawn(move || {
                channel::timeouts(&stream);
                if !channel::admit(&mut stream, &key, &dir) {
                    return;
                }
                let Some(req) = read_request(&mut stream) else { return };
                crate::windows::route(&app, validated(req), false);
                let _ = stream.write_all(b"ok\n");
            });
        }
    });
}

pub fn cleanup() {
    if let Some((dir, key)) = PROFILE.get() {
        channel::remove(dir, key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }
    fn real(p: &Path) -> String {
        crate::env::norm(p.canonicalize().unwrap())
    }

    #[test]
    fn a_restart_finds_its_mark_once_and_ignores_an_old_one() {
        let t = tempfile::tempdir().unwrap();
        let old = || vec![4242];
        assert!(!take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, old, false), "a normal start");
        std::fs::write(relaunch_mark(t.path(), "k"), "4242").unwrap();
        assert!(!take_relaunch_mark(t.path(), "other", RELAUNCH_MARK_AGE, old, false), "another profile's");
        assert!(take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, old, false));
        assert!(!take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, old, false), "used up");
        std::fs::write(relaunch_mark(t.path(), "k"), "4242").unwrap();
        std::thread::sleep(Duration::from_millis(30));
        assert!(!take_relaunch_mark(t.path(), "k", Duration::from_millis(1), old, false), "stale");
        assert!(!relaunch_mark(t.path(), "k").exists(), "a stale mark is removed too");
    }

    #[test]
    fn another_omega_neither_uses_nor_consumes_the_mark() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(relaunch_mark(t.path(), "k"), "4242").unwrap();
        assert!(!take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, || vec![77], false), "started by a shell");
        assert!(relaunch_mark(t.path(), "k").exists(), "still there for the real restart");
        assert!(take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, || vec![4242], false));
        // A planted file names nobody who started us.
        for planted in ["", "x", "0", "-1"] {
            assert!(!mark_is_for(planted, &[0, 4242], false), "{planted:?}");
        }
        assert!(mark_is_for("4242", &[], true), "macOS restarts through launchd");
    }

    #[test]
    fn a_restart_is_recognised_after_the_old_process_is_gone() {
        // What the old process wrote and told the new one; its parent no longer matters.
        let t = tempfile::tempdir().unwrap();
        std::fs::write(relaunch_mark(t.path(), "k"), "4242").unwrap();
        let told = OsString::from("4242");
        assert!(take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, || restart_starters(Some(&told)), false));
        // Told nothing, or another pid: not a restart, and the mark stays.
        std::fs::write(relaunch_mark(t.path(), "k"), "4242").unwrap();
        assert!(!take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, || restart_starters(None), false));
        let other = OsString::from("77");
        assert!(!take_relaunch_mark(t.path(), "k", RELAUNCH_MARK_AGE, || restart_starters(Some(&other)), false));
        assert!(relaunch_mark(t.path(), "k").exists());
        assert!(restart_starters(Some(OsStr::new("junk"))).is_empty());
    }

    #[test]
    fn help_and_version_are_found_before_anything_else() {
        assert_eq!(info_request(&os(&["a", "--help"])), Some(Parsed::Help));
        assert_eq!(info_request(&os(&["-v"])), Some(Parsed::Version));
        assert_eq!(info_request(&os(&["--", "--help"])), None);
        assert_eq!(info_request(&os(&["a"])), None);
    }

    #[test]
    fn a_detached_copy_skips_paths_that_are_gone() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("ok"), "x").unwrap();
        let Parsed::Open(r) = parse(os(&["gone", "-weird", "ok"]), t.path(), true).unwrap() else { panic!() };
        assert_eq!(r.files, [real(&t.path().join("ok"))]);
        assert!(parse(os(&["gone"]), t.path(), false).is_err());
    }

    #[test]
    fn detaches_only_a_real_terminal_start_of_a_release_build() {
        assert!(should_detach(true, false, false, false, false, false));
        assert!(!should_detach(false, false, false, false, false, false), "no terminal");
        assert!(!should_detach(true, true, false, false, false, false), "already detached");
        assert!(!should_detach(true, false, true, false, false, false), "a restart");
        assert!(!should_detach(true, false, false, true, false, false), "cargo run");
        assert!(!should_detach(true, false, false, false, true, false), "OMEGA_NO_DETACH");
        assert!(should_detach(true, false, false, true, false, true), "OMEGA_DETACH in a debug build");
    }

    #[cfg(unix)]
    #[test]
    fn the_macos_lock_path_does_not_depend_on_tmpdir() {
        let home = Path::new("/Users/u");
        let a = runtime_path(None, home, Path::new("/var/folders/a/T"), true, 501);
        let b = runtime_path(None, home, Path::new("/var/folders/b/T"), true, 501);
        assert_eq!(a, b);
        assert_eq!(runtime_path(Some("/run/user/1".into()), home, Path::new("/tmp"), false, 1), Path::new("/run/user/1/omega/cli"));
        assert_eq!(runtime_path(None, home, Path::new("/tmp"), false, 1), Path::new("/tmp/omega-1"));
    }

    #[test]
    fn resolves_against_the_callers_folder() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir(t.path().join("my dir")).unwrap();
        std::fs::write(t.path().join("my dir/a b.txt"), "x").unwrap();
        let Parsed::Open(r) = parse(os(&[".", "my dir", "my dir/a b.txt"]), t.path(), false).unwrap() else { panic!() };
        assert_eq!(r.dirs, [real(t.path()), real(&t.path().join("my dir"))]);
        assert_eq!(r.files, [real(&t.path().join("my dir/a b.txt"))]);
    }

    #[test]
    fn a_dash_path_needs_the_separator() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("-x"), "x").unwrap();
        assert!(parse(os(&["-x"]), t.path(), false).unwrap_err().contains("unknown option"));
        let Parsed::Open(r) = parse(os(&["--", "-x"]), t.path(), false).unwrap() else { panic!() };
        assert_eq!(r.files, [real(&t.path().join("-x"))]);
        assert_eq!(parse(os(&["--help"]), t.path(), false).unwrap(), Parsed::Help);
        assert!(matches!(parse(os(&["--", "--help"]), t.path(), false), Err(e) if e.contains("no such")));
    }

    #[test]
    fn a_missing_path_is_an_error() {
        let t = tempfile::tempdir().unwrap();
        assert!(parse(os(&["nope"]), t.path(), false).unwrap_err().contains("no such file or folder: nope"));
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_path_is_refused_clearly() {
        use std::os::unix::ffi::OsStringExt;
        let t = tempfile::tempdir().unwrap();
        let name = OsString::from_vec(vec![b'a', 0xff]);
        if std::fs::write(t.path().join(&name), "x").is_err() {
            return; // the filesystem doesn't allow such names
        }
        assert!(parse(vec![name], t.path(), false).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn the_receiver_drops_what_it_cant_trust() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("f");
        std::fs::write(&file, "x").unwrap();
        let (d, f) = (real(t.path()), real(&file));
        let r = validated(Request { dirs: vec![d.clone(), f.clone(), "relative".into(), format!("{d}/gone")], files: vec![f.clone(), d.clone()] });
        assert_eq!(r, Request { dirs: vec![d], files: vec![f] });
    }

    #[test]
    fn requests_are_bounded() {
        assert_eq!(read_request(&b"{\"dirs\":[\"/a\"],\"files\":[]}\n"[..]).unwrap().dirs, ["/a"]);
        assert!(read_request(&b"{\"dirs\":[],\"files\":[]}"[..]).is_none(), "no line end");
        assert!(read_request(&b"not json\n"[..]).is_none());
        let huge = vec![b'x'; MAX_REQUEST as usize + 10];
        assert!(read_request(&huge[..]).is_none());
    }

    #[test]
    fn profiles_never_collide_with_the_users_omega() {
        let user = profile_key(None, None, None);
        let inst = profile_key(Some("cli"), Some("/wt/a"), None);
        assert_ne!(user, inst);
        assert_ne!(inst, profile_key(Some("cli"), Some("/wt/b"), None), "same name, other worktree");
        assert_ne!(inst, profile_key(Some("other"), Some("/wt/a"), None));
        assert_ne!(user, profile_key(None, None, Some("/wt/a/target/debug/ide")), "a dev build");
        assert_ne!(user, profile_key(Some("default"), None, None));
        assert_eq!(inst, profile_key(Some("cli"), Some("/wt/a"), Some("/any")));
    }

    #[test]
    fn a_dying_appimage_mount_leaves_the_environment() {
    }

    #[test]
    fn finds_the_app_bundle() {
        assert_eq!(app_bundle(Path::new("/Applications/Omega.app/Contents/MacOS/ide")).unwrap(), Path::new("/Applications/Omega.app"));
        assert!(app_bundle(Path::new("/usr/bin/ide")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_private_folder_refuses_what_others_could_touch() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let ok = t.path().join("ok");
        assert_eq!(private_dir(&ok).unwrap(), ok);
        assert_eq!(std::fs::metadata(&ok).unwrap().permissions().mode() & 0o777, 0o700);
        let open = t.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(private_dir(&open).is_none());
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&ok, &link).unwrap();
        assert!(private_dir(&link).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn hands_over_through_the_channel() {
        let t = tempfile::tempdir().unwrap();
        let l = channel::bind(t.path(), "k").unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            assert!(channel::admit(&mut s, "k", Path::new("")));
            let r = read_request(&mut s).unwrap();
            s.write_all(b"ok\n").unwrap();
            r
        });
        let req = Request { dirs: vec!["/a b".into()], files: vec![] };
        forward(t.path(), "k", &req).unwrap();
        assert_eq!(server.join().unwrap(), req);
    }
}
