//! The `asset://` protocol (`convertFileSrc`): Markdown images, LaTeX PDFs and dropped screenshots
//! reach the webview through it (#167). Tauri's own handler checks one scope for the whole app, so
//! Omega serves it itself and decides per window:
//!  - files inside the window's open folder (their real path, after symlinks),
//!  - Omega's LaTeX build output,
//!  - anywhere else only files whose content is an image, so a Markdown image from outside the
//!    project keeps working while `~/.ssh/id_rsa` or a config with tokens can't be read.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::http::{header::*, Method, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

/// Most bytes one range answer carries (as Tauri's handler).
const MAX_RANGE: u64 = 1000 * 1024;
/// How much of a file outside the allowed folders is read to tell whether it's an image.
const SNIFF: u64 = 1024 * 1024 + 1;

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let origin = app.get_webview_window(&label).map(|w| origin_of(&w.url().ok())).unwrap_or_else(|| "null".into());
        let cache = app.path().app_cache_dir().ok().map(|d| d.join("latex"));
        let root = crate::fs::root_of(&label);
        let Some(path) = request_path(request.uri().path()) else {
            return responder.respond(status(&origin, StatusCode::FORBIDDEN));
        };
        responder.respond(serve(&request, &path, &Allowed { root: root.as_deref(), cache: cache.as_deref() }, &origin));
    });
}

/// The page's origin, for `Access-Control-Allow-Origin` (pdf.js fetches, `<img crossorigin>`).
fn origin_of(url: &Option<tauri::Url>) -> String {
    match url {
        Some(u) if u.scheme() != "data" => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{}://{h}:{p}", u.scheme()),
            (Some(h), None) => format!("{}://{h}", u.scheme()),
            _ => "null".into(),
        },
        _ => "null".into(),
    }
}

/// `/%2Fhome%2Fme%2Fa.png` → `/home/me/a.png`. Only absolute paths without `..` count.
fn request_path(raw: &str) -> Option<PathBuf> {
    let raw = raw.strip_prefix('/').unwrap_or(raw);
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let path = PathBuf::from(String::from_utf8(out).ok()?);
    (path.is_absolute() && !path.components().any(|c| c == Component::ParentDir)).then_some(path)
}

struct Allowed<'a> {
    root: Option<&'a Path>,
    cache: Option<&'a Path>,
}

impl Allowed<'_> {
    /// Whether the real file lies in the open folder or the LaTeX output.
    fn holds(&self, real: &Path) -> bool {
        [self.root, self.cache].into_iter().flatten().filter_map(|d| d.canonicalize().ok()).any(|d| real.starts_with(d))
    }
}

fn status(origin: &str, code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header(ACCESS_CONTROL_ALLOW_ORIGIN, origin).body(Vec::new()).unwrap()
}

fn mime_of(path: &Path, head: &[u8]) -> &'static str {
    if let Some(m) = crate::latex_guest::sniff_image(head) {
        return m;
    }
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        _ if head.starts_with(b"%PDF-") => "application/pdf",
        Some("pdf") => "application/pdf",
        Some("ico") => "image/x-icon",
        Some("tif" | "tiff") => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn serve(request: &Request<Vec<u8>>, path: &Path, allowed: &Allowed, origin: &str) -> Response<Vec<u8>> {
    let Ok(real) = path.canonicalize() else { return status(origin, StatusCode::NOT_FOUND) };
    let Ok(mut file) = File::open(&real) else { return status(origin, StatusCode::NOT_FOUND) };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return status(origin, StatusCode::NOT_FOUND) };
    let mut head = Vec::new();
    if (&mut file).take(SNIFF).read_to_end(&mut head).is_err() {
        return status(origin, StatusCode::NOT_FOUND);
    }
    let image = crate::latex_guest::sniff_image(&head).is_some();
    if !image && !allowed.holds(&real) {
        return status(origin, StatusCode::FORBIDDEN);
    }
    let resp = Response::builder()
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(CONTENT_TYPE, mime_of(&real, &head))
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");

    let range = request.headers().get(RANGE).and_then(|r| r.to_str().ok());
    if let Some(range) = range {
        let Some((start, end)) = parse_range(range, len) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap();
        };
        let end = end.min(start + MAX_RANGE - 1);
        let mut buf = Vec::with_capacity((end + 1 - start) as usize);
        if file.seek(SeekFrom::Start(start)).is_err() || (&mut file).take(end + 1 - start).read_to_end(&mut buf).is_err() {
            return status(origin, StatusCode::NOT_FOUND);
        }
        return resp
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(CONTENT_LENGTH, buf.len())
            .body(buf)
            .unwrap();
    }
    if request.method() == Method::HEAD {
        return resp.header(CONTENT_LENGTH, len).body(Vec::new()).unwrap();
    }
    let mut buf = head;
    if buf.len() as u64 == SNIFF && file.read_to_end(&mut buf).is_err() {
        return status(origin, StatusCode::NOT_FOUND);
    }
    resp.header(CONTENT_LENGTH, buf.len()).body(buf).unwrap()
}

