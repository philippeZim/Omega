//! Go in Omega's tools folder: the official toolchain archive (checksum verified), gopls and Delve.
//! Everything Go writes for them stays in `tools/go-home`, so a user's own `~/go` is never touched.
//! No admin rights and no shell profile edits.
use super::{download, get_json, get_text, record, sha256_hex, tail_chars, unpack, Progress, ARM, OS};
use crate::env;
use serde_json::Value;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

const RELEASES: &str = "https://go.dev/dl/?mode=json";
pub const GOPLS: &str = "golang.org/x/tools/gopls";
pub const DELVE: &str = "github.com/go-delve/delve/cmd/dlv";

/// Settings of a shell or another Go that must not leak into Omega's Go.
const FOREIGN_VARS: &[&str] = &["GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "GOBIN", "GOFLAGS", "GOWORK"];
/// Settings that could weaken the checks while Omega installs gopls or Delve.
const UNSAFE_INSTALL_VARS: &[&str] = &["GOSUMDB", "GONOSUMDB", "GONOSUMCHECK", "GOINSECURE", "GOPRIVATE", "GONOPROXY", "GOVCS"];

static WORK: Mutex<()> = Mutex::new(());

/// One install or removal of Go's files at a time.
pub(crate) fn go_lock() -> MutexGuard<'static, ()> {
    WORK.lock().unwrap_or_else(|e| e.into_inner())
}

fn go_dir() -> PathBuf {
    env::tools_dir().join("go")
}

/// GOROOT of Omega's Go (the archive holds one `go` folder).
fn go_root() -> PathBuf {
    go_dir().join("go")
}

pub(crate) fn go_home() -> PathBuf {
    env::tools_dir().join("go-home")
}

pub(crate) fn go_tools_bin() -> PathBuf {
    env::tools_dir().join("go-tools").join("bin")
}

fn go_platform(os: &str, arm: bool) -> (&'static str, &'static str) {
    let name = match os {
        "windows" => "windows",
        "macos" => "darwin",
        _ => "linux",
    };
    (name, if arm { "arm64" } else { "amd64" })
}

/// The newest stable release's archive for this platform: (file name, sha256).
fn pick_release(releases: &Value, os: &str, arch: &str) -> Option<(String, String)> {
    let release = releases.as_array()?.iter().find(|r| r["stable"].as_bool() == Some(true))?;
    let file = release["files"].as_array()?.iter().find(|f| f["os"] == os && f["arch"] == arch && f["kind"] == "archive")?;
    let name = file["filename"].as_str()?;
    let sum = file["sha256"].as_str()?;
    // The name goes into a URL and the hash is what everything else rests on.
    let safe = name.starts_with("go") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    (safe && sum.len() == 64 && sum.chars().all(|c| c.is_ascii_hexdigit())).then(|| (name.to_string(), sum.to_lowercase()))
}

fn checksum_matches(file: &Path, expected: &str) -> Result<bool, String> {
    Ok(sha256_hex(file)?.eq_ignore_ascii_case(expected))
}

/// `go.env` of Omega's Go. A key's first line wins there, so the shipped defaults are replaced.
fn go_env_text(original: &str, home: &Path) -> String {
    let dir = |name: &str| home.join(name).display().to_string();
    let ours = [
        ("GOPATH", dir("path")),
        ("GOCACHE", dir("cache")),
        ("GOMODCACHE", dir("mod")),
        ("GOBIN", dir("bin")),
        ("GOFLAGS", "-modcacherw".to_string()),
        // A project's go.mod can't make this Go download and run another toolchain.
        ("GOTOOLCHAIN", "local".to_string()),
    ];
    let mut out: String = original
        .lines()
        .filter(|l| !ours.iter().any(|(k, _)| l.trim_start().strip_prefix(k).is_some_and(|rest| rest.starts_with('='))))
        .map(|l| format!("{l}\n"))
        .collect();
    for (k, v) in ours {
        out.push_str(&format!("{k}={v}\n"));
    }
    out
}

