use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// File errors the frontend shows translated (`src/lib/fsError.ts`) are sent as a stable code
/// `fs:<code>`; any other error stays the OS message.
fn io_err(e: std::io::Error) -> String {
    use std::io::ErrorKind::*;
    let code = match e.kind() {
        NotFound => "not_found",
        PermissionDenied => "permission_denied",
        AlreadyExists => "exists",
        IsADirectory => "is_dir",
        NotADirectory => "not_dir",
        DirectoryNotEmpty => "not_empty",
        _ => return e.to_string(),
    };
    format!("fs:{code}")
}

/// The open project folder (set by `watch_dir`), for the symlink check of new entries (#91).
static ROOT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Refuses to create `target` when its path lies inside the open project but its folder resolves
/// (through a symlinked folder) to somewhere outside it. Paths outside the project (Save As
/// elsewhere) and saving existing files stay allowed.
fn check_new_entry(target: &Path) -> Result<(), String> {
    let root = ROOT.lock().ok().and_then(|r| r.clone());
    match root {
        Some(root) => check_new_entry_in(&root, target),
        None => Ok(()),
    }
}

fn check_new_entry_in(root: &Path, target: &Path) -> Result<(), String> {
    if !target.starts_with(root) {
        return Ok(());
    }
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // Missing folders in between get created, so the nearest existing one decides.
    let mut dir = target.parent();
    while let Some(d) = dir {
        if let Ok(c) = d.canonicalize() {
            return if c.starts_with(&root) { Ok(()) } else { Err("fs:outside_project".into()) };
        }
        dir = d.parent();
    }
    Ok(())
}

const HIDDEN: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", ".idea"];

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(io_err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if HIDDEN.contains(&name.as_str()) {
                return None;
            }
            let ft = e.file_type().ok()?;
            // `file_type` does not follow symlinks; a link to a directory is listed as a folder.
            // Broken links fall back to being shown as files.
            let is_dir = ft.is_dir() || (ft.is_symlink() && fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false));
            Some(Entry { name, path: crate::env::norm(e.path()), is_dir })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| "fs:not_utf8".into())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    fs::write(&path, content).map_err(io_err)
}

/// Creates a new empty file. Fails instead of truncating if the file already exists.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    check_new_entry(Path::new(&path))?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

/// Writes binary data sent as base64 (e.g. screenshots from the report dialog).
#[tauri::command]
pub fn write_file_base64(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(err)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    fs::write(&path, bytes).map_err(io_err)
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    check_new_entry(Path::new(&path))?;
    fs::create_dir_all(&path).map_err(io_err)
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    // symlink_metadata also sees a dangling link, which exists() would report as missing (#98).
    if fs::symlink_metadata(&to).is_ok() {
        return Err("fs:exists".into());
    }
    check_new_entry(Path::new(&to))?;
    fs::rename(&from, &to).map_err(io_err)
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(io_err)
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn home_dir() -> String {
    crate::env::norm(crate::env::home())
}

/// Paths passed on the command line (`omega <ordner|datei>…`), made absolute.
#[tauri::command]
pub fn cli_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            crate::env::norm(p.canonicalize().unwrap_or(p))
        })
        .collect()
}

/// All files below `root` (relative paths), skipping VCS/dependency/build folders. Capped for huge trees.
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(collect_files(&root, 50_000)))
        .await
        .map_err(|e| e.to_string())?
}

/// The walk behind `list_files`, stopping after `cap` files. The result is always sorted.
fn collect_files(root: &str, cap: usize) -> Vec<String> {
    walk_files(root, cap, &|_, _| true, &|| false, None).unwrap_or_default().0
}

/// The same walk for a Code Together guest: symlinked folders aren't entered (what they point to
/// inside the project is listed under its real path), a symlinked file only counts if `keep` allows
/// it. `None` if `stop` ended the walk. The flag says whether the cap or `deadline` left files out.
pub(crate) fn collect_guest_files(root: &str, cap: usize, keep: &dyn Fn(&Path) -> bool, stop: &dyn Fn() -> bool, deadline: std::time::Instant) -> Option<(Vec<String>, bool)> {
    let (mut files, late) = walk_files(root, cap.saturating_add(1), &|path, is_dir| !is_dir && keep(path), stop, Some(deadline))?;
    let truncated = late && files.len() <= cap || files.len() > cap;
    files.truncate(cap);
    Some((files, truncated))
}

