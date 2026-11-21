//! Tools Omega can install by itself into its app-data folder (`tools/`), per OS and CPU:
//! uv (Python), tectonic (LaTeX), Node.js, pnpm, CMake, Ninja, clangd, a JDK, Gradle, Rust (rustup),
//! Scala CLI with Coursier, sbt, OCaml through its own opam root, a C/C++ compiler (llvm-mingw on Windows, Xcode Command Line Tools
//! on macOS) and Git on Windows.
//! Installed tools are recorded in `tools/managed.json` (tool id → folder with its executables);
//! those folders are appended to the PATH of everything Omega starts (see `env.rs`).
use crate::env;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

const OS: &str = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
const ARM: bool = cfg!(target_arch = "aarch64");

fn manifest_path() -> PathBuf {
    env::tools_dir().join("managed.json")
}

pub fn manifest() -> BTreeMap<String, String> {
    std::fs::read_to_string(manifest_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn managed_bin_dirs() -> Vec<PathBuf> {
    manifest().into_values().map(PathBuf::from).filter(|p| p.is_dir()).collect()
}

fn record(id: &str, bin: &Path) -> Result<(), String> {
    let mut m = manifest();
    m.insert(id.into(), bin.display().to_string());
    std::fs::write(manifest_path(), serde_json::to_string_pretty(&m).unwrap()).map_err(|e| e.to_string())?;
    env::rebuild();
    Ok(())
}

/// Drops a tool from the manifest (after its folder was removed).
pub fn forget(id: &str) -> Result<(), String> {
    let mut m = manifest();
    m.remove(id);
    std::fs::write(manifest_path(), serde_json::to_string_pretty(&m).unwrap()).map_err(|e| e.to_string())?;
    env::rebuild();
    Ok(())
}

// ------------------------------------------------------------------ downloads

#[derive(Clone, serde::Serialize)]
struct Progress<'a> {
    id: &'a str,
    done: u64,
    total: u64,
    stage: &'a str,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().user_agent("omega-ide").timeout_connect(std::time::Duration::from_secs(20)).build()
}

pub fn http_text(url: &str) -> Result<String, String> {
    get_text(url)
}

fn get_text(url: &str) -> Result<String, String> {
    agent().get(url).call().map_err(|e| format!("{url}: {e}"))?.into_string().map_err(|e| e.to_string())
}

fn get_json(url: &str) -> Result<Value, String> {
    serde_json::from_str(&get_text(url)?).map_err(|e| format!("{url}: {e}"))
}

/// Streams `url` into `out`, emitting `tool-progress`; returns the final URL (after redirects).
pub fn download(app: &AppHandle, id: &str, url: &str, out: &Path) -> Result<String, String> {
    let resp = agent().get(url).call().map_err(|e| format!("tools:download_failed:{url}: {e}"))?;
    let final_url = resp.get_url().to_string();
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut last) = (0u64, 0u64);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("tools:download_aborted:{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last > 512 * 1024 {
            last = done;
            let _ = app.emit("tool-progress", Progress { id, done, total, stage: "download" });
        }
    }
    let _ = app.emit("tool-progress", Progress { id, done, total, stage: "extract" });
    Ok(final_url)
}

/// Unpacks a zip (.zip/.vsix) or gzip'ed tar into `dest`, detected by the file's signature
/// (download URLs often don't show the file name). Anything else is copied as executable `raw_name`.
pub fn unpack(archive: &Path, _name_hint: &str, dest: &Path, raw_name: &str) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 4];
    let n = std::fs::File::open(archive).and_then(|mut f| f.read(&mut magic)).map_err(|e| e.to_string())?;
    let magic = &magic[..n];
    if magic.starts_with(b"PK\x03\x04") {
        let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        zip::ZipArchive::new(f).map_err(|e| e.to_string())?.extract(dest).map_err(|e| format!("tools:unpack_failed:{e}"))
    } else if magic.starts_with(&[0x1f, 0x8b]) {
        let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut a = tar::Archive::new(flate2::read::GzDecoder::new(f));
        a.set_preserve_permissions(true);
        a.unpack(dest).map_err(|e| format!("tools:unpack_failed:{e}"))
    } else {
        let target = dest.join(raw_name);
        std::fs::copy(archive, &target).map_err(|e| e.to_string())?;
        make_executable(&target);
        Ok(())
    }
}

fn make_executable(_p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o755));
    }
}

fn exe_name(name: &str) -> String {
    exe_name_on(cfg!(windows), name)
}

/// A name with an extension is complete already (sbt.bat).
fn exe_name_on(windows: bool, name: &str) -> String {
    if windows && !name.contains('.') { format!("{name}.exe") } else { name.to_string() }
}

