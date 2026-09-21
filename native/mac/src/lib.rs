#![cfg(target_os = "macos")]
//! Native macOS window control for magibar-launcher.
//!
//! Replaces the previous `osascript`/System Events shell-outs — every call there
//! forks a whole process and JIT-compiles an AppleScript, which is why a tight
//! timeout could (and did) spuriously fail under ordinary system load. This talks
//! directly to the same two frameworks osascript was driving indirectly:
//! CoreGraphics' window list (to find the frontmost app, no permission needed)
//! and the Accessibility API (`AXUIElement`) to read/move/fullscreen its focused
//! window (requires the same Accessibility consent the AppleScript path needed).
//!
//! No Objective-C runtime is used at all — `CGWindowListCopyWindowInfo` is a
//! plain C API that reports on-screen windows front-to-back by z-order, which is
//! enough to find "the frontmost real app window" without `NSWorkspace`.

mod dir_size;

use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use core_foundation_sys::mach_port::{
  CFMachPortCreateRunLoopSource, CFMachPortInvalidate, CFMachPortRef,
};
use core_foundation_sys::number::{
  kCFBooleanFalse, kCFBooleanTrue, kCFNumberSInt32Type, kCFNumberSInt64Type, CFBooleanGetValue,
  CFBooleanRef, CFNumberGetValue, CFNumberRef,
};
use core_foundation_sys::runloop::{
  kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRun,
  CFRunLoopStop,
};
use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::ffi::{c_void, CString};
use std::sync::{Mutex, OnceLock};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

// -- Accessibility (AXUIElement) — not covered by `core-foundation-sys`, so
// declared here directly against `ApplicationServices` (linked in `build.rs`). --

type AXUIElementRef = CFTypeRef;
type AXValueRef = CFTypeRef;
type AXError = i32;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
  fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
  fn AXUIElementCopyAttributeValue(
    element: AXUIElementRef,
    attribute: CFStringRef,
    value: *mut CFTypeRef,
  ) -> AXError;
  fn AXUIElementSetAttributeValue(
    element: AXUIElementRef,
    attribute: CFStringRef,
    value: CFTypeRef,
  ) -> AXError;
  fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> u8;
  fn AXValueCreate(the_type: u32, value_ptr: *const c_void) -> AXValueRef;
}

const K_AX_ERROR_SUCCESS: AXError = 0;
const K_AX_VALUE_TYPE_CG_POINT: u32 = 1;
const K_AX_VALUE_TYPE_CG_SIZE: u32 = 2;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
  fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
}

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;

#[repr(C)]
#[derive(Copy, Clone, Default)]
struct CgPoint {
  x: f64,
  y: f64,
}

#[repr(C)]
#[derive(Copy, Clone, Default)]
struct CgSize {
  width: f64,
  height: f64,
}

/// Builds a CFString from a Rust `&str`, content-compared (not pointer-identity)
/// against dictionary/attribute keys — this is how `CFDictionaryGetValue` and the
/// AX attribute-name arguments below are meant to be used, so there's no need to
/// link the framework's exported `kCGWindowOwnerPID`-style constant symbols.
unsafe fn cfstring(s: &str) -> CFStringRef {
  let c = CString::new(s).unwrap();
  unsafe { CFStringCreateWithCString(kCFAllocatorDefault, c.as_ptr(), kCFStringEncodingUTF8) }
}

/// Reads a CFNumber as `i64` regardless of whether it's stored as 32- or 64-bit —
/// `CFNumberGetValue` converts for you as long as the requested width fits.
unsafe fn cfnumber_i64(number: CFNumberRef) -> Option<i64> {
  let mut out: i64 = 0;
  let ok = unsafe {
    CFNumberGetValue(number, kCFNumberSInt64Type, &mut out as *mut i64 as *mut c_void)
  };
  if ok {
    return Some(out);
  }
  // Some SDKs store small integers as SInt32; fall back rather than fail outright.
  let mut out32: i32 = 0;
  let ok32 = unsafe {
    CFNumberGetValue(number, kCFNumberSInt32Type, &mut out32 as *mut i32 as *mut c_void)
  };
  if ok32 {
    Some(out32 as i64)
  } else {
    None
  }
}

/// The pid of the frontmost real application window, or `0` if none is found
/// (e.g. every window is a desktop element, or the list is empty). `exclude` is
/// our own pid — the launcher itself can briefly be the frontmost window right as
/// it's shown/hidden, and capturing it would mean later commands snap our own
/// window instead of whatever the user was actually working in.
///
/// `CGWindowListCopyWindowInfo` needs no special permission and reports windows
/// front-to-back by on-screen stacking order, so the first entry whose layer is 0
/// (an ordinary app window — the Dock, menu bar, etc. use nonzero layers) and
/// whose owner isn't `exclude` is exactly "what the user was looking at."
#[napi]
pub fn frontmost_pid(exclude: i32) -> i32 {
  unsafe {
    let list = CGWindowListCopyWindowInfo(
      K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
      K_CG_NULL_WINDOW_ID,
    );
    if list.is_null() {
      return 0;
    }

    let layer_key = cfstring("kCGWindowLayer");
    let pid_key = cfstring("kCGWindowOwnerPID");

    let count = CFArrayGetCount(list);
    let mut found = 0i32;
    for i in 0..count {
      let entry = CFArrayGetValueAtIndex(list, i) as CFDictionaryRef;
      if entry.is_null() {
        continue;
      }

      let layer_value = CFDictionaryGetValue(entry, layer_key as *const c_void) as CFNumberRef;
      let layer = if layer_value.is_null() {
        None
      } else {
        cfnumber_i64(layer_value)
      };
      if layer != Some(0) {
        continue;
      }

      let pid_value = CFDictionaryGetValue(entry, pid_key as *const c_void) as CFNumberRef;
      if pid_value.is_null() {
        continue;
      }
      let Some(pid) = cfnumber_i64(pid_value) else {
        continue;
      };
      let pid = pid as i32;
      if pid != 0 && pid != exclude {
        found = pid;
        break;
      }
    }

    CFRelease(layer_key as CFTypeRef);
    CFRelease(pid_key as CFTypeRef);
    CFRelease(list as CFTypeRef);
    found
  }
}

