//! Go in Omega's tools folder: the official toolchain archive (checksum verified), gopls and Delve.
//! Everything Go writes for them stays in `tools/go-home`, so a user's own `~/go` is never touched.
//! No admin rights and no shell profile edits.
use super::{download, exe_name, get_json, get_text, record, sha256_hex, tail_chars, unpack, Progress, ARM, OS};
#[cfg(unix)]
use super::make_executable;
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

/// Where Go's telemetry and Delve's config go instead of the user's config folder. Go has no
/// setting for this (`GOTELEMETRY` and `GOTELEMETRYDIR` are read-only): it follows the OS's config
/// folder. On macOS that is below HOME, which git and netrc need, so there only Delve moves.
/// `XDG_CONFIG_HOME` is also where git looks: outside Linux only Delve, which runs no git, gets it.
fn private_config_vars(os: &str, config: &Path, delve: bool) -> Vec<(&'static str, PathBuf)> {
    let mut vars = Vec::new();
    if os == "linux" || delve {
        vars.push(("XDG_CONFIG_HOME", config.to_path_buf()));
    }
    if os == "windows" {
        vars.push(("APPDATA", config.to_path_buf()));
    }
    vars
}

/// Git run by Go reads the user's `git` config folder through the private one, so credentials and
/// `url.insteadOf` keep working and `~/.gitconfig` keeps its normal precedence. A real folder of
/// that name is never replaced.
#[cfg(unix)]
fn link_user_git(config: &Path, user: &Path) {
    if user == config {
        return;
    }
    let (link, target) = (config.join("git"), user.join("git"));
    let meta = std::fs::symlink_metadata(&link).ok();
    if meta.as_ref().is_some_and(|m| !m.file_type().is_symlink()) {
        return;
    }
    if !target.is_dir() {
        if meta.is_some() {
            let _ = std::fs::remove_file(&link);
        }
    } else if std::fs::read_link(&link).ok().as_deref() != Some(target.as_path()) {
        let _ = std::fs::remove_file(&link);
        let _ = std::os::unix::fs::symlink(&target, &link);
    }
}

/// The private config folder, ready for a Go program.
fn prepare_go_config() -> PathBuf {
    let config = go_config();
    let _ = std::fs::create_dir_all(&config);
    #[cfg(unix)]
    if OS == "linux" {
        if let Some(user) = dirs_config() {
            link_user_git(&config, &user);
        }
    }
    config
}

fn go_config() -> PathBuf {
    go_home().join("config")
}

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

/// The real `go` of Omega's installation.
fn real_go() -> PathBuf {
    go_root().join("bin").join(exe_name("go"))
}

/// In front of the real programs on Unix. A terminal's shell can export another Go's GOPATH or
/// GOFLAGS from its profile after Omega started it, so only a launcher can keep them out.
#[cfg(unix)]
fn shim_text(program: &str, private_config: bool) -> String {
    let mut text = format!(
        "#!/bin/sh\n# Omega's Go, with its own settings (see go.env) instead of those of another Go.\ndir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd) || exit 1\nunset {} GOTOOLCHAIN\nGOENV=off\nexport GOENV\n",
        FOREIGN_VARS.join(" ")
    );
    if private_config && program == "go" {
        // Telemetry stays in Omega's folder. What `go run` and `go test` start gets the user's value back.
        text.push_str(concat!(
            "if [ \"${XDG_CONFIG_HOME+x}\" = x ]; then OMEGA_GO_USER_CONFIG=$XDG_CONFIG_HOME; export OMEGA_GO_USER_CONFIG; else unset OMEGA_GO_USER_CONFIG; fi\n",
            "private=$(CDPATH= cd -- \"$dir/../..\" && pwd)/go-home/config\n",
            "user=${XDG_CONFIG_HOME:-$HOME/.config}\n",
            // Git run by Go keeps the user's settings; a real folder of that name is left alone.
            "case \"$user\" in /*) if [ \"$user\" != \"$private\" ]; then mkdir -p \"$private\"; if [ -d \"$user/git\" ]; then if [ -L \"$private/git\" ] || [ ! -e \"$private/git\" ]; then ln -sfn \"$user/git\" \"$private/git\" 2>/dev/null; fi; elif [ -L \"$private/git\" ]; then rm -f \"$private/git\"; fi; fi ;; esac\n",
            "XDG_CONFIG_HOME=$private\nexport XDG_CONFIG_HOME\n",
            "case \"$dir\" in *\"'\"*) q='\"' ;; *) q=\"'\" ;; esac\n",
            "case \"$1\" in run|test) sub=$1; shift; exec \"$dir/../go/bin/go\" \"$sub\" -exec \"$q$dir/omega-exec$q\" \"$@\" ;; esac\n",
        ));
    }
    text.push_str(&format!("exec \"$dir/../go/bin/{program}\" \"$@\"\n"));
    text
}

