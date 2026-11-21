//! Overview of everything Omega installs on demand (tools, language servers, debug adapters) for
//! the "Installations" settings tab: where each one comes from (Omega's tools folder, the system,
//! or missing), its version, the newest available version, and uninstalling Omega's copies.
//! Installing/updating reuses the regular install commands (`tool_install`, `install_server`,
//! `install_debugger`); things that come from the system are only shown, never touched.
use crate::env;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct Status {
    id: String,
    /// "omega" | "system" | "missing"
    source: &'static str,
    path: Option<String>,
    version: Option<String>,
    /// Package manager a system installation belongs to (updates go through it).
    owner: Option<Owner>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Owner {
    /// "pacman" | "apt" | "dnf" | "brew" | "mise" | "rustup" | "scoop"
    manager: String,
    package: String,
}

const TOOLS: &[&str] = &["uv", "tectonic", "node", "pnpm", "cmake", "ninja", "jdk", "gradle", "rust", "git", "cc", "scala", "sbt"];
const LSPS: &[&str] = &["python", "typescript", "java", "rust", "clangd", "scala"];
const DEBUGGERS: &[&str] = &["codelldb", "debugpy", "jsdebug", "javadebug"];

fn all_ids() -> Vec<String> {
    let mut v: Vec<String> = TOOLS.iter().map(|t| format!("tool:{t}")).collect();
    v.extend(LSPS.iter().map(|t| format!("lsp:{t}")));
    v.extend(DEBUGGERS.iter().map(|t| format!("debug:{t}")));
    v
}

/// Commands that identify a tool on the PATH (first one = the executable in Omega's copy).
fn tool_cmds(id: &str) -> &'static [&'static str] {
    match id {
        "jdk" => &["java"],
        "rust" => &["cargo"],
        "clangd" => &["clangd"],
        "cc" if cfg!(windows) => &["clang", "gcc", "cl"],
        "cc" if cfg!(target_os = "macos") => &["clang", "cc"],
        "cc" => &["gcc", "cc", "clang"],
        "uv" => &["uv"],
        "tectonic" => &["tectonic"],
        "node" => &["node"],
        "pnpm" => &["pnpm"],
        "cmake" => &["cmake"],
        "ninja" => &["ninja"],
        "gradle" => &["gradle"],
        "git" => &["git"],
        "scala" => &["scala-cli"],
        "sbt" if cfg!(windows) => &["sbt.bat"],
        "sbt" => &["sbt"],
        _ => &[],
    }
}

// ------------------------------------------------------------------ versions

/// First version number in `s` ("cmake version 4.1.2" → "4.1.2", "v22.11.0" → "22.11.0").
/// Prefers dotted numbers; falls back to a plain number ("20241030"). Long build stamps after the
/// third component are dropped ("1.44.0.202501221502" → "1.44.0").
pub fn extract_version(s: &str) -> Option<String> {
    let re = regex::Regex::new(r"\d+(?:\.\d+)+").unwrap();
    let raw = re.find(s).map(|m| m.as_str().to_string()).or_else(|| regex::Regex::new(r"\d+").unwrap().find(s).map(|m| m.as_str().to_string()))?;
    let parts: Vec<&str> = raw.split('.').collect();
    let mut keep = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i >= 3 && p.len() > 6 {
            break;
        }
        keep.push(*p);
    }
    Some(keep.join("."))
}

/// Runs `exe args` (max. 10 s) and extracts the version from stdout+stderr.
fn exe_version(exe: &Path, args: &[&str]) -> Option<String> {
    let mut c = env::command(exe);
    c.args(args).stdin(std::process::Stdio::null());
    let child = c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().ok()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = rx.recv_timeout(Duration::from_secs(10)).ok()?.ok()?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    extract_version(&text)
}

fn version_arg(cmd: &str) -> &'static [&'static str] {
    match cmd {
        "java" => &["-version"],
        "cl" => &[],
        // Plain `sbt --version` boots sbt and creates project/ and target/ in the current folder.
        "sbt" | "sbt.bat" => &["--script-version"],
        _ => &["--version"],
    }
}

fn json_version(path: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v["version"].as_str().map(String::from)
}

