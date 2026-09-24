#![cfg(target_os = "linux")]
//! Native Linux (X11/XWayland) window control for magibar-launcher.
//!
//! Replaces the previous `xdotool`/`wmctrl` shell-outs with direct EWMH-over-X11
//! calls via `x11rb`'s pure-Rust connection (`rust_connection` — no libxcb C
//! dependency, just a Unix-domain-socket connection to the X server). Every
//! operation here mirrors what those two tools do internally:
//! - `active_window` reads `_NET_ACTIVE_WINDOW` off the root window, same as
//!   `xdotool getactivewindow`.
//! - `get_window_rect` translates the window's origin to root coordinates, same
//!   as `xdotool getwindowgeometry` — `_NET_ACTIVE_WINDOW` is defined by the EWMH
//!   spec to be a *client* window, not the window manager's decoration frame, so
//!   no reparent-walking is needed.
//! - `apply_window_rect`/`toggle_fullscreen` send `_NET_WM_STATE` client messages
//!   to the root window, the same EWMH mechanism `wmctrl -b ...` drives.
//!
//! A single connection is opened lazily and cached for the process's lifetime
//! instead of reconnecting (and forking a whole process) per call.
//!
//! This is a hard platform limit, not a gap here: both this and `xdotool`/
//! `wmctrl` operate on X11 (which includes XWayland-backed windows under a
//! Wayland session — most apps, today), but a **Wayland-native** window cannot
//! be moved by any external process on Linux. Wayland's security model has no
//! cross-app window-control protocol; there is no workaround from here.

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread::JoinHandle;
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::{ConnectionExt as XfixesConnectionExt, SelectionEventMask};
use x11rb::protocol::xproto::{
  Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, CreateWindowAux,
  EventMask, Window, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

struct X11 {
  conn: RustConnection,
  root: Window,
}

static X11_CONN: OnceLock<Option<X11>> = OnceLock::new();

/// The cached connection + root window, established on first use. `None` if the
/// connection itself failed (no X server/XWayland reachable at all) — every
/// exported function below treats that the same as "command failed."
fn x11() -> Option<&'static X11> {
  X11_CONN
    .get_or_init(|| {
      let (conn, screen_num) = RustConnection::connect(None).ok()?;
      let root = conn.setup().roots.get(screen_num)?.root;
      Some(X11 { conn, root })
    })
    .as_ref()
}

fn atom(conn: &RustConnection, name: &str) -> Option<Atom> {
  conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok().map(|reply| reply.atom)
}

/// EWMH `_NET_WM_STATE` action codes (spec-defined, not part of the core X11
/// protocol).
const NET_WM_STATE_REMOVE: u32 = 0;
const NET_WM_STATE_TOGGLE: u32 = 2;

/// Sends a `_NET_WM_STATE` client message to the root window — the EWMH
/// mechanism every spec-compliant window manager listens on for state changes
/// (maximize, fullscreen, …) a client wants to request for itself. `prop2` of
/// `0` (the X11 "None" atom) is fine when only one property is being touched.
fn send_wm_state(x11: &X11, window: Window, action: u32, prop1: Atom, prop2: Atom) -> bool {
  let Some(net_wm_state) = atom(&x11.conn, "_NET_WM_STATE") else {
    return false;
  };
  // Source indication `1` = "normal application" per the EWMH spec.
  let event = ClientMessageEvent::new(32, window, net_wm_state, [action, prop1, prop2, 1, 0]);
  let mask = EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT;
  x11.conn.send_event(false, x11.root, mask, event).is_ok() && x11.conn.flush().is_ok()
}

/// The active window's id, or `0` if none (or the only candidate was `exclude`
/// — the launcher's own X11 window id, so a stray capture of the launcher
/// itself is discarded rather than moved later).
#[napi]
pub fn active_window(exclude: i64) -> i64 {
  let Some(x11) = x11() else {
    return 0;
  };
  let Some(net_active) = atom(&x11.conn, "_NET_ACTIVE_WINDOW") else {
    return 0;
  };
  let Ok(cookie) = x11.conn.get_property(false, x11.root, net_active, AtomEnum::WINDOW, 0, 1)
  else {
    return 0;
  };
  let Ok(reply) = cookie.reply() else {
    return 0;
  };
  let id = reply.value32().and_then(|mut values| values.next()).unwrap_or(0);
  if id == 0 || id as i64 == exclude {
    return 0;
  }
  // `_NET_ACTIVE_WINDOW` is not, on its own, a promise that there is a real
  // application window focused. Under GNOME Wayland with no XWayland clients
  // at all, Mutter still points it at one of its own internal windows (a
  // sibling of the `_NET_SUPPORTING_WM_CHECK` window), which has no
  // properties and appears in no client list — but which `get_geometry` and
  // `configure_window` both happily accept. Acting on it meant every window
  // command silently "succeeded" while moving an invisible internal window,
  // and — because a capture had apparently worked — suppressed the "nothing
  // to act on" path that would otherwise have told the user why. Checking
  // `_NET_CLIENT_LIST`, the window manager's own list of the windows it
  // manages, is what separates a real target from that placeholder.
  if !managed_windows(x11).contains(&id) {
    return 0;
  }
  id as i64
}

/// The window manager's `_NET_CLIENT_LIST` — every window it currently
/// manages, which for EWMH purposes is the definition of "a real application
/// window". Empty when the property is missing or unreadable, so callers
/// treat an unreachable/non-EWMH window manager the same as an empty desktop.
fn managed_windows(x11: &X11) -> Vec<u32> {
  let Some(client_list) = atom(&x11.conn, "_NET_CLIENT_LIST") else {
    return Vec::new();
  };
  let Ok(cookie) =
    x11.conn.get_property(false, x11.root, client_list, AtomEnum::WINDOW, 0, u32::MAX)
  else {
    return Vec::new();
  };
  let Ok(reply) = cookie.reply() else {
    return Vec::new();
  };
  reply.value32().map(|values| values.collect()).unwrap_or_default()
}

/// Whether any X11/XWayland window exists at all right now — checked via
/// `_NET_CLIENT_LIST` on the root window, and `false` if the X11 connection
/// itself can't be established (e.g. a pure-Wayland session with no XWayland).
/// A window-management feature offered on a desktop with zero reachable
/// windows would just silently no-op every command, so this is used to hide
/// the feature entirely instead.
#[napi]
pub fn has_xwayland_windows() -> bool {
  let Some(x11) = x11() else {
    return false;
  };
  !managed_windows(x11).is_empty()
}