/// Runs a program built by `go run` or `go test` with the environment it would have had.
#[cfg(unix)]
const PROGRAM_SHIM: &str = "#!/bin/sh\nif [ \"${OMEGA_GO_USER_CONFIG+x}\" = x ]; then XDG_CONFIG_HOME=$OMEGA_GO_USER_CONFIG; export XDG_CONFIG_HOME; else unset XDG_CONFIG_HOME; fi\nunset OMEGA_GO_USER_CONFIG GOENV\nexec \"$@\"\n";

/// The folder that goes on the PATH.
#[cfg(unix)]
fn write_shims(dir: &Path) -> Result<PathBuf, String> {
    let shim = dir.join("shim");
    std::fs::create_dir_all(&shim).map_err(|e| format!("tools:go_failed:{e}"))?;
    for program in ["go", "gofmt"] {
        let file = shim.join(program);
        std::fs::write(&file, shim_text(program, OS == "linux")).map_err(|e| format!("tools:go_failed:{e}"))?;
        make_executable(&file);
    }
    let exec = shim.join("omega-exec");
    std::fs::write(&exec, PROGRAM_SHIM).map_err(|e| format!("tools:go_failed:{e}"))?;
    make_executable(&exec);
    Ok(shim)
}

#[cfg(not(unix))]
fn write_shims(dir: &Path) -> Result<PathBuf, String> {
    Ok(dir.join("go").join("bin"))
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
    let managed = go.is_some_and(|p| p.starts_with(go_dir()));
    let (set, remove) = go_env_changes(managed);
    for k in remove {
        c.env_remove(k);
    }
    c.envs(set);
    let own_tool = env::which(&program.to_string_lossy()).is_some_and(|p| p.starts_with(go_tools_bin()));
    if managed || own_tool {
        let config = prepare_go_config();
        c.envs(private_config_vars(OS, &config, stem == "dlv"));
    }
}

/// The user's own Go config file (`go env -w`).
fn user_go_env_file() -> Option<PathBuf> {
    match std::env::var_os("GOENV") {
        Some(v) if v == "off" => return None,
        Some(v) if !v.is_empty() => return Some(PathBuf::from(v)),
        _ => {}
    }
    dirs_config().map(|d| d.join("go").join("env"))
}

fn dirs_config() -> Option<PathBuf> {
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    if cfg!(target_os = "macos") {
        return Some(env::home().join("Library").join("Application Support"));
    }
    std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| Some(env::home().join(".config")))
}

fn env_file_sets_toolchain(text: &str) -> bool {
    text.lines().any(|l| l.trim_start().strip_prefix("GOTOOLCHAIN=").is_some_and(|v| !v.trim().is_empty()))
}

#[derive(serde::Serialize)]
pub struct GoInfo {
    /// `go` on the PATH is Omega's own.
    managed: bool,
    /// The user chose a toolchain policy (environment or `go env -w`): Omega's Run leaves it alone.
    user_toolchain: bool,
    /// For a debugged program: the values it would have without Omega's settings (`null` = unset).
    program_env: std::collections::HashMap<String, Option<String>>,
}

