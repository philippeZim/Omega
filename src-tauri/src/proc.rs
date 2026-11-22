//! Child processes speaking JSON-RPC over stdio with `Content-Length` framing.
//! Used for both Language Servers (LSP) and Debug Adapters (DAP).
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct ProcState {
    /// JSON-RPC endpoints (stdio pipes or TCP connections) by window-scoped id.
    conns: Mutex<HashMap<String, (u64, Box<dyn Write + Send>)>>,
    /// Child processes by window-scoped id (stdio servers and TCP debug adapters).
    children: Mutex<HashMap<String, Child>>,
    /// Children started by `run_killable`: `proc_kill` also ends what they started.
    trees: Mutex<HashSet<String>>,
}

#[derive(Serialize, Clone)]
struct Msg {
    id: String,
    msg: String,
}

pub fn which(cmd: &str) -> Option<PathBuf> {
    crate::env::which(cmd)
}

#[tauri::command]
pub fn which_cmd(cmd: String) -> Option<String> {
    which(&cmd).map(crate::env::norm)
}

/// True if `cmd --version` runs successfully (catches rustup proxies without the component).
#[tauri::command]
pub fn cmd_works(cmd: String) -> bool {
    which(&cmd).is_some_and(|exe| crate::env::command(exe).arg("--version").output().is_ok_and(|o| o.status.success()))
}

#[tauri::command]
pub fn tools_dir() -> Result<String, String> {
    let d = crate::env::tools_dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(crate::env::norm(d))
}

fn command(cmd: &str, args: &[String], cwd: Option<String>, env: Option<HashMap<String, String>>) -> Result<Command, String> {
    let exe = which(cmd).ok_or_else(|| format!("proc:not_found:{cmd}"))?;
    let mut c = crate::env::command(&exe);
    crate::tools::managed_ocaml_env(&mut c, &exe);
    c.args(args).current_dir(cwd.map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(crate::env::home));
    if let Some(env) = env {
        c.envs(env);
    }
    Ok(c)
}

/// Reads one `Content-Length` framed message body. `None` on end of stream / read error
/// (including EOF in the middle of a body). Headers other than `Content-Length` are ignored,
/// blank lines before the header block are skipped.
fn read_message<R: BufRead>(reader: &mut R) -> Option<Vec<u8>> {
    let mut len = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            if len.is_some() {
                break;
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0u8; len?];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}

/// Reads `Content-Length` framed messages and emits them as `proc-msg` events.
fn pump_messages(app: AppHandle, owner: String, id: String, generation: u64, stream: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        while let Some(body) = read_message(&mut reader) {
            crate::windows::emit(&app, &owner, "proc-msg", Msg { id: id.clone(), msg: String::from_utf8_lossy(&body).into() });
        }
        let ended = crate::windows::end_own(&mut app.state::<ProcState>().conns.lock().unwrap(), &crate::windows::key(&owner, &id), |c| c.0 == generation);
        if !matches!(ended, crate::windows::Ended::Replaced) {
            crate::windows::emit(&app, &owner, "proc-exit", id.clone());
        }
    });
}

fn pump_lines(app: AppHandle, owner: String, id: String, stream: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            crate::windows::emit(&app, &owner, "proc-stderr", Msg { id: id.clone(), msg: line });
        }
    });
}

/// Starts a JSON-RPC server that talks over stdin/stdout (language servers, debugpy, gdb).
#[tauri::command]
pub fn proc_spawn(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let mut child = command(&cmd, &args, cwd, env)?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{cmd}: {e}"))?;
    let stdin = child.stdin.take().unwrap();
    let owner = window.label().to_string();
    let generation = crate::windows::next_generation();
    pump_messages(app.clone(), owner.clone(), id.clone(), generation, child.stdout.take().unwrap());
    pump_lines(app.clone(), owner.clone(), id.clone(), child.stderr.take().unwrap());
    let state = app.state::<ProcState>();
    let key = crate::windows::key(&owner, &id);
    state.conns.lock().unwrap().insert(key.clone(), (generation, Box::new(stdin)));
    state.children.lock().unwrap().insert(key, child);
    Ok(())
}

