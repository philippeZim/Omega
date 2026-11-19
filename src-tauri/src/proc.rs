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
    let exe = which(cmd).ok_or_else(|| format!("{cmd} nicht gefunden"))?;
    let mut c = crate::env::command(exe);
    c.args(args).current_dir(cwd.map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(crate::env::home));
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
                let pkgs: &[&str] = if kind == "python" { &["basedpyright"] } else { &["typescript", "typescript-language-server"] };
                run(crate::env::tool("npm")?.arg("install").arg("--prefix").arg(&target).arg("--no-fund").arg("--no-audit").args(pkgs))?;
                let bin = if kind == "python" { "basedpyright-langserver" } else { "typescript-language-server" };
                Ok(crate::env::norm(target.join("node_modules").join(".bin").join(bin)))
            }
            "java" => {
                let archive = dir.join(".jdtls.tar.gz");
                crate::tools::download(&app, "jdtls", "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz", &archive)?;
                let target = dir.join("jdtls");
                let _ = std::fs::remove_dir_all(&target);
                let r = crate::tools::unpack(&archive, "jdtls.tar.gz", &target, "");
                let _ = std::fs::remove_file(archive);
                r?;
                Ok(crate::env::norm(target))
            }
            "rust" => {
                run(crate::env::tool("rustup")?.args(["component", "add", "rust-analyzer"]))?;
                Ok("rust-analyzer".into())
            }
            "clangd" => crate::tools::tool_install_blocking(&app, "clangd"),
            _ => Err(format!("Keine automatische Installation für {kind}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
                crate::env::command(uv).args(["pip", "install", "--quiet", "--target"]).arg(&target).arg("debugpy").status().is_ok_and(|s| s.success())
            });
            if !ok {
                let py = which("python3").or_else(|| which("python")).ok_or("Python nicht gefunden")?;
                let st = crate::env::command(py).args(["-m", "pip", "install", "--quiet", "--target"]).arg(&target).arg("debugpy").status().map_err(|e| e.to_string())?;
                if !st.success() {
                    return Err("debugpy konnte nicht installiert werden".into());
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
                .ok_or("js-debug-Release nicht gefunden")?
                .to_string();
            let archive = dir.join(".js-debug.tar.gz");
            crate::tools::download(&app, "jsdebug", &url, &archive)?;
            let _ = std::fs::remove_dir_all(dir.join("js-debug"));
            let r = crate::tools::unpack(&archive, "js-debug.tar.gz", &dir, "");
            let _ = std::fs::remove_file(&archive);
            r?;
            Ok(crate::env::norm(dir.join("js-debug").join("src").join("dapDebugServer.js")))
        }
        "javadebug" => {
            let base = "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin";
            let meta = crate::tools::http_text(&format!("{base}/maven-metadata.xml"))?;
            let version = meta
                .split("<release>")
                .nth(1)
                .and_then(|s| s.split("</release>").next())
                .ok_or("Version nicht gefunden")?
                .to_string();
            let target = dir.join("java-debug");
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            let jar = target.join(format!("com.microsoft.java.debug.plugin-{version}.jar"));
            crate::tools::download(&app, "javadebug", &format!("{base}/{version}/com.microsoft.java.debug.plugin-{version}.jar"), &jar)?;
            Ok(crate::env::norm(jar))
        }
        _ => Err(format!("Unbekannter Debugger: {kind}")),
    })
    .await
    .map_err(|e| e.to_string())?
}
