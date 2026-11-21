//! The "Install omega command" button: a small launcher in a folder of the user's. Needs no admin
//! rights, never touches shell profiles and never replaces someone else's `omega` unasked. The
//! launcher names the stable path of the app (the AppImage, the installed binary), so it stays
//! valid when the app updates itself in place.
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Marks a launcher as ours, so it can be updated and removed safely.
const MARKER: &str = "omega-launcher";
const FILE_NAME: &str = if cfg!(windows) { "omega.cmd" } else { "omega" };
/// A launcher is a few lines; anything bigger is someone's program.
const MAX_LAUNCHER: u64 = 4096;

#[derive(Debug, PartialEq, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Missing,
    /// Ours, and pointing at this app.
    Installed,
    /// Ours, but pointing elsewhere (the app moved).
    Stale,
    /// Something else is called `omega` here.
    Foreign,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    state: State,
    path: String,
    dir: String,
    on_path: bool,
    /// False in test instances without their own folder: they must not touch the real home.
    available: bool,
}

/// Quotes for POSIX sh.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn script(exe: &str, no_fuse: bool) -> String {
    if cfg!(windows) {
        return format!("@echo off\r\nrem {MARKER}\r\n\"{}\" %*\r\nexit /b %errorlevel%\r\n", exe.replace('%', "%%"));
    }
    // NO_CLEANUP: the process that detaches must not delete what its detached copy runs from.
    let run = if no_fuse { format!("env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 {}", sh_quote(exe)) } else { sh_quote(exe) };
    format!("#!/bin/sh\n# {MARKER}: created by Omega\nexec {run} \"$@\"\n")
}

/// What `install.sh` wrote before launchers had a marker.
fn is_old_launcher(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    lines.len() == 2 && lines[0] == "#!/bin/sh" && lines[1].starts_with("exec ") && lines[1].ends_with("Omega.AppImage \"$@\"")
}

fn classify(path: &Path, wanted: &str) -> State {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return State::Missing };
    if !meta.is_file() || meta.len() > MAX_LAUNCHER {
        return State::Foreign;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return State::Foreign };
    if text == wanted {
        State::Installed
    } else if text.contains(MARKER) || is_old_launcher(&text) {
        State::Stale
    } else {
        State::Foreign
    }
}

