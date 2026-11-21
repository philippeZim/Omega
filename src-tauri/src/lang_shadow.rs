//! Private working folders for files whose language the user chose by hand (Code mode). Compilers
//! that insist on a file extension get a copy here, and build output lands here, so nothing is
//! written into the project. The base folder has a random name and mode 0700, is created
//! atomically (never reused if it already exists) and is removed when the app exits. Each source
//! file has three folders: `run` (copy plus links to its neighbours), `bin` (build output, never
//! any links, so a compiler can't write through one) and `lsp` (the language server's copy).
use crate::env::norm;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static BASE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Entries linked next to a run copy at most (a huge folder must not stall every Run).
const MAX_LINKS: usize = 2000;

fn create_private(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    fs::create_dir(dir)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Creates a new private folder in `parent`. An existing name is never taken over.
fn new_base(parent: &Path) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).map_err(|e| e.to_string())?;
        let dir = parent.join(format!("omega-lang-{}", hex(&id)));
        match create_private(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("no free temp folder".into())
}

fn base() -> Result<PathBuf, String> {
    let mut slot = BASE.lock().map_err(|e| e.to_string())?;
    if let Some(dir) = slot.as_ref().filter(|d| d.is_dir()) {
        return Ok(dir.clone());
    }
    // The per-user runtime folder where there is one; the temp folder is shared on some systems,
    // which the random name and mode 0700 account for.
    let parent = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir);
    let dir = new_base(&parent)?;
    *slot = Some(dir.clone());
    Ok(dir)
}

/// The folder of one source file below `base`. Only `run` ever holds links: the language server
/// must not see the project's build files, and build output must not land on a link.
fn file_dir(base: &Path, file: &str, part: &str) -> Result<PathBuf, String> {
    let id = hex(&Sha256::digest(file.as_bytes())[..12]);
    let dir = base.join(id).join(part);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A plain file name: no separators, no leading dot or dash, nothing a shell would act on.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.starts_with(['.', '-']) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

fn part_name(part: &str) -> Result<&str, String> {
    if matches!(part, "run" | "bin" | "lsp") { Ok(part) } else { Err("invalid folder".into()) }
}

/// Replaces the links of an earlier run with links to what lies next to the source now, so
/// relative imports of the copy resolve to the real files.
#[cfg(unix)]
fn link_siblings(dir: &Path, source: &Path, copy_name: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let Some(parent) = source.parent() else { return };
    let Ok(entries) = fs::read_dir(parent) else { return };
    for e in entries.flatten().take(MAX_LINKS) {
        let name = e.file_name();
        if name == copy_name || e.path() == source || dir.join(&name).symlink_metadata().is_ok() {
            continue;
        }
        let _ = std::os::unix::fs::symlink(e.path(), dir.join(&name));
    }
}

#[cfg(not(unix))]
fn link_siblings(_dir: &Path, _source: &Path, _copy_name: &str) {}

fn copy_into(dir: &Path, file: &str, name: &str, link: bool) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("invalid file name".into());
    }
    let data = fs::read(file).map_err(|e| e.to_string())?;
    let target = dir.join(name);
    // A link from an earlier run must not be written through.
    if target.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    if link {
        link_siblings(dir, Path::new(file), name);
    }
    Ok(target)
}

/// The private folder for `file` (`part`: "run", "bin" or "lsp").
#[tauri::command]
pub fn lang_workdir(file: String, part: String) -> Result<String, String> {
    Ok(norm(file_dir(&base()?, &file, part_name(&part)?)?))
}

/// Copies `file` as `name` into its private folder and returns the copy's path. With `link`, what
/// lies next to the file is linked beside the copy.
#[tauri::command]
pub fn lang_copy(file: String, part: String, name: String, link: bool) -> Result<String, String> {
    let dir = file_dir(&base()?, &file, part_name(&part)?)?;
    Ok(norm(copy_into(&dir, &file, &name, link)?))
}

pub fn cleanup() {
    if let Ok(mut slot) = BASE.lock() {
        if let Some(dir) = slot.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_leave_the_folder_or_read_as_options() {
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "-rf", "a b", "a;b", "a\nb"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        for ok in ["OmegaMain.java", "omega_main.ts", "main.sc"] {
            assert!(valid_name(ok));
        }
    }

    #[test]
    fn a_new_base_is_private_and_never_an_existing_folder() {
        let parent = tempfile::tempdir().unwrap();
        let (a, b) = (new_base(parent.path()).unwrap(), new_base(parent.path()).unwrap());
        assert_ne!(a, b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn a_copy_replaces_a_planted_link_instead_of_writing_through_it() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("prog");
        fs::write(&source, "new").unwrap();
        let dir = root.path().join("work");
        fs::create_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            let victim = root.path().join("victim");
            fs::write(&victim, "keep").unwrap();
            std::os::unix::fs::symlink(&victim, dir.join("main.ts")).unwrap();
            let copy = copy_into(&dir, source.to_str().unwrap(), "main.ts", false).unwrap();
            assert_eq!(fs::read_to_string(copy).unwrap(), "new");
            assert_eq!(fs::read_to_string(victim).unwrap(), "keep");
        }
    }

    #[cfg(unix)]
    #[test]
    fn siblings_are_linked_and_stale_links_go() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("prog"), "x").unwrap();
        fs::write(src.join("helper.ts"), "y").unwrap();
        let dir = root.path().join("work");
        fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(root.path().join("gone"), dir.join("stale")).unwrap();
        copy_into(&dir, src.join("prog").to_str().unwrap(), "omega_main.ts", true).unwrap();
        assert_eq!(fs::read_to_string(dir.join("helper.ts")).unwrap(), "y");
        assert!(dir.join("stale").symlink_metadata().is_err());
        assert!(dir.join("prog").symlink_metadata().is_err());
    }
}