/// Folder below `root` that contains executable `name` (breadth-first, a few levels deep).
fn find_bin(root: &Path, name: &str) -> Option<PathBuf> {
    let file = exe_name(name);
    let mut level = vec![root.to_path_buf()];
    for _ in 0..6 {
        let mut next = Vec::new();
        for d in level {
            if d.join(&file).is_file() {
                return Some(d);
            }
            if let Ok(rd) = std::fs::read_dir(&d) {
                next.extend(rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
            }
        }
        level = next;
    }
    None
}

/// First asset of a recent (non-prerelease) GitHub release whose lowercase name matches.
fn gh_asset(repo: &str, pred: impl Fn(&str) -> bool) -> Result<String, String> {
    let releases = get_json(&format!("https://api.github.com/repos/{repo}/releases?per_page=20"))?;
    pick_asset(&releases, pred).ok_or_else(|| format!("tools:no_asset:{OS}/{} ({repo})", std::env::consts::ARCH))
}

/// Download URL of the first asset in a GitHub releases list (skipping drafts and prereleases)
/// whose lowercase name matches `pred`.
fn pick_asset(releases: &Value, pred: impl Fn(&str) -> bool) -> Option<String> {
    for r in releases.as_array().into_iter().flatten() {
        if r["prerelease"].as_bool() == Some(true) || r["draft"].as_bool() == Some(true) {
            continue;
        }
        for a in r["assets"].as_array().into_iter().flatten() {
            let name = a["name"].as_str().unwrap_or_default().to_lowercase();
            if pred(&name) {
                if let Some(u) = a["browser_download_url"].as_str() {
                    return Some(u.to_string());
                }
            }
        }
    }
    None
}

fn not_sig(n: &str) -> bool {
    !(n.ends_with(".sig") || n.ends_with(".sha256") || n.ends_with(".asc") || n.contains("sha256sum") || n.ends_with(".json"))
}

// ------------------------------------------------------------------ tool table

struct Plan {
    url: String,
    /// Executable that identifies the bin folder.
    exe: &'static str,
}

fn plan(id: &str) -> Result<Plan, String> {
    let arch = if ARM { "aarch64" } else { "x86_64" };
    let x = if ARM { "arm64" } else { "x64" };
    Ok(match id {
        "uv" => {
            let triple = match OS {
                "windows" => format!("{arch}-pc-windows-msvc"),
                "macos" => format!("{arch}-apple-darwin"),
                _ => format!("{arch}-unknown-linux-gnu"),
            };
            let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
            Plan { url: format!("https://github.com/astral-sh/uv/releases/latest/download/uv-{triple}.{ext}"), exe: "uv" }
        }
        "tectonic" => {
            let triple = match OS {
                "windows" => "x86_64-pc-windows-msvc".to_string(),
                "macos" => format!("{arch}-apple-darwin"),
                _ => format!("{arch}-unknown-linux-musl"),
            };
            let url = gh_asset("tectonic-typesetting/tectonic", |n| n.starts_with("tectonic-") && n.contains(&triple) && (n.ends_with(".tar.gz") || n.ends_with(".zip")))?;
            Plan { url, exe: "tectonic" }
        }
        "node" => {
            let index = get_json("https://nodejs.org/dist/index.json")?;
            let v = index
                .as_array()
                .and_then(|a| a.iter().find(|r| r["lts"].is_string()))
                .and_then(|r| r["version"].as_str())
                .ok_or("tools:no_version:Node.js")?
                .to_string();
            let (plat, ext) = match OS {
                "windows" => (format!("win-{x}"), "zip"),
                "macos" => (format!("darwin-{x}"), "tar.gz"),
                _ => (format!("linux-{x}"), "tar.gz"),
            };
            Plan { url: format!("https://nodejs.org/dist/{v}/node-{v}-{plat}.{ext}"), exe: "node" }
        }
        "pnpm" => {
            let os = match OS { "windows" => "win", "macos" => "macos", _ => "linux" };
            let prefix = format!("pnpm-{os}-{x}");
            let url = gh_asset("pnpm/pnpm", |n| n.starts_with(&prefix) && not_sig(n) && !n.contains("musl"))?;
            Plan { url, exe: "pnpm" }
        }
        "cmake" => {
            let suffix = match OS {
                "windows" => if ARM { "windows-arm64.zip" } else { "windows-x86_64.zip" },
                "macos" => "macos-universal.tar.gz",
                _ => if ARM { "linux-aarch64.tar.gz" } else { "linux-x86_64.tar.gz" },
            };
            let url = gh_asset("Kitware/CMake", |n| n.starts_with("cmake-") && n.ends_with(suffix) && !n.contains("-rc"))?;
            Plan { url, exe: "cmake" }
        }
        "ninja" => {
            let file = match OS {
                "windows" => if ARM { "ninja-winarm64.zip" } else { "ninja-win.zip" },
                "macos" => "ninja-mac.zip",
                _ => if ARM { "ninja-linux-aarch64.zip" } else { "ninja-linux.zip" },
            };
            Plan { url: format!("https://github.com/ninja-build/ninja/releases/latest/download/{file}"), exe: "ninja" }
        }
        "clangd" => {
            let os = match OS { "windows" => "windows", "macos" => "mac", _ => "linux" };
            let prefix = format!("clangd-{os}-");
            let url = gh_asset("clangd/clangd", |n| n.starts_with(&prefix) && n.ends_with(".zip"))?;
            Plan { url, exe: "clangd" }
        }
        "jdk" => {
            let os = match OS { "windows" => "windows", "macos" => "mac", _ => "linux" };
            let a = if ARM { "aarch64" } else { "x64" };
            Plan { url: format!("https://api.adoptium.net/v3/binary/latest/21/ga/{os}/{a}/jdk/hotspot/normal/eclipse"), exe: "java" }
        }
        "gradle" => {
            let v = get_json("https://services.gradle.org/versions/current")?;
            let url = v["downloadUrl"].as_str().ok_or("tools:no_version:Gradle")?.to_string();
            Plan { url, exe: "gradle" }
        }
        "sbt" => {
            // The official runner: it starts whichever sbt a project's build.properties asks for.
            let url = gh_asset("sbt/sbt", |n| n.starts_with("sbt-") && n.ends_with(if cfg!(windows) { ".zip" } else { ".tgz" }))?;
            Plan { url, exe: if cfg!(windows) { "sbt.bat" } else { "sbt" } }
        }
        "git" if cfg!(windows) => {
            let suffix = if ARM { "-arm64.zip" } else { "-64-bit.zip" };
            let url = gh_asset("git-for-windows/git", |n| n.starts_with("mingit-") && n.ends_with(suffix) && !n.contains("busybox"))?;
            Plan { url, exe: "git" }
        }
        "cc" if cfg!(windows) => {
            let suffix = if ARM { "ucrt-aarch64.zip" } else { "ucrt-x86_64.zip" };
            let url = gh_asset("mstorsjo/llvm-mingw", |n| n.starts_with("llvm-mingw-") && n.ends_with(suffix))?;
            Plan { url, exe: "clang" }
        }
        _ => return Err(format!("tools:unsupported:{id}")),
    })
}

/// Which tool ids can be installed automatically on this OS.
#[tauri::command]
pub fn tool_installable() -> Vec<&'static str> {
    let mut v = vec!["uv", "tectonic", "node", "pnpm", "cmake", "ninja", "clangd", "jdk", "gradle", "rust", "scala", "sbt"];
    if cfg!(windows) {
        v.extend(["git", "cc"]);
    } else {
        v.push("ocaml"); // opam on Windows needs a Cygwin setup of its own
    }
    if cfg!(target_os = "macos") {
        v.extend(["git", "cc"]); // Xcode Command Line Tools
    }
    v
}