fn is_go_program(program: &OsStr) -> Option<String> {
    let stem = Path::new(program).file_stem()?.to_str()?.to_ascii_lowercase();
    matches!(stem.as_str(), "go" | "gopls" | "dlv").then_some(stem)
}

/// What a Go program started by Omega gets: never a toolchain a project asks for, and with Omega's
/// Go none of the settings of another Go installation.
fn go_env_changes(managed: bool) -> (Vec<(&'static str, &'static str)>, &'static [&'static str]) {
    let mut set = vec![("GOTOOLCHAIN", "local")];
    if managed {
        set.push(("GOENV", "off"));
    }
    (set, if managed { FOREIGN_VARS } else { &[] })
}

/// Called for every process: only `go`, `gopls` and `dlv` are changed.
pub fn apply_go_env(c: &mut Command, program: &OsStr) {
    let Some(stem) = is_go_program(program) else { return };
    let go = if stem == "go" { env::which(&program.to_string_lossy()) } else { env::which("go") };
    let (set, remove) = go_env_changes(go.is_some_and(|p| p.starts_with(go_root())));
    for k in remove {
        c.env_remove(k);
    }
    c.envs(set);
}

/// Deletes a tree that may hold read-only files (Go's module cache and downloaded toolchains).
pub(crate) fn remove_tree(dir: &Path) -> Result<(), String> {
    fn writable(p: &Path) {
        let Ok(meta) = std::fs::symlink_metadata(p) else { return };
        if meta.file_type().is_symlink() {
            return;
        }
        let mut perm = meta.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perm.set_mode(perm.mode() | 0o700);
        }
        #[cfg(not(unix))]
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(p, perm);
        if meta.is_dir() {
            for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
                writable(&e.path());
            }
        }
    }
    writable(dir);
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", env::norm(dir))),
        _ => Ok(()),
    }
}

/// Installs or updates Omega's Go. The old version stays until the new one is complete.
pub fn install_go(app: &AppHandle) -> Result<String, String> {
    let _work = go_lock();
    let (os, arch) = go_platform(OS, ARM);
    let (name, sum) = pick_release(&get_json(RELEASES)?, os, arch).ok_or_else(|| format!("tools:no_asset:{os}/{arch} (Go)"))?;
    let tools = env::tools_dir();
    std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let archive = tools.join(".go.download");
    let fresh = tools.join(".go.new");
    let result = (|| {
        download(app, "go", &format!("https://go.dev/dl/{name}"), &archive)?;
        if !checksum_matches(&archive, &sum)? {
            return Err(format!("tools:go_failed:checksum mismatch for {name}"));
        }
        remove_tree(&fresh)?;
        unpack(&archive, &name, &fresh, "")?;
        let env_file = fresh.join("go").join("go.env");
        let shipped = std::fs::read_to_string(&env_file).map_err(|e| format!("tools:go_failed:{e}"))?;
        std::fs::write(&env_file, go_env_text(&shipped, &go_home())).map_err(|e| format!("tools:go_failed:{e}"))?;
        remove_tree(&go_dir())?;
        std::fs::rename(&fresh, go_dir()).map_err(|e| format!("tools:go_failed:{e}"))
    })();
    let _ = std::fs::remove_file(&archive);
    let _ = remove_tree(&fresh);
    result?;
    let bin = go_root().join("bin");
    record("go", &bin)?;
    Ok(env::norm(bin))
}

