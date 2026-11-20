//! Tools Omega can install by itself into its app-data folder (`tools/`), per OS and CPU:
//! uv (Python), tectonic (LaTeX), Node.js, pnpm, CMake, Ninja, clangd, a JDK, Gradle, Rust (rustup),
//! a C/C++ compiler (llvm-mingw on Windows, Xcode Command Line Tools on macOS) and Git on Windows.
//! Installed tools are recorded in `tools/managed.json` (tool id → folder with its executables);
//! those folders are appended to the PATH of everything Omega starts (see `env.rs`).
use crate::env;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
    let resp = agent().get(url).call().map_err(|e| format!("Download fehlgeschlagen ({url}): {e}"))?;
    let final_url = resp.get_url().to_string();
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut last) = (0u64, 0u64);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download abgebrochen: {e}"))?;
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
        zip::ZipArchive::new(f).map_err(|e| e.to_string())?.extract(dest).map_err(|e| format!("Entpacken: {e}"))
    } else if magic.starts_with(&[0x1f, 0x8b]) {
        let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut a = tar::Archive::new(flate2::read::GzDecoder::new(f));
        a.set_preserve_permissions(true);
        a.unpack(dest).map_err(|e| format!("Entpacken: {e}"))
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
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
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
    for r in releases.as_array().into_iter().flatten() {
        if r["prerelease"].as_bool() == Some(true) || r["draft"].as_bool() == Some(true) {
            continue;
        }
        for a in r["assets"].as_array().into_iter().flatten() {
            let name = a["name"].as_str().unwrap_or_default().to_lowercase();
            if pred(&name) {
                if let Some(u) = a["browser_download_url"].as_str() {
                    return Ok(u.to_string());
                }
            }
        }
    }
    Err(format!("Kein passender Download für {OS}/{} in {repo} gefunden", std::env::consts::ARCH))
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
                .ok_or("Node.js-Version nicht gefunden")?
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
            let url = v["downloadUrl"].as_str().ok_or("Gradle-Version nicht gefunden")?.to_string();
            Plan { url, exe: "gradle" }
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
        _ => return Err(format!("{id} kann auf diesem System nicht automatisch installiert werden")),
    })
}

/// Which tool ids can be installed automatically on this OS.
#[tauri::command]
pub fn tool_installable() -> Vec<&'static str> {
    let mut v = vec!["uv", "tectonic", "node", "pnpm", "cmake", "ninja", "clangd", "jdk", "gradle", "rust"];
    if cfg!(windows) {
        v.extend(["git", "cc"]);
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
    let bin = find_bin(&dest, p.exe).ok_or_else(|| format!("{} nicht im Download gefunden", p.exe))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