#[napi(object)]
pub struct LinuxRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// The window's current position (translated to root/screen coordinates) and
/// size, or `null` if unavailable (invalid id, or the X11 connection is down).
#[napi]
pub fn get_window_rect(id: i64) -> Option<LinuxRect> {
  let x11 = x11()?;
  let window = id as u32;

  let geometry = x11.conn.get_geometry(window).ok()?.reply().ok()?;
  let translated = x11.conn.translate_coordinates(window, x11.root, 0, 0).ok()?.reply().ok()?;

  Some(LinuxRect {
    x: translated.dst_x as f64,
    y: translated.dst_y as f64,
    width: geometry.width as f64,
    height: geometry.height as f64,
  })
}

/// Moves and resizes the window to `rect`. Unmaximizes first — most window
/// managers ignore a `ConfigureWindow` resize/move on an already-maximized
/// window, the same reason the mac/Windows paths restore the window before
/// repositioning it. That step is best-effort (a window that was never
/// maximized has nothing to remove, and this shouldn't block the actual move);
/// the `ConfigureWindow` call is what determines the return value.
#[napi]
pub fn apply_window_rect(id: i64, rect: LinuxRect) -> bool {
  let Some(x11) = x11() else {
    return false;
  };
  let window = id as u32;

  if let (Some(vert), Some(horz)) = (
    atom(&x11.conn, "_NET_WM_STATE_MAXIMIZED_VERT"),
    atom(&x11.conn, "_NET_WM_STATE_MAXIMIZED_HORZ"),
  ) {
    send_wm_state(x11, window, NET_WM_STATE_REMOVE, vert, horz);
  }

  let aux = ConfigureWindowAux::new()
    .x(rect.x.round() as i32)
    .y(rect.y.round() as i32)
    .width(rect.width.round() as u32)
    .height(rect.height.round() as u32);

  x11.conn.configure_window(window, &aux).is_ok() && x11.conn.flush().is_ok()
}

/// Toggles EWMH `_NET_WM_STATE_FULLSCREEN` on the window — broadly supported
/// across X11 window managers (the same mechanism `wmctrl -b toggle,fullscreen`
/// drives).
#[napi]
pub fn toggle_fullscreen(id: i64) -> bool {
  let Some(x11) = x11() else {
    return false;
  };
  let Some(fullscreen) = atom(&x11.conn, "_NET_WM_STATE_FULLSCREEN") else {
    return false;
  };
  send_wm_state(x11, id as u32, NET_WM_STATE_TOGGLE, fullscreen, 0)
}

// ---------------------------------------------------------------------------
// GNOME Shell window control (Wayland)
// ---------------------------------------------------------------------------
//
// Everything above this point speaks X11, and therefore can only ever reach
// XWayland-backed windows. On a GNOME Wayland session most applications are
// Wayland-native, so for them the X11 path is not "degraded" — it is blind:
// they do not appear in `_NET_CLIENT_LIST`, and no amount of EWMH can move
// them. That is Wayland's design, not a gap in `x11rb`.
//
// The only supported way to move a Wayland window is to run code inside the
// compositor, so Magibar ships a small GNOME Shell extension
// (`resources/gnome-extension/magibar@magibar.app`) that does exactly that and
// exposes the private D-Bus API called below. The alternatives were checked
// and are closed: `org.gnome.Shell.Introspect` is read-only and returns
// `AccessDenied` to unprivileged callers, and `org.gnome.Shell.Eval` is
// refused outside GNOME's unsafe mode.
//
// Installation and enablement of that extension live on the TypeScript side
// (`gnome-extension.ts`) — it is file copying and `gsettings`, with no reason
// to be native. This module only *talks* to it, and every function here
// answers `false`/`None` when the extension isn't running, which is what lets
// `control-linux.ts` fall back to the X11 path without a branch of its own.

const GNOME_BUS_NAME: &str = "app.magibar.Shell";
const GNOME_OBJECT_PATH: &str = "/app/magibar/Shell";
const GNOME_INTERFACE: &str = "app.magibar.WindowManager";

/// A session-bus connection shared by every call below, opened lazily and
/// cached for the process's lifetime. Separate from the hotkey watcher's
/// connection, which is owned by (and lives on) its own worker thread.
///
/// `None` when the session bus can't be reached at all, which is the normal
/// state on a non-desktop session rather than an error worth surfacing.
fn gnome_bus() -> Option<&'static zbus::blocking::Connection> {
  static CONN: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
  CONN.get_or_init(|| zbus::blocking::Connection::session().ok()).as_ref()
}

/// Calls one method on the extension and deserializes its reply.
///
/// Every failure mode collapses to `None` deliberately: a missing extension,
/// a disabled one, a shell that just restarted, and a genuine call error are
/// all "the GNOME path isn't usable right now", and the caller's answer is the
/// same in each case — fall back to X11. These calls are made from the main
/// Node thread and block on a bus round-trip (sub-millisecond on a session
/// bus, and only ever in response to a user command), the same way the X11
/// calls above block on an X server round-trip.
fn gnome_call<B, R>(method: &str, args: &B) -> Option<R>
where
  B: serde::ser::Serialize + zbus::zvariant::DynamicType,
  R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
{
  let conn = gnome_bus()?;
  let reply = conn
    .call_method(Some(GNOME_BUS_NAME), GNOME_OBJECT_PATH, Some(GNOME_INTERFACE), method, args)
    .ok()?;
  reply.body().deserialize::<R>().ok()
}

/// Whether the Magibar GNOME Shell extension is installed, enabled, and
/// running right now.
///
/// Asks the bus whether anyone owns the extension's name rather than calling
/// a method on it and inspecting the error, so a "no" costs one round-trip to
/// `org.freedesktop.DBus` and can't be confused with a method that exists but
/// failed. Intentionally *not* cached: the user can enable, disable, or
/// re-install the extension (and GNOME Shell itself can restart) while Magibar
/// keeps running, and a cached answer here is exactly the bug that made the
/// X11 check report a permanently stale result.
#[napi]
pub fn gnome_shell_available() -> bool {
  let Some(conn) = gnome_bus() else {
    return false;
  };
  conn
    .call_method(
      Some("org.freedesktop.DBus"),
      "/org/freedesktop/DBus",
      Some("org.freedesktop.DBus"),
      "NameHasOwner",
      &(GNOME_BUS_NAME,),
    )
    .ok()
    .and_then(|reply| reply.body().deserialize::<bool>().ok())
    .unwrap_or(false)
}