/// The application's focused window, or `null` (`AXError`) if it has none, the
/// pid is invalid, or Accessibility access hasn't been granted. Caller must
/// `CFRelease` the returned element.
unsafe fn focused_window(pid: i32) -> Option<AXUIElementRef> {
  unsafe {
    let app = AXUIElementCreateApplication(pid);
    if app.is_null() {
      return None;
    }
    let attr = cfstring("AXFocusedWindow");
    let mut window: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(app, attr, &mut window as *mut CFTypeRef);
    CFRelease(attr as CFTypeRef);
    CFRelease(app);
    if err == K_AX_ERROR_SUCCESS && !window.is_null() {
      Some(window)
    } else {
      None
    }
  }
}

#[napi(object)]
pub struct MacRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// The focused window's current position and size, or `null` if unavailable
/// (no focused window, invalid pid, or Accessibility access not granted).
#[napi]
pub fn get_window_rect(pid: i32) -> Option<MacRect> {
  unsafe {
    let window = focused_window(pid)?;

    let pos_attr = cfstring("AXPosition");
    let size_attr = cfstring("AXSize");

    let mut pos_value: CFTypeRef = std::ptr::null();
    let pos_err = AXUIElementCopyAttributeValue(window, pos_attr, &mut pos_value as *mut CFTypeRef);
    let mut size_value: CFTypeRef = std::ptr::null();
    let size_err =
      AXUIElementCopyAttributeValue(window, size_attr, &mut size_value as *mut CFTypeRef);
    CFRelease(pos_attr as CFTypeRef);
    CFRelease(size_attr as CFTypeRef);

    let result = if pos_err == K_AX_ERROR_SUCCESS
      && size_err == K_AX_ERROR_SUCCESS
      && !pos_value.is_null()
      && !size_value.is_null()
    {
      let mut point = CgPoint::default();
      let mut size = CgSize::default();
      let got_point = AXValueGetValue(
        pos_value,
        K_AX_VALUE_TYPE_CG_POINT,
        &mut point as *mut CgPoint as *mut c_void,
      );
      let got_size = AXValueGetValue(
        size_value,
        K_AX_VALUE_TYPE_CG_SIZE,
        &mut size as *mut CgSize as *mut c_void,
      );
      if got_point != 0 && got_size != 0 {
        Some(MacRect {
          x: point.x,
          y: point.y,
          width: size.width,
          height: size.height,
        })
      } else {
        None
      }
    } else {
      None
    };

    if !pos_value.is_null() {
      CFRelease(pos_value);
    }
    if !size_value.is_null() {
      CFRelease(size_value);
    }
    CFRelease(window);
    result
  }
}

/// Moves and resizes the focused window to `rect`. Sets size, then position, then
/// size again — some apps clamp or reflow their frame when it lands near a screen
/// edge, and re-asserting the size after the move is what makes the final result
/// stick (same workaround the AppleScript version used). Returns whether both
/// attributes were written successfully.
#[napi]
pub fn apply_window_rect(pid: i32, rect: MacRect) -> bool {
  unsafe {
    let Some(window) = focused_window(pid) else {
      return false;
    };

    let pos_attr = cfstring("AXPosition");
    let size_attr = cfstring("AXSize");

    let point = CgPoint { x: rect.x, y: rect.y };
    let size = CgSize {
      width: rect.width,
      height: rect.height,
    };

    let size_value = AXValueCreate(K_AX_VALUE_TYPE_CG_SIZE, &size as *const CgSize as *const c_void);
    let pos_value = AXValueCreate(K_AX_VALUE_TYPE_CG_POINT, &point as *const CgPoint as *const c_void);

    let mut ok = true;
    if !size_value.is_null() {
      ok &= AXUIElementSetAttributeValue(window, size_attr, size_value) == K_AX_ERROR_SUCCESS;
    } else {
      ok = false;
    }
    if !pos_value.is_null() {
      ok &= AXUIElementSetAttributeValue(window, pos_attr, pos_value) == K_AX_ERROR_SUCCESS;
    } else {
      ok = false;
    }
    if !size_value.is_null() {
      ok &= AXUIElementSetAttributeValue(window, size_attr, size_value) == K_AX_ERROR_SUCCESS;
    }

    if !size_value.is_null() {
      CFRelease(size_value);
    }
    if !pos_value.is_null() {
      CFRelease(pos_value);
    }
    CFRelease(pos_attr as CFTypeRef);
    CFRelease(size_attr as CFTypeRef);
    CFRelease(window);
    ok
  }
}

/// Whether the focused window is currently in native macOS fullscreen (its own
/// Space). `false` for anything that can't be determined (no focused window,
/// permission not granted, or the window doesn't support this attribute at all —
/// `AXFullScreen` isn't part of the standard Accessibility attribute set, so a
/// missing-attribute error here just means "this app doesn't offer fullscreen,"
/// not a real failure).
#[napi]
pub fn is_fullscreen(pid: i32) -> bool {
  unsafe {
    let Some(window) = focused_window(pid) else {
      return false;
    };
    let attr = cfstring("AXFullScreen");
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(window, attr, &mut value as *mut CFTypeRef);
    CFRelease(attr as CFTypeRef);

    let result = if err == K_AX_ERROR_SUCCESS && !value.is_null() {
      CFBooleanGetValue(value as CFBooleanRef)
    } else {
      false
    };
    if !value.is_null() {
      CFRelease(value);
    }
    CFRelease(window);
    result
  }
}