#[tauri::command]
pub fn go_info() -> GoInfo {
    let chosen = std::env::var_os("GOTOOLCHAIN").is_some_and(|v| !v.is_empty());
    let in_file = user_go_env_file().and_then(|f| std::fs::read_to_string(f).ok()).is_some_and(|t| env_file_sets_toolchain(&t));
    let mut keys = vec!["GOENV", "GOTOOLCHAIN"];
    keys.extend(private_config_vars(OS, Path::new(""), true).into_iter().map(|(k, _)| k));
    let program_env = keys.into_iter().map(|k| (k.to_string(), std::env::var(k).ok())).collect();
    GoInfo { managed: env::which("go").is_some_and(|p| p.starts_with(go_dir())), user_toolchain: chosen || in_file, program_env }
}

/// cmd.exe reads no profile, so on Windows a terminal is kept clean when it starts.
#[cfg(windows)]
pub fn apply_go_shell_env(c: &mut portable_pty::CommandBuilder) {
    if env::which("go").is_some_and(|p| p.starts_with(go_dir())) {
        for k in FOREIGN_VARS {
            c.env_remove(k);
        }
        c.env_remove("GOTOOLCHAIN");
        c.env("GOENV", "off");
    }
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

fn go_old() -> PathBuf {
    env::tools_dir().join(".go.old")
}

/// After a crash during `swap_in`: the old version comes back if the new one never arrived.
fn recover_old(target: &Path, old: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(old).is_err() {
        return Ok(());
    }
    if target.exists() {
        return remove_tree(old);
    }
    std::fs::rename(old, target).map_err(|e| format!("tools:go_failed:{e}"))
}

/// Puts `fresh` at `target`. Until it is there the old version is only moved aside, and it returns
/// if the move fails (a virus scanner or an open file on Windows).
fn swap_in(fresh: &Path, target: &Path, old: &Path) -> Result<(), String> {
    recover_old(target, old)?;
    let had_old = target.exists();
    if had_old {
        std::fs::rename(target, old).map_err(|e| format!("tools:go_failed:{e}"))?;
    }
    if let Err(e) = std::fs::rename(fresh, target) {
        if had_old && !target.exists() {
            std::fs::rename(old, target).map_err(|back| format!("tools:go_failed:{e}; {back}"))?;
        }
        return Err(format!("tools:go_failed:{e}"));
    }
    let _ = remove_tree(old);
    Ok(())
}

/// At startup, before the PATH is built from the installed tools.
pub fn recover_go() {
    let _work = go_lock();
    let _ = recover_old(&go_dir(), &go_old());
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
        swap_in(&fresh, &go_dir(), &go_old())
    })();
    let _ = std::fs::remove_file(&archive);
    let _ = remove_tree(&fresh);
    result?;
    let bin = write_shims(&go_dir())?;
    telemetry_off(&real_go());
    record("go", &bin)?;
    Ok(env::norm(bin))
}

/// Go's own switch, in Omega's private config. On macOS that folder can't be moved, so nothing is written.
fn telemetry_off(go: &Path) {
    if OS == "macos" {
        return;
    }
    let config = prepare_go_config();
    let _ = env::command(go).args(["telemetry", "off"]).current_dir(go_home_or_tools()).envs(private_config_vars(OS, &config, false)).env("GOENV", "off").stdin(Stdio::null()).output();
}

fn go_home_or_tools() -> PathBuf {
    let home = go_home();
    if home.is_dir() { home } else { env::tools_dir() }
}