/// Builds gopls or Delve with `go install` into Omega's folder. It runs outside any project, and
/// only here may Go fetch the newer toolchain the tool itself requires.
pub fn install_go_tool(app: &AppHandle, progress: &str, package: &str, exe: &str) -> Result<String, String> {
    let _work = go_lock();
    let go = env::which("go").ok_or("tools:go_missing")?;
    let (home, bin) = (go_home(), go_tools_bin());
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let _ = app.emit("tool-progress", Progress { id: progress, done: 0, total: 0, stage: "build" });
    let mut c = env::command(&go);
    for k in FOREIGN_VARS.iter().chain(UNSAFE_INSTALL_VARS) {
        c.env_remove(k);
    }
    c.args(["install", &format!("{package}@latest")])
        .current_dir(&home)
        .env("GOENV", "off")
        .env("GOWORK", "off")
        .env("GOTOOLCHAIN", "auto")
        .env("GOFLAGS", "-modcacherw")
        .env("GOBIN", &bin)
        .env("GOPATH", home.join("path"))
        .env("GOCACHE", home.join("cache"))
        .env("GOMODCACHE", home.join("mod"))
        .stdin(Stdio::null());
    if !go.starts_with(go_root()) {
        // A system Go keeps its own GOROOT, if the shell names one.
        if let Some(root) = std::env::var_os("GOROOT") {
            c.env("GOROOT", root);
        }
    }
    let out = c.output().map_err(|e| format!("tools:go_failed:{e}"))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tools:go_failed:{}", tail_chars(&said, 600).replace('\n', " ")));
    }
    let file = bin.join(super::exe_name(exe));
    if !file.is_file() {
        return Err(format!("tools:bin_missing:{exe}"));
    }
    Ok(env::norm(file))
}

/// Removes Omega's Go with its caches. gopls and Delve are separate items and stay.
pub fn remove_go() -> Result<(), String> {
    let _work = go_lock();
    if !super::manifest().contains_key("go") {
        return Err("installs:not_ours:go".into());
    }
    remove_tree(&go_dir())?;
    remove_tree(&go_home())?;
    super::forget("go")
}