// -- NSPasteboard (AppKit) — Objective-C only, no Core Foundation or plain-C
// equivalent exists for this, so unlike everything above this talks to the
// Objective-C runtime directly (`objc_msgSend`) rather than a framework's C
// API. Kept to this one scalar property read rather than pulling in a
// bridging crate for it. --

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
  fn objc_getClass(name: *const std::ffi::c_char) -> *mut c_void;
  fn sel_registerName(name: *const std::ffi::c_char) -> *mut c_void;
  fn objc_msgSend(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
}

// No AppKit C symbols are called directly — this block exists purely to force
// the framework to be linked (and so loaded into the process), which is what
// actually registers `NSPasteboard` with the Objective-C runtime.
// `objc_getClass` on an unlinked framework's class silently returns nil, and
// a message sent to nil silently returns 0 — the bug this caught: without
// this, `pasteboard_change_count()` compiled and ran fine, just always
// returned 0.
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

/// `NSPasteboard.generalPasteboard.changeCount` — a counter AppKit increments
/// every time the general pasteboard's *content* changes (a copy, a cut, or
/// any programmatic write), and never otherwise. macOS has no pasteboard
/// "changed" notification/event at all — every clipboard-history app,
/// Raycast included, is built around polling *something*; the point of this
/// export is to make that something cheap. Reading it costs nothing (no IPC,
/// no permission prompt, no clipboard format negotiation) — a poller can
/// check this very frequently and only pay for an actual Electron
/// `clipboard.read()` call on the rare tick where it's moved.
///
/// `generalPasteboard` is a process-wide singleton the caller doesn't own
/// (the selector isn't `alloc`/`new`/`copy`-prefixed), so it's never
/// released — same manual-reference-counting convention every other
/// Objective-C call in this codebase already assumes, just without a
/// bridging crate to enforce it for us here.
#[napi]
pub fn pasteboard_change_count() -> i64 {
  unsafe {
    let cls = objc_getClass(c"NSPasteboard".as_ptr());
    let general_sel = sel_registerName(c"generalPasteboard".as_ptr());
    let pasteboard = objc_msgSend(cls, general_sel);
    let change_count_sel = sel_registerName(c"changeCount".as_ptr());
    objc_msgSend(pasteboard, change_count_sel) as i64
  }
}

/// Toggles native macOS fullscreen on the focused window — the same effect as
/// clicking-and-holding the green traffic-light button and choosing "Enter/Exit
/// Full Screen." Not every window supports this; returns whether the write
/// succeeded.
#[napi]
pub fn toggle_fullscreen(pid: i32) -> bool {
  unsafe {
    let Some(window) = focused_window(pid) else {
      return false;
    };
    let current = is_fullscreen(pid);
    let attr = cfstring("AXFullScreen");

    // Every CFBoolean is one of exactly two process-wide singletons.
    let value = if current {
      kCFBooleanFalse as CFTypeRef
    } else {
      kCFBooleanTrue as CFTypeRef
    };
    let err = AXUIElementSetAttributeValue(window, attr, value);
    CFRelease(attr as CFTypeRef);
    CFRelease(window);
    err == K_AX_ERROR_SUCCESS
  }
}

// -- Process listing / termination (Activity Monitor), via `sysinfo` --
// `sysinfo` wraps `libproc`/`sysctl` for us here rather than hand-rolling
// another unsafe FFI surface like the CoreGraphics/AX calls above — unlike
// those, there's no single well-known low-level API this needs to match, and
// a maintained cross-platform crate means the same call shape works
// unchanged in `native/win` and `native/linux` too.

/// One process's identity and live resource usage, as reported by the last
/// `list_processes()` refresh.
#[napi(object)]
pub struct NativeProcess {
  pub pid: i32,
  pub name: String,
  /// Percentage of a single CPU core (0–100 per core, so a busy multi-core
  /// process can exceed 100), matching Activity Monitor's own convention.
  pub cpu_usage: f64,
  pub memory_bytes: f64,
  /// Full path to the executable, when readable — lets the TS side resolve
  /// an app icon (walking up to the enclosing `.app` bundle on macOS, since
  /// the raw Mach-O binary carries no icon of its own). `None` for a process
  /// whose executable path isn't readable (permission-restricted, or exited
  /// between the refresh and this read).
  pub path: Option<String>,
}

/// A process-wide `System`, reused across every `list_processes()`/
/// `kill_process()` call rather than recreated per call. `sysinfo`'s CPU
/// percentages are a delta against the *previous* refresh of the same
/// instance — a fresh `System` every call would always report ~0% on its
/// first (and only) read.
fn system() -> &'static Mutex<System> {
  static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
  SYSTEM.get_or_init(|| Mutex::new(System::new()))
}