/// The running extension's API version, or `0` if it isn't reachable. Lets the
/// TypeScript side notice that an older extension is still installed after a
/// Magibar update and re-install the bundled copy — see
/// `BUNDLED_EXTENSION_VERSION` in `gnome-extension.ts`.
#[napi]
pub fn gnome_api_version() -> u32 {
  gnome_call::<_, u32>("Version", &()).unwrap_or(0)
}

/// Whether GNOME currently has any normal application window at all — the
/// Wayland-session counterpart of `has_xwayland_windows`.
#[napi]
pub fn gnome_has_windows() -> bool {
  gnome_call::<_, bool>("HasWindows", &()).unwrap_or(false)
}

/// The focused window's Mutter stable-sequence id, or `0` if there is none.
/// `exclude_app_id` is Magibar's own application id, so a capture that happens
/// while the launcher itself holds focus is discarded rather than acted on
/// later — the GNOME counterpart of the X11 path's `exclude` window id, which
/// can't be reused here because the two address windows completely differently.
#[napi]
pub fn gnome_active_window(exclude_app_id: String) -> u32 {
  gnome_call::<_, u32>("GetFocused", &(exclude_app_id,)).unwrap_or(0)
}

/// The window's frame rect in GNOME's stage coordinates, which are logical
/// pixels — the same space Electron's `screen` module reports work areas in,
/// so no scale conversion is needed between the two (see `electron-screen.ts`).
#[napi]
pub fn gnome_get_window_rect(id: u32) -> Option<LinuxRect> {
  let (ok, x, y, width, height) = gnome_call::<_, (bool, i32, i32, i32, i32)>("GetRect", &(id,))?;
  if !ok {
    return None;
  }
  Some(LinuxRect {
    x: x as f64,
    y: y as f64,
    width: width as f64,
    height: height as f64,
  })
}

/// Moves and resizes the window. The extension clears any maximized/fullscreen/
/// minimized state first — Mutter keeps enforcing those over an explicit frame
/// change, so without that step snapping a maximized window appears to do
/// nothing.
#[napi]
pub fn gnome_apply_window_rect(id: u32, rect: LinuxRect) -> bool {
  gnome_call::<_, bool>(
    "MoveResize",
    &(
      id,
      rect.x.round() as i32,
      rect.y.round() as i32,
      rect.width.round() as i32,
      rect.height.round() as i32,
    ),
  )
  .unwrap_or(false)
}

#[napi]
pub fn gnome_toggle_fullscreen(id: u32) -> bool {
  gnome_call::<_, bool>("ToggleFullscreen", &(id,)).unwrap_or(false)
}

/// Custom `ClientMessage` type atom `ClipboardWatcher::stop` sends to wake the
/// watcher thread's blocking `wait_for_event()` loop. `SendEvent` only
/// delivers to clients that have selected the given `event-mask` on the
/// destination window, so the watcher creates its own (otherwise-unused)
/// window and selects `PROPERTY_CHANGE` on it purely so `stop()` — running on
/// a different connection, since the watcher's own connection is busy
/// blocking in `wait_for_event()` — has a mask that routes the message back
/// to it specifically, rather than nowhere.
const CLIPBOARD_WATCHER_STOP_ATOM: &str = "MAGIBAR_CLIPBOARD_WATCHER_STOP";

/// Handle for the background clipboard watcher `start_clipboard_watcher` starts. Dropping this
/// without calling `stop()` leaks the watcher's X11 connection and thread for the rest of the
/// process's life — callers must `stop()` it explicitly (e.g. on app quit), matching
/// `ClipboardPoller.stop()` on the TS side and `@magibar/win`'s `ClipboardWatcher`.
#[napi]
pub struct ClipboardWatcher {
  window: u32,
  thread: Option<JoinHandle<()>>,
}

