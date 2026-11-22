//! The Java language server: a pinned jdtls release and the Java it runs on.
//!
//! jdtls snapshots raise their required Java without notice, so Omega installs one known-good
//! milestone, verified by its published checksum.

use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const VERSION: &str = "1.63.0";
const BUILD: &str = "202610191322";
const SHA256: &str = "b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4";
/// The Java this jdtls needs (`osgi.ee` of its JDT bundles), and the JDK Omega installs.
pub const MIN_JAVA: u32 = 25;

fn url() -> String {
    format!("https://download.eclipse.org/jdtls/milestones/{VERSION}/jdt-language-server-{VERSION}-{BUILD}.tar.gz")
}

/// Feature version from `java -version` output ("27", "25.0.5.1", legacy "1.8.0_402" → 8).
/// Only the quoted version counts: JAVA_TOOL_OPTIONS is echoed first and may contain digits.
fn java_major(text: &str) -> Option<u32> {
    let caps = regex::Regex::new(r#"version "(\d+)(?:\.(\d+))?"#).unwrap().captures(text)?;
    let first: u32 = caps[1].parse().ok()?;
    if first == 1 { caps.get(2)?.as_str().parse().ok() } else { Some(first) }
}

fn java_version(exe: &Path) -> Option<u32> {
    let out = crate::env::command(exe).arg("-version").stdin(std::process::Stdio::null()).output().ok()?;
    java_major(&format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout)))
}

/// The first Java new enough for jdtls, and the newest version seen (for the "too old" message).
fn choose(candidates: impl IntoIterator<Item = (PathBuf, Option<u32>)>) -> (Option<PathBuf>, Option<u32>) {
    let mut newest = None;
    for (exe, version) in candidates {
        if version.is_some_and(|v| v >= MIN_JAVA) {
            return (Some(exe), version);
        }
        newest = newest.max(version);
    }
    (None, newest)
}

/// The `java` on PATH if it is new enough, otherwise Omega's own JDK.
fn find_java() -> (Option<PathBuf>, Option<u32>) {
    let managed = crate::tools::manifest().get("jdk").and_then(|bin| crate::env::which(&crate::env::norm(Path::new(bin).join("java"))));
    let mut seen: Vec<PathBuf> = Vec::new();
    for exe in crate::env::which("java").into_iter().chain(managed) {
        if !seen.contains(&exe) {
            seen.push(exe);
        }
    }
    choose(seen.into_iter().map(|exe| {
        let v = java_version(&exe);
        (exe, v)
    }))
}

fn installed(target: &Path) -> Option<String> {
    let names = std::fs::read_dir(target.join("plugins")).ok()?;
    names.flatten().find_map(|e| e.file_name().to_string_lossy().strip_prefix("org.eclipse.jdt.ls.core_").and_then(crate::installs::extract_version))
}

#[derive(serde::Serialize)]
pub struct Runtime {
    /// The Java to start jdtls with; none is new enough if absent.
    java: Option<String>,
    /// Newest Java found.
    found: Option<u32>,
    required: u32,
    /// Omega's jdtls is the pinned release.
    current: bool,
}

#[tauri::command]
pub async fn jdtls_runtime() -> Result<Runtime, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (java, found) = find_java();
        Runtime { java: java.map(crate::env::norm), found, required: MIN_JAVA, current: installed(&crate::env::tools_dir().join("jdtls")).as_deref() == Some(VERSION) }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Installs the pinned jdtls, and Omega's JDK if no Java here can run it.
pub fn install(app: &AppHandle, dir: &Path) -> Result<String, String> {
    if find_java().0.is_none() {
        crate::tools::tool_install_blocking(app, "jdk")?;
    }
    let target = dir.join("jdtls");
    let before = installed(&target);
    if before.as_deref() == Some(VERSION) {
        return Ok(crate::env::norm(target));
    }
    let archive = dir.join(".jdtls.tar.gz");
    let r = crate::tools::download(app, "jdtls", &url(), &archive).and_then(|_| {
        if crate::tools::sha256_hex(&archive)? != SHA256 {
            return Err("tools:download_aborted:jdtls checksum mismatch".to_string());
        }
        let _ = std::fs::remove_dir_all(&target);
        crate::tools::unpack(&archive, "jdtls.tar.gz", &target, "")
    });
    let _ = std::fs::remove_file(&archive);
    r?;
    // Eclipse doesn't support opening its metadata with another version; both are rebuilt.
    if before.is_some() {
        let _ = std::fs::remove_dir_all(dir.join("jdtls-config"));
        let _ = std::fs::remove_dir_all(dir.join("jdtls-workspace"));
    }
    Ok(crate::env::norm(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_quoted_java_version_only() {
        assert_eq!(java_major("Picked up JAVA_TOOL_OPTIONS: -Duser.home=/tmp/9.9\nopenjdk version \"27\" 2026-09-15"), Some(27));
        assert_eq!(java_major("openjdk version \"25.0.5.1\" 2026-11-17 LTS"), Some(25));
        assert_eq!(java_major("java version \"1.8.0_402\""), Some(8));
        assert_eq!(java_major("no java here 25"), None);
    }

    #[test]
    fn path_java_is_used_only_when_new_enough() {
        let (path, managed) = (PathBuf::from("/usr/bin/java"), PathBuf::from("/tools/jdk/bin/java"));
        assert_eq!(choose([(path.clone(), Some(27)), (managed.clone(), Some(25))]).0, Some(path.clone()));
        assert_eq!(choose([(path.clone(), Some(21)), (managed.clone(), Some(25))]).0, Some(managed.clone()));
        assert_eq!(choose([(path, Some(17)), (managed, Some(21))]), (None, Some(21)));
    }

    #[test]
    fn the_pin_is_a_fixed_release() {
        assert!(url().contains("/milestones/1.63.0/") && !url().contains("latest"));
        assert_eq!(SHA256.len(), 64);
    }
}