/// Writes the launcher. `replace`: the user agreed to replace a foreign `omega`.
fn install_to(dir: &Path, text: &str, replace: bool) -> Result<State, String> {
    let path = dir.join(FILE_NAME);
    if classify(&path, text) == State::Foreign && !replace {
        return Err("launcher:foreign".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    // Replaces a symlink itself instead of writing through it.
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(classify(&path, text))
}

fn target_dir(home: &Path, exe: &Path) -> PathBuf {
    if let Some(d) = std::env::var_os("OMEGA_CLI_BIN_DIR").filter(|d| !d.is_empty()) {
        return d.into();
    }
    if cfg!(windows) {
        return exe.parent().unwrap_or(home).join("bin");
    }
    match std::env::var_os("XDG_BIN_HOME").filter(|d| !d.is_empty()) {
        Some(d) => d.into(),
        None => home.join(".local").join("bin"),
    }
}

/// Test instances run in the user's real home, so they only install into a folder set for them.
fn available() -> bool {
    crate::instance::name().is_none() || std::env::var_os("OMEGA_CLI_BIN_DIR").is_some_and(|d| !d.is_empty())
}

fn app_path() -> Result<PathBuf, String> {
    match std::env::var_os("APPIMAGE") {
        Some(p) => Ok(p.into()),
        None => std::env::current_exe().map_err(|e| e.to_string()),
    }
}

fn has_fuse2() -> bool {
    ["/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu"].iter().any(|d| {
        std::fs::read_dir(d).is_ok_and(|mut e| e.any(|f| f.is_ok_and(|f| f.file_name().to_string_lossy().starts_with("libfuse.so.2"))))
    })
}

fn wanted_script(exe: &Path) -> Result<String, String> {
    let exe = exe.to_str().ok_or("the app's path is not valid UTF-8")?;
    Ok(script(exe, std::env::var_os("APPIMAGE").is_some() && !has_fuse2()))
}

fn on_path(dir: &Path, path: &std::ffi::OsStr) -> bool {
    std::env::split_paths(path).any(|p| p == dir)
}

#[tauri::command]
pub fn cli_status() -> Result<Status, String> {
    let exe = app_path()?;
    let dir = target_dir(&crate::env::home(), &exe);
    let path = dir.join(FILE_NAME);
    Ok(Status {
        state: classify(&path, &wanted_script(&exe)?),
        path: path.to_string_lossy().into_owned(),
        on_path: on_path(&dir, &crate::env::path()),
        dir: dir.to_string_lossy().into_owned(),
        available: available(),
    })
}

#[tauri::command]
pub fn cli_install(replace: bool) -> Result<Status, String> {
    if !available() {
        return Err("launcher:test_instance".into());
    }
    let exe = app_path()?;
    install_to(&target_dir(&crate::env::home(), &exe), &wanted_script(&exe)?, replace)?;
    cli_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(sh_quote("/a b/it's"), r"'/a b/it'\''s'");
    }

    #[cfg(unix)]
    #[test]
    fn the_launcher_runs_a_path_with_spaces_and_quotes() {
        let t = tempfile::tempdir().unwrap();
        let app_dir = t.path().join("my app's dir");
        std::fs::create_dir(&app_dir).unwrap();
        let app = app_dir.join("fake app");
        std::fs::write(&app, "#!/bin/sh\nfor a in \"$@\"; do echo \"[$a]\"; done\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = t.path().join("bin");
        install_to(&bin, &script(app.to_str().unwrap(), false), false).unwrap();
        let out = std::process::Command::new(bin.join("omega")).args(["a b", "-x"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "[a b]\n[-x]\n");
    }

    #[test]
    fn without_fuse_the_extracted_app_survives_the_detach() {
        if cfg!(unix) {
            assert!(script("/a", true).contains("APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 '/a'"));
            assert!(!script("/a", false).contains("EXTRACT"));
        }
    }

    #[test]
    fn never_replaces_a_foreign_omega_unasked() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join(FILE_NAME);
        std::fs::write(&path, "someone else's program").unwrap();
        let text = script("/app", false);
        assert_eq!(classify(&path, &text), State::Foreign);
        assert_eq!(install_to(t.path(), &text, false), Err("launcher:foreign".into()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "someone else's program");
        assert_eq!(install_to(t.path(), &text, true), Ok(State::Installed));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_foreign_and_its_target_stays_untouched() {
        let t = tempfile::tempdir().unwrap();
        let other = t.path().join("other");
        std::fs::write(&other, "keep").unwrap();
        let bin = t.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::os::unix::fs::symlink(&other, bin.join("omega")).unwrap();
        let text = script("/app", false);
        assert!(install_to(&bin, &text, false).is_err());
        install_to(&bin, &text, true).unwrap();
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "keep");
        assert!(!std::fs::symlink_metadata(bin.join("omega")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn updates_its_own_launcher() {
        let t = tempfile::tempdir().unwrap();
        install_to(t.path(), &script("/old", false), false).unwrap();
        let text = script("/new", false);
        assert_eq!(classify(&t.path().join(FILE_NAME), &text), State::Stale);
        assert_eq!(install_to(t.path(), &text, false), Ok(State::Installed));
    }

    #[test]
    fn recognises_the_old_install_script_launcher() {
        assert!(is_old_launcher("#!/bin/sh\nexec /home/u/.local/bin/Omega.AppImage \"$@\"\n"));
        assert!(is_old_launcher("#!/bin/sh\nexec env APPIMAGE_EXTRACT_AND_RUN=1 /h/Omega.AppImage \"$@\"\n"));
        assert!(!is_old_launcher("#!/bin/sh\nrm -rf /\nexec /h/Omega.AppImage \"$@\"\n"));
    }

    #[test]
    fn tells_if_the_folder_is_on_path() {
        let path = std::env::join_paths(["/usr/bin", "/home/u/.local/bin"]).unwrap();
        assert!(on_path(Path::new("/home/u/.local/bin"), &path));
        assert!(!on_path(Path::new("/home/u/bin"), &path));
    }
}
