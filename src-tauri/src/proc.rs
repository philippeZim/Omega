//! Child processes speaking JSON-RPC over stdio with `Content-Length` framing.
//! Used for both Language Servers (LSP) and Debug Adapters (DAP).
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct ProcState {
    /// JSON-RPC endpoints (stdio pipes or TCP connections) by id.
    conns: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    /// Child processes by id (stdio servers and TCP debug adapters).
    children: Mutex<HashMap<String, Child>>,
}

#[derive(Serialize, Clone)]
struct Msg {
    id: String,
    msg: String,
}

pub fn which(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return p.is_file().then_some(p);
    }
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).map(|p| p.join(cmd)).find(|p| p.is_file()))
}

#[tauri::command]
pub fn which_cmd(cmd: String) -> Option<String> {
    which(&cmd).map(|p| p.display().to_string())
}

/// True if `cmd --version` runs successfully (catches rustup proxies without the component).
#[tauri::command]
pub fn cmd_works(cmd: String) -> bool {
    which(&cmd).is_some_and(|exe| Command::new(exe).arg("--version").output().is_ok_and(|o| o.status.success()))
}

#[tauri::command]
pub fn tools_dir(app: AppHandle) -> Result<String, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.display().to_string())
}

fn command(cmd: &str, args: &[String], cwd: Option<String>, env: Option<HashMap<String, String>>) -> Result<Command, String> {
    let exe = which(cmd).ok_or_else(|| format!("{cmd} nicht gefunden"))?;
    let mut c = Command::new(exe);
    c.args(args).current_dir(cwd.filter(|d| std::path::Path::new(d).is_dir()).unwrap_or_else(|| "/".into()));
    if let Some(env) = env {
        c.envs(env);
    }
    Ok(c)
}

/// Reads `Content-Length` framed messages and emits them as `proc-msg` events.
fn pump_messages(app: AppHandle, id: String, stream: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        loop {
            let mut len = None;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        app.state::<ProcState>().conns.lock().unwrap().remove(&id);
                        let _ = app.emit("proc-exit", id.clone());
                        return;
                    }
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
            let mut body = vec![0u8; len.unwrap()];
            if reader.read_exact(&mut body).is_err() {
                continue;
            }
            let _ = app.emit("proc-msg", Msg { id: id.clone(), msg: String::from_utf8_lossy(&body).into() });
        }
    });
}

fn pump_lines(app: AppHandle, id: String, stream: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let _ = app.emit("proc-stderr", Msg { id: id.clone(), msg: line });
        }
    });
}

/// Starts a JSON-RPC server that talks over stdin/stdout (language servers, debugpy, gdb).
#[tauri::command]
pub fn proc_spawn(
    app: AppHandle,
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
    pump_messages(app.clone(), id.clone(), child.stdout.take().unwrap());
    pump_lines(app.clone(), id.clone(), child.stderr.take().unwrap());
    let state = app.state::<ProcState>();
    state.conns.lock().unwrap().insert(id.clone(), Box::new(stdin));
    state.children.lock().unwrap().insert(id, child);
    Ok(())
}

/// Starts a server that listens on a TCP port (`{port}` in args is replaced); returns the port
/// once it accepts connections. Output lines are forwarded as `proc-stderr`.
#[tauri::command]
pub async fn proc_spawn_tcp(
    app: AppHandle,
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
    pump_lines(app.clone(), id.clone(), child.stdout.take().unwrap());
    pump_lines(app.clone(), id.clone(), child.stderr.take().unwrap());
    // No probe connection here: some adapters (CodeLLDB) accept exactly one client.
    // proc_connect retries until the port is open.
    app.state::<ProcState>().children.lock().unwrap().insert(id, child);
    Ok(port)
}