/// Installs a tool and returns the folder containing its executables.
#[tauri::command]
pub async fn tool_install(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app, &id)).await.map_err(|e| e.to_string())?
}

pub fn tool_install_blocking(app: &AppHandle, id: &str) -> Result<String, String> {
    install(app, id)
}

fn install(app: &AppHandle, id: &str) -> Result<String, String> {
    if id == "rust" {
        return install_rust(app);
    }
    if id == "scala" {
        return install_scala(app);
    }
    if id == "ocaml" {
        return install_ocaml(app);
    }
    if cfg!(target_os = "macos") && (id == "cc" || id == "git") {
        // Apple's installer dialog; the tools appear in /usr/bin once the user finished it.
        env::command("xcode-select").arg("--install").status().map_err(|e| e.to_string())?;
        return Err("XCODE_CLT".into());
    }
    let p = plan(id)?;
    let tools = env::tools_dir();
    let tmp = tools.join(format!(".{id}.download"));
    let final_url = download(app, id, &p.url, &tmp)?;
    let dest = tools.join(id);
    let _ = std::fs::remove_dir_all(&dest);
    let res = unpack(&tmp, &final_url, &dest, &exe_name(p.exe));
    let _ = std::fs::remove_file(&tmp);
    res?;
    let bin = find_bin(&dest, p.exe).ok_or_else(|| format!("tools:bin_missing:{}", p.exe))?;
    make_executable(&bin.join(exe_name(p.exe)));
    record(id, &bin)?;
    Ok(env::norm(bin))
}

/// Rust via the official rustup-init (installs to ~/.cargo, like the shell installer). On Windows
/// the GNU toolchain is used: it brings its own linker, so no Visual Studio is needed.
fn install_rust(app: &AppHandle) -> Result<String, String> {
    let triple = match (OS, ARM) {
        ("windows", false) => "x86_64-pc-windows-msvc",
        ("windows", true) => "aarch64-pc-windows-msvc",
        ("macos", false) => "x86_64-apple-darwin",
        ("macos", true) => "aarch64-apple-darwin",
        (_, false) => "x86_64-unknown-linux-gnu",
        (_, true) => "aarch64-unknown-linux-gnu",
    };
    let exe = env::tools_dir().join(exe_name("rustup-init"));
    download(app, "rust", &format!("https://static.rust-lang.org/rustup/dist/{triple}/{}", exe_name("rustup-init")), &exe)?;
    make_executable(&exe);
    let _ = app.emit("tool-progress", Progress { id: "rust", done: 0, total: 0, stage: "install" });
    let mut c = env::command(&exe);
    c.args(["-y", "--profile", "default", "-c", "rust-analyzer"]);
    if cfg!(windows) && !ARM {
        c.args(["--default-host", "x86_64-pc-windows-gnu"]);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&exe);
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(800).collect());
    }
    // Recorded so the Installations tab knows this toolchain is Omega's to update/remove.
    let bin = env::home().join(".cargo").join("bin");
    record("rust", &bin)?;
    Ok(env::norm(bin))
}