/// Starts a server that listens on a TCP port (`{port}` in args is replaced); returns the port
/// once it accepts connections. Output lines are forwarded as `proc-stderr`.
#[tauri::command]
pub async fn proc_spawn_tcp(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u16, String> {
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let args: Vec<String> = args.into_iter().map(|a| a.replace("{port}", &port.to_string())).collect();
    let mut child = command(&cmd, &args, cwd, env)?
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{cmd}: {e}"))?;
    let owner = window.label().to_string();
    pump_lines(app.clone(), owner.clone(), id.clone(), child.stdout.take().unwrap());
    pump_lines(app.clone(), owner.clone(), id.clone(), child.stderr.take().unwrap());
    // No probe connection here: some adapters (CodeLLDB) accept exactly one client.
    // proc_connect retries until the port is open.
    app.state::<ProcState>().children.lock().unwrap().insert(crate::windows::key(&owner, &id), child);
    Ok(port)
}

/// Opens a JSON-RPC connection to a TCP port (debug adapters, java-debug, js-debug child sessions).
#[tauri::command]
pub async fn proc_connect(app: AppHandle, window: tauri::WebviewWindow, id: String, port: u16) -> Result<(), String> {
    let stream = tauri::async_runtime::spawn_blocking(move || {
        let mut last = String::new();
        for _ in 0..100 {
            match std::net::TcpStream::connect(("127.0.0.1", port)) {
                Ok(s) => return Ok(s),
                Err(e) => last = e.to_string(),
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(format!("proc:connect_failed:{port}: {last}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let owner = window.label().to_string();
    let generation = crate::windows::next_generation();
    pump_messages(app.clone(), owner.clone(), id.clone(), generation, reader);
    app.state::<ProcState>().conns.lock().unwrap().insert(crate::windows::key(&owner, &id), (generation, Box::new(stream)));
    Ok(())
}

#[tauri::command]
pub fn proc_send(app: AppHandle, window: tauri::WebviewWindow, id: String, msg: String) -> Result<(), String> {
    let state = app.state::<ProcState>();
    let mut conns = state.conns.lock().unwrap();
    let (_, w) = conns.get_mut(&crate::windows::key(window.label(), &id)).ok_or("proc:not_connected")?;
    write!(w, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn proc_kill(app: AppHandle, window: tauri::WebviewWindow, id: String) {
    let state = app.state::<ProcState>();
    let key = crate::windows::key(window.label(), &id);
    if let Some(w) = state.conns.lock().unwrap().remove(&key) {
        drop(w);
    }
    kill_registered(&state.children, &state.trees, &key);
}

/// Ends every language server, debugger and Run task of one window.
pub fn kill_window(app: &AppHandle, owner: &str) {
    let state = app.state::<ProcState>();
    drop(crate::windows::take_owned(&mut state.conns.lock().unwrap(), owner));
    kill_owned(&state.children, &state.trees, owner);
}

fn kill_owned(children: &Mutex<HashMap<String, Child>>, trees: &Mutex<HashSet<String>>, owner: &str) {
    // Collected first: `kill_registered` takes the lock itself.
    let keys: Vec<String> = children.lock().unwrap().keys().filter(|k| crate::windows::is_owned(k, owner)).cloned().collect();
    for key in keys {
        kill_registered(children, trees, &key);
    }
}

fn kill_registered(children: &Mutex<HashMap<String, Child>>, trees: &Mutex<HashSet<String>>, id: &str) {
    let child = children.lock().unwrap().remove(id);
    let tree = trees.lock().unwrap().remove(id);
    if let Some(mut child) = child {
        // Not reaped yet, so its pid and process group can't have been reused.
        if tree {
            kill_tree(&child);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// (pid, ppid, pgid) rows of `ps -o pid=,ppid=,pgid=` output.
#[cfg(unix)]
fn ps_rows(ps: &str) -> Vec<(i32, i32, i32)> {
    ps.lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace().map(str::parse::<i32>);
            Some((f.next()?.ok()?, f.next()?.ok()?, f.next()?.ok()?))
        })
        .collect()
}

/// `root` and every process below it.
#[cfg(unix)]
fn descendants(rows: &[(i32, i32, i32)], root: i32) -> HashSet<i32> {
    let mut found = HashSet::from([root]);
    loop {
        let before = found.len();
        for (pid, ppid, _) in rows {
            if found.contains(ppid) {
                found.insert(*pid);
            }
        }
        if found.len() == before {
            return found;
        }
    }
}

/// The process groups of everything below `root` in `ps -o pid=,ppid=,pgid=` output, without
/// `own` (Omega's group) and the system's.
#[cfg(unix)]
fn descendant_groups(ps: &str, root: i32, own: i32) -> Vec<i32> {
    let rows = ps_rows(ps);
    let found = descendants(&rows, root);
    let mut groups: Vec<i32> = rows.iter().filter(|(pid, _, _)| found.contains(pid)).map(|r| r.2).filter(|g| *g > 1 && *g != own).collect();
    groups.sort_unstable();
    groups.dedup();
    groups
}

/// Rounds of looking for new processes before the kill goes ahead regardless.
#[cfg(unix)]
const KILL_TREE_ROUNDS: usize = 16;

/// Ends a build and the actions it started. Dune gives every action a process group of its own,
/// so killing dune's group isn't enough. The whole tree is stopped first, round by round until no
/// new process shows up: a running action could otherwise start a job in a new group after the
/// list was read. Nothing is killed before that, because an orphan can't be found through its parent.
#[cfg(unix)]
fn kill_tree(child: &Child) {
    let pid = child.id() as i32;
    // SAFETY: plain signal calls; `pid` is an unreaped child of this process.
    let own = unsafe {
        libc::kill(pid, libc::SIGSTOP);
        libc::getpgrp()
    };
    let mut stopped = HashSet::from([pid]);
    let mut groups = HashSet::new();
    let mut alive = HashSet::new();
    for _ in 0..KILL_TREE_ROUNDS {
        let ps = crate::env::process("/bin/ps").args(["-A", "-o", "pid=,ppid=,pgid="]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        let text = ps.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        groups.extend(descendant_groups(&text, pid, own));
        alive = descendants(&ps_rows(&text), pid);
        let new: Vec<i32> = alive.difference(&stopped).copied().collect();
        if new.is_empty() && !text.is_empty() {
            break;
        }
        for p in new {
            // SAFETY: `p` was just listed below our unreaped child.
            unsafe { libc::kill(p, libc::SIGSTOP) };
            stopped.insert(p);
        }
    }
    for group in groups.into_iter().chain([pid]) {
        // SAFETY: as above; the groups were read from the tree and never include Omega's own.
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }
    // One that hasn't left Omega's group yet isn't reached through a group.
    for p in alive {
        // SAFETY: as above.
        unsafe { libc::kill(p, libc::SIGKILL) };
    }
}

/// Windows keeps killing only the process itself.
#[cfg(not(unix))]
fn kill_tree(_child: &Child) {}

#[derive(Serialize)]
pub struct Captured {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs a command to completion and returns its output (builds before debugging).
#[tauri::command]
pub async fn run_capture(cmd: String, args: Vec<String>, cwd: Option<String>) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = command(&cmd, &args, cwd, None)?.output().map_err(|e| e.to_string())?;
        Ok(Captured {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into(),
            stderr: String::from_utf8_lossy(&out.stderr).into(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One shared tool install at a time, across all windows.
static SHARED_INSTALL: Mutex<()> = Mutex::new(());

/// A hung install is ended after this.
const SHARED_INSTALL_LIMIT: std::time::Duration = std::time::Duration::from_secs(300);
/// How long a window waits for another window's install, which ends within the limit.
const SHARED_INSTALL_WAIT: std::time::Duration = std::time::Duration::from_secs(320);

/// `run_capture` for installing into a folder all windows share: one at a time, ended if it hangs.
/// `done` is written after a successful install, so a half-finished one is never taken for done.
#[tauri::command]
pub async fn run_shared_install(cmd: String, args: Vec<String>, cwd: Option<String>, done: String) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_once(&SHARED_INSTALL, Path::new(&done), SHARED_INSTALL_WAIT, || output_limited(&mut command(&cmd, &args, cwd, None)?, SHARED_INSTALL_LIMIT))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_once(lock: &Mutex<()>, done: &Path, wait: std::time::Duration, run: impl FnOnce() -> Result<Captured, String>) -> Result<Captured, String> {
    let deadline = std::time::Instant::now() + wait;
    let _one = loop {
        match lock.try_lock() {
            Ok(g) => break g,
            Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) if std::time::Instant::now() >= deadline => return Err("install_busy".into()),
            Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    };
    if done.exists() {
        return Ok(Captured { code: 0, stdout: String::new(), stderr: String::new() });
    }
    let out = run()?;
    if out.code == 0 {
        std::fs::write(done, "").map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Runs a command to its end, or ends it and what it started after `limit`.
fn output_limited(c: &mut Command, limit: std::time::Duration) -> Result<Captured, String> {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(c, 0);
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let deadline = std::time::Instant::now() + limit;
    let code = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status.code().unwrap_or(-1);
        }
        if std::time::Instant::now() >= deadline {
            kill_tree(&child);
            let _ = child.kill();
            let _ = child.wait();
            return Err("install_timeout".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let wait = std::time::Duration::from_secs(2);
    Ok(Captured { code, stdout: stdout.recv_timeout(wait).unwrap_or_default(), stderr: stderr.recv_timeout(wait).unwrap_or_default() })
}

/// Reads a pipe to its end on its own thread, so a full pipe can't block the child.
fn drain(pipe: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(pipe).read_to_end(&mut bytes);
        let _ = tx.send(String::from_utf8_lossy(&bytes).to_string());
    });
    rx
}

/// Runs `c` as child `id` until it exits or something removes it from `children` (`proc_kill`).
/// A killed run returns at once with code -1, also if a process it left behind holds the pipes.
fn run_registered(children: &Mutex<HashMap<String, Child>>, trees: &Mutex<HashSet<String>>, id: &str, c: &mut Command) -> Result<Captured, String> {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(c, 0);
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    trees.lock().unwrap().insert(id.to_string());
    children.lock().unwrap().insert(id.to_string(), child);
    let code = loop {
        {
            let mut map = children.lock().unwrap();
            let Some(child) = map.get_mut(id) else { break None };
            if let Ok(Some(status)) = child.try_wait() {
                map.remove(id);
                trees.lock().unwrap().remove(id);
                break Some(status.code().unwrap_or(-1));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let wait = std::time::Duration::from_millis(if code.is_some() { 2000 } else { 0 });
    Ok(Captured { code: code.unwrap_or(-1), stdout: stdout.recv_timeout(wait).unwrap_or_default(), stderr: stderr.recv_timeout(wait).unwrap_or_default() })
}

/// `run_capture` for a build that may have to stop early: `proc_kill` with this `id` ends it and,
/// on Unix, the actions it started (not one that detached itself with `setsid`).
#[tauri::command]
pub async fn run_killable(app: AppHandle, window: tauri::WebviewWindow, id: String, cmd: String, args: Vec<String>, cwd: Option<String>) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = command(&cmd, &args, cwd, None)?;
        let state = app.state::<ProcState>();
        run_registered(&state.children, &state.trees, &crate::windows::key(window.label(), &id), &mut c)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs a language server into the app's tools dir. Returns the executable path.
#[tauri::command]
pub async fn install_server(app: AppHandle, kind: String) -> Result<String, String> {
    let dir = PathBuf::from(tools_dir()?);
    tauri::async_runtime::spawn_blocking(move || {
        let run = |cmd: &mut Command| -> Result<(), String> {
            let out = cmd.output().map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).chars().take(800).collect())
            }
        };
        match kind.as_str() {
            "python" | "typescript" => {
                let target = dir.join(&kind);
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                run(crate::env::tool("npm")?.arg("install").arg("--prefix").arg(&target).arg("--no-fund").arg("--no-audit").args(npm_packages(&kind)))?;
                let bin = if kind == "python" { "basedpyright-langserver" } else { "typescript-language-server" };
                Ok(crate::env::norm(target.join("node_modules").join(".bin").join(bin)))
            }
            "java" => crate::jdtls::install(&app, &dir),
            "rust" => {
                run(crate::env::tool("rustup")?.args(["component", "add", "rust-analyzer"]))?;
                Ok("rust-analyzer".into())
            }
            "clangd" => crate::tools::tool_install_blocking(&app, "clangd"),
            "scala" => crate::tools::install_metals(&app),
            "ocaml" => crate::tools::install_ocaml_package(&app, "lsp-ocaml", "ocaml-lsp-server", "ocamllsp"),
            "mojo" => crate::tools::install_mojo(&app, "lsp-mojo", false),
            "go" => crate::tools::golang::install_go_tool(&app, "lsp-go", crate::tools::golang::GOPLS, "gopls"),
            _ => Err(format!("proc:no_auto_install:{kind}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// npm packages of a managed language server. TypeScript is pinned to 5: TypeScript 7 (the
/// native port) ships no `lib/tsserver.js`, which typescript-language-server needs.
fn npm_packages(kind: &str) -> &'static [&'static str] {
    if kind == "python" {
        &["basedpyright"]
    } else {
        &["typescript@5", "typescript-language-server"]
    }
}

/// Installs a debug adapter into the tools dir and returns its main path.
#[tauri::command]
pub async fn install_debugger(app: AppHandle, kind: String) -> Result<String, String> {
    let dir = PathBuf::from(tools_dir()?);
    tauri::async_runtime::spawn_blocking(move || match kind.as_str() {
        "codelldb" => {
            let plat = match (std::env::consts::OS, std::env::consts::ARCH) {
                ("windows", "aarch64") => "win32-arm64",
                ("windows", _) => "win32-x64",
                ("macos", "aarch64") => "darwin-arm64",
                ("macos", _) => "darwin-x64",
                (_, "aarch64") => "linux-arm64",
                _ => "linux-x64",
            };
            let vsix = dir.join(".codelldb.vsix");
            crate::tools::download(&app, "codelldb", &format!("https://github.com/vadimcn/codelldb/releases/latest/download/codelldb-{plat}.vsix"), &vsix)?;
            let target = dir.join("codelldb");
            let _ = std::fs::remove_dir_all(&target);
            let r = crate::tools::unpack(&vsix, "codelldb.vsix", &target, "");
            let _ = std::fs::remove_file(&vsix);
            r?;
            let exe = target.join("extension").join("adapter").join(if cfg!(windows) { "codelldb.exe" } else { "codelldb" });
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let lldb = target.join("extension").join("lldb").join("bin");
                for p in [exe.clone(), lldb.join("lldb"), lldb.join("lldb-server"), lldb.join("lldb-argdumper")] {
                    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
                }
                if cfg!(target_os = "macos") {
                    if let Ok(rd) = std::fs::read_dir(&lldb) {
                        for e in rd.flatten() {
                            let _ = std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(0o755));
                        }
                    }
                }
            }
            Ok(crate::env::norm(exe))
        }
        "debugpy" => {
            let target = dir.join("debugpy");
            let ok = which("uv").is_some_and(|uv| {
                crate::env::command(uv).args(["pip", "install", "--quiet", "--upgrade", "--target"]).arg(&target).arg("debugpy").status().is_ok_and(|s| s.success())
            });
            if !ok {
                let py = which("python3").or_else(|| which("python")).ok_or("proc:not_found:Python")?;
                let st = crate::env::command(py).args(["-m", "pip", "install", "--quiet", "--upgrade", "--target"]).arg(&target).arg("debugpy").status().map_err(|e| e.to_string())?;
                if !st.success() {
                    return Err("proc:debugpy_failed".into());
                }
            }
            Ok(crate::env::norm(target))
        }
        "jsdebug" => {
            let release: serde_json::Value = serde_json::from_str(&crate::tools::http_text("https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest")?).map_err(|e| e.to_string())?;
            let url = release["assets"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.starts_with("js-debug-dap-") && n.ends_with(".tar.gz"))))
                .and_then(|x| x["browser_download_url"].as_str())
                .ok_or("proc:no_version:js-debug")?
                .to_string();
            let archive = dir.join(".js-debug.tar.gz");
            crate::tools::download(&app, "jsdebug", &url, &archive)?;
            let _ = std::fs::remove_dir_all(dir.join("js-debug"));
            let r = crate::tools::unpack(&archive, "js-debug.tar.gz", &dir, "");
            let _ = std::fs::remove_file(&archive);
            r?;
            if let Some(v) = crate::installs::extract_version(&url.rsplit('/').next().unwrap_or_default()) {
                let _ = std::fs::write(dir.join("js-debug").join(".omega-version"), v);
            }
            Ok(crate::env::norm(dir.join("js-debug").join("src").join("dapDebugServer.js")))
        }
        "javadebug" => {
            let base = "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin";
            let meta = crate::tools::http_text(&format!("{base}/maven-metadata.xml"))?;
            let version = meta
                .split("<release>")
                .nth(1)
                .and_then(|s| s.split("</release>").next())
                .ok_or("proc:no_version:java-debug")?
                .to_string();
            let target = dir.join("java-debug");
            // Old plugin jars would be loaded into jdtls next to the new one.
            let _ = std::fs::remove_dir_all(&target);
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            let jar = target.join(format!("com.microsoft.java.debug.plugin-{version}.jar"));
            crate::tools::download(&app, "javadebug", &format!("{base}/{version}/com.microsoft.java.debug.plugin-{version}.jar"), &jar)?;
            Ok(crate::env::norm(jar))
        }
        "earlybird" => crate::tools::install_ocaml_package(&app, "earlybird", "earlybird", "ocamlearlybird"),
        "mojo" => crate::tools::install_mojo(&app, "mojo", false),
        "delve" => crate::tools::golang::install_go_tool(&app, "delve", crate::tools::golang::DELVE, "dlv"),
        _ => Err(format!("proc:unknown_debugger:{kind}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{npm_packages, read_message, run_registered};
    #[cfg(unix)]
    use super::{descendant_groups, descendants, kill_registered, ps_rows};
    use std::collections::{HashMap, HashSet};
    use std::process::Command;
    use std::sync::Mutex;

    #[cfg(unix)]
    #[test]
    fn a_registered_run_reports_its_exit_and_output() {
        let (children, trees) = (Mutex::new(HashMap::new()), Mutex::new(HashSet::new()));
        let mut c = Command::new("sh");
        c.args(["-c", "echo out; echo err >&2; exit 3"]);
        let r = run_registered(&children, &trees, "b", &mut c).unwrap();
        assert_eq!((r.code, r.stdout.trim(), r.stderr.trim()), (3, "out", "err"));
        assert!(children.lock().unwrap().is_empty());
        assert!(trees.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    fn running(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        if !std::path::Path::new("/proc/self/stat").exists() {
            return true; // no procfs (macOS)
        }
        // A zombie can be reaped between the two checks: then its stat is gone, and so is it.
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.rsplit(')').next().is_some_and(|r| !r.trim_start().starts_with(['Z', 'X'])))
    }

    /// Runs `script` (which writes the pids to end up dead into $1) and kills it through the registry.
    #[cfg(unix)]
    fn pids_after_kill(script: &str, wanted: usize) -> Vec<i32> {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("pids");
        let children = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let trees = std::sync::Arc::new(Mutex::new(HashSet::new()));
        let (c2, t2) = (children.clone(), trees.clone());
        let (script, arg) = (script.to_string(), file.clone());
        let run = std::thread::spawn(move || {
            let mut c = Command::new("sh");
            c.arg("-c").arg(script).arg("sh").arg(arg);
            run_registered(&c2, &t2, "b", &mut c).unwrap().code
        });
        let start = std::time::Instant::now();
        let read = || -> Vec<i32> { std::fs::read_to_string(&file).unwrap_or_default().split_whitespace().filter_map(|x| x.parse().ok()).collect() };
        // The script can write its pids before the run is registered, and a kill before that finds nothing.
        while read().len() < wanted || !children.lock().unwrap().contains_key("b") {
            assert!(start.elapsed().as_secs() < 20, "script didn't start");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let killed_at = std::time::Instant::now();
        kill_registered(&children, &trees, "b");
        assert_eq!(run.join().unwrap(), -1);
        assert!(killed_at.elapsed().as_secs() < 5);
        // Read after the kill: this also counts what was started while it ran.
        let pids = read();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while pids.iter().any(|p| running(*p)) && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        pids.into_iter().filter(|p| running(*p)).collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_kill_ends_a_process_in_the_runs_own_group() {
        assert_eq!(pids_after_kill(r#"sleep 30 & echo $! >> "$1"; wait"#, 1), Vec::<i32>::new());
    }

    /// What dune does: every action is a process group of its own, with children of its own.
    #[cfg(unix)]
    #[test]
    fn a_kill_ends_an_action_in_its_own_process_group() {
        let script = r#"set -m; sh -c 'sleep 30 & echo $! >> "$0"; echo $$ >> "$0"; wait' "$1" & wait"#;
        assert_eq!(pids_after_kill(script, 2), Vec::<i32>::new());
    }

    /// One snapshot of the tree missed these: each job gets a new group after the list was read.
    #[cfg(unix)]
    #[test]
    fn a_kill_ends_jobs_an_action_starts_while_it_runs() {
        let script = r#"set -m; sh -c 'set -m; while :; do sleep 8 & echo $! >> "$0"; done' "$1" & wait"#;
        for _ in 0..5 {
            assert_eq!(pids_after_kill(script, 5), Vec::<i32>::new());
        }
    }

    #[cfg(unix)]
    #[test]
    fn descendants_are_the_whole_subtree() {
        let rows = ps_rows("1 0 1\n50 1 50\n100 50 50\n200 100 200\n201 200 200\n300 201 300\n400 50 50\n");
        assert_eq!(descendants(&rows, 100), HashSet::from([100, 200, 201, 300]));
        assert_eq!(descendants(&rows, 999), HashSet::from([999]));
    }

    #[cfg(unix)]
    #[test]
    fn descendant_groups_follow_the_tree_only() {
        let ps = "1 0 1\n50 1 50\n100 50 50\n200 100 200\n201 200 200\n300 201 300\n400 50 50\n500 1 500\n";
        assert_eq!(descendant_groups(ps, 100, 50), [200, 300]);
        assert_eq!(descendant_groups("garbage\n", 100, 50), Vec::<i32>::new());
    }

    #[test]
    fn typescript_is_pinned_to_a_version_with_tsserver() {
        assert!(npm_packages("typescript").contains(&"typescript@5"));
        assert_eq!(npm_packages("python"), &["basedpyright"]);
    }
    use std::io::Cursor;

    fn read_all(input: &[u8]) -> Vec<Vec<u8>> {
        let mut r = Cursor::new(input.to_vec());
        std::iter::from_fn(|| read_message(&mut r)).collect()
    }

    #[test]
    fn two_back_to_back_messages_with_extra_headers() {
        let input = b"Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}\
Content-Type: x\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
        assert_eq!(read_all(input), vec![b"{}".to_vec(), b"{\"a\":1}".to_vec()]);
    }

    #[test]
    fn blank_lines_before_header_are_skipped() {
        let input = b"\r\n\r\n\nContent-Length: 3\r\n\r\nabc";
        assert_eq!(read_all(input), vec![b"abc".to_vec()]);
    }

    #[test]
    fn eof_mid_body_returns_none() {
        let mut r = Cursor::new(b"Content-Length: 10\r\n\r\nabc".to_vec());
        assert_eq!(read_message(&mut r), None);
    }

    #[test]
    fn eof_in_headers_and_empty_stream_return_none() {
        assert_eq!(read_all(b""), Vec::<Vec<u8>>::new());
        assert_eq!(read_all(b"Content-Length: 3\r\n"), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn missing_or_invalid_content_length_does_not_panic() {
        // Header block without Content-Length: blank line is skipped, reader keeps scanning and
        // finds the next valid message.
        let input = b"Content-Type: x\r\n\r\nContent-Length: 2\r\n\r\nok";
        assert_eq!(read_all(input), vec![b"ok".to_vec()]);
        let input = b"Content-Length: abc\r\n\r\n";
        assert_eq!(read_all(input), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn zero_length_body() {
        assert_eq!(read_all(b"Content-Length: 0\r\n\r\n"), vec![Vec::<u8>::new()]);
    }

    #[test]
    fn length_counts_bytes_not_chars() {
        let body = "{\"t\":\"äöü€😀\"}";
        let mut input = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        input.extend_from_slice(body.as_bytes());
        input.extend_from_slice(b"Content-Length: 1\r\n\r\nx");
        let got = read_all(&input);
        assert_eq!(got.len(), 2);
        assert_eq!(String::from_utf8(got[0].clone()).unwrap(), body);
        assert_eq!(got[1], b"x");
    }

    #[test]
    fn lf_only_line_endings() {
        assert_eq!(read_all(b"Content-Length: 2\n\nhi"), vec![b"hi".to_vec()]);
    }
}

#[cfg(all(test, unix))]
mod window_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_shared_install_runs_once_for_two_windows() {
        let t = tempfile::tempdir().unwrap();
        let done = Arc::new(t.path().join("done"));
        let lock = Arc::new(Mutex::new(()));
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..2).map(|_| {
            let (done, lock, runs) = (done.clone(), lock.clone(), runs.clone());
            std::thread::spawn(move || {
                run_once(&lock, &done, std::time::Duration::from_secs(5), || {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    Ok(Captured { code: 0, stdout: String::new(), stderr: String::new() })
                }).unwrap();
            })
        }).collect();
        for th in threads { th.join().unwrap(); }
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_install_is_not_marked_done() {
        let t = tempfile::tempdir().unwrap();
        let done = t.path().join("done");
        let lock = Mutex::new(());
        let run = |code| Ok(Captured { code, stdout: String::new(), stderr: String::new() });
        run_once(&lock, &done, std::time::Duration::from_secs(1), || run(1)).unwrap();
        assert!(!done.exists());
        run_once(&lock, &done, std::time::Duration::from_secs(1), || run(0)).unwrap();
        assert!(done.exists());
    }

    #[test]
    fn a_hung_install_ends_and_a_waiting_window_gives_up() {
        let start = std::time::Instant::now();
        let e = output_limited(Command::new("sleep").arg("30"), std::time::Duration::from_millis(150)).err();
        assert_eq!(e.as_deref(), Some("install_timeout"));
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        let ok = output_limited(Command::new("sh").args(["-c", "echo hi"]), std::time::Duration::from_secs(5)).unwrap();
        assert_eq!((ok.code, ok.stdout.as_str()), (0, "hi\n"));

        let t = tempfile::tempdir().unwrap();
        let lock = Mutex::new(());
        let _held = lock.lock().unwrap();
        let r = run_once(&lock, &t.path().join("done"), std::time::Duration::from_millis(100), || panic!("must not run"));
        assert_eq!(r.err().as_deref(), Some("install_busy"));
    }

    #[test]
    fn closing_a_window_ends_only_its_processes_without_deadlock() {
        let spawn = || Command::new("sleep").arg("30").spawn().unwrap();
        let children = Arc::new(Mutex::new(HashMap::new()));
        let trees = Arc::new(Mutex::new(HashSet::new()));
        children.lock().unwrap().insert(crate::windows::key("main", "lsp"), spawn());
        children.lock().unwrap().insert(crate::windows::key("main", "dap"), spawn());
        children.lock().unwrap().insert(crate::windows::key("w-b", "lsp"), spawn());
        let (c2, t2) = (children.clone(), trees.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            kill_owned(&c2, &t2, "main");
            let _ = tx.send(());
        });
        rx.recv_timeout(std::time::Duration::from_secs(5)).expect("kill_owned must not deadlock");
        let mut left = children.lock().unwrap();
        assert_eq!(left.keys().cloned().collect::<Vec<_>>(), [crate::windows::key("w-b", "lsp")]);
        for c in left.values_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