/// Version from the name of the first entry in `dir` that starts with `prefix`.
fn name_version(dir: &Path, prefix: &str) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).find(|n| n.starts_with(prefix)).and_then(|n| extract_version(&n[prefix.len()..]))
}

// ------------------------------------------------------------------ status

fn tools() -> PathBuf {
    env::tools_dir()
}

fn in_tools(p: &Path) -> bool {
    p.starts_with(tools())
}

/// First of `cmds` on the PATH that isn't one of Omega's own copies.
fn system_exe(cmds: &[&str]) -> Option<(PathBuf, String)> {
    let path = env::path();
    for c in cmds {
        for d in std::env::split_paths(&path) {
            if in_tools(&d) {
                continue;
            }
            if let Some(p) = env::which(&env::norm(d.join(c))) {
                return Some((p, c.to_string()));
            }
        }
    }
    None
}

fn omega(path: PathBuf, version: Option<String>) -> (&'static str, Option<PathBuf>, Option<String>) {
    ("omega", Some(path), version)
}

fn system_tool(cmds: &[&str], with_version: bool) -> (&'static str, Option<PathBuf>, Option<String>) {
    match system_exe(cmds) {
        Some((p, c)) => {
            let v = if with_version { exe_version(&p, version_arg(&c)) } else { None };
            ("system", Some(p), v)
        }
        None => ("missing", None, None),
    }
}