/// Download URLs of the two native launchers of the Scala toolchain for this platform. There is
/// no Windows ARM build; the x86-64 one runs there under emulation.
fn scala_urls(os: &str, arm: bool) -> [(&'static str, String); 2] {
    let (triple, ext) = match (os, arm) {
        ("windows", _) => ("x86_64-pc-win32", "zip"),
        ("macos", false) => ("x86_64-apple-darwin", "gz"),
        ("macos", true) => ("aarch64-apple-darwin", "gz"),
        (_, false) => ("x86_64-pc-linux", "gz"),
        (_, true) => ("aarch64-pc-linux", "gz"),
    };
    [
        ("scala-cli", format!("https://github.com/VirtusLab/scala-cli/releases/latest/download/scala-cli-{triple}.{ext}")),
        ("cs", format!("https://github.com/coursier/launchers/raw/master/cs-{triple}.{ext}")),
    ]
}

/// Writes the content of a gzip'ed single file (not a tar) to `out` as an executable.
fn gunzip_exe(archive: &Path, out: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut w = std::fs::File::create(out).map_err(|e| e.to_string())?;
    std::io::copy(&mut flate2::read::GzDecoder::new(f), &mut w).map_err(|e| format!("tools:unpack_failed:{e}"))?;
    make_executable(out);
    Ok(())
}

/// Downloads one native launcher into `dir` (directly in it, whatever the archive's layout).
fn fetch_launcher(app: &AppHandle, progress: &str, name: &str, url: &str, dir: &Path) -> Result<(), String> {
    let tmp = env::tools_dir().join(format!(".{name}.download"));
    let r = download(app, progress, url, &tmp).and_then(|_| if url.ends_with(".gz") { gunzip_exe(&tmp, &dir.join(exe_name(name))) } else { unpack(&tmp, url, dir, &exe_name(name)) });
    let _ = std::fs::remove_file(&tmp);
    r?;
    let bin = find_bin(dir, name).ok_or_else(|| format!("tools:bin_missing:{name}"))?;
    if bin != dir {
        std::fs::rename(bin.join(exe_name(name)), dir.join(exe_name(name))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Scala CLI (build and run) and Coursier (fetches Metals), side by side in `tools/scala`.
fn install_scala(app: &AppHandle) -> Result<String, String> {
    let tools = env::tools_dir();
    let staging = tools.join(".scala.new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    if let Err(e) = scala_urls(OS, ARM).iter().try_for_each(|(name, url)| fetch_launcher(app, "scala", name, url, &staging)) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let dest = tools.join("scala");
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
    record("scala", &dest)?;
    Ok(env::norm(dest))
}

/// Whether the output of `cs --help` is Coursier's.
fn is_coursier_help(text: &str) -> bool {
    text.contains("Coursier is the Scala application")
}

/// Asks a `cs` found on the PATH what it is (at most 10 s).
fn is_coursier(exe: &Path) -> bool {
    let Ok(mut child) = env::command(exe).arg("--help").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return false };
    let Some(mut pipe) = child.stdout.take() else { return false };
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = pipe.read_to_end(&mut text);
        String::from_utf8_lossy(&text).to_string()
    });
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while matches!(child.try_wait(), Ok(None)) {
        if std::time::Instant::now() > until {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    reader.join().is_ok_and(|t| is_coursier_help(&t))
}

/// The last `max` characters: a failed tool says what went wrong at the end of its output.
fn tail_chars(text: &str, max: usize) -> String {
    let text = text.trim_end();
    let skip = text.chars().count().saturating_sub(max);
    text.chars().skip(skip).collect()
}

/// Latest Metals release. Maven's "latest" can be a release candidate; this list is Metals' own.
pub fn metals_latest() -> Result<String, String> {
    get_json("https://scalameta.org/metals/latests.json")?["release"].as_str().map(String::from).ok_or_else(|| "tools:no_version:Metals".to_string())
}

/// Bootstraps the Metals launcher into `tools/metals`. Coursier comes from the PATH (the managed
/// Scala toolchain has it); with a system scala-cli alone, a temporary copy is fetched for this.
pub fn install_metals(app: &AppHandle) -> Result<String, String> {
    let version = metals_latest()?;
    let dir = env::tools_dir().join("metals");
    let staging = env::tools_dir().join(".metals.new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let file = if cfg!(windows) { "metals.bat" } else { "metals" };
    let managed = env::tools_dir().join("scala").join(exe_name("cs"));
    // Another program can be called `cs` too: one from the PATH has to prove it is Coursier.
    let cs = if managed.is_file() {
        managed
    } else if let Some(p) = env::which("cs").filter(|p| is_coursier(p)) {
        p
    } else {
        let [_, (name, url)] = scala_urls(OS, ARM);
        fetch_launcher(app, "lsp-scala", name, &url, &staging)?;
        staging.join(exe_name(name))
    };
    let mut c = env::command(&cs);
    c.args(["bootstrap", "--java-opt", "-Xss4m", "--java-opt", "-XX:+UseStringDeduplication"]);
    if cfg!(windows) {
        c.arg("--bat=true");
    }
    let out = c.arg(format!("org.scalameta:metals_2.13:{version}")).arg("-o").arg(staging.join("metals")).arg("-f").output().map_err(|e| e.to_string())?;
    if !out.status.success() || !staging.join(file).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        let err = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).to_string();
        return Err(tail_chars(&err, 800));
    }
    if cs.starts_with(&staging) {
        let _ = std::fs::remove_file(&cs);
    }
    std::fs::write(staging.join(".omega-version"), &version).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&staging, &dir).map_err(|e| e.to_string())?;
    Ok(env::norm(dir.join(file)))
}

// ------------------------------------------------------------------ OCaml

/// Compiler of Omega's switch: dune, ocaml-lsp-server and Earlybird are all built with it, and
/// Earlybird can only read bytecode from the compiler it was built with.
const OCAML_COMPILER: &str = "ocaml-base-compiler.5.5.2";
const OCAML_SWITCH: &str = "omega";

fn ocaml_dir() -> PathBuf {
    env::tools_dir().join("ocaml")
}

fn opam_exe() -> PathBuf {
    ocaml_dir().join("opam")
}

fn opam_root() -> PathBuf {
    ocaml_dir().join("root")
}

/// The switch's programs. This is what the manifest puts on the PATH; `opam` itself stays off it.
pub fn ocaml_bin() -> PathBuf {
    opam_root().join(OCAML_SWITCH).join("bin")
}

/// Which of the programs opam needs to build a compiler are missing.
fn ocaml_missing(has: impl Fn(&str) -> bool) -> Vec<&'static str> {
    let mut v = Vec::new();
    if !["cc", "gcc", "clang"].iter().any(|c| has(c)) {
        v.push("C compiler (gcc)");
    }
    for c in ["make", "patch", "tar", "unzip"] {
        if !has(c) {
            v.push(c);
        }
    }
    if !["curl", "wget"].iter().any(|c| has(c)) {
        v.push("curl");
    }
    v
}

/// File name of the opam release binary for this platform.
fn opam_asset_suffix(os: &str, arm: bool) -> String {
    format!("-{}-{}", if arm { "arm64" } else { "x86_64" }, if os == "macos" { "macos" } else { "linux" })
}

/// Whether an inherited variable would point a tool at another opam switch.
fn is_switch_var(name: &str) -> bool {
    name.starts_with("OPAM") || matches!(name, "CAML_LD_LIBRARY_PATH" | "OCAMLPATH" | "OCAMLTOP_INCLUDE_PATH" | "OCAMLFIND_CONF")
}

fn clear_switch_vars(c: &mut Command) {
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if is_switch_var(&k) {
            c.env_remove(k);
        }
    }
}

/// A program of Omega's switch runs with that switch only: `eval $(opam env)` in the shell Omega
/// was started from can't mix in another compiler, and what it starts (dune, ocamlc) comes first
/// from its own folder.
pub fn managed_ocaml_env(c: &mut Command, exe: &Path) {
    if !exe.starts_with(ocaml_bin()) {
        return;
    }
    clear_switch_vars(c);
    let path = env::path();
    let dirs = std::iter::once(ocaml_bin()).chain(std::env::split_paths(&path));
    if let Ok(joined) = std::env::join_paths(dirs) {
        c.env("PATH", joined);
    }
}

