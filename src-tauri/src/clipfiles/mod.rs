//! Files on the system clipboard (#299): a file manager's "Copy" puts the files there, the
//! explorer pastes them; the explorer's own "Copy" offers its files the same way, so they paste
//! into a file manager too. Linux through GTK (a URI list), Windows (CF_HDROP) and macOS (file
//! URLs on the pasteboard) in their own files.

#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
mod macos;

/// `file://` URIs → local paths. Other schemes (trash:, sftp: …) are left out.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn uris_to_paths(uris: &[String]) -> Vec<String> {
    uris.iter()
        .filter_map(|u| {
            let rest = u.trim().strip_prefix("file://")?;
            // file://host/path: only the local host (empty or "localhost") is a local file.
            let path = rest.strip_prefix("localhost").unwrap_or(rest);
            path.starts_with('/').then(|| percent_decode(path))
        })
        .collect()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A local path → `file://` URI, escaping everything but unreserved characters and "/".
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn path_to_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for &c in path.as_bytes() {
        if c.is_ascii_alphanumeric() || b"/-_.~".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// Local files on the clipboard (empty when there are none).
#[tauri::command]
pub async fn clipboard_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        // GTK clipboard calls must run on the main thread.
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let uris: Vec<String> = clip.wait_for_uris().into_iter().map(|u| u.to_string()).collect();
            let _ = tx.send(uris);
        })
        .map_err(|e| e.to_string())?;
        let uris = rx.await.map_err(|e| e.to_string())?;
        Ok(uris_to_paths(&uris))
    }
    #[cfg(windows)]
    {
        let _ = app;
        let paths = tauri::async_runtime::spawn_blocking(windows::read_files).await.map_err(|e| e.to_string())?;
        Ok(paths.iter().map(crate::env::norm).collect())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(macos::read_files).await.map_err(|e| e.to_string())
    }
}

/// Puts `paths` on the clipboard as files ("Copy" in the explorer).
#[tauri::command]
pub async fn clipboard_set_files(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                use gtk::TargetEntry;
                let uris: Vec<String> = paths.iter().map(|p| path_to_uri(p)).collect();
                let text = paths.join("\n");
                // Nautilus pastes x-special/gnome-copied-files, most others text/uri-list; text/plain
                // gives the paths to text fields.
                let gnome = format!("copy\n{}", uris.join("\n"));
                let targets = [
                    TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 0),
                    TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 1),
                    TargetEntry::new("UTF8_STRING", gtk::TargetFlags::empty(), 2),
                    TargetEntry::new("text/plain", gtk::TargetFlags::empty(), 2),
                ];
                let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
                let ok = clip.set_with_data(&targets, move |_, sel, info| match info {
                    0 => sel.set(&sel.target(), 8, gnome.as_bytes()),
                    1 => {
                        let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                        sel.set_uris(&refs);
                    }
                    _ => {
                        sel.set_text(&text);
                    }
                });
                if ok {
                    clip.store();
                }
                let _ = tx.send(ok);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // The window owns the clipboard content; the handle is passed on as a number (HWND isn't Send).
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || windows::write_files(hwnd as *mut std::ffi::c_void, &paths))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        tauri::async_runtime::spawn_blocking(move || macos::write_files(&paths)).await.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_become_paths() {
        let uris = vec![
            "file:///home/a/b%20c.png".to_string(),
            "file://localhost/tmp/x".to_string(),
            "trash:///gone".to_string(),
            "file:///h/%C3%A4.txt\r".to_string(),
        ];
        assert_eq!(uris_to_paths(&uris), vec!["/home/a/b c.png", "/tmp/x", "/h/ä.txt"]);
    }

    #[test]
    fn paths_round_trip_through_uris() {
        for p in ["/home/a/b c.png", "/h/ä #1%.txt", "/plain/name.md"] {
            assert_eq!(uris_to_paths(&[path_to_uri(p)]), vec![p.to_string()]);
        }
    }
}