/// A snapshot of every currently running process's pid, name, CPU% and
/// resident memory. Cheap to call on a poll interval (a couple of times a
/// second) — the underlying refresh only re-reads `/proc`-equivalent process
/// tables, no per-call allocation of a new `System`.
#[napi]
pub fn list_processes() -> Vec<NativeProcess> {
  let mut sys = system().lock().unwrap();
  sys.refresh_processes_specifics(
    ProcessesToUpdate::All,
    true,
    ProcessRefreshKind::everything(),
  );
  sys
    .processes()
    .values()
    .map(|process| NativeProcess {
      pid: process.pid().as_u32() as i32,
      name: process.name().to_string_lossy().into_owned(),
      cpu_usage: process.cpu_usage() as f64,
      memory_bytes: process.memory() as f64,
      path: process
        .exe()
        .map(|path| path.to_string_lossy().into_owned()),
    })
    .collect()
}

/// Terminates `pid` — `SIGTERM` (a graceful "Quit") when `force` is `false`,
/// `SIGKILL` ("Force Quit") when `true`. Returns `false` if the process no
/// longer exists or the OS denies permission (not owned by this user); the
/// caller can't tell those apart from the bool alone and doesn't need to —
/// both are surfaced as the same inline error.
#[napi]
pub fn kill_process(pid: i32, force: bool) -> bool {
  let mut sys = system().lock().unwrap();
  let target = Pid::from_u32(pid as u32);
  sys.refresh_processes_specifics(
    ProcessesToUpdate::Some(&[target]),
    true,
    ProcessRefreshKind::new(),
  );
  let Some(process) = sys.process(target) else {
    return false;
  };
  let signal = if force { Signal::Kill } else { Signal::Term };
  process.kill_with(signal).unwrap_or_else(|| process.kill())
}

/// One listening TCP socket and the process that owns it. Cheap enough (a few
/// ms) to fetch alongside `list_processes()` on every poll tick.
#[napi(object)]
pub struct NativePort {
  pub pid: i32,
  pub port: u32,
}

/// Every TCP port something is listening on, with the owning pid. Empty if the
/// OS refuses to enumerate (e.g. missing permission).
#[napi]
pub fn list_listening_ports() -> Vec<NativePort> {
  listeners::get_all()
    .map(|set| {
      set
        .into_iter()
        .map(|l| NativePort {
          pid: l.process.pid as i32,
          port: l.socket.port() as u32,
        })
        .collect()
    })
    .unwrap_or_default()
}

// -- Global hotkeys via a CGEventTap --
//
// Electron's `globalShortcut` (Carbon's `RegisterEventHotKey` under the hood)
// has two gaps `main/native/hotkeys.ts` needs closed, mirroring why
// `native/win` exists at all: it can't represent a modifier-only chord
// (`Shift+Command` with no other key — Raycast-style), and once some *other*
// app has already registered a combo, our own `register()` for the same
// combo never even reaches this process, so a shortcut recorder can't
// observe the keystroke at all — it just watches the other app's action
// fire. A session-level `CGEventTap` installed with `kCGHeadInsertEventTap`
// sees every keystroke system-wide *before* Carbon's hotkey dispatch (the
// same mechanism apps like Karabiner-Elements/BetterTouchTool rely on to
// override "reserved" shortcuts), so it can both detect and — by returning
// `NULL` instead of the event — suppress what `globalShortcut` can't reach.
//
// Needs the "Input Monitoring" privacy permission (System Settings > Privacy
// & Security > Input Monitoring) — separate from the Accessibility grant
// `AccessibilityRow` already requests for window snapping. There's no public
// API to prompt for it the way `AXIsProcessTrustedWithOptions` can for
// Accessibility; `CGEventTapCreate` below just returns `NULL` until the user
// grants it manually and relaunches, same failure shape `@magibar/win`
// failing to `require()` gets on the TS side (`hotkeys.ts` falls back to the
// `globalShortcut` engine).

type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
  fn CGEventTapCreate(
    tap: u32,
    place: u32,
    options: u32,
    events_of_interest: u64,
    callback: extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef,
    user_info: *mut c_void,
  ) -> CFMachPortRef;
  fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
  fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
  fn CGEventGetFlags(event: CGEventRef) -> u64;
}

const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;

const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_EVENT_KEY_UP: u32 = 11;
const K_CG_EVENT_FLAGS_CHANGED: u32 = 12;
// `CGEventType`'s two "the OS gave up on us" values — sent instead of a real
// event when this callback (or another tap ahead of it) is judged too slow.
// Our callback body never blocks, so this should only ever be transient;
// re-enabling immediately is the documented recovery.
const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;

const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

const FLAG_SHIFT: u64 = 0x0002_0000; // kCGEventFlagMaskShift
const FLAG_CONTROL: u64 = 0x0004_0000; // kCGEventFlagMaskControl
const FLAG_OPTION: u64 = 0x0008_0000; // kCGEventFlagMaskAlternate
const FLAG_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
const RELEVANT_FLAGS: u64 = FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND;

/// A held-modifier set, masked from `CGEventGetFlags` — unlike
/// `native/win`'s `Modifiers`, this never needs to track which physical side
/// (left/right) was pressed: `format_accelerator`/`eventToAccelerator` don't
/// distinguish sides on mac, and `CGEventGetFlags` already reports the
/// *combined* modifier state for every event (keydown, keyup, and
/// flagsChanged alike), so there's no need to hand-track individual
/// modifier-key down/up transitions the way the Windows hook does.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Modifiers {
  cmd: bool,
  ctrl: bool,
  alt: bool,
  shift: bool,
}

impl Modifiers {
  fn from_flags(flags: u64) -> Self {
    Modifiers {
      cmd: flags & FLAG_COMMAND != 0,
      ctrl: flags & FLAG_CONTROL != 0,
      alt: flags & FLAG_OPTION != 0,
      shift: flags & FLAG_SHIFT != 0,
    }
  }

  fn is_empty(&self) -> bool {
    !self.cmd && !self.ctrl && !self.alt && !self.shift
  }

