//! Files on the macOS pasteboard: one item with a file URL per file, as Finder's "Copy" writes them.
//! No Tauri types, so it can be checked on its own.

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypeString, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSString, NSURL};

/// Paths of the files on the pasteboard. Finder often writes file reference URLs
/// ("file:///.file/id=…"); NSURL turns them into real paths.
pub fn read_files() -> Vec<String> {
    let pb = NSPasteboard::generalPasteboard();
    let Some(items) = pb.pasteboardItems() else { return Vec::new() };
    items
        .iter()
        .filter_map(|item| {
            let s = item.stringForType(unsafe { NSPasteboardTypeFileURL })?;
            let url = NSURL::URLWithString(&s)?;
            let path = url.filePathURL()?.path()?;
            Some(path.to_string())
        })
        .collect()
}

/// Puts `paths` on the pasteboard as files (Finder pastes them as a copy); the first item also
/// carries all paths as text.
pub fn write_files(paths: &[String]) -> bool {
    let pb = NSPasteboard::generalPasteboard();
    let text = NSString::from_str(&paths.join("\n"));
    let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        let Some(uri) = NSURL::fileURLWithPath(&NSString::from_str(p)).absoluteString() else { continue };
        let item = NSPasteboardItem::new();
        item.setString_forType(&uri, unsafe { NSPasteboardTypeFileURL });
        if i == 0 {
            item.setString_forType(&text, unsafe { NSPasteboardTypeString });
        }
        items.push(ProtocolObject::from_retained(item));
    }
    pb.clearContents();
    pb.writeObjects(&NSArray::from_retained_slice(&items))
}