fn locate(id: &str) -> (&'static str, Option<PathBuf>, Option<String>) {
    let t = tools();
    let manifest = crate::tools::manifest();
    let (group, name) = id.split_once(':').unwrap_or(("", id));
    match (group, name) {
        ("tool", name) | ("lsp", name @ "clangd") => {
            if let Some(bin) = manifest.get(name).map(PathBuf::from).filter(|p| p.is_dir()) {
                let cmd = tool_cmds(name)[0];
                let exe = env::which(&env::norm(bin.join(cmd))).unwrap_or_else(|| bin.join(cmd));
                // llvm-mingw is versioned by release date; its folder name carries it.
                let v = if name == "cc" && cfg!(windows) { name_version(&t.join("cc"), "llvm-mingw-") } else { exe_version(&exe, version_arg(cmd)) };
                return omega(exe, v);
            }
            // A system sbt may be a launcher without --script-version, which would boot sbt here.
            system_tool(tool_cmds(name), name != "sbt")
        }
        ("lsp", "python") => {
            let d = t.join("python").join("node_modules");
            match env::which(&env::norm(d.join(".bin").join("basedpyright-langserver"))) {
                Some(p) => omega(p, json_version(&d.join("basedpyright").join("package.json"))),
                None => system_tool(&["basedpyright-langserver", "pyright-langserver"], false),
            }
        }
        ("lsp", "typescript") => {
            let d = t.join("typescript").join("node_modules");
            match env::which(&env::norm(d.join(".bin").join("typescript-language-server"))) {
                Some(p) => omega(p, json_version(&d.join("typescript-language-server").join("package.json"))),
                None => system_tool(&["typescript-language-server"], true),
            }
        }
        ("lsp", "java") => {
            let d = t.join("jdtls");
            if d.join("plugins").is_dir() {
                return omega(d.clone(), name_version(&d.join("plugins"), "org.eclipse.jdt.ls.core_"));
            }
            system_tool(&["jdtls"], false)
        }
        ("lsp", "rust") => {
            // A component of the Rust toolchain (rustup); updated together with Rust.
            match env::which("rust-analyzer").filter(|p| env::command(p).arg("--version").output().is_ok_and(|o| o.status.success())) {
                Some(p) => {
                    let v = exe_version(&p, &["--version"]);
                    (if manifest.contains_key("rust") { "omega" } else { "system" }, Some(p), v)
                }
                None => ("missing", None, None),
            }
        }
        ("lsp", "scala") => {
            let d = t.join("metals");
            match env::which(&env::norm(d.join("metals"))) {
                Some(p) => omega(p, std::fs::read_to_string(d.join(".omega-version")).ok().map(|s| s.trim().to_string())),
                None => system_tool(&["metals"], false),
            }
        }
        ("debug", "codelldb") => {
            let d = t.join("codelldb").join("extension");
            if d.is_dir() { omega(t.join("codelldb"), json_version(&d.join("package.json"))) } else { ("missing", None, None) }
        }
        ("debug", "debugpy") => {
            let d = t.join("debugpy");
            if d.join("debugpy").is_dir() { omega(d.clone(), name_version(&d, "debugpy-")) } else { ("missing", None, None) }
        }
        ("debug", "jsdebug") => {
            let d = t.join("js-debug");
            if d.is_dir() {
                let v = std::fs::read_to_string(d.join(".omega-version")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                omega(d, v)
            } else {
                ("missing", None, None)
            }
        }
        ("debug", "javadebug") => {
            let d = t.join("java-debug");
            match name_version(&d, "com.microsoft.java.debug.plugin-") {
                Some(v) => omega(d, Some(v)),
                None => ("missing", None, None),
            }
        }
        _ => ("missing", None, None),
    }
}

/// Status of every item (checked in parallel: version calls like `gradle --version` are slow).
#[tauri::command]
pub async fn installs_status() -> Vec<Status> {
    tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = all_ids()
            .into_iter()
            .map(|id| {
                std::thread::spawn(move || {
                    let (source, path, version) = locate(&id);
                    let owner = if source == "system" { path.as_deref().and_then(owner) } else { None };
                    Status { id, source, path: path.map(env::norm), version, owner }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .unwrap_or_default()
}

// ------------------------------------------------------------------ package managers

fn out(c: &mut std::process::Command) -> Option<(bool, String)> {
    let o = c.stdin(std::process::Stdio::null()).output().ok()?;
    Some((o.status.success(), String::from_utf8_lossy(&o.stdout).to_string()))
}

fn segment_after(p: &str, marker: &str) -> Option<String> {
    p.split_once(marker).and_then(|(_, rest)| rest.split('/').next()).filter(|s| !s.is_empty()).map(String::from)
}

/// Package manager recognisable from the (normalised) path alone: mise, Homebrew, Scoop.
fn owner_from_path(p: &str) -> Option<Owner> {
    let own = |m: &str, p: String| Some(Owner { manager: m.into(), package: p });
    if let Some(n) = segment_after(p, "/mise/installs/") {
        return own("mise", n);
    }
    if let Some(n) = segment_after(p, "/Cellar/") {
        return own("brew", n);
    }
    if let Some(n) = segment_after(&p.to_lowercase(), "/scoop/apps/") {
        return own("scoop", n);
    }
    None
}

/// Which package manager installed `path` (and under which package name).
fn owner(path: &Path) -> Option<Owner> {
    let own = |m: &str, p: String| Some(Owner { manager: m.into(), package: p });
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (orig, canon) = (env::norm(path), env::norm(&real));
    for p in [&orig, &canon] {
        if let Some(o) = owner_from_path(p) {
            return Some(o);
        }
    }
    if path.starts_with(env::home().join(".cargo").join("bin")) && env::which("rustup").is_some() {
        return own("rustup", "stable".into());
    }
    if !cfg!(target_os = "linux") {
        return None;
    }
    if env::which("pacman").is_some() {
        let (ok, o) = out(env::command("pacman").arg("-Qqo").arg(&real))?;
        return if ok { own("pacman", o.trim().to_string()) } else { None };
    }
    if env::which("dpkg-query").is_some() {
        // "nodejs: /usr/bin/node" (or "nodejs:amd64: …")
        let (ok, o) = out(env::command("dpkg-query").arg("-S").arg(&real))?;
        return if ok { own("apt", o.lines().next()?.split(':').next()?.trim().to_string()) } else { None };
    }
    if env::which("rpm").is_some() {
        let (ok, o) = out(env::command("rpm").args(["-qf", "--qf", "%{NAME}"]).arg(&real))?;
        return if ok { own("dnf", o.trim().to_string()) } else { None };
    }
    None
}

#[derive(serde::Serialize)]
pub struct SysUpdate {
    /// Newer version the package manager offers (None: up to date).
    available: Option<String>,
    /// Shell command that performs the update (run visibly in the terminal).
    command: Option<String>,
    /// The update upgrades the whole system (Arch doesn't support partial upgrades).
    full_system: bool,
}

fn update_command(o: &Owner) -> Option<(String, bool)> {
    let p = &o.package;
    Some(match o.manager.as_str() {
        "pacman" => (format!("sudo pacman -Syu --needed {p}"), true),
        "apt" => (format!("sudo apt update && sudo apt install --only-upgrade -y {p}"), false),
        "dnf" => (format!("sudo dnf upgrade -y {p}"), false),
        "brew" => (format!("brew upgrade {p}"), false),
        "mise" => (format!("mise upgrade {p}"), false),
        "rustup" => ("rustup update".into(), false),
        "scoop" => (format!("scoop update {p}"), false),
        _ => return None,
    })
}

/// Newer version of `o` from its package manager: Ok(None) = up to date, Err = unknown.
fn sys_available(o: &Owner, pacman_updates: &Option<std::collections::HashMap<String, String>>) -> Result<Option<String>, String> {
    let p = o.package.as_str();
    let none = || "keine Antwort".to_string();
    match o.manager.as_str() {
        "pacman" => {
            if let Some(map) = pacman_updates {
                return Ok(map.get(p).cloned());
            }
            // No checkupdates: compare with the (possibly stale) sync database.
            let (ok, info) = out(env::command("pacman").args(["-Si", p])).ok_or_else(none)?;
            if !ok {
                return Err("installs:not_in_repos".into());
            }
            let repo = info.lines().find(|l| l.starts_with("Version")).and_then(|l| l.split(':').nth(1)).map(|v| v.trim().to_string()).ok_or_else(none)?;
            let (_, inst) = out(env::command("pacman").args(["-Q", p])).ok_or_else(none)?;
            Ok((inst.split_whitespace().nth(1) != Some(repo.as_str())).then_some(repo))
        }
        "apt" => {
            let (_, o) = out(env::command("apt-cache").args(["policy", p])).ok_or_else(none)?;
            let field = |k: &str| o.lines().find(|l| l.trim_start().starts_with(k)).and_then(|l| l.split_once(':')).map(|(_, v)| v.trim().to_string());
            let (inst, cand) = (field("Installed").ok_or_else(none)?, field("Candidate").ok_or_else(none)?);
            Ok((inst != cand && cand != "(none)").then_some(cand))
        }
        "dnf" => {
            let o = env::command("dnf").args(["-q", "check-update", p]).output().map_err(|e| e.to_string())?;
            // Exit code 100: updates available, listed as "name.arch  version  repo".
            if o.status.code() != Some(100) {
                return Ok(None);
            }
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            Ok(text.lines().find(|l| l.starts_with(&format!("{p}."))).and_then(|l| l.split_whitespace().nth(1)).map(String::from))
        }
        "brew" => {
            let (_, o) = out(env::command("brew").args(["outdated", "--json=v2", p])).ok_or_else(none)?;
            let v: serde_json::Value = serde_json::from_str(&o).map_err(|e| e.to_string())?;
            Ok(v["formulae"][0]["current_version"].as_str().map(String::from))
        }
        "mise" => {
            let (_, o) = out(env::command("mise").args(["outdated", p, "--json"])).ok_or_else(none)?;
            let v: serde_json::Value = serde_json::from_str(&o).map_err(|e| e.to_string())?;
            Ok(v[p]["latest"].as_str().map(String::from))
        }
        "rustup" => {
            let (_, o) = out(env::command("rustup").arg("check")).ok_or_else(none)?;
            let line = o.lines().find(|l| l.starts_with("stable")).unwrap_or_default();
            Ok(if line.to_lowercase().contains("update available") { line.rsplit("->").next().and_then(extract_version) } else { None })
        }
        "scoop" => {
            let (_, o) = out(env::tool("scoop")?.arg("status")).ok_or_else(none)?;
            parse_scoop_status(&o, p)
        }
        _ => Err("installs:unknown_manager".into()),
    }
}

/// Latest version of `package` from `scoop status` output: Ok(None) = not listed as outdated.
/// Scoop prints a PowerShell table ("Name  Installed Version  Latest Version  Missing Dependencies
/// Info"); old versions printed "Updates are available for:" followed by "name: old -> new" lines.
fn parse_scoop_status(text: &str, package: &str) -> Result<Option<String>, String> {
    let lines: Vec<&str> = text.lines().collect();
    if let Some(h) = lines.iter().position(|l| l.trim_start().starts_with("Name") && l.contains("Latest Version")) {
        // Cells are fixed-width columns aligned with the header.
        let col = |name: &str| lines[h].find(name).map(|b| lines[h][..b].chars().count());
        let start = col("Latest Version").ok_or("scoop status: no Latest Version column")?;
        let end = col("Missing Dependencies").or_else(|| col("Info")).unwrap_or(usize::MAX);
        for row in &lines[h + 1..] {
            if row.split_whitespace().next() != Some(package) {
                continue;
            }
            let cell: String = row.chars().skip(start).take(end.saturating_sub(start)).collect();
            return Ok(cell.split_whitespace().next().map(String::from));
        }
        return Ok(None);
    }
    for l in &lines {
        if let Some((name, rest)) = l.trim().split_once(':') {
            if name.trim() == package {
                if let Some((_, new)) = rest.split_once("->") {
                    return Ok(Some(new.trim().to_string()));
                }
            }
        }
    }
    let low = text.to_lowercase();
    if low.contains("everything is ok") || low.contains("updates are available") {
        return Ok(None);
    }
    Err("scoop status: unexpected output".into())
}

/// Asks the package managers about updates for the given system installations.
#[tauri::command]
pub async fn installs_system_updates(items: std::collections::BTreeMap<String, Owner>) -> std::collections::BTreeMap<String, SysUpdate> {
    tauri::async_runtime::spawn_blocking(move || {
        // checkupdates (pacman-contrib) syncs a temporary database: fresh results, no root needed.
        let pacman_updates = (items.values().any(|o| o.manager == "pacman") && env::which("checkupdates").is_some())
            .then(|| env::command("checkupdates").stdin(std::process::Stdio::null()).output().ok())
            .flatten()
            .filter(|o| o.status.code() == Some(0) || o.status.code() == Some(2)) // 2 = no updates
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| {
                        let mut w = l.split_whitespace();
                        let name = w.next()?.to_string();
                        Some((name, w.last()?.to_string()))
                    })
                    .collect::<std::collections::HashMap<_, _>>()
            });
        let pacman_updates = std::sync::Arc::new(pacman_updates);
        let handles: Vec<_> = items
            .into_iter()
            .map(|(id, o)| {
                let pu = pacman_updates.clone();
                std::thread::spawn(move || {
                    let r = sys_available(&o, &pu);
                    if let Err(e) = &r {
                        eprintln!("installs_system_updates {id}: {e}");
                    }
                    let cmd = update_command(&o);
                    (id, r.ok().map(|available| SysUpdate { available: available.as_deref().map(|v| extract_version(v).unwrap_or(v.to_string())), command: cmd.as_ref().map(|c| c.0.clone()), full_system: cmd.is_some_and(|c| c.1) }))
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).filter_map(|(id, u)| u.map(|u| (id, u))).collect()
    })
    .await
    .unwrap_or_default()
}

// ------------------------------------------------------------------ latest versions

fn json(url: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(&crate::tools::http_text(url)?).map_err(|e| format!("{url}: {e}"))
}

fn gh_latest(repo: &str) -> Result<String, String> {
    let r = json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
    r["tag_name"].as_str().and_then(extract_version).ok_or_else(|| format!("installs:no_version:{repo}"))
}

fn npm_latest(pkg: &str) -> Result<String, String> {
    json(&format!("https://registry.npmjs.org/{pkg}/latest"))?["version"].as_str().map(String::from).ok_or_else(|| format!("installs:no_version:{pkg}"))
}

fn latest(id: &str) -> Result<Option<String>, String> {
    let v = match id {
        "tool:uv" => gh_latest("astral-sh/uv")?,
        "tool:tectonic" => gh_latest("tectonic-typesetting/tectonic")?,
        "tool:node" => {
            let index = json("https://nodejs.org/dist/index.json")?;
            index.as_array().and_then(|a| a.iter().find(|r| r["lts"].is_string())).and_then(|r| r["version"].as_str()).and_then(extract_version).ok_or("installs:no_version:Node.js")?
        }
        "tool:pnpm" => gh_latest("pnpm/pnpm")?,
        "tool:cmake" => gh_latest("Kitware/CMake")?,
        "tool:ninja" => gh_latest("ninja-build/ninja")?,
        "lsp:clangd" => gh_latest("clangd/clangd")?,
        "tool:jdk" => {
            let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "mac" } else { "linux" };
            let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
            let r = json(&format!("https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture={arch}&image_type=jdk&os={os}&vendor=eclipse"))?;
            r[0]["version"]["semver"].as_str().and_then(extract_version).ok_or("installs:no_version:JDK")?
        }
        "tool:scala" => gh_latest("VirtusLab/scala-cli")?,
        "tool:sbt" => gh_latest("sbt/sbt")?,
        "lsp:scala" => crate::tools::metals_latest()?,
        "tool:gradle" => json("https://services.gradle.org/versions/current")?["version"].as_str().map(String::from).ok_or("installs:no_version:Gradle")?,
        "tool:git" if cfg!(windows) => gh_latest("git-for-windows/git")?,
        "tool:cc" if cfg!(windows) => gh_latest("mstorsjo/llvm-mingw")?,
        "tool:rust" => {
            // `rustup check`: "stable-x86_64-… - Update available : 1.82.0 (…) -> 1.83.0 (…)" or "Up to date : 1.83.0 (…)".
            let out = env::tool("rustup")?.arg("check").output().map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let line = text.lines().find(|l| l.starts_with("stable")).unwrap_or_default();
            let tail = line.rsplit("->").next().unwrap_or(line);
            let tail = tail.rsplit(':').next().unwrap_or(tail);
            extract_version(tail).ok_or("installs:no_version:rustup")?
        }
        "lsp:python" => npm_latest("basedpyright")?,
        "lsp:typescript" => npm_latest("typescript-language-server")?,
        "lsp:java" => {
            let name = crate::tools::http_text("https://download.eclipse.org/jdtls/snapshots/latest.txt")?;
            extract_version(name.trim().trim_start_matches("jdt-language-server-")).ok_or("installs:no_version:jdtls")?
        }
        "debug:codelldb" => gh_latest("vadimcn/codelldb")?,
        "debug:debugpy" => json("https://pypi.org/pypi/debugpy/json")?["info"]["version"].as_str().map(String::from).ok_or("installs:no_version:debugpy")?,
        "debug:jsdebug" => gh_latest("microsoft/vscode-js-debug")?,
        "debug:javadebug" => {
            let meta = crate::tools::http_text("https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/maven-metadata.xml")?;
            meta.split("<release>").nth(1).and_then(|s| s.split("</release>").next()).map(String::from).ok_or("installs:no_version:java-debug")?
        }
        _ => return Ok(None),
    };
    Ok(Some(v))
}

/// Newest available version for each of `ids` (null when unknown or the lookup failed).
#[tauri::command]
pub async fn installs_latest(ids: Vec<String>) -> std::collections::BTreeMap<String, Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = ids.into_iter().map(|id| std::thread::spawn(move || {
            let v = latest(&id).unwrap_or_else(|e| {
                eprintln!("installs_latest {id}: {e}");
                None
            });
            (id, v)
        })).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .unwrap_or_default()
}

// ------------------------------------------------------------------ uninstall / rust update

fn remove_dir(p: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", env::norm(p))),
    }
}

fn run_ok(c: &mut std::process::Command) -> Result<(), String> {
    let out = c.output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).chars().take(800).collect()) }
}