  fn union(&self, other: Modifiers) -> Modifiers {
    Modifiers {
      cmd: self.cmd || other.cmd,
      ctrl: self.ctrl || other.ctrl,
      alt: self.alt || other.alt,
      shift: self.shift || other.shift,
    }
  }
}

/// Mac virtual keycode -> the token `eventToAccelerator`'s mac branch would
/// produce for the same physical key (`shortcut.ts`'s `CODE_TO_KEY`/
/// `keyFromCode`), for reporting a captured combo back to JS. `None` for a
/// keycode with no accelerator equivalent — such a key is simply not
/// reported, same as `eventToAccelerator` silently ignoring it.
fn keycode_to_token(code: i64) -> Option<String> {
  Some(
    match code {
      0x00 => "A", 0x0B => "B", 0x08 => "C", 0x02 => "D", 0x0E => "E", 0x03 => "F",
      0x05 => "G", 0x04 => "H", 0x22 => "I", 0x26 => "J", 0x28 => "K", 0x25 => "L",
      0x2E => "M", 0x2D => "N", 0x1F => "O", 0x23 => "P", 0x0C => "Q", 0x0F => "R",
      0x01 => "S", 0x11 => "T", 0x20 => "U", 0x09 => "V", 0x0D => "W", 0x07 => "X",
      0x10 => "Y", 0x06 => "Z",
      0x1D => "0", 0x12 => "1", 0x13 => "2", 0x14 => "3", 0x15 => "4",
      0x17 => "5", 0x16 => "6", 0x1A => "7", 0x1C => "8", 0x19 => "9",
      0x24 => "Return", 0x30 => "Tab", 0x31 => "Space", 0x33 => "Backspace",
      0x35 => "Escape", 0x75 => "Delete",
      0x7E => "Up", 0x7D => "Down", 0x7B => "Left", 0x7C => "Right",
      0x2B => ",", 0x2F => ".", 0x2C => "/", 0x2A => "\\", 0x29 => ";",
      0x27 => "'", 0x21 => "[", 0x1E => "]", 0x1B => "-", 0x18 => "=", 0x32 => "`",
      0x7A => "F1", 0x78 => "F2", 0x63 => "F3", 0x76 => "F4", 0x60 => "F5",
      0x61 => "F6", 0x62 => "F7", 0x64 => "F8", 0x65 => "F9", 0x6D => "F10",
      0x67 => "F11", 0x6F => "F12", 0x69 => "F13", 0x6B => "F14", 0x71 => "F15",
      0x6A => "F16", 0x40 => "F17", 0x4F => "F18", 0x50 => "F19", 0x5A => "F20",
      _ => return None,
    }
    .to_string(),
  )
}

/// The reverse of `keycode_to_token` — parses the key token out of an
/// accelerator string being registered.
fn token_to_keycode(token: &str) -> Option<i64> {
  if token.len() == 1 {
    let c = token.chars().next()?;
    if c.is_ascii_alphabetic() {
      return Some(match c.to_ascii_uppercase() {
        'A' => 0x00, 'B' => 0x0B, 'C' => 0x08, 'D' => 0x02, 'E' => 0x0E, 'F' => 0x03,
        'G' => 0x05, 'H' => 0x04, 'I' => 0x22, 'J' => 0x26, 'K' => 0x28, 'L' => 0x25,
        'M' => 0x2E, 'N' => 0x2D, 'O' => 0x1F, 'P' => 0x23, 'Q' => 0x0C, 'R' => 0x0F,
        'S' => 0x01, 'T' => 0x11, 'U' => 0x20, 'V' => 0x09, 'W' => 0x0D, 'X' => 0x07,
        'Y' => 0x10, 'Z' => 0x06,
        _ => return None,
      });
    }
    if c.is_ascii_digit() {
      return Some(match c {
        '0' => 0x1D, '1' => 0x12, '2' => 0x13, '3' => 0x14, '4' => 0x15,
        '5' => 0x17, '6' => 0x16, '7' => 0x1A, '8' => 0x1C, '9' => 0x19,
        _ => return None,
      });
    }
    return Some(match c {
      ',' => 0x2B, '.' => 0x2F, '/' => 0x2C, '\\' => 0x2A, ';' => 0x29,
      '\'' => 0x27, '[' => 0x21, ']' => 0x1E, '-' => 0x1B, '=' => 0x18, '`' => 0x32,
      _ => return None,
    });
  }
  Some(match token.to_lowercase().as_str() {
    "space" => 0x31,
    "up" => 0x7E,
    "down" => 0x7D,
    "left" => 0x7B,
    "right" => 0x7C,
    "escape" | "esc" => 0x35,
    "tab" => 0x30,
    "return" | "enter" => 0x24,
    "backspace" => 0x33,
    "delete" => 0x75,
    "f1" => 0x7A, "f2" => 0x78, "f3" => 0x63, "f4" => 0x76, "f5" => 0x60,
    "f6" => 0x61, "f7" => 0x62, "f8" => 0x64, "f9" => 0x65, "f10" => 0x6D,
    "f11" => 0x67, "f12" => 0x6F, "f13" => 0x69, "f14" => 0x6B, "f15" => 0x71,
    "f16" => 0x6A, "f17" => 0x40, "f18" => 0x4F, "f19" => 0x50, "f20" => 0x5A,
    _ => return None,
  })
}

/// A parsed accelerator: a modifier set plus an optional non-modifier key.
/// `key: None` is a modifier-only chord (`Command` alone, `Command+Shift`,
/// …) — unlike `native/win`, which only ever special-cases a *lone* `Super`
/// tap, this tap can watch a release of *any* combination of modifiers, so
/// there's no reason to restrict a chord-only binding to a single modifier.
struct ParsedAccelerator {
  mods: Modifiers,
  key: Option<i64>,
}