/// `keep_link(path, is_dir)` decides whether a symlink is followed or listed.
fn walk_files(root: &str, cap: usize, keep_link: &dyn Fn(&Path, bool) -> bool, stop: &dyn Fn() -> bool, deadline: Option<std::time::Instant>) -> Option<(Vec<String>, bool)> {
    const SKIP: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".idea", "build", "dist", ".gradle", ".mypy_cache", ".pytest_cache", ".cache"];
    let base = PathBuf::from(root);
    let mut out = Vec::new();
    // Symlinks are followed, but every real directory is visited only once (tracked by its
    // canonical path), so loops and webs of links can't make the walk explode. Entries are
    // walked in sorted order, and symlinked folders are deferred until all real folders are
    // done, so a folder inside the root appears under its real path and links only add what
    // isn't reachable otherwise. Only symlinks are canonicalized: a real directory's canonical path is
    // its parent's plus its name. If canonicalizing fails (RAM disks, network or shared
    // folders), the raw path stands in.
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.clone());
    let mut visited = std::collections::HashSet::new();
    let mut stack = vec![(base.clone(), base_canon)];
    let mut deferred = std::collections::VecDeque::new();
    let mut capped = false;
    'walk: loop {
        if stop() {
            return None;
        }
        if deadline.is_some_and(|d| std::time::Instant::now() > d) {
            capped = true;
            break;
        }
        let Some((dir, canon)) = stack.pop().or_else(|| deferred.pop_front()) else { break };
        if !visited.insert(canon.clone()) {
            continue;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let (mut subdirs, mut links) = (Vec::new(), Vec::new());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(mut ft) = e.file_type() else { continue };
            let link = ft.is_symlink();
            if link {
                // Broken links are skipped.
                let Ok(m) = fs::metadata(e.path()) else { continue };
                ft = m.file_type();
                if !keep_link(&e.path(), ft.is_dir()) {
                    continue;
                }
            }
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) && !(name.starts_with('.') && name != ".github") {
                    let c = if link { e.path().canonicalize().unwrap_or_else(|_| e.path()) } else { canon.join(e.file_name()) };
                    if !visited.contains(&c) {
                        if link { links.push((e.path(), c)) } else { subdirs.push((e.path(), c)) }
                    }
                }
            } else if ft.is_file() {
                if let Ok(rel) = e.path().strip_prefix(&base) {
                    out.push(crate::env::norm(rel));
                }
                if out.len() >= cap {
                    // Stop the walk, but still sort what was collected.
                    break 'walk;
                }
            }
        }
        stack.extend(subdirs.into_iter().rev());
        deferred.extend(links);
    }
    out.sort();
    Some((out, capped))
}

// ------------------------------------------------------------------ file watcher

static WATCHER: std::sync::Mutex<Option<notify::RecommendedWatcher>> = std::sync::Mutex::new(None);

#[derive(Serialize, Clone)]
struct FsChanged {
    dirs: Vec<String>,
    files: Vec<String>,
}