/// Launcher for shell commands (Run, Build, Test): the terminal's shell may have its own opam
/// environment, which only a wrapper around the command can clear in every shell.
const OCAML_RUNNER: &str = r#"#!/bin/sh
# Runs a command with Omega's OCaml, without the opam environment of the calling shell.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
for v in $(env | sed -n 's/^\(OPAM[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
unset CAML_LD_LIBRARY_PATH OCAMLPATH OCAMLTOP_INCLUDE_PATH OCAMLFIND_CONF
PATH="$dir/root/omega/bin:$PATH"
export PATH
exec "$@"
"#;

fn write_ocaml_runner(dir: &Path) -> Result<(), String> {
    let file = dir.join("run");
    std::fs::write(&file, OCAML_RUNNER).map_err(|e| e.to_string())?;
    make_executable(&file);
    Ok(())
}

/// opam for Omega's own root only: nothing from the user's opam setup, no system packages (sudo).
fn opam() -> Command {
    let mut c = env::command(opam_exe());
    clear_switch_vars(&mut c);
    c.env("OPAMROOT", opam_root()).envs([("OPAMYES", "1"), ("OPAMCOLOR", "never"), ("OPAMUTF8", "never"), ("OPAMNODEPEXTS", "1"), ("OPAMNOENVNOTICE", "1")]);
    c.stdin(Stdio::null());
    c
}

/// One opam job at a time in Omega's root. Installs wait for each other; a look at the newest
/// versions (Settings) is skipped while an install runs or waits, so it can't get in its way.
static OPAM_WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static OPAM_INSTALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct OpamInstall(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

impl Drop for OpamInstall {
    fn drop(&mut self) {
        OPAM_INSTALLS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn opam_install_lock() -> OpamInstall {
    OPAM_INSTALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    OpamInstall(OPAM_WORK.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The lock for a read-only look at opam; None while an install runs or waits.
fn opam_query_lock() -> Option<std::sync::MutexGuard<'static, ()>> {
    let installing = || OPAM_INSTALLS.load(std::sync::atomic::Ordering::SeqCst) > 0;
    if installing() {
        return None;
    }
    let guard = OPAM_WORK.lock().unwrap_or_else(|e| e.into_inner());
    // An install may have started while this waited.
    (!installing()).then_some(guard)
}

/// Updates (done, total) from a line of opam's output; true if a package finished.
fn opam_progress(line: &str, done: &mut u64, total: &mut u64) -> bool {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("=== ") {
        let mut w = rest.split_whitespace();
        if let (Some("install" | "upgrade" | "recompile" | "downgrade"), Some(Ok(n))) = (w.next(), w.next().map(str::parse::<u64>)) {
            *total += n;
        }
        return false;
    }
    if ["-> installed ", "\u{2217} installed "].iter().any(|p| line.starts_with(p)) {
        *done += 1;
        return true;
    }
    false
}

/// Runs opam, reporting finished packages as progress. A failure ends with what opam said.
fn run_opam(app: &AppHandle, id: &str, args: &[&str]) -> Result<(), String> {
    let mut child = opam().args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("tools:ocaml_failed:{e}"))?;
    let stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let (mut done, mut total) = (0, 0);
    let mut output = String::new();
    if let Some(pipe) = child.stdout.take() {
        for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
            if opam_progress(&line, &mut done, &mut total) || line.starts_with("=== ") {
                let _ = app.emit("tool-progress", Progress { id, done, total, stage: "build" });
            }
            output.push_str(&line);
            output.push('\n');
        }
    }
    let status = child.wait().map_err(|e| format!("tools:ocaml_failed:{e}"))?;
    let errors = errors.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let said = if errors.trim().is_empty() { output } else { errors };
    Err(format!("tools:ocaml_failed:{}", tail_chars(&said, 600).replace('\n', " ")))
}

/// opam, an Omega-only opam root, a switch with the compiler, and dune. Run again it updates them.
/// `--no-setup`: the user's shell profile is never touched.
fn install_ocaml(app: &AppHandle) -> Result<String, String> {
    if cfg!(windows) {
        return Err("tools:unsupported:OCaml".into());
    }
    let missing = ocaml_missing(|c| env::which(c).is_some());
    if !missing.is_empty() {
        return Err(format!("tools:ocaml_missing:{}", missing.join(", ")));
    }
    let _work = opam_install_lock();
    let dir = ocaml_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !opam_exe().is_file() {
        let suffix = opam_asset_suffix(OS, ARM);
        let url = gh_asset("ocaml/opam", |n| n.starts_with("opam-") && n.ends_with(&suffix))?;
        let tmp = dir.join(".opam.download");
        download(app, "ocaml", &url, &tmp)?;
        make_executable(&tmp);
        std::fs::rename(&tmp, opam_exe()).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("tool-progress", Progress { id: "ocaml", done: 0, total: 0, stage: "install" });
    if !opam_root().join("config").is_file() {
        let _ = std::fs::remove_dir_all(opam_root());
        let mut args = vec!["init", "--bare", "--no-setup", "--disable-completion"];
        if cfg!(target_os = "linux") && env::which("bwrap").is_none() {
            args.push("--disable-sandboxing"); // opam's build sandbox needs bubblewrap
        }
        run_opam(app, "ocaml", &args)?;
    }
    let update = ocaml_bin().join("ocamlc").is_file();
    if update {
        run_opam(app, "ocaml", &["update"])?;
    } else {
        // An earlier attempt may have stopped halfway.
        if opam_root().join(OCAML_SWITCH).exists() {
            run_opam(app, "ocaml", &["switch", "remove", OCAML_SWITCH])?;
        }
        run_opam(app, "ocaml", &["switch", "create", OCAML_SWITCH, OCAML_COMPILER, "--no-switch"])?;
    }
    run_opam(app, "ocaml", &["install", "--switch", OCAML_SWITCH, "dune"])?;
    if update {
        run_opam(app, "ocaml", &["upgrade", "--switch", OCAML_SWITCH])?;
    }
    write_ocaml_runner(&dir)?;
    record("ocaml", &ocaml_bin())?;
    Ok(env::norm(ocaml_bin()))
}

/// A package in Omega's switch, so it always matches the compiler. Run again it updates it.
pub fn install_ocaml_package(app: &AppHandle, id: &str, package: &str, exe: &str) -> Result<String, String> {
    if !ocaml_bin().join("ocamlc").is_file() {
        return Err(format!("tools:ocaml_not_managed:{package}"));
    }
    let _ = app.emit("tool-progress", Progress { id, done: 0, total: 0, stage: "install" });
    let _work = opam_install_lock();
    let path = ocaml_bin().join(exe);
    if path.is_file() {
        run_opam(app, id, &["update"])?;
        run_opam(app, id, &["upgrade", "--switch", OCAML_SWITCH, package])?;
    } else {
        run_opam(app, id, &["install", "--switch", OCAML_SWITCH, package])?;
    }
    if !path.is_file() {
        return Err(format!("tools:bin_missing:{exe}"));
    }
    env::rebuild();
    Ok(env::norm(path))
}

/// Removes a package from Omega's switch.
pub fn remove_ocaml_package(package: &str) -> Result<(), String> {
    if !ocaml_bin().join("ocamlc").is_file() {
        return Err(format!("installs:not_ours:{package}"));
    }
    let _work = opam_install_lock();
    let out = opam().args(["remove", "--switch", OCAML_SWITCH, package]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("tools:ocaml_failed:{}", tail_chars(&String::from_utf8_lossy(&out.stderr), 600)))
    }
}

/// The version an upgrade would give, from a line like "- upgrade dune 3.24.0 to 3.25.0".
fn opam_upgrade_target(text: &str, package: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let w: Vec<&str> = l.split_whitespace().collect();
        let i = w.iter().position(|x| *x == "upgrade")?;
        (w.get(i + 1) == Some(&package) && w.get(i + 3) == Some(&"to")).then(|| w.get(i + 4).map(|v| v.to_string()))?
    })
}

/// Refreshes opam's package list at most once in a few minutes: several items ask at once.
fn opam_refresh() {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(300)) {
        let _ = opam().arg("update").output();
        *last = Some(std::time::Instant::now());
    }
}

