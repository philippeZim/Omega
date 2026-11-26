//! Files on the Windows clipboard: CF_HDROP, the format Explorer's "Copy" uses.
//! Plain Win32, no Tauri types, so it can be checked on its own.

use std::ffi::c_void;
use windows_sys::Win32::Foundation::{GlobalFree, POINT};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
use windows_sys::Win32::UI::Shell::{DragQueryFileW, DROPFILES};

/// Opens the clipboard, retrying briefly: another program may hold it for a moment.
fn open(owner: *mut c_void) -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(owner) } != 0 {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Paths of the files on the clipboard (as Windows writes them, with backslashes).
pub fn read_files() -> Vec<String> {
    if !open(std::ptr::null_mut()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    unsafe {
        let drop = GetClipboardData(CF_HDROP as u32);
        if !drop.is_null() {
            let n = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
            for i in 0..n {
                let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0);
                let mut buf = vec![0u16; len as usize + 1];
                let got = DragQueryFileW(drop, i, buf.as_mut_ptr(), len + 1);
                out.push(String::from_utf16_lossy(&buf[..got as usize]));
            }
        }
        CloseClipboard();
    }
    out
}

/// Copies `bytes` into a movable global memory block for SetClipboardData.
unsafe fn global(bytes: &[u8]) -> *mut c_void {
    let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
    if h.is_null() {
        return h;
    }
    let p = GlobalLock(h) as *mut u8;
    if p.is_null() {
        GlobalFree(h);
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
    GlobalUnlock(h);
    h
}

/// Hands `bytes` to the clipboard in `format`; the clipboard owns the memory afterwards.
unsafe fn put(format: u32, bytes: &[u8]) -> bool {
    let h = global(bytes);
    if h.is_null() {
        return false;
    }
    if SetClipboardData(format, h).is_null() {
        GlobalFree(h);
        return false;
    }
    true
}

/// The CF_HDROP block: a DROPFILES header, then the paths as NUL-terminated UTF-16, then one more NUL.
pub fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    let header = DROPFILES { pFiles: std::mem::size_of::<DROPFILES>() as u32, pt: POINT { x: 0, y: 0 }, fNC: 0, fWide: 1 };
    let mut bytes = unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, std::mem::size_of::<DROPFILES>()) }.to_vec();
    for p in paths {
        for u in wide(&p.replace('/', "\\")) {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

/// Puts `paths` on the clipboard as files Explorer pastes as a copy, plus the paths as text.
/// `owner` is the window handle that owns the clipboard content.
pub fn write_files(owner: *mut c_void, paths: &[String]) -> bool {
    if !open(owner) {
        return false;
    }
    unsafe {
        EmptyClipboard();
        let ok = put(CF_HDROP as u32, &hdrop_bytes(paths));
        // "Preferred DropEffect" = DROPEFFECT_COPY: Explorer copies instead of moving.
        let effect = RegisterClipboardFormatW(wide("Preferred DropEffect").as_ptr());
        if effect != 0 {
            put(effect, &1u32.to_le_bytes());
        }
        let text: Vec<u8> = wide(&paths.iter().map(|p| p.replace('/', "\\")).collect::<Vec<_>>().join("\r\n")).iter().flat_map(|u| u.to_le_bytes()).collect();
        put(CF_UNICODETEXT as u32, &text);
        CloseClipboard();
        ok
    }
}