fn uninstall(id: &str) -> Result<(), String> {
    let t = tools();
    let manifest = crate::tools::manifest();
    match id.split_once(':').unwrap_or(("", id)) {
        ("tool", "rust") => {
            if !manifest.contains_key("rust") {
                return Err("installs:not_ours:Rust".into());
            }
            run_ok(env::tool("rustup")?.args(["self", "uninstall", "-y"]))?;
            crate::tools::forget("rust")
        }
        ("tool", name) | ("lsp", name @ "clangd") => {
            if !manifest.contains_key(name) {
                return Err(format!("installs:not_ours:{name}"));
            }
            remove_dir(&t.join(name))?;
            crate::tools::forget(name)
        }
        ("lsp", "rust") => {
            if !manifest.contains_key("rust") {
                return Err("installs:system_rust_analyzer".into());
            }
            run_ok(env::tool("rustup")?.args(["component", "remove", "rust-analyzer"]))
        }
        ("lsp", "python") => remove_dir(&t.join("python")),
        ("lsp", "typescript") => remove_dir(&t.join("typescript")),
        ("lsp", "scala") => remove_dir(&t.join("metals")),
        ("lsp", "java") => {
            remove_dir(&t.join("jdtls"))?;
            remove_dir(&t.join("jdtls-config"))
        }
        ("debug", "codelldb") => remove_dir(&t.join("codelldb")),
        ("debug", "debugpy") => remove_dir(&t.join("debugpy")),
        ("debug", "jsdebug") => remove_dir(&t.join("js-debug")),
        ("debug", "javadebug") => remove_dir(&t.join("java-debug")),
        _ => Err(format!("installs:unknown:{id}")),
    }
}