/// Builds gopls or Delve with `go install` into Omega's folder. It runs outside any project, and
/// only here may Go fetch the newer toolchain the tool itself requires.
pub fn install_go_tool(app: &AppHandle, progress: &str, package: &str, exe: &str) -> Result<String, String> {
    let _work = go_lock();
    let go = env::which("go").ok_or("tools:go_missing")?;
    // The launcher would drop the settings below.
    let managed = go.starts_with(go_dir());
    let go = if managed { real_go() } else { go };
    let (home, bin) = (go_home(), go_tools_bin());
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    telemetry_off(&go);
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
        .envs(private_config_vars(OS, &prepare_go_config(), false))
        .stdin(Stdio::null());
    if !managed {
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
    let file = bin.join(exe_name(exe));
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
    remove_tree(&go_old())?;
    remove_tree(&go_dir())?;
    remove_tree(&go_home())?;
    super::forget("go")
}

pub fn remove_go_tool(exe: &str) -> Result<(), String> {
    let _work = go_lock();
    match std::fs::remove_file(go_tools_bin().join(exe_name(exe))) {
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
    fn the_launcher_drops_another_gos_settings_and_passes_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("with space");
        std::fs::create_dir_all(root.join("go/bin")).unwrap();
        let fake = root.join("go/bin/go");
        std::fs::write(&fake, "#!/bin/sh\nprintf '%s|' \"$#\" \"$1\" \"$GOPATH\" \"$GOFLAGS\" \"$GOTOOLCHAIN\" \"$GOENV\" \"$KEEP\"\n").unwrap();
        make_executable(&fake);
        let shim = write_shims(&root).unwrap();
        let out = Command::new(shim.join("go")).args(["a b", "c"]).env("GOPATH", "/own").env("GOFLAGS", "-mod=mod").env("GOTOOLCHAIN", "auto").env("KEEP", "yes").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "2|a b||||off|yes|");
    }

    #[test]
    fn config_folders_move_per_system() {
        let p = Path::new("/c");
        let names = |os, delve| private_config_vars(os, p, delve).into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        assert_eq!(names("linux", false), ["XDG_CONFIG_HOME"]);
        assert_eq!(names("macos", true), ["XDG_CONFIG_HOME"]);
        assert_eq!(names("windows", true), ["XDG_CONFIG_HOME", "APPDATA"]);
        // Go runs git, which reads XDG_CONFIG_HOME too.
        assert!(names("macos", false).is_empty());
        assert_eq!(names("windows", false), ["APPDATA"]);
    }

    fn version_dir(path: &Path, text: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("VERSION"), text).unwrap();
    }
    fn version(path: &Path) -> String {
        std::fs::read_to_string(path.join("VERSION")).unwrap()
    }

    #[test]
    fn a_failed_replace_keeps_the_old_go() {
        let dir = tempfile::tempdir().unwrap();
        let (target, old) = (dir.path().join("go"), dir.path().join(".go.old"));
        version_dir(&target, "old");
        assert!(swap_in(&dir.path().join("missing"), &target, &old).is_err());
        assert_eq!(version(&target), "old");
        assert!(!old.exists());
    }

    #[test]
    fn a_replace_leaves_only_the_new_go() {
        let dir = tempfile::tempdir().unwrap();
        let (fresh, target, old) = (dir.path().join(".go.new"), dir.path().join("go"), dir.path().join(".go.old"));
        version_dir(&target, "old");
        version_dir(&fresh, "new");
        swap_in(&fresh, &target, &old).unwrap();
        assert_eq!(version(&target), "new");
        assert!(!old.exists() && !fresh.exists());
    }

    #[test]
    fn a_crash_between_the_moves_brings_the_old_go_back() {
        let dir = tempfile::tempdir().unwrap();
        let (target, old) = (dir.path().join("go"), dir.path().join(".go.old"));
        version_dir(&old, "old");
        recover_old(&target, &old).unwrap();
        assert_eq!(version(&target), "old");
        assert!(!old.exists());
    }

    #[test]
    fn a_crash_after_the_new_go_arrived_only_drops_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let (target, old) = (dir.path().join("go"), dir.path().join(".go.old"));
        version_dir(&target, "new");
        version_dir(&old, "old");
        recover_old(&target, &old).unwrap();
        assert_eq!(version(&target), "new");
        assert!(!old.exists());
    }

    #[cfg(unix)]
    #[test]
    fn git_under_the_launcher_keeps_the_users_config_and_its_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".config/git")).unwrap();
        std::fs::write(home.join(".config/git/config"), "[a]\n\tfromxdg = x\n\tboth = xdg\n").unwrap();
        std::fs::write(home.join(".gitconfig"), "[a]\n\tboth = home\n").unwrap();
        let root = dir.path().join("tools/go");
        std::fs::create_dir_all(root.join("go/bin")).unwrap();
        let fake = root.join("go/bin/go");
        std::fs::write(&fake, "#!/bin/sh\ngit config --get a.fromxdg\ngit config --get a.both\n").unwrap();
        make_executable(&fake);
        let shim = write_shim_for_test(&root);
        let run = || Command::new(shim.join("go")).arg("get").current_dir(&home).env("HOME", &home).env_remove("XDG_CONFIG_HOME").env_remove("GIT_CONFIG_GLOBAL").env_remove("GIT_CONFIG_SYSTEM").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&run().stdout), "x\nhome\n");
        // The user's folder goes away: so does the link.
        std::fs::remove_dir_all(home.join(".config/git")).unwrap();
        assert_eq!(String::from_utf8_lossy(&run().stdout), "home\n");
        assert!(std::fs::symlink_metadata(dir.path().join("tools/go-home/config/git")).is_err());
    }

    #[cfg(unix)]
    fn write_shim_for_test(root: &Path) -> PathBuf {
        let shim = root.join("shim");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::write(shim.join("go"), shim_text("go", true)).unwrap();
        make_executable(&shim.join("go"));
        shim
    }

    #[cfg(unix)]
    #[test]
    fn the_git_link_never_replaces_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (config, user) = (dir.path().join("private"), dir.path().join("user"));
        std::fs::create_dir_all(config.join("git")).unwrap();
        std::fs::write(config.join("git/keep"), "x").unwrap();
        std::fs::create_dir_all(user.join("git")).unwrap();
        link_user_git(&config, &user);
        assert!(config.join("git/keep").exists());
        std::fs::remove_dir_all(config.join("git")).unwrap();
        link_user_git(&config, &user);
        assert_eq!(std::fs::read_link(config.join("git")).unwrap(), user.join("git"));
    }

    #[test]
    fn a_toolchain_choice_in_go_env_is_seen() {
        assert!(env_file_sets_toolchain("GOPROXY=x\nGOTOOLCHAIN=auto\n"));
        assert!(!env_file_sets_toolchain("GOPROXY=x\nGOTOOLCHAIN=\n# GOTOOLCHAIN=auto\n"));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_started_by_go_gets_the_users_config_folder_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("it's here");
        std::fs::create_dir_all(root.join("go/bin")).unwrap();
        let fake = root.join("go/bin/go");
        // Like `go run -exec`: splits the quoted launcher off and starts the program through it.
        std::fs::write(&fake, "#!/bin/sh\nprintf 'go:%s|' \"$XDG_CONFIG_HOME\"\nif [ \"$2\" = -exec ]; then x=$3; x=${x#?}; x=${x%?}; exec \"$x\" sh -c 'printf \"prog:%s:%s\" \"${XDG_CONFIG_HOME-unset}\" \"${GOENV-unset}\"'; fi\n").unwrap();
        make_executable(&fake);
        std::fs::write(root.join("x"), "").unwrap();
        let shim = root.join("shim");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::write(shim.join("go"), shim_text("go", true)).unwrap();
        make_executable(&shim.join("go"));
        std::fs::write(shim.join("omega-exec"), PROGRAM_SHIM).unwrap();
        make_executable(&shim.join("omega-exec"));
        let run = |user: Option<&str>| {
            let mut c = Command::new(shim.join("go"));
            c.args(["run", "."]).env_remove("XDG_CONFIG_HOME");
            if let Some(u) = user {
                c.env("XDG_CONFIG_HOME", u);
            }
            String::from_utf8_lossy(&c.output().unwrap().stdout).to_string()
        };
        let own = run(Some("/mine"));
        assert!(own.starts_with("go:") && own.contains("go-home/config|"), "{own}");
        assert!(own.ends_with("prog:/mine:unset"), "{own}");
        assert!(run(None).ends_with("prog:unset:unset"));
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