/// Watches the open folder recursively and emits `fs-changed` (debounced) with
///  - `dirs`: parent directories of created/removed/renamed entries, so the explorer can reload
///    exactly those folders, and
///  - `files`: every file whose content or existence changed (e.g. to recompile LaTeX when an
///    included file was edited outside the editor).
/// Changes inside HIDDEN folders (.git, node_modules, target, …) are ignored.
/// Calling it again replaces the previous watch; `None` stops watching.
#[tauri::command]
pub fn watch_dir(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};
    use std::collections::BTreeSet;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Emitter;

    let mut slot = WATCHER.lock().map_err(err)?;
    *slot = None; // drops (stops) the old watcher, which also ends its debounce thread
    if let Ok(mut root) = ROOT.lock() {
        *root = path.as_ref().map(PathBuf::from);
    }
    let Some(path) = path else { return Ok(()) };

    // (path, structural): structural = created/removed/renamed, i.e. the parent listing changed.
    let (tx, rx) = mpsc::channel::<(PathBuf, bool)>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let structural = matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)));
        if !structural && !matches!(ev.kind, EventKind::Modify(_)) {
            return; // access events etc.
        }
        for p in ev.paths {
            if p.components().any(|c| HIDDEN.contains(&c.as_os_str().to_string_lossy().as_ref())) {
                continue;
            }
            let _ = tx.send((p, structural));
        }
    })
    .map_err(err)?;
    watcher.watch(Path::new(&path), RecursiveMode::Recursive).map_err(err)?;
    *slot = Some(watcher);

    std::thread::spawn(move || {
        // Blocks until the first change; ends when the watcher (sender) is dropped.
        while let Ok(first) = rx.recv() {
            let (mut dirs, mut files) = (BTreeSet::new(), BTreeSet::new());
            let mut add = |(p, structural): (PathBuf, bool)| {
                if structural {
                    if let Some(parent) = p.parent() {
                        dirs.insert(crate::env::norm(parent));
                    }
                }
                files.insert(crate::env::norm(&p));
            };
            add(first);
            // Collect until 250 ms of quiet, but flush at least every second during long bursts.
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(1) {
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(x) => add(x),
                    Err(_) => break,
                }
            }
            let _ = app.emit("fs-changed", FsChanged { dirs: dirs.into_iter().collect(), files: files.into_iter().collect() });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_file_keeps_existing_content() {
        let dir = std::env::temp_dir().join(format!("omega-create-file-{}", std::process::id()));
        let file = dir.join("sub/main.c");
        let path = file.to_string_lossy().to_string();
        create_file(path.clone()).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"");
        fs::write(&file, "int main() {}").unwrap();
        assert!(create_file(path).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "int main() {}");
        fs::remove_dir_all(dir).unwrap();
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn list_dir_dirs_first_case_insensitive_hidden_skipped() {
        let t = tempfile::tempdir().unwrap();
        for d in ["zeta", "Alpha", ".git", "node_modules", "target", "src"] {
            fs::create_dir(t.path().join(d)).unwrap();
        }
        for f in ["b.txt", "A.txt", "c.TXT", ".env"] {
            fs::write(t.path().join(f), "").unwrap();
        }
        let out = list_dir(s(t.path())).unwrap();
        let names: Vec<(&str, bool)> = out.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
        assert_eq!(
            names,
            [("Alpha", true), ("src", true), ("zeta", true), (".env", false), ("A.txt", false), ("b.txt", false), ("c.TXT", false)]
        );
        assert_eq!(out[0].path, crate::env::norm(t.path().join("Alpha")));
    }

    #[test]
    fn list_dir_missing_is_err() {
        let t = tempfile::tempdir().unwrap();
        assert!(list_dir(s(&t.path().join("nope"))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn list_dir_symlinked_dir_is_dir() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("real")).unwrap();
        std::os::unix::fs::symlink(t.path().join("real"), t.path().join("link")).unwrap();
        std::os::unix::fs::symlink(t.path().join("gone"), t.path().join("broken")).unwrap();
        fs::write(t.path().join("a.txt"), "").unwrap();
        let out = list_dir(s(t.path())).unwrap();
        let names: Vec<(&str, bool)> = out.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
        // The link sorts with the folders; the broken link doesn't crash and shows as a file.
        assert_eq!(names, [("link", true), ("real", true), ("a.txt", false), ("broken", false)]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_files_follows_symlinked_dirs_without_looping() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("real/sub")).unwrap();
        fs::write(r.join("real/sub/x.txt"), "").unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("o.txt"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), r.join("ext")).unwrap();
        // Loops: a link to the root and a link to its own parent.
        std::os::unix::fs::symlink(r, r.join("real/sub/up")).unwrap();
        std::os::unix::fs::symlink(r.join("real"), r.join("real/self")).unwrap();
        std::os::unix::fs::symlink(r.join("missing"), r.join("broken")).unwrap();
        let out = list_files(s(r)).await.unwrap();
        assert_eq!(out, ["ext/o.txt", "real/sub/x.txt"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_files_includes_symlinked_files() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::write(r.join("a.txt"), "").unwrap();
        std::os::unix::fs::symlink(r.join("a.txt"), r.join("b.txt")).unwrap();
        assert_eq!(list_files(s(r)).await.unwrap(), ["a.txt", "b.txt"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_files_mutual_sibling_links_list_each_file_once() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("a")).unwrap();
        fs::create_dir_all(r.join("b")).unwrap();
        fs::write(r.join("a/x.txt"), "").unwrap();
        fs::write(r.join("b/y.txt"), "").unwrap();
        std::os::unix::fs::symlink(r.join("b"), r.join("a/l")).unwrap();
        std::os::unix::fs::symlink(r.join("a"), r.join("b/l")).unwrap();
        // Real paths win over the links.
        assert_eq!(list_files(s(r)).await.unwrap(), ["a/x.txt", "b/y.txt"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_files_link_and_target_give_each_file_once_deterministically() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("real/sub")).unwrap();
        fs::write(r.join("real/a.txt"), "").unwrap();
        fs::write(r.join("real/sub/b.txt"), "").unwrap();
        std::os::unix::fs::symlink(r.join("real"), r.join("link")).unwrap();
        let first = list_files(s(r)).await.unwrap();
        // The real path wins even though "link" sorts first.
        assert_eq!(first, ["real/a.txt", "real/sub/b.txt"]);
        for _ in 0..5 {
            assert_eq!(list_files(s(r)).await.unwrap(), first);
        }
    }

    #[test]
    fn rename_path_moves_and_refuses_existing_target() {
        let t = tempfile::tempdir().unwrap();
        let (a, b, c) = (t.path().join("a"), t.path().join("b"), t.path().join("c"));
        fs::write(&a, "A").unwrap();
        fs::write(&b, "B").unwrap();
        let e = rename_path(s(&a), s(&b)).unwrap_err();
        assert_eq!(e, "fs:exists");
        assert_eq!(fs::read_to_string(&a).unwrap(), "A");
        assert_eq!(fs::read_to_string(&b).unwrap(), "B");
        rename_path(s(&a), s(&c)).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(&c).unwrap(), "A");
    }

    #[test]
    fn delete_path_file_and_dir_tree() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("f.txt");
        fs::write(&f, "x").unwrap();
        delete_path(s(&f)).unwrap();
        assert!(!f.exists());
        let d = t.path().join("d");
        fs::create_dir_all(d.join("x/y")).unwrap();
        fs::write(d.join("x/y/z.txt"), "z").unwrap();
        fs::write(d.join("top.txt"), "t").unwrap();
        delete_path(s(&d)).unwrap();
        assert!(!d.exists());
        assert!(delete_path(s(&d)).is_err());
    }

    #[test]
    fn write_file_base64_decodes_and_rejects_bad_input() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("sub/img.bin");
        write_file_base64(s(&f), "AAEC/w==".into()).unwrap();
        assert_eq!(fs::read(&f).unwrap(), [0u8, 1, 2, 255]);
        let bad = t.path().join("bad/x.bin");
        assert!(write_file_base64(s(&bad), "not base64!!".into()).is_err());
        assert!(!bad.exists());
        assert!(!t.path().join("bad").exists(), "no parent dir created on decode error");
    }

    #[tokio::test]
    async fn list_files_skips_dot_dirs_keeps_github_sorted_relative() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        for d in ["src/nested", ".github/workflows", ".git", ".vscode", "node_modules/pkg", "target/debug", "build"] {
            fs::create_dir_all(r.join(d)).unwrap();
        }
        for f in [
            "z.txt",
            "a.txt",
            ".env",
            "src/main.rs",
            "src/nested/deep.rs",
            ".github/workflows/ci.yml",
            ".git/HEAD",
            ".vscode/settings.json",
            "node_modules/pkg/index.js",
            "target/debug/omega",
            "build/out.o",
        ] {
            fs::write(r.join(f), "").unwrap();
        }
        let out = list_files(s(r)).await.unwrap();
        assert_eq!(out, [".env", ".github/workflows/ci.yml", "a.txt", "src/main.rs", "src/nested/deep.rs", "z.txt"]);
    }

    #[test]
    fn collect_files_sorts_when_capped() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("a")).unwrap();
        // The walk lists the files of a folder before its subfolders, so an unsorted result is
        // ["b.txt", "a/z.txt"].
        for f in ["b.txt", "a/z.txt"] {
            fs::write(r.join(f), "").unwrap();
        }
        assert_eq!(collect_files(&s(r), 2), ["a/z.txt", "b.txt"]);
    }

    #[test]
    fn file_errors_are_codes() {
        let t = tempfile::tempdir().unwrap();
        let bin = t.path().join("data.bin");
        fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_file(s(&bin)).unwrap_err(), "fs:not_utf8");
        assert_eq!(read_file(s(&t.path().join("nope"))).unwrap_err(), "fs:not_found");
        assert_eq!(read_file(s(t.path())).unwrap_err(), "fs:is_dir");
        assert_eq!(create_file(s(&bin)).unwrap_err(), "fs:exists");
        #[cfg(unix)]
        {
            let link = t.path().join("broken-link");
            std::os::unix::fs::symlink(t.path().join("gone"), &link).unwrap();
            assert_eq!(create_file(s(&link)).unwrap_err(), "fs:exists");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rename_path_refuses_dangling_symlink_target() {
        let t = tempfile::tempdir().unwrap();
        let (a, link) = (t.path().join("a"), t.path().join("broken-link"));
        fs::write(&a, "A").unwrap();
        std::os::unix::fs::symlink(t.path().join("gone"), &link).unwrap();
        assert_eq!(rename_path(s(&a), s(&link)).unwrap_err(), "fs:exists");
        assert_eq!(fs::read_to_string(&a).unwrap(), "A");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn new_entries_through_a_link_out_of_the_project_are_refused() {
        let t = tempfile::tempdir().unwrap();
        let (root, outside) = (t.path().join("proj"), t.path().join("outside"));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("ext")).unwrap();
        let err = Err("fs:outside_project".to_string());
        assert_eq!(check_new_entry_in(&root, &root.join("ext/x")), err);
        assert_eq!(check_new_entry_in(&root, &root.join("ext/new/deeper/x")), err);
        assert_eq!(check_new_entry_in(&root, &root.join("sub/../../outside/x")), err);
        assert_eq!(check_new_entry_in(&root, &root.join("sub/x")), Ok(()));
        assert_eq!(check_new_entry_in(&root, &root.join("new/deeper/x")), Ok(()));
        // Explicit paths outside the project (Save As elsewhere) stay allowed.
        assert_eq!(check_new_entry_in(&root, &outside.join("x")), Ok(()));

        // Through the commands, with the project root set like watch_dir does.
        *ROOT.lock().unwrap() = Some(root.clone());
        assert_eq!(create_file(s(&root.join("ext/x"))), err);
        assert_eq!(create_dir(s(&root.join("ext/d"))), err);
        fs::write(root.join("a.txt"), "A").unwrap();
        assert_eq!(rename_path(s(&root.join("a.txt")), s(&root.join("ext/a.txt"))), err);
        assert!(!outside.join("x").exists() && !outside.join("d").exists() && !outside.join("a.txt").exists());
        create_file(s(&root.join("sub/ok.txt"))).unwrap();
        // Saving an existing file through the link stays allowed.
        fs::write(outside.join("linked.txt"), "old").unwrap();
        write_file(s(&root.join("ext/linked.txt")), "new".into()).unwrap();
        assert_eq!(fs::read_to_string(outside.join("linked.txt")).unwrap(), "new");
        *ROOT.lock().unwrap() = None;
    }
}