/// Opens a JSON-RPC connection to a TCP port (debug adapters, java-debug, js-debug child sessions).
#[tauri::command]
pub async fn proc_connect(app: AppHandle, id: String, port: u16) -> Result<(), String> {
    let stream = tauri::async_runtime::spawn_blocking(move || {
        let mut last = String::new();
        for _ in 0..100 {
            match std::net::TcpStream::connect(("127.0.0.1", port)) {
                Ok(s) => return Ok(s),
                Err(e) => last = e.to_string(),
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(format!("Verbindung zu Port {port} fehlgeschlagen: {last}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    pump_messages(app.clone(), id.clone(), reader);
    app.state::<ProcState>().conns.lock().unwrap().insert(id, Box::new(stream));
    Ok(())
}

#[tauri::command]
pub fn proc_send(app: AppHandle, id: String, msg: String) -> Result<(), String> {
    let state = app.state::<ProcState>();
    let mut conns = state.conns.lock().unwrap();
    let w = conns.get_mut(&id).ok_or("Verbindung besteht nicht")?;
    write!(w, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn proc_kill(app: AppHandle, id: String) {
    let state = app.state::<ProcState>();
    if let Some(w) = state.conns.lock().unwrap().remove(&id) {
        drop(w);
    }
    if let Some(mut child) = state.children.lock().unwrap().remove(&id) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

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

/// Installs a language server into the app's tools dir. Returns the executable path.
#[tauri::command]
pub async fn install_server(app: AppHandle, kind: String) -> Result<String, String> {
    let dir = PathBuf::from(tools_dir(app)?);
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
                let pkgs: &[&str] = if kind == "python" { &["basedpyright"] } else { &["typescript", "typescript-language-server"] };
                run(Command::new(which("npm").ok_or("npm fehlt")?).arg("install").arg("--prefix").arg(&target).arg("--no-fund").arg("--no-audit").args(pkgs))?;
                let bin = if kind == "python" { "basedpyright-langserver" } else { "typescript-language-server" };
                Ok(target.join("node_modules/.bin").join(bin).display().to_string())
            }
            "java" => {
                let target = dir.join("jdtls");
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                let archive = dir.join("jdtls.tar.gz");
                run(Command::new("curl").args(["-fsSL", "-o"]).arg(&archive).arg("https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"))?;
                run(Command::new("tar").arg("xzf").arg(&archive).arg("-C").arg(&target))?;
                let _ = std::fs::remove_file(archive);
                Ok(target.join("bin/jdtls").display().to_string())
            }
            "rust" => {
                run(Command::new(which("rustup").ok_or("rustup fehlt")?).args(["component", "add", "rust-analyzer"]))?;
                Ok("rust-analyzer".into())
            }
            _ => Err(format!("Keine automatische Installation für {kind}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn curl(url: &str, out: &std::path::Path) -> Result<(), String> {
    let o = Command::new("curl").args(["-fsSL", "-o"]).arg(out).arg(url).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err(format!("Download fehlgeschlagen: {url}\n{}", String::from_utf8_lossy(&o.stderr))) }
}

fn curl_text(url: &str) -> Result<String, String> {
    let o = Command::new("curl").args(["-fsSL", "-H", "User-Agent: studio-ide", url]).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into()) } else { Err(format!("Download fehlgeschlagen: {url}")) }
}

/// Installs a debug adapter into the tools dir and returns its main path.
#[tauri::command]
pub async fn install_debugger(app: AppHandle, kind: String) -> Result<String, String> {
    let dir = PathBuf::from(tools_dir(app)?);
    tauri::async_runtime::spawn_blocking(move || match kind.as_str() {
        "codelldb" => {
            let vsix = dir.join("codelldb.vsix");
            curl("https://github.com/vadimcn/codelldb/releases/latest/download/codelldb-linux-x64.vsix", &vsix)?;
            let target = dir.join("codelldb");
            let _ = std::fs::remove_dir_all(&target);
            let file = std::fs::File::open(&vsix).map_err(|e| e.to_string())?;
            zip::ZipArchive::new(file).map_err(|e| e.to_string())?.extract(&target).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&vsix);
            let exe = target.join("extension/adapter/codelldb");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for p in [exe.clone(), target.join("extension/lldb/bin/lldb"), target.join("extension/lldb/bin/lldb-server")] {
                    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
                }
            }
            Ok(exe.display().to_string())
        }
        "debugpy" => {
            let target = dir.join("debugpy");
            let ok = which("uv").is_some_and(|uv| {
                Command::new(uv).args(["pip", "install", "--quiet", "--target"]).arg(&target).arg("debugpy").status().is_ok_and(|s| s.success())
            });
            if !ok {
                let st = Command::new("python3").args(["-m", "pip", "install", "--quiet", "--target"]).arg(&target).arg("debugpy").status().map_err(|e| e.to_string())?;
                if !st.success() {
                    return Err("debugpy konnte nicht installiert werden".into());
                }
            }
            Ok(target.display().to_string())
        }
        "jsdebug" => {
            let release: serde_json::Value = serde_json::from_str(&curl_text("https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest")?).map_err(|e| e.to_string())?;
            let url = release["assets"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.starts_with("js-debug-dap-") && n.ends_with(".tar.gz"))))
                .and_then(|x| x["browser_download_url"].as_str())
                .ok_or("js-debug-Release nicht gefunden")?
                .to_string();
            let archive = dir.join("js-debug.tar.gz");
            curl(&url, &archive)?;
            let _ = std::fs::remove_dir_all(dir.join("js-debug"));
            let st = Command::new("tar").arg("xzf").arg(&archive).arg("-C").arg(&dir).status().map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&archive);
            if !st.success() {
                return Err("Entpacken fehlgeschlagen".into());
            }
            Ok(dir.join("js-debug/src/dapDebugServer.js").display().to_string())
        }
        "javadebug" => {
            let base = "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin";
            let meta = curl_text(&format!("{base}/maven-metadata.xml"))?;
            let version = meta
                .split("<release>")
                .nth(1)
                .and_then(|s| s.split("</release>").next())
                .ok_or("Version nicht gefunden")?
                .to_string();
            let target = dir.join("java-debug");
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            let jar = target.join(format!("com.microsoft.java.debug.plugin-{version}.jar"));
            curl(&format!("{base}/{version}/com.microsoft.java.debug.plugin-{version}.jar"), &jar)?;
            Ok(jar.display().to_string())
        }
        _ => Err(format!("Unbekannter Debugger: {kind}")),
    })
    .await
    .map_err(|e| e.to_string())?
}
