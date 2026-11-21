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
    let exe = which(cmd).ok_or_else(|| format!("proc:not_found:{cmd}"))?;
    let mut c = crate::env::command(exe);
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
fn pump_messages(app: AppHandle, id: String, stream: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        while let Some(body) = read_message(&mut reader) {
            let _ = app.emit("proc-msg", Msg { id: id.clone(), msg: String::from_utf8_lossy(&body).into() });
        }
        app.state::<ProcState>().conns.lock().unwrap().remove(&id);
        let _ = app.emit("proc-exit", id.clone());
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
        Err(format!("proc:connect_failed:{port}: {last}"))
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
    let w = conns.get_mut(&id).ok_or("proc:not_connected")?;
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
fn run_registered(children: &Mutex<HashMap<String, Child>>, id: &str, c: &mut Command) -> Result<Captured, String> {
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    children.lock().unwrap().insert(id.to_string(), child);
    let code = loop {
        {
            let mut map = children.lock().unwrap();
            let Some(child) = map.get_mut(id) else { break None };
            if let Ok(Some(status)) = child.try_wait() {
                map.remove(id);
                break Some(status.code().unwrap_or(-1));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let wait = std::time::Duration::from_millis(if code.is_some() { 2000 } else { 0 });
    Ok(Captured { code: code.unwrap_or(-1), stdout: stdout.recv_timeout(wait).unwrap_or_default(), stderr: stderr.recv_timeout(wait).unwrap_or_default() })
}

/// `run_capture` for a build that may have to stop early: `proc_kill` with this `id` ends it.
#[tauri::command]
pub async fn run_killable(app: AppHandle, id: String, cmd: String, args: Vec<String>, cwd: Option<String>) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = command(&cmd, &args, cwd, None)?;
        run_registered(&app.state::<ProcState>().children, &id, &mut c)
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
            "scala" => crate::tools::install_metals(&app),
            "ocaml" => crate::tools::install_ocaml_package(&app, "lsp-ocaml", "ocaml-lsp-server", "ocamllsp"),
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
        _ => Err(format!("proc:unknown_debugger:{kind}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{npm_packages, read_message, run_registered};
    use std::collections::HashMap;
    use std::process::Command;
    use std::sync::Mutex;

    #[cfg(unix)]
    #[test]
    fn a_registered_run_reports_its_exit_and_output() {
        let children = Mutex::new(HashMap::new());
        let mut c = Command::new("sh");
        c.args(["-c", "echo out; echo err >&2; exit 3"]);
        let r = run_registered(&children, "b", &mut c).unwrap();
        assert_eq!((r.code, r.stdout.trim(), r.stderr.trim()), (3, "out", "err"));
        assert!(children.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_registered_run_ends_at_once_when_it_is_killed() {
        let children = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let map = children.clone();
        let run = std::thread::spawn(move || {
            let mut c = Command::new("sleep");
            c.arg("30");
            run_registered(&map, "b", &mut c).unwrap().code
        });
        let start = std::time::Instant::now();
        loop {
            if let Some(mut child) = children.lock().unwrap().remove("b") {
                child.kill().unwrap();
                child.wait().unwrap();
                break;
            }
            assert!(start.elapsed().as_secs() < 5);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(run.join().unwrap(), -1);
        assert!(start.elapsed().as_secs() < 5);
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