#[napi]
impl ClipboardWatcher {
  /// Wakes the watcher thread (via a self-addressed `ClientMessage`, since
  /// `wait_for_event()` is otherwise blocked on the socket) and joins it.
  /// Idempotent — a second call is a no-op.
  #[napi]
  pub fn stop(&mut self) {
    if self.window != 0 {
      // A fresh, short-lived connection: the watcher's own connection is busy
      // blocking in `wait_for_event()` on its thread, so the wake-up has to
      // come from a separate client — any connection to the same X server can
      // `SendEvent` to a window it doesn't own.
      if let Ok((conn, _)) = RustConnection::connect(None) {
        if let Some(stop_atom) = atom(&conn, CLIPBOARD_WATCHER_STOP_ATOM) {
          let event = ClientMessageEvent::new(32, self.window, stop_atom, [0u32; 5]);
          let _ = conn.send_event(false, self.window, EventMask::PROPERTY_CHANGE, event);
          let _ = conn.flush();
        }
      }
      self.window = 0;
    }
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

/// Starts watching the system clipboard for changes via a true OS push notification instead of
/// polling: a background thread opens its own X11 connection, registers for `XFixes`
/// `SelectionNotify` events on the `CLIPBOARD` selection (`XFixesSelectSelectionInput` — the same
/// mechanism the `clipnotify` CLI tool is built on), and invokes `callback` with no arguments
/// once for every clipboard-ownership change. This is what lets the TS `ClipboardPoller` (see
/// `main/pasteboard-change-linux.ts`) skip its `setInterval` fallback entirely on Linux, the same
/// way `@magibar/win`'s `startClipboardWatcher` does on Windows.
///
/// `XFixesSelectionNotify` only fires on a selection *ownership* change (a new copy), not on
/// every write within the same ownership — exactly the granularity `ClipboardPoller` wants.
///
/// Blocks briefly waiting for the background thread to finish connecting and subscribing before
/// returning, so a failure (no X server/XWayland reachable, or the XFixes extension missing) can
/// be reported by returning a watcher whose internal window is already `0` rather than a handle
/// that silently never calls back.
#[napi]
pub fn start_clipboard_watcher(callback: ThreadsafeFunction<()>) -> ClipboardWatcher {
  let (tx, rx) = mpsc::channel::<u32>();

  let thread = std::thread::spawn(move || {
    let Ok((conn, screen_num)) = RustConnection::connect(None) else {
      let _ = tx.send(0);
      return;
    };
    let Some(root) = conn.setup().roots.get(screen_num).map(|screen| screen.root) else {
      let _ = tx.send(0);
      return;
    };

    // The XFixes extension requires clients to negotiate a version before
    // issuing any other request against it.
    let version_ok = match conn.xfixes_query_version(5, 0) {
      Ok(cookie) => cookie.reply().is_ok(),
      Err(_) => false,
    };
    if !version_ok {
      let _ = tx.send(0);
      return;
    }

    let (Some(clipboard_atom), Some(stop_atom)) =
      (atom(&conn, "CLIPBOARD"), atom(&conn, CLIPBOARD_WATCHER_STOP_ATOM))
    else {
      let _ = tx.send(0);
      return;
    };

    let Ok(window) = conn.generate_id() else {
      let _ = tx.send(0);
      return;
    };
    // An InputOnly window (never mapped/shown) purely to give the watcher an
    // identity of its own — see `CLIPBOARD_WATCHER_STOP_ATOM` for why. Depth
    // and visual must both be `0`/`CopyFromParent` for this window class.
    // Selecting `PROPERTY_CHANGE` (otherwise unused — the window's properties
    // are never touched) is what makes `stop()`'s synthetic `ClientMessage`
    // (sent with that same mask) route to this connection specifically,
    // rather than nowhere: `SendEvent` only delivers to clients that have
    // selected the event's mask on the destination window.
    let created = conn.create_window(
      0,
      window,
      root,
      0,
      0,
      1,
      1,
      0,
      WindowClass::INPUT_ONLY,
      0,
      &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    );
    if created.is_err() {
      let _ = tx.send(0);
      return;
    }

    let selected = conn.xfixes_select_selection_input(
      window,
      clipboard_atom,
      SelectionEventMask::SET_SELECTION_OWNER,
    );
    if selected.is_err() || conn.flush().is_err() {
      let _ = tx.send(0);
      return;
    }

    let _ = tx.send(window);

    loop {
      let event = match conn.wait_for_event() {
        Ok(event) => event,
        Err(_) => break,
      };
      match event {
        Event::XfixesSelectionNotify(_) => {
          callback.call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
        }
        Event::ClientMessage(message) if message.window == window && message.type_ == stop_atom => {
          break;
        }
        _ => {}
      }
    }
  });

  let window = rx.recv().unwrap_or(0);
  ClipboardWatcher { window, thread: Some(thread) }
}

// -- Process listing / termination (Activity Monitor), via `sysinfo` --
// Same shape as `native/mac/src/lib.rs` and `native/win/src/lib.rs` — see the
// comment there.

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

/// One process's identity and live resource usage, as reported by the last
/// `list_processes()` refresh.
#[napi(object)]
pub struct NativeProcess {
  pub pid: i32,
  pub name: String,
  /// Percentage of a single CPU core (0–100 per core, so a busy multi-core
  /// process can exceed 100), matching `top`'s own convention.
  pub cpu_usage: f64,
  pub memory_bytes: f64,
  /// Full path to the executable, when readable — lets the TS side resolve
  /// an icon for it via Electron's `app.getFileIcon`. `None` for a process
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
/// second) — just a `/proc` walk under the hood.
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

// -- Global hotkeys via GNOME custom keybindings --
//
// Three approaches were tried before this one (see git history for the
// first two, and `main/index.ts`'s `ensureToggleShortcutRegistered` comment
// for the underlying constraints): Electron's own `globalShortcut`, a raw
// `XGrabKey` passive grab, and the `org.freedesktop.portal.GlobalShortcuts`
// D-Bus portal. All three either can't work at all on this GNOME/Wayland
// setup (`globalShortcut`/`XGrabKey` — GNOME >= 49 doesn't forward XWayland
// key grabs to unfocused clients, confirmed against mutter's own issue
// tracker, same bug that breaks Discord's push-to-talk) or worked
// inconsistently in practice (the portal bound shortcuts that sat correctly
// in `dconf` without reliably ever firing `Activated`).
//
// This is the one mechanism confirmed end-to-end, by hand, to actually work
// on this desktop: GNOME's own "custom keyboard shortcut runs a command"
// feature (Settings -> Keyboard -> Custom Shortcuts), which every GNOME
// version has supported for years precisely because it's *not* a global key
// grab at all — `gnome-settings-daemon`'s `media-keys` plugin owns the
// binding itself (the same mechanism screenshot/volume keys use) and just
// runs a command when it fires, with none of the app-identity/activation-
// routing uncertainty the portal has.
//
// This module manages one `media-keys` "custom keybinding" dconf entry per
// registered hotkey id (CRUD via the `gsettings`/`dconf` CLIs — see below
// for why not a raw D-Bus write) whose command relays back to *this*
// process. A plain command can't carry which id fired, and only two
// POSIX real-time-safe user signals exist (nowhere near enough for
// per-action hotkeys, not just the one toggle shortcut) — so instead this
// process exposes its own tiny D-Bus service (`HOTKEY_BUS_NAME`) with a
// single `Trigger(id)` method, and each keybinding's command is a `gdbus
// call` invoking it with that hotkey's id. `gdbus call` is a lightweight
// CLI wrapper around a single D-Bus method call — nowhere near the cost of
// `main/index.ts`'s original relay (spawning an entire second Electron/
// Chromium process just to have it exit immediately after relaying via
// `second-instance`), which was the visible "slow to pop up" symptom that
// led here.
//
// CRUD goes through the `gsettings`/`dconf` CLIs rather than a raw D-Bus
// write to `ca.desrt.dconf.Writer` (which `zbus` — already a dependency —
// could do directly): dconf's actual wire format for a `Writer.Change` call
// is its own binary-encoded (GVDB) byte array, not a friendly typed D-Bus
// argument, and reproducing that encoding correctly isn't worth it when the
// officially-supported way for a non-GLib program to read/write GSettings
// *is* shelling out to these CLIs — every desktop integration script doing
// this does the same.

use std::process::Command;

/// This process's own D-Bus identity for the `Trigger` relay — reverse-DNS
/// under the same domain as `APP_ID`/`electron-builder.yml`'s `appId`, but
/// otherwise unrelated to it: unlike the portal this replaced, nothing here
/// validates this name against an installed `.desktop` file, so there's no
/// app-identity gotcha to get right this time.
const HOTKEY_BUS_NAME: &str = "app.magibar.Hotkeys";
const HOTKEY_OBJECT_PATH: &str = "/app/magibar/Hotkeys";
const HOTKEY_INTERFACE: &str = "app.magibar.Hotkeys";

const MEDIA_KEYS_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_KEYBINDING_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const CUSTOM_KEYBINDINGS_BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings";

/// A `[a-z0-9-]`-only rendering of `id`, used both as the `custom-keybindings`
/// relocatable-schema path segment (`slot_path`) *and* as the argument
/// embedded in the keybinding's `gdbus call` command (`trigger_command`) —
/// deterministic rather than allocated, so CRUD needs no persisted id <->
/// slot mapping of its own for the *dconf* side: the same `id` always maps
/// to the same slot, and a repeat `register` for that id just overwrites it.
///
/// `id` reaches here from `HOTKEY_CHANNELS.set`'s `actionId` (an IPC
/// argument from the renderer — see `main/index.ts`), not a value this
/// process fully controls, so it must never be embedded in
/// `trigger_command`'s shell-parsed command string as-is: GNOME's
/// `media-keys` plugin runs that string through `g_shell_parse_argv` when
/// the key fires, and an id containing `'`/`"`/whitespace could break out of
/// the intended single argument and inject extra `gdbus call` flags —
/// including a different `--dest`/`--object-path`/`--method`, turning a
/// pressed hotkey into an arbitrary D-Bus method call under the user's
/// session. Restricting this rendering to a fixed safe charset closes that
/// off entirely (and, as a side effect, fixes the same bug's harmless
/// twin: any `id` containing a plain apostrophe — plausible for a
/// user-named quicklink/widget — previously broke `gdbus call`'s own
/// GVariant string-literal parsing outright, just from a typo, not an
/// attack). The real `id` this slot stands in for is recovered via
/// `slot_registry` when `HotkeyService::trigger` receives it back.
fn slot_id(id: &str) -> String {
  id.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()
}

fn slot_path(id: &str) -> String {
  format!("{CUSTOM_KEYBINDINGS_BASE}/magibar-{}/", slot_id(id))
}

/// The command a custom keybinding at `slot_path(id)` runs when pressed — a
/// `gdbus call` relaying `slot_id(id)` (never the raw `id` — see its doc) to
/// this process's own `Trigger` method (see the module doc for why not a
/// plain command/signal).
fn trigger_command(id: &str) -> String {
  format!(
    "gdbus call --session --dest {HOTKEY_BUS_NAME} --object-path {HOTKEY_OBJECT_PATH} \
     --method {HOTKEY_INTERFACE}.Trigger \"'{}'\"",
    slot_id(id)
  )
}

fn gsettings_set(schema_and_path: &str, key: &str, value: &str) -> bool {
  Command::new("gsettings")
    .args(["set", schema_and_path, key, value])
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

fn gsettings_get(schema_and_path: &str, key: &str) -> Option<String> {
  let output = Command::new("gsettings").args(["get", schema_and_path, key]).output().ok()?;
  if !output.status.success() {
    return None;
  }
  String::from_utf8(output.stdout).ok().map(|s| s.trim().to_string())
}

/// Parses `gsettings get`'s GVariant text-format output for an `as`
/// (array-of-strings) key — e.g. `['/a/', '/b/']` or, empty, `@as []` — into
/// owned strings. Relies on none of this app's own dconf paths ever
/// containing a literal `'`, true by construction (`slot_path` only ever
/// produces `[a-z0-9-]` segments).
fn parse_string_array(raw: &str) -> Vec<String> {
  raw
    .split('\'')
    .enumerate()
    .filter_map(|(i, s)| (i % 2 == 1).then(|| s.to_string()))
    .collect()
}

fn format_string_array(items: &[String]) -> String {
  format!("[{}]", items.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", "))
}

/// Adds `path` to `media-keys`' top-level `custom-keybindings` list (the
/// registry every relocatable-schema entry under `CUSTOM_KEYBINDINGS_BASE`
/// must be listed in to actually take effect — an orphaned entry not listed
/// here is inert). Idempotent.
fn add_to_custom_keybindings_list(path: &str) -> bool {
  let current =
    gsettings_get(MEDIA_KEYS_SCHEMA, "custom-keybindings").map(|s| parse_string_array(&s)).unwrap_or_default();
  if current.iter().any(|p| p == path) {
    return true;
  }
  let mut updated = current;
  updated.push(path.to_string());
  gsettings_set(MEDIA_KEYS_SCHEMA, "custom-keybindings", &format_string_array(&updated))
}

/// Idempotent counterpart to `add_to_custom_keybindings_list`.
fn remove_from_custom_keybindings_list(path: &str) -> bool {
  let current =
    gsettings_get(MEDIA_KEYS_SCHEMA, "custom-keybindings").map(|s| parse_string_array(&s)).unwrap_or_default();
  let updated: Vec<String> = current.into_iter().filter(|p| p != path).collect();
  gsettings_set(MEDIA_KEYS_SCHEMA, "custom-keybindings", &format_string_array(&updated))
}

/// GTK accelerator syntax (e.g. `"<Control><Alt>space"`) — what a
/// `media-keys` custom keybinding's `binding` key expects, and conveniently
/// the same syntax `gtk_accelerator_parse` uses everywhere else in the GNOME
/// stack — for the same accelerator vocabulary `shortcut.ts`'s
/// `eventToAccelerator`/`matchesShortcut` produce/accept on Linux
/// (`Ctrl`/`Alt`/`Shift`/`Super` plus a key token). `None` for no modifier at
/// all (never valid — a global hotkey needs at least one so it doesn't
/// collide with normal typing) *or* no real key token: unlike the portal
/// this replaced, a custom keybinding has no modifier-only-chord
/// representation (`accelerator == "Super"`, `main/native/hotkeys.ts`'s
/// `LONE_SUPER_HOTKEY`) — same gap `native/win`'s `RegisterHotKey`-based
/// fallback would have, just reached by a different platform here.
fn accelerator_to_binding(accelerator: &str) -> Option<String> {
  let mut mods = String::new();
  let mut key: Option<&str> = None;
  for token in accelerator.split('+').filter(|t| !t.is_empty()) {
    match token.to_lowercase().as_str() {
      "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" | "command" | "cmd" => {
        mods.push_str("<Control>")
      }
      "alt" | "option" => mods.push_str("<Alt>"),
      "shift" => mods.push_str("<Shift>"),
      "super" | "meta" => mods.push_str("<Super>"),
      _ => key = Some(token),
    }
  }
  if mods.is_empty() {
    return None;
  }
  keysym_name(key?).map(|k| format!("{mods}{k}"))
}

/// The X keysym name (`gdk_keyval_name` convention) for one key token of
/// `shortcut.ts`'s accelerator vocabulary.
fn keysym_name(token: &str) -> Option<String> {
  let lower = token.to_lowercase();
  if let Some(digits) = lower.strip_prefix('f') {
    if let Ok(n) = digits.parse::<u8>() {
      if (1..=24).contains(&n) {
        return Some(format!("F{n}"));
      }
    }
  }
  if token.chars().count() == 1 {
    let c = token.chars().next()?;
    if c.is_ascii_alphanumeric() {
      return Some(c.to_ascii_lowercase().to_string());
    }
    return Some(
      match c {
        ',' => "comma",
        '.' => "period",
        '/' => "slash",
        '\\' => "backslash",
        ';' => "semicolon",
        '\'' => "apostrophe",
        '[' => "bracketleft",
        ']' => "bracketright",
        '-' => "minus",
        '=' => "equal",
        '`' => "grave",
        _ => return None,
      }
      .to_string(),
    );
  }
  Some(
    match lower.as_str() {
      "space" => "space",
      "up" => "Up",
      "down" => "Down",
      "left" => "Left",
      "right" => "Right",
      "escape" | "esc" => "Escape",
      "tab" => "Tab",
      "return" | "enter" => "Return",
      "backspace" => "BackSpace",
      "delete" => "Delete",
      _ => return None,
    }
    .to_string(),
  )
}

/// Creates (or overwrites) the custom keybinding for `id`: sets its
/// `name`/`command`/`binding` and makes sure it's listed in the top-level
/// registry. All four writes are local `gsettings` CLI calls with a
/// definitive exit code, not an async round trip anywhere — unlike the
/// portal this replaced, `register()`'s return value is a real,
/// same-tick "did this actually work" answer.
fn upsert_custom_keybinding(id: &str, binding: &str) -> bool {
  let path = slot_path(id);
  let schema_and_path = format!("{CUSTOM_KEYBINDING_SCHEMA}:{path}");
  gsettings_set(&schema_and_path, "name", id)
    && gsettings_set(&schema_and_path, "command", &trigger_command(id))
    && gsettings_set(&schema_and_path, "binding", binding)
    && add_to_custom_keybindings_list(&path)
}

/// Idempotent counterpart to `upsert_custom_keybinding`: unlists `id`'s slot
/// from the top-level registry and resets its whole dconf subtree (`dconf
/// reset -f`, not `gsettings reset` — the latter only resets one key at a
/// time, this needs all three gone).
fn remove_custom_keybinding(id: &str) -> bool {
  let path = slot_path(id);
  let unlisted = remove_from_custom_keybindings_list(&path);
  let reset = Command::new("dconf")
    .args(["reset", "-f", &path])
    .status()
    .map(|status| status.success())
    .unwrap_or(false);
  unlisted && reset
}

// GNOME's own shortcuts win over a `media-keys` custom keybinding bound to
// the same combo — Ubuntu ships `<Alt>space` as `activate-window-menu` and
// `<Super>space` as `switch-input-source`, so the two most obvious launcher
// toggles silently never fire. Registering a hotkey therefore also takes the
// combo away from any system binding holding it ("displacing" it), and gives
// it back when that hotkey changes or is removed. The same system grab also
// swallows the keystroke before the Settings recorder's DOM listener ever
// sees it, so capture temporarily lifts every modifier+Space system binding
// ("suspending" it) for as long as a recorder is open.
//
// What was taken is persisted in dconf (under `MAGIBAR_DCONF_DIR`, a
// schemaless path — dconf accepts any key there) rather than only in memory:
// displaced bindings must still be restorable after a restart, and suspended
// ones after a crash mid-recording (`start_hotkey_watcher` restores those).

/// The GSettings schemas whose `as` keys hold GNOME's system-wide shortcuts.
const SYSTEM_KEYBINDING_SCHEMAS: &[&str] = &[
  "org.gnome.desktop.wm.keybindings",
  "org.gnome.shell.keybindings",
  "org.gnome.mutter.keybindings",
  "org.gnome.mutter.wayland.keybindings",
  "org.gnome.settings-daemon.plugins.media-keys",
];

const MAGIBAR_DCONF_DIR: &str = "/app/magibar/hotkeys";

/// A system binding taken away from GNOME: `binding` was one entry of
/// `schema`'s `key` array.
#[derive(Clone, PartialEq)]
struct TakenBinding {
  schema: String,
  key: String,
  binding: String,
}

impl TakenBinding {
  /// `|`-joined for dconf storage — none of the three ever contain `|` or `'`.
  fn encode(&self) -> String {
    format!("{}|{}|{}", self.schema, self.key, self.binding)
  }

  fn decode(raw: &str) -> Option<Self> {
    let mut parts = raw.splitn(3, '|');
    Some(Self {
      schema: parts.next()?.to_string(),
      key: parts.next()?.to_string(),
      binding: parts.next()?.to_string(),
    })
  }
}

/// A GTK accelerator reduced to something comparable: sorted canonical
/// modifier names plus the lowercased key, so `<Primary><Mod1>Space` and
/// `<Alt><Control>space` compare equal. `None` for an empty/disabled entry.
fn normalize_binding(binding: &str) -> Option<(Vec<&'static str>, String)> {
  let mut rest = binding.trim();
  let mut mods = Vec::new();
  while let Some(stripped) = rest.strip_prefix('<') {
    let end = stripped.find('>')?;
    let modifier = match stripped[..end].to_lowercase().as_str() {
      "control" | "ctrl" | "primary" => "control",
      "alt" | "mod1" => "alt",
      "super" | "mod4" => "super",
      "shift" => "shift",
      "meta" => "meta",
      "hyper" => "hyper",
      _ => "other",
    };
    mods.push(modifier);
    rest = &stripped[end + 1..];
  }
  if rest.is_empty() {
    return None;
  }
  mods.sort_unstable();
  mods.dedup();
  Some((mods, rest.to_lowercase()))
}

fn same_binding(a: &str, b: &str) -> bool {
  matches!((normalize_binding(a), normalize_binding(b)), (Some(x), Some(y)) if x == y)
}

/// A binding the recorder can't see while GNOME holds it: modifier+Space.
fn is_modifier_space(binding: &str) -> bool {
  matches!(normalize_binding(binding), Some((mods, key)) if !mods.is_empty() && key == "space")
}

/// Every `as`-typed key of `schema` with its current entries. String-typed
/// keys (older `media-keys` versions) are skipped — they can't be edited by
/// removing one array entry.
fn array_keys(schema: &str) -> Vec<(String, Vec<String>)> {
  let Ok(output) = Command::new("gsettings").args(["list-recursively", schema]).output() else {
    return Vec::new();
  };
  if !output.status.success() {
    return Vec::new();
  }
  String::from_utf8_lossy(&output.stdout)
    .lines()
    .filter_map(|line| {
      let mut parts = line.splitn(3, ' ');
      let (_, key, value) = (parts.next()?, parts.next()?, parts.next()?);
      let value = value.trim();
      (value.starts_with('[') || value.starts_with("@as"))
        .then(|| (key.to_string(), parse_string_array(value)))
    })
    .collect()
}

/// Removes every system binding `matches` accepts from its key, returning
/// what was removed so it can be given back later.
fn take_system_bindings(matches: impl Fn(&str) -> bool) -> Vec<TakenBinding> {
  let mut taken = Vec::new();
  for schema in SYSTEM_KEYBINDING_SCHEMAS {
    for (key, entries) in array_keys(schema) {
      let (removed, kept): (Vec<String>, Vec<String>) = entries.into_iter().partition(|b| matches(b));
      if removed.is_empty() || !gsettings_set(schema, &key, &format_string_array(&kept)) {
        continue;
      }
      taken.extend(removed.into_iter().map(|binding| TakenBinding {
        schema: schema.to_string(),
        key: key.clone(),
        binding,
      }));
    }
  }
  taken
}

/// Gives `taken` back to their keys — appended, and only if the key doesn't
/// hold that binding again already (the user may have re-added it).
fn restore_system_bindings(taken: &[TakenBinding]) {
  for entry in taken {
    let Some(raw) = gsettings_get(&entry.schema, &entry.key) else { continue };
    let mut current = parse_string_array(&raw);
    if current.iter().any(|b| same_binding(b, &entry.binding)) {
      continue;
    }
    current.push(entry.binding.clone());
    gsettings_set(&entry.schema, &entry.key, &format_string_array(&current));
  }
}

fn stored_bindings(name: &str) -> Vec<TakenBinding> {
  let Ok(output) = Command::new("dconf").args(["read", &format!("{MAGIBAR_DCONF_DIR}/{name}")]).output() else {
    return Vec::new();
  };
  parse_string_array(&String::from_utf8_lossy(&output.stdout)).iter().filter_map(|raw| TakenBinding::decode(raw)).collect()
}

fn store_bindings(name: &str, taken: &[TakenBinding]) {
  let path = format!("{MAGIBAR_DCONF_DIR}/{name}");
  let _ = if taken.is_empty() {
    Command::new("dconf").args(["reset", &path]).status()
  } else {
    let encoded: Vec<String> = taken.iter().map(TakenBinding::encode).collect();
    Command::new("dconf").args(["write", &path, &format_string_array(&encoded)]).status()
  };
}

fn displaced_name(id: &str) -> String {
  format!("displaced-{}", slot_id(id))
}

/// Takes `binding` away from every system shortcut holding it, on behalf of
/// hotkey `id`, adding to what that id already displaced.
fn displace_for(id: &str, binding: &str) {
  let mut displaced = stored_bindings(&displaced_name(id));
  for entry in take_system_bindings(|b| same_binding(b, binding)) {
    if !displaced.contains(&entry) {
      displaced.push(entry);
    }
  }
  store_bindings(&displaced_name(id), &displaced);
}

/// Gives back everything hotkey `id` displaced, except entries for `keep` —
/// the binding it's about to (re-)take anyway.
fn release_displaced(id: &str, keep: Option<&str>) {
  let (kept, released): (Vec<TakenBinding>, Vec<TakenBinding>) = stored_bindings(&displaced_name(id))
    .into_iter()
    .partition(|entry| keep.is_some_and(|binding| same_binding(&entry.binding, binding)));
  restore_system_bindings(&released);
  store_bindings(&displaced_name(id), &kept);
}

/// Lifts every modifier+Space system binding while a recorder is open. A
/// no-op if a suspension is already in effect, so nested starts never
/// overwrite the record of what to give back.
fn suspend_for_capture() {
  if !stored_bindings("suspended").is_empty() {
    return;
  }
  store_bindings("suspended", &take_system_bindings(is_modifier_space));
}

/// Ends `suspend_for_capture`. A suspended binding that a Magibar hotkey now
/// uses (the user just recorded Alt+Space) isn't given back to GNOME — it's
/// moved to that hotkey's displaced list instead, so the new hotkey works.
fn resume_after_capture(registered: &HashMap<String, String>) {
  let suspended = stored_bindings("suspended");
  let mut restore = Vec::new();
  for entry in suspended {
    match registered.iter().find(|(_, binding)| same_binding(binding, &entry.binding)) {
      Some((id, _)) => {
        let mut displaced = stored_bindings(&displaced_name(id));
        if !displaced.contains(&entry) {
          displaced.push(entry);
        }
        store_bindings(&displaced_name(id), &displaced);
      }
      None => restore.push(entry),
    }
  }
  restore_system_bindings(&restore);
  store_bindings("suspended", &[]);
}

fn hotkey_callback() -> &'static Mutex<Option<ThreadsafeFunction<String>>> {
  static CALLBACK: OnceLock<Mutex<Option<ThreadsafeFunction<String>>>> = OnceLock::new();
  CALLBACK.get_or_init(|| Mutex::new(None))
}

/// `slot_id(id) -> id` for every currently-registered hotkey — both the
/// source of truth `HotkeyService::trigger` resolves a `Trigger` call's
/// (sanitized, per `slot_id`'s doc) argument back to the real id through,
/// and the guard against a `Trigger` call for an id that was just
/// `unregister`ed (its custom-keybinding CRUD may not have caught up yet —
/// GNOME's `media-keys` plugin re-reads dconf on its own schedule) firing
/// anyway.
fn slot_registry() -> &'static Mutex<HashMap<String, String>> {
  static REGISTRY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
  REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `Trigger` D-Bus service (`HOTKEY_BUS_NAME`/`HOTKEY_INTERFACE`) every
/// custom keybinding's `gdbus call` invokes — see the module doc. `slot`
/// is `slot_id(id)`, not `id` itself (see `slot_id`'s doc for why), so the
/// first thing this does is translate it back.
struct HotkeyService;

#[zbus::interface(name = "app.magibar.Hotkeys")]
impl HotkeyService {
  fn trigger(&self, slot: String) {
    let Some(id) = slot_registry().lock().unwrap().get(&slot).cloned() else {
      return;
    };
    if let Some(tsfn) = hotkey_callback().lock().unwrap().as_ref() {
      tsfn.call(Ok(id), ThreadsafeFunctionCallMode::NonBlocking);
    }
  }
}

/// Handle for the background hotkey watcher `start_hotkey_watcher` starts —
/// mirrors `native/win`/`native/mac`'s `HotkeyWatcher` shape so `main/
/// native/hotkeys.ts` needs no Linux-specific branch of its own. Owns one
/// background worker thread that serializes `register`/`unregister` into
/// `gsettings`/`dconf` CRUD calls and, on the same connection, hosts the
/// `Trigger` D-Bus service for the life of the process.
#[napi]
pub struct HotkeyWatcher {
  worker_tx: mpsc::Sender<HotkeyCommand>,
  worker: Option<JoinHandle<()>>,
}

enum HotkeyCommand {
  Register(String, String, mpsc::Sender<bool>),
  Unregister(String),
  StartCapture,
  StopCapture,
  Stop,
}

#[napi]
impl HotkeyWatcher {
  /// Parses `accelerator` and, if it parses, round-trips a CRUD request to
  /// the worker thread and returns whether every `gsettings`/`dconf` call
  /// actually succeeded — see `upsert_custom_keybinding`'s doc for why this
  /// is a real synchronous answer. `false` for an unrepresentable
  /// accelerator string without even reaching the worker.
  #[napi]
  pub fn register(&self, id: String, accelerator: String) -> bool {
    let Some(binding) = accelerator_to_binding(&accelerator) else {
      return false;
    };
    let (reply_tx, reply_rx) = mpsc::channel();
    if self.worker_tx.send(HotkeyCommand::Register(id.clone(), binding, reply_tx)).is_err() {
      return false;
    }
    slot_registry().lock().unwrap().insert(slot_id(&id), id);
    reply_rx.recv().unwrap_or(false)
  }

  /// Idempotent — removing an id that isn't registered is a no-op.
  #[napi]
  pub fn unregister(&self, id: String) {
    slot_registry().lock().unwrap().remove(&slot_id(&id));
    let _ = self.worker_tx.send(HotkeyCommand::Unregister(id));
  }

  /// Never reports keystrokes — a `media-keys` custom keybinding has no way
  /// to observe one (it only ever runs its command once bound), so a
  /// shortcut recorder here relies on the renderer's own DOM listener. What
  /// this does do is lift GNOME's modifier+Space shortcuts for the duration
  /// (see `suspend_for_capture`), which would otherwise swallow exactly the
  /// combos a launcher toggle is usually set to before that listener sees them.
  #[napi]
  pub fn start_capture(&self, _callback: ThreadsafeFunction<String>) {
    let _ = self.worker_tx.send(HotkeyCommand::StartCapture);
  }

  /// Gives back what `start_capture` lifted (see `resume_after_capture`).
  #[napi]
  pub fn stop_capture(&self) {
    let _ = self.worker_tx.send(HotkeyCommand::StopCapture);
  }

  /// Stops the worker thread (which also drops the `Trigger` D-Bus service's
  /// connection, releasing `HOTKEY_BUS_NAME`). Deliberately leaves every
  /// registered custom keybinding in place rather than tearing them down on
  /// every app quit — they're inert (their `Trigger` call just fails to find
  /// anything listening) until the app starts again, and re-creating them
  /// from scratch on every launch would mean a brief window after each
  /// startup where the user's configured hotkey doesn't work yet. Idempotent.
  #[napi]
  pub fn stop(&mut self) {
    let _ = self.worker_tx.send(HotkeyCommand::Stop);
    if let Some(thread) = self.worker.take() {
      let _ = thread.join();
    }
    slot_registry().lock().unwrap().clear();
    *hotkey_callback().lock().unwrap() = None;
  }
}

/// Starts the global-hotkey watcher: a background thread opens a D-Bus
/// session connection, claims `HOTKEY_BUS_NAME`, and hosts `HotkeyService`
/// on it (serviced automatically by `zbus`'s own internal executor for as
/// long as the connection stays open — no explicit dispatch loop needed),
/// then processes `register`/`unregister` calls (relayed from the returned
/// `HotkeyWatcher`) into `gsettings`/`dconf` CRUD against that same
/// connection's lifetime.
#[napi]
pub fn start_hotkey_watcher(callback: ThreadsafeFunction<String>) -> HotkeyWatcher {
  *hotkey_callback().lock().unwrap() = Some(callback);
  slot_registry().lock().unwrap().clear();

  let (worker_tx, worker_rx) = mpsc::channel::<HotkeyCommand>();

  let worker = std::thread::spawn(move || {
    let conn = match zbus::blocking::Connection::session() {
      Ok(conn) => conn,
      Err(error) => {
        eprintln!("[linux-hotkeys] session bus connect failed: {error}");
        return;
      }
    };
    if let Err(error) = conn.object_server().at(HOTKEY_OBJECT_PATH, HotkeyService) {
      eprintln!("[linux-hotkeys] failed to host Trigger service: {error}");
      return;
    }
    if let Err(error) = conn.request_name(HOTKEY_BUS_NAME) {
      eprintln!("[linux-hotkeys] failed to claim {HOTKEY_BUS_NAME}: {error}");
      return;
    }

    // A crash mid-recording would otherwise leave GNOME's modifier+Space
    // shortcuts lifted for good. Nothing is registered yet, so all of them
    // go back; registering below re-takes any a hotkey actually uses.
    resume_after_capture(&HashMap::new());

    // id -> binding this process has registered (and displaced for) so far.
    let mut registered: HashMap<String, String> = HashMap::new();

    for command in worker_rx {
      match command {
        HotkeyCommand::Register(id, binding, reply) => {
          // `register` is re-asserted on every "is it still held?" pass, so
          // the system-binding scan only runs when the binding is new here.
          if registered.get(&id) != Some(&binding) {
            // Also covers a binding displaced by an earlier run for a combo
            // this id no longer uses.
            release_displaced(&id, Some(&binding));
            displace_for(&id, &binding);
            registered.insert(id.clone(), binding.clone());
          }
          let _ = reply.send(upsert_custom_keybinding(&id, &binding));
        }
        HotkeyCommand::Unregister(id) => {
          remove_custom_keybinding(&id);
          release_displaced(&id, None);
          registered.remove(&id);
        }
        HotkeyCommand::StartCapture => suspend_for_capture(),
        HotkeyCommand::StopCapture => resume_after_capture(&registered),
        HotkeyCommand::Stop => break,
      }
    }

    // Quitting mid-recording: give the lifted shortcuts back now.
    resume_after_capture(&registered);

    let _ = conn.release_name(HOTKEY_BUS_NAME);
  });

  HotkeyWatcher { worker_tx, worker: Some(worker) }
}