/// Parses the same accelerator vocabulary `eventToAccelerator`/
/// `matchesShortcut` (`shortcut.ts`) produce/accept on mac — `Command`/`Cmd`/
/// `Meta`/`Super` (and `CommandOrControl`/`CmdOrCtrl`, which resolve to
/// `Command` on mac same as `matchesShortcut` does), `Control`/`Ctrl`,
/// `Option`/`Alt`, `Shift`, plus an optional key token. Returns `None` for an
/// unmapped key token or no modifier at all (never valid — a bare key would
/// collide with normal typing).
fn parse_accelerator(accelerator: &str) -> Option<ParsedAccelerator> {
  let mut mods = Modifiers::default();
  let mut key: Option<i64> = None;
  for token in accelerator.split('+').filter(|t| !t.is_empty()) {
    match token.to_lowercase().as_str() {
      "commandorcontrol" | "cmdorctrl" | "command" | "cmd" | "meta" | "super" => mods.cmd = true,
      "control" | "ctrl" => mods.ctrl = true,
      "alt" | "option" => mods.alt = true,
      "shift" => mods.shift = true,
      other => key = Some(token_to_keycode(other)?),
    }
  }
  if mods.is_empty() {
    return None;
  }
  Some(ParsedAccelerator { mods, key })
}

/// Builds the same accelerator-string shape `eventToAccelerator`'s mac
/// branch does — `Command`, `Control`, `Option`, `Shift`, then an optional
/// key token, in that order — for reporting a captured combo back to JS.
fn format_accelerator(mods: Modifiers, key: Option<&str>) -> String {
  let mut parts: Vec<&str> = Vec::with_capacity(5);
  if mods.cmd {
    parts.push("Command");
  }
  if mods.ctrl {
    parts.push("Control");
  }
  if mods.alt {
    parts.push("Option");
  }
  if mods.shift {
    parts.push("Shift");
  }
  if let Some(k) = key {
    parts.push(k);
  }
  parts.join("+")
}

struct HotkeyEntry {
  id: String,
  parsed: ParsedAccelerator,
}

/// Live state the tap callback reads/updates on every keystroke. A single
/// process-wide instance — `start_hotkey_watcher` only ever runs once (one
/// tap per app) — behind a `Mutex` since the tap thread and whichever thread
/// calls `register`/`unregister` (the JS/napi thread) both touch it.
#[derive(Default)]
struct HookState {
  entries: Vec<HotkeyEntry>,
  /// The modifier set actually held right now, per the most recent
  /// `flagsChanged` event — used only to detect the empty <-> non-empty
  /// transitions that start/end a chord session below.
  current_mods: Modifiers,
  /// The union of every modifier combination seen since the current
  /// "nothing held -> something held" session began; `None` while nothing is
  /// held. Union rather than "whatever's held right now" so pressing
  /// `Command` then `Shift` then releasing `Command` first still reports/
  /// matches `Command+Shift` — the full chord the user actually held, not
  /// just whatever's left at the moment the first key comes back up.
  chord_session: Option<Modifiers>,
  /// Set the moment a real (non-modifier) key fires during the current
  /// chord session, so its eventual all-released transition is *not* also
  /// treated as completing a modifier-only chord — it was a `mods+key` combo
  /// instead, already handled at keydown.
  chord_cancelled: bool,
  /// The keycode a `mods+key` match/capture last suppressed, so its
  /// key-repeat and eventual keyup stay suppressed too, without re-firing/
  /// re-reporting.
  suppressed_key: Option<i64>,
  /// Set by `HotkeyWatcher::start_capture`/`stop_capture`. While true, any
  /// reportable combo (a `mods+key` press, or a modifier-only chord release)
  /// is sent to `capture_callback` instead of checked against `entries` —
  /// see the module doc comment for why a shortcut recorder needs this at
  /// all: an already-registered-elsewhere combo otherwise never reaches this
  /// process's normal keydown handling to be observed.
  capturing: bool,
}

fn hook_state() -> &'static Mutex<HookState> {
  static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
  STATE.get_or_init(|| Mutex::new(HookState::default()))
}

fn hook_callback() -> &'static Mutex<Option<ThreadsafeFunction<String>>> {
  static CALLBACK: OnceLock<Mutex<Option<ThreadsafeFunction<String>>>> = OnceLock::new();
  CALLBACK.get_or_init(|| Mutex::new(None))
}

fn capture_callback() -> &'static Mutex<Option<ThreadsafeFunction<String>>> {
  static CALLBACK: OnceLock<Mutex<Option<ThreadsafeFunction<String>>>> = OnceLock::new();
  CALLBACK.get_or_init(|| Mutex::new(None))
}

/// The live tap port, stashed so the callback can re-enable it after a
/// `kCGEventTapDisabledByTimeout`/`...ByUserInput` notification — `None`
/// until `start_hotkey_watcher`'s background thread finishes creating it.
fn tap_port() -> &'static Mutex<Option<isize>> {
  static PORT: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
  PORT.get_or_init(|| Mutex::new(None))
}

