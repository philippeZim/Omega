//! Private working folders for files whose language the user chose by hand (Code mode). Compilers
//! that insist on a file extension get a copy here, and build output lands here, so nothing is
//! written into the project. The base folder has a random name and mode 0700, is created
//! atomically (never reused if it already exists) and is removed when the app exits. Each source
//! file has three folders: `run` (copy plus links to its neighbours), `bin` (build output, never
//! any links, so a compiler can't write through one) and `lsp` (the language server's copy).
//!
//! A running Omega holds a lock on `.lock` in its base folder. After a crash the lock is gone, and
//! the next start removes the leftover folder (see `sweep_in`).
use crate::env::norm;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The base folder and the lock that marks it as in use for as long as this process lives.
static BASE: Mutex<Option<(PathBuf, File)>> = Mutex::new(None);

const LOCK: &str = ".lock";
/// A lock file this young may belong to a start that hasn't taken the lock yet.
const MIN_STALE_AGE: Duration = Duration::from_secs(600);

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

/// The per-user runtime folder where there is one; the temp folder is shared on some systems,
/// which the random name and mode 0700 account for.
fn parent_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir)
}

fn lock_base(dir: &Path) -> Result<File, String> {
    let lock = OpenOptions::new().write(true).create_new(true).open(dir.join(LOCK)).map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|e| e.to_string())?;
    Ok(lock)
}

fn base() -> Result<PathBuf, String> {
    let mut slot = BASE.lock().map_err(|e| e.to_string())?;
    if let Some((dir, _)) = slot.as_ref().filter(|(d, _)| d.is_dir()) {
        return Ok(dir.clone());
    }
    let dir = new_base(&parent_dir())?;
    let lock = lock_base(&dir)?;
    *slot = Some((dir.clone(), lock));
    Ok(dir)
}

/// `omega-lang-` and the 32 lowercase hex digits `new_base` gives it, nothing else.
#[cfg(unix)]
fn is_base_name(name: &str) -> bool {
    name.strip_prefix("omega-lang-").is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Whether `dir` is a leftover of a process that is gone. Anything uncertain counts as in use: a
/// missing or young lock file, another owner, a link, or a lock someone holds.
#[cfg(unix)]
fn is_stale(dir: &Path, uid: u32, min_age: Duration) -> bool {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let Ok(meta) = fs::symlink_metadata(dir) else { return false };
    if !meta.file_type().is_dir() || meta.uid() != uid {
        return false;
    }
    let Ok(lock) = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(dir.join(LOCK)) else { return false };
    let Ok(info) = lock.metadata() else { return false };
    if !info.file_type().is_file() || info.uid() != uid {
        return false;
    }
    let old = info.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age >= min_age);
    // Dropping `lock` afterwards releases it; a holder keeps its own lock, so this fails for it.
    old && lock.try_lock().is_ok()
}