pub fn remove_go_tool(exe: &str) -> Result<(), String> {
    let _work = go_lock();
    match std::fs::remove_file(go_tools_bin().join(super::exe_name(exe))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn go_latest() -> Result<String, String> {
    let (os, arch) = go_platform(OS, ARM);
    let (name, _) = pick_release(&get_json(RELEASES)?, os, arch).ok_or("installs:no_version:Go")?;
    crate::installs::extract_version(&name).ok_or_else(|| "installs:no_version:Go".to_string())
}

/// Latest version of a Go module from the module proxy.
pub fn module_latest(module: &str) -> Result<String, String> {
    let info: Value = serde_json::from_str(&get_text(&format!("https://proxy.golang.org/{module}/@latest"))?).map_err(|e| e.to_string())?;
    info["Version"].as_str().and_then(crate::installs::extract_version).ok_or_else(|| format!("installs:no_version:{module}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn releases() -> Value {
        let sum = "a".repeat(64);
        json!([
            { "version": "go1.99rc1", "stable": false, "files": [{ "filename": "go1.99rc1.linux-amd64.tar.gz", "os": "linux", "arch": "amd64", "kind": "archive", "sha256": sum }] },
            { "version": "go1.27.4", "stable": true, "files": [
                { "filename": "go1.27.4.src.tar.gz", "os": "", "arch": "", "kind": "source", "sha256": sum },
                { "filename": "go1.27.4.windows-amd64.msi", "os": "windows", "arch": "amd64", "kind": "installer", "sha256": sum },
                { "filename": "go1.27.4.windows-amd64.zip", "os": "windows", "arch": "amd64", "kind": "archive", "sha256": sum },
                { "filename": "go1.27.4.darwin-arm64.tar.gz", "os": "darwin", "arch": "arm64", "kind": "archive", "sha256": sum },
                { "filename": "go1.27.4.linux-amd64.tar.gz", "os": "linux", "arch": "amd64", "kind": "archive", "sha256": sum },
            ]},
        ])
    }

    #[test]
    fn picks_the_stable_archive_per_platform() {
        let r = releases();
        assert_eq!(pick_release(&r, "linux", "amd64").unwrap().0, "go1.27.4.linux-amd64.tar.gz");
        assert_eq!(pick_release(&r, "windows", "amd64").unwrap().0, "go1.27.4.windows-amd64.zip");
        assert_eq!(pick_release(&r, "darwin", "arm64").unwrap().0, "go1.27.4.darwin-arm64.tar.gz");
        assert!(pick_release(&r, "linux", "arm64").is_none());
    }

    #[test]
    fn platform_names_are_the_ones_go_uses() {
        assert_eq!(go_platform("macos", true), ("darwin", "arm64"));
        assert_eq!(go_platform("windows", false), ("windows", "amd64"));
        assert_eq!(go_platform("linux", true), ("linux", "arm64"));
    }

    #[test]
    fn a_release_without_a_real_checksum_or_with_an_odd_name_is_refused() {
        let file = |name: &str, sum: &str| json!([{ "stable": true, "files": [{ "filename": name, "os": "linux", "arch": "amd64", "kind": "archive", "sha256": sum }] }]);
        assert!(pick_release(&file("go1.tar.gz", "abc"), "linux", "amd64").is_none());
        assert!(pick_release(&file("../evil.tar.gz", &"a".repeat(64)), "linux", "amd64").is_none());
    }

    #[test]
    fn a_wrong_checksum_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a");
        std::fs::write(&f, "hello").unwrap();
        assert!(checksum_matches(&f, "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824").unwrap());
        assert!(!checksum_matches(&f, &"0".repeat(64)).unwrap());
    }

    #[test]
    fn go_env_replaces_the_shipped_toolchain_default() {
        let text = go_env_text("# comment\nGOPROXY=https://proxy.golang.org,direct\nGOTOOLCHAIN=auto\nGOTOOLCHAINX=keep\n", Path::new("/t/go home"));
        assert_eq!(text.matches("GOTOOLCHAIN=").count(), 1);
        assert!(text.contains("GOTOOLCHAIN=local\n"));
        assert!(text.contains("GOTOOLCHAINX=keep\n"));
        assert!(text.contains("GOPROXY=https://proxy.golang.org,direct\n"));
        for (k, d) in [("GOPATH", "path"), ("GOCACHE", "cache"), ("GOMODCACHE", "mod"), ("GOBIN", "bin")] {
            assert!(text.contains(&format!("{k}={}\n", Path::new("/t/go home").join(d).display())), "{k}");
        }
    }

    #[test]
    fn only_go_programs_are_recognised() {
        for p in ["go", "/x/bin/go", "gopls", "/x/dlv", "go.exe", "dlv.exe"] {
            assert!(is_go_program(OsStr::new(p)).is_some(), "{p}");
        }
        for p in ["gofmt", "cargo", "/go/bin/node", "golang"] {
            assert!(is_go_program(OsStr::new(p)).is_none(), "{p}");
        }
    }

    #[test]
    fn every_go_program_stays_on_the_local_toolchain() {
        for managed in [false, true] {
            assert!(go_env_changes(managed).0.contains(&("GOTOOLCHAIN", "local")));
        }
    }

    #[test]
    fn only_omegas_go_drops_the_settings_of_another_go() {
        let (set, remove) = go_env_changes(true);
        assert!(set.contains(&("GOENV", "off")));
        for k in ["GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "GOBIN", "GOFLAGS"] {
            assert!(remove.contains(&k), "{k}");
        }
        let (set, remove) = go_env_changes(false);
        assert!(remove.is_empty());
        assert_eq!(set, vec![("GOTOOLCHAIN", "local")]);
    }

    #[cfg(unix)]
    #[test]
    fn remove_tree_deletes_read_only_folders_and_leaves_link_targets() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, "x").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o444)).unwrap();
        let tree = dir.path().join("tree/sub");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join("f"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, tree.join("link")).unwrap();
        std::fs::set_permissions(&tree, std::fs::Permissions::from_mode(0o555)).unwrap();
        remove_tree(&dir.path().join("tree")).unwrap();
        assert!(!dir.path().join("tree").exists());
        assert_eq!(std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777, 0o444);
    }
}