/// Newest version of a package the switch's compiler can use.
pub fn ocaml_latest(package: &str) -> Result<String, String> {
    if !ocaml_bin().join("ocamlc").is_file() {
        return Err(format!("installs:not_ours:{package}"));
    }
    let Some(_work) = opam_query_lock() else { return Err(format!("tools:no_version:{package}")) };
    opam_refresh();
    let out = opam().args(["upgrade", "--switch", OCAML_SWITCH, "--dry-run", "--show-actions", package]).output().map_err(|e| e.to_string())?;
    if let Some(v) = opam_upgrade_target(&String::from_utf8_lossy(&out.stdout), package) {
        return Ok(v);
    }
    let now = opam().args(["list", "--switch", OCAML_SWITCH, "--installed", "--short", "--columns=version", package]).output().map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&now.stdout).lines().next().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).ok_or_else(|| format!("tools:no_version:{package}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_check_is_skipped_while_an_install_runs_and_never_blocks_it() {
        // The only test using these locks: other tests never start opam.
        assert!(opam_query_lock().is_some());
        let install = opam_install_lock();
        assert!(opam_query_lock().is_none());
        drop(install);
        let query = opam_query_lock().expect("free again");
        // An install that arrives during a check waits for it, and the next check steps aside.
        let (tx, rx) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            let lock = opam_install_lock();
            tx.send(()).unwrap();
            drop(lock);
        });
        while OPAM_INSTALLS.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        assert!(rx.recv_timeout(std::time::Duration::from_millis(50)).is_err());
        drop(query);
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        waiting.join().unwrap();
        assert!(opam_query_lock().is_some());
    }

    #[test]
    fn switch_variables_are_recognised() {
        for v in ["OPAMROOT", "OPAMSWITCH", "OPAM_SWITCH_PREFIX", "CAML_LD_LIBRARY_PATH", "OCAMLPATH", "OCAMLTOP_INCLUDE_PATH", "OCAMLFIND_CONF"] {
            assert!(is_switch_var(v), "{v}");
        }
        for v in ["PATH", "HOME", "OCAMLRUNPARAM", "CAML_DEBUG_SOCKET"] {
            assert!(!is_switch_var(v), "{v}");
        }
    }

    #[test]
    fn only_programs_of_omegas_switch_get_its_environment() {
        let mut other = Command::new("dune");
        managed_ocaml_env(&mut other, Path::new("/usr/bin/dune"));
        assert_eq!(other.get_envs().count(), 0);

        let exe = ocaml_bin().join("dune");
        let mut own = Command::new(&exe);
        managed_ocaml_env(&mut own, &exe);
        let path = own.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v).expect("PATH");
        assert_eq!(std::env::split_paths(path).next(), Some(ocaml_bin()));
    }

    #[cfg(unix)]
    #[test]
    fn the_runner_clears_another_switch_and_puts_its_own_first() {
        let t = tempfile::tempdir().unwrap();
        write_ocaml_runner(t.path()).unwrap();
        let out = Command::new(t.path().join("run"))
            .args(["sh", "-c", r#"echo "$OPAM_SWITCH_PREFIX|$OPAMROOT|$CAML_LD_LIBRARY_PATH|$OCAMLPATH|$KEEP|${PATH%%:*}""#])
            .envs([("OPAM_SWITCH_PREFIX", "/other"), ("OPAMROOT", "/other"), ("CAML_LD_LIBRARY_PATH", "/other"), ("OCAMLPATH", "/other"), ("KEEP", "kept")])
            .output()
            .unwrap();
        let real = t.path().canonicalize().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), format!("||||kept|{}/root/omega/bin", real.display()));
    }

    #[test]
    fn ocaml_names_what_is_missing() {
        assert!(ocaml_missing(|_| true).is_empty());
        assert_eq!(ocaml_missing(|c| c != "make" && c != "patch"), ["make", "patch"]);
        assert_eq!(ocaml_missing(|c| !["cc", "gcc", "clang"].contains(&c)), ["C compiler (gcc)"]);
        assert_eq!(ocaml_missing(|c| c != "curl"), Vec::<&str>::new()); // wget is enough
        assert_eq!(ocaml_missing(|c| c != "curl" && c != "wget"), ["curl"]);
    }

    #[test]
    fn opam_asset_per_platform() {
        assert_eq!(opam_asset_suffix("linux", false), "-x86_64-linux");
        assert_eq!(opam_asset_suffix("linux", true), "-arm64-linux");
        assert_eq!(opam_asset_suffix("macos", true), "-arm64-macos");
    }

    #[test]
    fn opam_progress_counts_finished_packages() {
        let (mut done, mut total) = (0, 0);
        for l in ["The following actions will be performed:", "=== install 3 packages", "  - install dune 3.25.0", "-> retrieved dune.3.25.0", "-> installed dune.3.25.0", "\u{2217} installed base.v0"] {
            opam_progress(l, &mut done, &mut total);
        }
        assert_eq!((done, total), (2, 3));
    }

    #[test]
    fn opam_upgrade_target_reads_the_plan() {
        let text = "=== upgrade 2 packages\n  - upgrade base 1.0 to 1.1\n  - upgrade dune 3.24.0 to 3.25.0 [required]\n";
        assert_eq!(opam_upgrade_target(text, "dune").as_deref(), Some("3.25.0"));
        assert_eq!(opam_upgrade_target(text, "earlybird"), None);
        assert_eq!(opam_upgrade_target("Already up-to-date.\n", "dune"), None);
    }

    #[test]
    fn exe_name_keeps_a_given_extension() {
        assert_eq!(exe_name_on(true, "cs"), "cs.exe");
        assert_eq!(exe_name_on(true, "sbt.bat"), "sbt.bat");
        assert_eq!(exe_name_on(false, "cs"), "cs");
        assert_eq!(exe_name_on(false, "sbt.bat"), "sbt.bat");
    }

    #[test]
    fn only_coursier_counts_as_cs() {
        assert!(is_coursier_help("Usage: cs <COMMAND>\nCoursier is the Scala application and artifact manager.\n"));
        assert!(!is_coursier_help("cs: a different tool\n"));
        assert!(!is_coursier_help(""));
    }

    #[cfg(unix)]
    #[test]
    fn a_cs_that_is_something_else_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let (real, other) = (t.path().join("real"), t.path().join("other"));
        std::fs::write(&real, "#!/bin/sh\necho 'Coursier is the Scala application and artifact manager.'\n").unwrap();
        std::fs::write(&other, "#!/bin/sh\necho 'not it'\n").unwrap();
        make_executable(&real);
        make_executable(&other);
        assert!(is_coursier(&real));
        assert!(!is_coursier(&other));
    }

    #[test]
    fn tail_chars_keeps_the_end() {
        assert_eq!(tail_chars("abcdef\n", 3), "def");
        assert_eq!(tail_chars("äöü€", 2), "ü€");
        assert_eq!(tail_chars("ab", 800), "ab");
    }

    #[test]
    fn scala_urls_per_platform() {
        let urls = |os, arm| scala_urls(os, arm).map(|(_, u)| u.rsplit('/').next().unwrap().to_string());
        assert_eq!(urls("linux", false), ["scala-cli-x86_64-pc-linux.gz", "cs-x86_64-pc-linux.gz"]);
        assert_eq!(urls("linux", true), ["scala-cli-aarch64-pc-linux.gz", "cs-aarch64-pc-linux.gz"]);
        assert_eq!(urls("macos", true), ["scala-cli-aarch64-apple-darwin.gz", "cs-aarch64-apple-darwin.gz"]);
        assert_eq!(urls("windows", true), ["scala-cli-x86_64-pc-win32.zip", "cs-x86_64-pc-win32.zip"]);
    }

    #[test]
    fn gunzip_exe_writes_an_executable() {
        let t = tempfile::tempdir().unwrap();
        let (gz, out) = (t.path().join("a.gz"), t.path().join("a"));
        let mut w = flate2::write::GzEncoder::new(std::fs::File::create(&gz).unwrap(), flate2::Compression::default());
        w.write_all(b"\x7fELF launcher").unwrap();
        w.finish().unwrap();
        gunzip_exe(&gz, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"\x7fELF launcher");
        #[cfg(unix)]
        assert_eq!(mode(&out), 0o755);
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn unpack_zip() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("download");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            let exe = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
            z.add_directory("tool-1.0/bin/", exe).unwrap();
            z.start_file("tool-1.0/bin/tool", exe).unwrap();
            z.write_all(b"#!/bin/sh\necho hi\n").unwrap();
            z.start_file("tool-1.0/README", plain).unwrap();
            z.write_all(b"readme").unwrap();
            z.finish().unwrap();
        }
        let dest = t.path().join("out");
        unpack(&archive, "", &dest, "ignored").unwrap();
        assert_eq!(std::fs::read(dest.join("tool-1.0/bin/tool")).unwrap(), b"#!/bin/sh\necho hi\n");
        assert_eq!(std::fs::read_to_string(dest.join("tool-1.0/README")).unwrap(), "readme");
        assert!(!dest.join("ignored").exists());
        #[cfg(unix)]
        {
            assert_eq!(mode(&dest.join("tool-1.0/bin/tool")) & 0o111, 0o111);
            assert_eq!(mode(&dest.join("tool-1.0/README")) & 0o111, 0);
        }
    }

    #[test]
    fn unpack_tar_gz() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("download");
        {
            let gz = flate2::write::GzEncoder::new(std::fs::File::create(&archive).unwrap(), flate2::Compression::default());
            let mut b = tar::Builder::new(gz);
            let mut add = |path: &str, data: &[u8], mode: u32| {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(mode);
                h.set_cksum();
                b.append_data(&mut h, path, data).unwrap();
            };
            add("node-v22/bin/node", b"ELF", 0o755);
            add("node-v22/LICENSE", b"MIT", 0o644);
            b.into_inner().unwrap().finish().unwrap();
        }
        let dest = t.path().join("out");
        unpack(&archive, "node.tar.gz", &dest, "node").unwrap();
        assert_eq!(std::fs::read(dest.join("node-v22/bin/node")).unwrap(), b"ELF");
        assert_eq!(std::fs::read(dest.join("node-v22/LICENSE")).unwrap(), b"MIT");
        assert!(!dest.join("node").exists());
        #[cfg(unix)]
        {
            assert_eq!(mode(&dest.join("node-v22/bin/node")), 0o755);
            assert_eq!(mode(&dest.join("node-v22/LICENSE")), 0o644);
        }
    }

    #[test]
    fn unpack_raw_file_becomes_executable() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("download");
        std::fs::write(&archive, b"\x7fELF raw binary").unwrap();
        let dest = t.path().join("out/nested");
        unpack(&archive, "", &dest, "pnpm").unwrap();
        assert_eq!(std::fs::read(dest.join("pnpm")).unwrap(), b"\x7fELF raw binary");
        #[cfg(unix)]
        assert_eq!(mode(&dest.join("pnpm")), 0o755);
    }

    #[test]
    fn unpack_tiny_file_is_raw() {
        // Shorter than the 4-byte signature.
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("download");
        std::fs::write(&archive, b"PK").unwrap();
        unpack(&archive, "", t.path(), "x").unwrap();
        assert_eq!(std::fs::read(t.path().join("x")).unwrap(), b"PK");
    }

    #[test]
    fn find_bin_nested_and_depth_limit() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let put = |dir: &str| {
            std::fs::create_dir_all(r.join(dir)).unwrap();
            std::fs::write(r.join(dir).join(exe_name("cmake")), "").unwrap();
        };
        std::fs::create_dir_all(r.join("a/b")).unwrap();
        put("cmake-4.1/bin");
        assert_eq!(find_bin(r, "cmake").unwrap(), r.join("cmake-4.1/bin"));
        assert!(find_bin(r, "ninja").is_none());

        // Directly in root.
        let t2 = tempfile::tempdir().unwrap();
        std::fs::write(t2.path().join(exe_name("uv")), "").unwrap();
        assert_eq!(find_bin(t2.path(), "uv").unwrap(), t2.path());

        // A directory named like the executable doesn't count.
        let t3 = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t3.path().join(exe_name("uv"))).unwrap();
        assert!(find_bin(t3.path(), "uv").is_none());

        // Depth 5 (root + 5 folders) is still searched, depth 6 isn't.
        let t4 = tempfile::tempdir().unwrap();
        let d5 = t4.path().join("1/2/3/4/5");
        std::fs::create_dir_all(&d5).unwrap();
        std::fs::write(d5.join(exe_name("deep")), "").unwrap();
        assert_eq!(find_bin(t4.path(), "deep").unwrap(), d5);
        let d6 = d5.join("6");
        std::fs::create_dir_all(&d6).unwrap();
        std::fs::write(d6.join(exe_name("deeper")), "").unwrap();
        assert!(find_bin(t4.path(), "deeper").is_none());
    }

    #[test]
    fn not_sig_filters_checksums_and_signatures() {
        for n in ["pnpm-linux-x64.sha256", "x.tar.gz.asc", "x.tar.gz.sig", "release.json", "sha256sums.txt", "pnpm-sha256sum"] {
            assert!(!not_sig(n), "{n}");
        }
        for n in ["pnpm-linux-x64", "pnpm-win-x64.exe", "cmake-4.1.2-linux-x86_64.tar.gz"] {
            assert!(not_sig(n), "{n}");
        }
    }

    #[test]
    fn pick_asset_skips_drafts_prereleases_and_lowercases() {
        let v = serde_json::json!([
            { "prerelease": true, "assets": [ { "name": "tool-linux.tar.gz", "browser_download_url": "https://pre" } ] },
            { "draft": true, "assets": [ { "name": "tool-linux.tar.gz", "browser_download_url": "https://draft" } ] },
            { "prerelease": false, "assets": [
                { "name": "tool-linux.tar.gz.sha256", "browser_download_url": "https://sum" },
                { "name": "Tool-Linux.tar.gz" },
                { "name": "TOOL-LINUX.TAR.GZ", "browser_download_url": "https://stable" }
            ] },
            { "assets": [ { "name": "tool-linux.tar.gz", "browser_download_url": "https://older" } ] }
        ]);
        let pred = |n: &str| n.starts_with("tool-linux") && n.ends_with(".tar.gz");
        assert_eq!(pick_asset(&v, pred).as_deref(), Some("https://stable"));
        assert_eq!(pick_asset(&v, |n| n.contains("windows")), None);
        assert_eq!(pick_asset(&serde_json::json!({"message": "rate limited"}), pred), None);
        assert_eq!(pick_asset(&serde_json::json!([]), pred), None);
    }

    /// Ids whose plan is built without network requests (the others query GitHub/nodejs.org/gradle.org).
    #[test]
    fn plan_offline_ids() {
        for id in ["uv", "ninja", "jdk"] {
            let p = plan(id).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(p.url.starts_with("https://"), "{id}: {}", p.url);
            assert!(!p.exe.is_empty());
        }
        assert!(plan("nonexistent").is_err());
        assert!(tool_installable().contains(&"rust"));
        // rust is installed through rustup-init, not plan().
        assert!(plan("rust").is_err());
    }

    /// Network test: resolve, download, unpack and locate a few small tools (`cargo test -- --ignored`).
    #[test]
    #[ignore]
    fn install_small_tools() {
        let root = std::env::temp_dir().join(format!("omega-tools-test-{}", std::process::id()));
        for id in ["ninja", "uv", "pnpm", "tectonic"] {
            let p = plan(id).unwrap();
            let tmp = root.join(format!(".{id}.dl"));
            std::fs::create_dir_all(&root).unwrap();
            let mut resp = agent().get(&p.url).call().unwrap().into_reader();
            std::io::copy(&mut resp, &mut std::fs::File::create(&tmp).unwrap()).unwrap();
            let dest = root.join(id);
            unpack(&tmp, "", &dest, &exe_name(p.exe)).unwrap();
            let bin = find_bin(&dest, p.exe).unwrap_or_else(|| panic!("{id}: binary not found"));
            make_executable(&bin.join(exe_name(p.exe)));
            let out = std::process::Command::new(bin.join(exe_name(p.exe))).arg("--version").output().unwrap();
            assert!(out.status.success(), "{id} --version failed");
            println!("{id}: {}", String::from_utf8_lossy(&out.stdout).trim());
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