fn fire_hotkey(id: &str) {
  if let Some(tsfn) = hook_callback().lock().unwrap().as_ref() {
    tsfn.call(Ok(id.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
  }
}

fn report_capture(accelerator: &str) {
  if let Some(tsfn) = capture_callback().lock().unwrap().as_ref() {
    tsfn.call(
      Ok(accelerator.to_string()),
      ThreadsafeFunctionCallMode::NonBlocking,
    );
  }
}

/// Handles a `flagsChanged` event (a modifier key going down or up).
/// Returns whether this event should be suppressed — only ever true for the
/// single event that completes a matched/captured modifier-only chord; every
/// other modifier transition passes through untouched; passing through the
/// individual presses that build up to a chord is safe (doesn't corrupt a
/// `mods+key` combo elsewhere — `CGEventGetFlags` on a later keydown reflects
/// live hardware modifier state regardless of whether we ate an earlier
/// `flagsChanged` notification for it).
fn handle_flags_changed(mods: Modifiers) -> bool {
  let mut state = hook_state().lock().unwrap();
  let was_empty = state.current_mods.is_empty();
  state.current_mods = mods;

  if mods.is_empty() {
    let session = state.chord_session.take();
    let cancelled = state.chord_cancelled;
    state.chord_cancelled = false;
    let Some(session_mods) = session else {
      return false;
    };
    if cancelled || session_mods.is_empty() {
      return false;
    }
    if state.capturing {
      drop(state);
      report_capture(&format_accelerator(session_mods, None));
      return true;
    }
    let matched = state
      .entries
      .iter()
      .find(|e| e.parsed.key.is_none() && e.parsed.mods == session_mods)
      .map(|e| e.id.clone());
    drop(state);
    match matched {
      Some(id) => {
        fire_hotkey(&id);
        true
      }
      None => false,
    }
  } else {
    if was_empty {
      state.chord_session = Some(mods);
      state.chord_cancelled = false;
    } else if let Some(session_mods) = state.chord_session {
      state.chord_session = Some(session_mods.union(mods));
    }
    false
  }
}

/// Handles a `keyDown`/`keyUp` event for an ordinary (non-modifier) key.
/// Returns whether this event should be suppressed.
fn handle_key_event(mods: Modifiers, keycode: i64, is_down: bool) -> bool {
  let mut state = hook_state().lock().unwrap();

  if !is_down {
    if state.suppressed_key == Some(keycode) {
      state.suppressed_key = None;
      return true;
    }
    return false;
  }

  // A real key firing means whatever modifier session is live (if any) is
  // no longer a pure chord — cancel it so releasing the modifiers afterward
  // doesn't *also* fire/report a modifier-only match.
  state.chord_cancelled = true;

  if mods.is_empty() {
    // No modifier held: never a valid accelerator (see `eventToAccelerator`)
    // — leave it alone so Escape/Enter/plain typing inside the recorder
    // (and everywhere else) behave exactly as if this tap didn't exist.
    return false;
  }

  if state.suppressed_key == Some(keycode) {
    return true; // key-repeat of an already-fired/-captured combo's key
  }

  let Some(token) = keycode_to_token(keycode) else {
    return false;
  };

  if state.capturing {
    state.suppressed_key = Some(keycode);
    drop(state);
    report_capture(&format_accelerator(mods, Some(&token)));
    return true;
  }

  let matched = state
    .entries
    .iter()
    .find(|e| e.parsed.key == Some(keycode) && e.parsed.mods == mods)
    .map(|e| e.id.clone());
  match matched {
    Some(id) => {
      state.suppressed_key = Some(keycode);
      drop(state);
      fire_hotkey(&id);
      true
    }
    None => false,
  }
}

extern "C" fn hotkey_tap_callback(
  _proxy: CGEventTapProxy,
  event_type: u32,
  event: CGEventRef,
  _user_info: *mut c_void,
) -> CGEventRef {
  if event_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
    || event_type == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
  {
    if let Some(tap) = *tap_port().lock().unwrap() {
      unsafe { CGEventTapEnable(tap as CFMachPortRef, true) };
    }
    return event;
  }

  let flags = unsafe { CGEventGetFlags(event) } & RELEVANT_FLAGS;
  let mods = Modifiers::from_flags(flags);

  let suppress = if event_type == K_CG_EVENT_FLAGS_CHANGED {
    handle_flags_changed(mods)
  } else {
    let is_down = event_type == K_CG_EVENT_KEY_DOWN;
    let keycode = unsafe { CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE) };
    handle_key_event(mods, keycode, is_down)
  };

  if suppress {
    std::ptr::null_mut()
  } else {
    event
  }
}

/// Handle for the background hotkey watcher `start_hotkey_watcher` starts.
/// Dropping this without calling `stop()` leaks the event tap and its
/// run-loop thread for the rest of the process's life — callers must
/// `stop()` it explicitly (e.g. on app quit), mirroring `native/win`'s
/// `HotkeyWatcher`.
#[napi]
pub struct HotkeyWatcher {
  tap: isize,
  run_loop: isize,
  thread: Option<std::thread::JoinHandle<()>>,
}

#[napi]
impl HotkeyWatcher {
  /// Parses and stores `accelerator` under `id`, replacing whatever was
  /// previously registered under that id. Returns `false` if `accelerator`
  /// doesn't parse, or if a *different* id already holds the exact same
  /// modifiers+key — unlike `globalShortcut`, this never asks macOS for
  /// exclusive ownership of the combo (it just watches, and on a match
  /// suppresses, every keystroke itself), so nothing upstream would ever
  /// reject a genuine duplicate on its own: without this check, `entries`
  /// would happily hold two ids for the same combo, and whichever happened
  /// to land first in the list would silently keep winning every match in
  /// `handle_key_event`/`handle_flags_changed` forever, while the *other*
  /// id's `register()` call reported success anyway.
  #[napi]
  pub fn register(&self, id: String, accelerator: String) -> bool {
    let Some(parsed) = parse_accelerator(&accelerator) else {
      return false;
    };
    let mut state = hook_state().lock().unwrap();
    let held_by_another = state
      .entries
      .iter()
      .any(|e| e.id != id && e.parsed.mods == parsed.mods && e.parsed.key == parsed.key);
    if held_by_another {
      return false;
    }
    state.entries.retain(|e| e.id != id);
    state.entries.push(HotkeyEntry { id, parsed });
    true
  }

  /// Idempotent — removing an id that isn't registered is a no-op.
  #[napi]
  pub fn unregister(&self, id: String) {
    hook_state().lock().unwrap().entries.retain(|e| e.id != id);
  }

  /// Starts reporting every reportable keystroke (any `mods+key` press, or a
  /// modifier-only chord's release) to `callback` as a captured accelerator
  /// string, instead of matching it against registered entries — see
  /// `HookState::capturing`'s doc comment for why a shortcut recorder needs
  /// this rather than its own DOM listener: an already-bound combo would
  /// otherwise never reach this process at all. A keystroke with no modifier
  /// held is untouched and keeps reaching the focused window's own keydown
  /// handler exactly as before (Escape-to-cancel, Enter-to-confirm, …).
  /// Replaces any previous capture callback if already capturing.
  #[napi]
  pub fn start_capture(&self, callback: ThreadsafeFunction<String>) {
    *capture_callback().lock().unwrap() = Some(callback);
    let mut state = hook_state().lock().unwrap();
    state.capturing = true;
    state.chord_session = None;
    state.chord_cancelled = false;
    state.suppressed_key = None;
  }

  /// Stops capture mode and resumes normal entry-matching. Idempotent.
  #[napi]
  pub fn stop_capture(&self) {
    let mut state = hook_state().lock().unwrap();
    state.capturing = false;
    state.chord_session = None;
    state.chord_cancelled = false;
    state.suppressed_key = None;
    *capture_callback().lock().unwrap() = None;
  }

  /// Disables and invalidates the tap, stops its run loop, and joins the
  /// background thread. Idempotent.
  #[napi]
  pub fn stop(&mut self) {
    if self.run_loop != 0 {
      unsafe { CFRunLoopStop(self.run_loop as CFRunLoopRef) };
      self.run_loop = 0;
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
    self.tap = 0;
    {
      let mut state = hook_state().lock().unwrap();
      state.entries.clear();
      state.capturing = false;
    }
    *hook_callback().lock().unwrap() = None;
    *capture_callback().lock().unwrap() = None;
  }
}

/// Starts the global-hotkey watcher: a background thread installs a
/// session-level `CGEventTap` (requires the user to have granted Magibar
/// Input Monitoring access — see the module doc comment) and runs a
/// `CFRunLoop` to keep receiving callbacks on it, invoking `callback` with
/// the registered id whenever a bound accelerator fires. Entries are
/// registered/unregistered afterward via the returned `HotkeyWatcher`.
///
/// Blocks briefly waiting for the background thread to finish setting up, so
/// a failure (permission not granted, or run-loop-source creation failing)
/// can be reported by returning a watcher whose `tap` is already 0 rather
/// than one that silently never calls back — same contract as
/// `native/win`'s `start_hotkey_watcher`.
#[napi]
pub fn start_hotkey_watcher(callback: ThreadsafeFunction<String>) -> HotkeyWatcher {
  *hook_callback().lock().unwrap() = Some(callback);
  hook_state().lock().unwrap().entries.clear();

  let (tap_tx, tap_rx) = std::sync::mpsc::channel::<isize>();
  let (rl_tx, rl_rx) = std::sync::mpsc::channel::<isize>();

  let thread = std::thread::spawn(move || {
    let mask: u64 = (1u64 << K_CG_EVENT_KEY_DOWN)
      | (1u64 << K_CG_EVENT_KEY_UP)
      | (1u64 << K_CG_EVENT_FLAGS_CHANGED);

    let tap = unsafe {
      CGEventTapCreate(
        K_CG_SESSION_EVENT_TAP,
        K_CG_HEAD_INSERT_EVENT_TAP,
        K_CG_EVENT_TAP_OPTION_DEFAULT,
        mask,
        hotkey_tap_callback,
        std::ptr::null_mut(),
      )
    };
    if tap.is_null() {
      eprintln!(
        "[mac-hotkeys] CGEventTapCreate failed — grant Magibar \"Input \
         Monitoring\" access in System Settings > Privacy & Security, then \
         relaunch."
      );
      let _ = tap_tx.send(0);
      return;
    }

    let source = unsafe { CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) };
    if source.is_null() {
      unsafe { CFRelease(tap as CFTypeRef) };
      let _ = tap_tx.send(0);
      return;
    }

    let run_loop = unsafe { CFRunLoopGetCurrent() };
    unsafe {
      CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
    }
    *tap_port().lock().unwrap() = Some(tap as isize);

    let _ = tap_tx.send(tap as isize);
    let _ = rl_tx.send(run_loop as isize);

    unsafe { CFRunLoopRun() };

    // `CFRunLoopStop` (from `HotkeyWatcher::stop`) returned us here.
    unsafe {
      CGEventTapEnable(tap, false);
      CFMachPortInvalidate(tap);
      CFRelease(source as CFTypeRef);
      CFRelease(tap as CFTypeRef);
    }
    *tap_port().lock().unwrap() = None;
  });

  let tap = tap_rx.recv().unwrap_or(0);
  let run_loop = if tap != 0 { rl_rx.recv().unwrap_or(0) } else { 0 };

  HotkeyWatcher {
    tap,
    run_loop,
    thread: Some(thread),
  }
}