/// One byte range (`bytes=0-499`, `bytes=500-`, `bytes=-500`) as inclusive bounds. Several ranges
/// at once get only the first; nothing in Omega asks for more.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.checked_sub(n.min(len))?, len.checked_sub(1)?)
        }
        (s, "") => (s.parse().ok()?, len.checked_sub(1)?),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && end < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder().uri("asset://localhost/x");
        if let Some(r) = range {
            b = b.header(RANGE, r);
        }
        b.body(Vec::new()).unwrap()
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    #[test]
    fn request_path_decodes_and_refuses_relative_or_dotdot() {
        let enc = |p: &str| p.bytes().map(|b| format!("%{b:02X}")).collect::<String>();
        #[cfg(unix)]
        {
            assert_eq!(request_path(&format!("/{}", enc("/home/me/a b.png"))), Some(PathBuf::from("/home/me/a b.png")));
            assert_eq!(request_path(&format!("/{}", enc("/home/me/../.ssh/id_rsa"))), None);
        }
        #[cfg(windows)]
        assert_eq!(request_path(&format!("/{}", enc("C:\\Users\\me\\a.png"))), Some(PathBuf::from("C:\\Users\\me\\a.png")));
        assert_eq!(request_path("/a.png"), None);
        assert_eq!(request_path("/%2"), None);
        assert_eq!(request_path(""), None);
    }

    #[test]
    fn serves_the_project_and_the_cache_but_elsewhere_only_images() {
        let base = std::env::temp_dir().join(format!("omega-asset-{}", std::process::id()));
        let (project, cache, home) = (base.join("project"), base.join("cache"), base.join("home"));
        for d in [&project, &cache, &home.join(".ssh")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(project.join("notes.txt"), "hi").unwrap();
        std::fs::write(cache.join("out.pdf"), "%PDF-1.7").unwrap();
        std::fs::write(home.join(".ssh/id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        std::fs::write(home.join("key.png"), "not an image").unwrap();
        std::fs::write(home.join("shot.png"), PNG).unwrap();
        let allowed = Allowed { root: Some(&project), cache: Some(&cache) };
        let code = |p: PathBuf| serve(&req(None), &p, &allowed, "tauri://localhost").status();

        assert_eq!(code(project.join("notes.txt")), StatusCode::OK);
        assert_eq!(code(cache.join("out.pdf")), StatusCode::OK);
        assert_eq!(code(home.join("shot.png")), StatusCode::OK);
        assert_eq!(code(home.join(".ssh/id_rsa")), StatusCode::FORBIDDEN);
        assert_eq!(code(home.join("key.png")), StatusCode::FORBIDDEN);
        assert_eq!(code(project.join("missing.png")), StatusCode::NOT_FOUND);
        // Another window's folder (or none) doesn't open this one's.
        let none = Allowed { root: None, cache: Some(&cache) };
        assert_eq!(serve(&req(None), &project.join("notes.txt"), &none, "o").status(), StatusCode::FORBIDDEN);

        #[cfg(unix)]
        {
            // A link in the project: an image behind it shows, a secret behind it stays closed.
            std::os::unix::fs::symlink(home.join("shot.png"), project.join("shot.png")).unwrap();
            std::os::unix::fs::symlink(home.join(".ssh"), project.join("ssh")).unwrap();
            assert_eq!(code(project.join("shot.png")), StatusCode::OK);
            assert_eq!(code(project.join("ssh/id_rsa")), StatusCode::FORBIDDEN);
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn answers_carry_type_origin_and_ranges() {
        let dir = std::env::temp_dir().join(format!("omega-asset-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = dir.join("a.pdf");
        std::fs::write(&pdf, b"%PDF-0123456789").unwrap();
        let allowed = Allowed { root: Some(&dir), cache: None };

        let full = serve(&req(None), &pdf, &allowed, "tauri://localhost");
        assert_eq!(full.headers()[CONTENT_TYPE], "application/pdf");
        assert_eq!(full.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");
        assert_eq!(full.body(), b"%PDF-0123456789");

        let part = serve(&req(Some("bytes=5-7")), &pdf, &allowed, "o");
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[CONTENT_RANGE], "bytes 5-7/15");
        assert_eq!(part.body(), b"012");
        assert_eq!(serve(&req(Some("bytes=99-")), &pdf, &allowed, "o").status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parse_range_forms() {
        assert_eq!(parse_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-9, 20-29", 1000), Some((0, 9)));
        assert_eq!(parse_range("bytes=10-5", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-5", 1000), None);
    }

    #[test]
    fn origin_from_the_page_url() {
        let o = |s: &str| origin_of(&tauri::Url::parse(s).ok());
        assert_eq!(o("tauri://localhost/index.html"), "tauri://localhost");
        assert_eq!(o("http://tauri.localhost/"), "http://tauri.localhost");
        assert_eq!(o("http://localhost:1420/"), "http://localhost:1420");
        assert_eq!(o("data:text/html,x"), "null");
    }
}
