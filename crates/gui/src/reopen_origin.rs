//! macOS: identify which process initiated the current reopen Apple Event.
//!
//! tao dispatches `RunEvent::Reopen` **synchronously** inside AppKit's handling
//! of the `kAEReopenApplication` event (`applicationShouldHandleReopen:` →
//! `AppState::reopen` → user callback, no run-loop hop), so
//! `-[NSAppleEventManager currentAppleEvent]` still holds that event while we
//! run. Its `keySenderPIDAttr` ('spid', macOS 10.11+) names the sending
//! process:
//!
//! | gesture                         | sender bundle id            |
//! |---------------------------------|-----------------------------|
//! | Finder toolbar click            | `com.apple.finder`          |
//! | Dock icon click                 | `com.apple.dock`            |
//! | Spotlight / double-click / open | transient LaunchServices pid|
//!
//! Only a Finder-toolbar click should adopt the front Finder window as a
//! workspace; every other reactivation must be ignored. Reading the sender is
//! race-free (it's an attribute of the event we're handling), unlike polling
//! `NSWorkspace.frontmostApplication`, which is a point-in-time global that has
//! usually already flipped to us by the time we look.
#![cfg(target_os = "macos")]

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

// Carbon Apple Event Manager descriptor — { type, opaque handle }.
#[repr(C)]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

impl AEDesc {
    const fn null() -> Self {
        AEDesc {
            descriptor_type: 0,
            data_handle: std::ptr::null_mut(),
        }
    }
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn AEGetAttributeDesc(
        the_event: *const AEDesc,
        keyword: u32,
        desired_type: u32,
        out: *mut AEDesc,
    ) -> i16;
    // Carbon `Size` is `long` (64-bit on macOS); declaring it i32 makes
    // AEGetDescData read garbage for maximumSize and refuse to copy.
    fn AEGetDescData(desc: *const AEDesc, ptr: *mut c_void, max: isize) -> i16;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
}

const fn four_cc(b: &[u8; 4]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

/// True iff the reopen Apple Event currently being handled was sent by Finder
/// (i.e. a Finder-toolbar click), as opposed to the Dock, Spotlight, or `open`.
/// Conservative: returns false whenever the sender can't be positively
/// identified as Finder, so a mis-read never causes a spurious workspace add.
pub fn reopen_came_from_finder() -> bool {
    reopen_sender_bundle_id().as_deref() == Some("com.apple.finder")
}

/// Bundle id of the process that sent the reopen event currently being handled,
/// via `keySenderPIDAttr`. `None` if there is no current Apple Event or the
/// sender can't be resolved (e.g. a transient helper that has already exited).
fn reopen_sender_bundle_id() -> Option<String> {
    const KEY_SENDER_PID_ATTR: u32 = four_cc(b"spid");
    const TYPE_SINT32: u32 = four_cc(b"long");

    unsafe {
        let mgr: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        if mgr.is_null() {
            return None;
        }
        let event: *mut AnyObject = msg_send![mgr, currentAppleEvent];
        if event.is_null() {
            return None;
        }
        // const AEDesc * — borrowed; objc2 needs an Encode-able return type.
        let ae_raw: *mut c_void = msg_send![event, aeDesc];
        let ae = ae_raw as *const AEDesc;
        if ae.is_null() {
            return None;
        }

        let mut spid_desc = AEDesc::null();
        if AEGetAttributeDesc(ae, KEY_SENDER_PID_ATTR, TYPE_SINT32, &mut spid_desc) != 0 {
            return None;
        }
        let mut pid: i32 = -1;
        AEGetDescData(&spid_desc, &mut pid as *mut i32 as *mut c_void, 4);
        AEDisposeDesc(&mut spid_desc);
        if pid <= 0 {
            return None;
        }
        bundle_id_for_pid(pid)
    }
}

unsafe fn bundle_id_for_pid(pid: i32) -> Option<String> {
    let app: *mut AnyObject =
        msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
    if app.is_null() {
        return None;
    }
    let bid: *mut AnyObject = msg_send![app, bundleIdentifier];
    if bid.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![bid, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
}