/// Removes leftover base folders in `parent`. Only in a folder others can't rename things in: our
/// own, or a sticky one like /tmp. `remove_dir_all` doesn't follow the links inside.
#[cfg(unix)]
fn sweep_in(parent: &Path, min_age: Duration) {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and can't fail.
    let uid = unsafe { libc::geteuid() };
    let Ok(meta) = fs::metadata(parent) else { return };
    if meta.uid() != uid && meta.mode() & 0o1000 == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(parent) else { return };
    for e in entries.flatten() {
        if e.file_name().to_str().is_some_and(is_base_name) && is_stale(&e.path(), uid, min_age) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// At startup: folders a crashed Omega left behind. On Windows there is no such sweep.
pub fn sweep_stale() {
    #[cfg(unix)]
    sweep_in(&parent_dir(), MIN_STALE_AGE);
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
        // No hidden entries: tools keep their build state there (`.scala-build`), and it must not
        // be written through a link into the project.
        let hidden = name.as_encoded_bytes().first() == Some(&b'.');
        if hidden || name == copy_name || e.path() == source || dir.join(&name).symlink_metadata().is_ok() {
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
    // A new file under a random name (`create_new` never follows a link), then a rename, which
    // replaces a link at the target instead of writing through it.
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".omega-tmp-{}", hex(&id)));
    let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
    if let Err(e) = out.write_all(&data).and_then(|()| fs::rename(&tmp, &target)) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
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
        if let Some((dir, _lock)) = slot.take() {
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

    #[cfg(unix)]
    #[test]
    fn a_planted_temp_name_is_not_written_through() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("prog"), "new").unwrap();
        let victim = root.path().join("bashrc");
        fs::write(&victim, "keep").unwrap();
        // What a repository could ship next to the file, and what the old temp name was.
        std::os::unix::fs::symlink(&victim, src.join(".omega_main.js.tmp")).unwrap();
        let dir = root.path().join("work");
        fs::create_dir(&dir).unwrap();
        for _ in 0..2 {
            copy_into(&dir, src.join("prog").to_str().unwrap(), "omega_main.js", true).unwrap();
        }
        std::os::unix::fs::symlink(&victim, dir.join(".omega_main.js.tmp")).unwrap();
        copy_into(&dir, src.join("prog").to_str().unwrap(), "omega_main.js", true).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(fs::read_to_string(dir.join("omega_main.js")).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn hidden_neighbours_are_not_linked() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        fs::create_dir_all(src.join(".scala-build")).unwrap();
        fs::write(src.join("prog"), "x").unwrap();
        let dir = root.path().join("work");
        fs::create_dir(&dir).unwrap();
        copy_into(&dir, src.join("prog").to_str().unwrap(), "omega_main.sc", true).unwrap();
        assert!(dir.join(".scala-build").symlink_metadata().is_err());
    }

    #[cfg(unix)]
    mod sweep {
        use super::*;
        const ID: &str = "0123456789abcdef0123456789abcdef";

        fn base_in(parent: &Path, id: &str) -> PathBuf {
            let dir = parent.join(format!("omega-lang-{id}"));
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join(LOCK), "").unwrap();
            dir
        }

        #[test]
        fn a_crashed_processes_folder_goes_without_following_its_links() {
            let parent = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("keep"), "x").unwrap();
            let dir = base_in(parent.path(), ID);
            std::os::unix::fs::symlink(outside.path(), dir.join("link")).unwrap();
            sweep_in(parent.path(), Duration::ZERO);
            assert!(!dir.exists());
            assert!(outside.path().join("keep").exists());
        }

        #[test]
        fn a_folder_in_use_stays() {
            let parent = tempfile::tempdir().unwrap();
            let dir = base_in(parent.path(), ID);
            let held = File::open(dir.join(LOCK)).unwrap();
            held.try_lock().unwrap();
            sweep_in(parent.path(), Duration::ZERO);
            assert!(dir.join(LOCK).exists());
        }

        #[test]
        fn a_young_lock_or_none_counts_as_in_use() {
            let parent = tempfile::tempdir().unwrap();
            let young = base_in(parent.path(), ID);
            let unlocked = parent.path().join("omega-lang-fedcba9876543210fedcba9876543210");
            fs::create_dir(&unlocked).unwrap();
            sweep_in(parent.path(), Duration::from_secs(3600));
            assert!(young.exists());
            sweep_in(parent.path(), Duration::ZERO);
            assert!(unlocked.exists());
        }

        #[test]
        fn other_names_links_and_files_stay() {
            let parent = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let target = base_in(outside.path(), ID);
            std::os::unix::fs::symlink(&target, parent.path().join("omega-lang-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).unwrap();
            fs::write(parent.path().join("omega-lang-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), "file").unwrap();
            for name in ["omega-lang-short", "omega-lang-0123456789ABCDEF0123456789ABCDEF", "xomega-lang-0123456789abcdef0123456789abcdef"] {
                fs::create_dir(parent.path().join(name)).unwrap();
                fs::write(parent.path().join(name).join(LOCK), "").unwrap();
            }
            sweep_in(parent.path(), Duration::ZERO);
            assert!(target.join(LOCK).exists());
            assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 5);
        }

        #[test]
        fn a_lock_that_is_a_link_is_not_touched() {
            let parent = tempfile::tempdir().unwrap();
            let other = tempfile::NamedTempFile::new().unwrap();
            let dir = parent.path().join(format!("omega-lang-{ID}"));
            fs::create_dir(&dir).unwrap();
            std::os::unix::fs::symlink(other.path(), dir.join(LOCK)).unwrap();
            sweep_in(parent.path(), Duration::ZERO);
            assert!(dir.exists());
        }
    }
}