/// Removes an item Omega installed (system installations are refused).
#[tauri::command]
pub async fn installs_remove(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || uninstall(&id)).await.map_err(|e| e.to_string())?
}

/// `rustup update` for a Rust toolchain Omega installed.
#[tauri::command]
pub async fn installs_update_rust() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !crate::tools::manifest().contains_key("rust") {
            return Err("installs:not_ours:Rust".into());
        }
        run_ok(env::tool("rustup")?.arg("update"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoop_status_table() {
        let text = "Scoop is up to date.\n\nName   Installed Version Latest Version Missing Dependencies Info\n----   ----------------- -------------- -------------------- ----\nuv     0.4.0             0.5.1\nnodejs 20.0.0            22.1.0                              Held package\ngit    2.40.0                                                Manifest removed\n\n";
        assert_eq!(parse_scoop_status(text, "uv"), Ok(Some("0.5.1".into())));
        assert_eq!(parse_scoop_status(text, "nodejs"), Ok(Some("22.1.0".into())));
        // Listed, but without a newer version (manifest gone): nothing to offer.
        assert_eq!(parse_scoop_status(text, "git"), Ok(None));
        assert_eq!(parse_scoop_status(text, "cmake"), Ok(None));
    }

    #[test]
    fn scoop_status_other_formats() {
        assert_eq!(parse_scoop_status("Scoop is up to date.\nEverything is ok!\n", "uv"), Ok(None));
        let old = "Updates are available for:\n    uv: 0.4.0 -> 0.5.1\n    cmake: 3.30.0 -> 4.1.2\n";
        assert_eq!(parse_scoop_status(old, "cmake"), Ok(Some("4.1.2".into())));
        assert_eq!(parse_scoop_status(old, "node"), Ok(None));
        assert!(parse_scoop_status("", "uv").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn scoop_owner_has_an_update_check() {
        // Before #19, sys_available had no scoop arm ("unknown package manager"), so scoop installs
        // never got an update entry. Here (no scoop installed) it gets as far as looking for scoop.
        let o = Owner { manager: "scoop".into(), package: "uv".into() };
        assert_eq!(sys_available(&o, &None), Err("scoop: not found".to_string()));
    }

    #[test]
    fn versions() {
        assert_eq!(extract_version("cmake version 4.1.2\n").as_deref(), Some("4.1.2"));
        assert_eq!(extract_version("v22.11.0").as_deref(), Some("22.11.0"));
        assert_eq!(extract_version("openjdk version \"21.0.5\" 2024-10-15").as_deref(), Some("21.0.5"));
        assert_eq!(extract_version("1.44.0.202501221502.jar").as_deref(), Some("1.44.0"));
        assert_eq!(extract_version("tectonic@0.15.0").as_deref(), Some("0.15.0"));
        assert_eq!(extract_version("20241030").as_deref(), Some("20241030"));
    }

    #[test]
    fn segment_after_cases() {
        assert_eq!(segment_after("/x/mise/installs/node/22/bin", "/mise/installs/").as_deref(), Some("node"));
        assert_eq!(segment_after("/x/mise/installs/node", "/mise/installs/").as_deref(), Some("node"));
        assert_eq!(segment_after("/x/mise/installs/", "/mise/installs/"), None);
        assert_eq!(segment_after("/usr/bin/node", "/mise/installs/"), None);
        assert_eq!(segment_after("", "/mise/installs/"), None);
    }

    fn owner_of(p: &str) -> Option<(String, String)> {
        owner_from_path(p).map(|o| (o.manager, o.package))
    }

    fn pair(m: &str, p: &str) -> Option<(String, String)> {
        Some((m.into(), p.into()))
    }

    #[test]
    fn owner_from_path_cases() {
        assert_eq!(owner_of("/home/u/.local/share/mise/installs/node/22.11.0/bin/node"), pair("mise", "node"));
        assert_eq!(owner_of("/opt/homebrew/Cellar/cmake/4.1.2/bin/cmake"), pair("brew", "cmake"));
        assert_eq!(owner_of("/usr/local/Cellar/node/23.1.0/bin/node"), pair("brew", "node"));
        assert_eq!(owner_of("C:/Users/U/Scoop/Apps/nodejs/current/node.exe"), pair("scoop", "nodejs"));
        assert_eq!(owner_of("C:/Users/U/scoop/apps/cmake/current/bin/cmake.exe"), pair("scoop", "cmake"));
        // Markers are case-sensitive for mise/brew.
        assert_eq!(owner_of("/opt/homebrew/cellar/cmake/4.1.2/bin/cmake"), None);
        assert_eq!(owner_of("/usr/bin/node"), None);
        assert_eq!(owner_of("/x/mise/installs/"), None);
    }

    #[test]
    fn update_command_cases() {
        let o = |m: &str| Owner { manager: m.into(), package: "nodejs".into() };
        assert_eq!(update_command(&o("pacman")), Some(("sudo pacman -Syu --needed nodejs".to_string(), true)));
        assert_eq!(update_command(&o("apt")), Some(("sudo apt update && sudo apt install --only-upgrade -y nodejs".to_string(), false)));
        assert_eq!(update_command(&o("brew")), Some(("brew upgrade nodejs".to_string(), false)));
        assert_eq!(update_command(&o("rustup")), Some(("rustup update".to_string(), false)));
        for m in ["dnf", "mise", "scoop"] {
            let (cmd, full) = update_command(&o(m)).unwrap();
            assert!(cmd.ends_with(" nodejs") && !full, "{m}: {cmd}");
        }
        assert_eq!(update_command(&o("unknown")), None);
    }
}

#[cfg(test)]
mod live {
    /// Prints status + latest of everything (`cargo test --lib live_overview -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn live_overview() {
        crate::env::init(crate::env::home().join(".local/share/io.github.philippezim.omega/tools"));
        for id in super::all_ids() {
            let (s, p, v) = super::locate(&id);
            let l = super::latest(&id);
            let o = if s == "system" { p.as_deref().and_then(super::owner).map(|o| format!("{}:{}", o.manager, o.package)) } else { None };
            println!("{id:16} {s:8} {:12} latest={:?} owner={:?} {}", v.unwrap_or_default(), l, o, p.map(crate::env::norm).unwrap_or_default());
        }
    }

    #[test]
    #[ignore]
    fn live_system_updates() {
        crate::env::init(crate::env::home().join(".local/share/io.github.philippezim.omega/tools"));
        let mut items = std::collections::BTreeMap::new();
        for id in super::all_ids() {
            let (s, p, _) = super::locate(&id);
            if let (true, Some(o)) = (s == "system", p.as_deref().and_then(super::owner)) {
                items.insert(id, o);
            }
        }
        let r = tauri::async_runtime::block_on(super::installs_system_updates(items));
        for (id, u) in r {
            println!("{id:16} available={:?} cmd={:?} full={}", u.available, u.command, u.full_system);
        }
    }
}
