/**
 * Magibar's GNOME Shell side of window management.
 *
 * Why this exists at all: on a Wayland session no external process can move
 * another application's window — Wayland's security model simply has no
 * cross-app window-control protocol, which is why the X11/EWMH path in
 * `control-linux.ts` can only ever reach XWayland-backed windows. Code running
 * *inside* the compositor has no such limit, and a GNOME Shell extension is
 * the only supported way to get code in there. GNOME's own
 * `org.gnome.Shell.Introspect` is read-only and refuses unprivileged callers,
 * and `org.gnome.Shell.Eval` is disabled outside unsafe mode, so neither is a
 * way around shipping this.
 *
 * The API deliberately stays tiny and mechanical — find a window, read its
 * frame, write its frame. All the layout math (regions, thirds, gaps, custom
 * layouts, multi-monitor mapping) stays on the Magibar side in `layout.ts`,
 * shared with the Windows and macOS backends, so this file never has to be
 * updated when a new snap region is added.
 *
 * Windows are addressed by Mutter's stable sequence (`get_stable_sequence()`),
 * a per-session unique id. Magibar captures one id at the moment the launcher
 * takes focus and then acts on it for the rest of the interaction, so the id
 * has to stay valid across focus changes — which a "currently focused window"
 * lookup would not.
 */

import Gio from "gi://Gio";
import Meta from "gi://Meta";

/**
 * Magibar's own bus name rather than exporting onto `org.gnome.Shell`. It
 * makes "is the extension installed, enabled, and actually running right
 * now?" a single name-has-owner check on the Magibar side (see
 * `gnomeShellAvailable` in `native/linux/src/lib.rs`) instead of a speculative
 * method call, and it keeps this API from looking like part of GNOME's own.
 */
const BUS_NAME = "app.magibar.Shell";
const OBJECT_PATH = "/app/magibar/Shell";

/**
 * Bumped whenever the interface below changes in a way Magibar's client cares
 * about. Magibar compares this against the version it ships and silently
 * re-installs the extension when the copy on disk is older, so a Magibar
 * update never leaves a stale extension exporting an interface its client no
 * longer matches. Keep in sync with `BUNDLED_EXTENSION_VERSION` in
 * `gnome-extension.ts`.
 */
const API_VERSION = 1;

const IFACE = `
<node>
  <interface name="app.magibar.WindowManager">
    <method name="Version">
      <arg type="u" direction="out" name="version"/>
    </method>
    <method name="HasWindows">
      <arg type="b" direction="out" name="present"/>
    </method>
    <method name="GetFocused">
      <arg type="s" direction="in" name="excludeAppId"/>
      <arg type="u" direction="out" name="id"/>
    </method>
    <method name="GetRect">
      <arg type="u" direction="in" name="id"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
    </method>
    <method name="MoveResize">
      <arg type="u" direction="in" name="id"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ToggleFullscreen">
      <arg type="u" direction="in" name="id"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

/**
 * Every real application window, newest-first is irrelevant here — what
 * matters is that override-redirect surfaces (menus, tooltips, the shell's
 * own chrome) are filtered out, since none of them is something a user would
 * ever mean by "this window".
 */
function applicationWindows() {
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter((win) => win && !win.is_override_redirect() && win.get_window_type() === Meta.WindowType.NORMAL);
}

function windowById(id) {
  return applicationWindows().find((win) => win.get_stable_sequence() === id) ?? null;
}

/**
 * Whether the window is maximized in either direction.
 *
 * Mutter renamed this across the shell versions `metadata.json` claims
 * support for: GNOME 50's Mutter (libmutter-18) exposes `is_maximized()` and
 * dropped the older `get_maximized()` entirely, so calling either one
 * unconditionally throws on some supported version. The
 * `maximized_horizontally`/`maximized_vertically` properties are the last
 * resort because they have outlived both methods.
 */
function isMaximized(win) {
  if (typeof win.is_maximized === "function") return win.is_maximized();
  if (typeof win.get_maximized === "function") return win.get_maximized() !== 0;
  return win.maximized_horizontally || win.maximized_vertically;
}

/**
 * Whether `win` belongs to `appId` — checked against all three identifiers a
 * window can carry, because which of them is populated depends on how the app
 * connects. A Wayland-native GTK app sets `gtk_application_id` and often no
 * WM_CLASS at all; an XWayland client (which Magibar itself is — it runs with
 * `--ozone-platform=x11`) sets WM_CLASS and no GTK id. Matching only one would
 * work in exactly one of those cases.
 */
function windowMatchesApp(win, appId) {
  if (!appId) return false;
  const wanted = appId.toLowerCase();
  const candidates = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()];
  return candidates.some((value) => value && value.toLowerCase() === wanted);
}

class WindowManagerService {
  Version() {
    return API_VERSION;
  }

  /**
   * Whether there is any window to act on at all. Magibar uses this to decide
   * whether to offer window-management commands, rather than listing commands
   * that would silently do nothing on an empty desktop.
   */
  HasWindows() {
    return applicationWindows().length > 0;
  }

  /**
   * The focused window's id, or `0` if there is none — or if the only
   * candidate belongs to `excludeAppId`, which is Magibar's own application
   * id. Magibar captures the focused window just *before* showing its
   * launcher, so under normal use the launcher isn't focused yet and the
   * exclusion never triggers; it's the guard for the races where it is
   * (a capture driven by a global hotkey while the launcher is already up),
   * which would otherwise snap the launcher itself.
   */
  GetFocused(excludeAppId) {
    const win = global.display.get_focus_window();
    if (!win || win.is_override_redirect()) return 0;
    if (windowMatchesApp(win, excludeAppId)) return 0;
    return win.get_stable_sequence();
  }

  /**
   * The window's frame rect in stage coordinates — the same logical-pixel
   * space Electron's `screen` module reports display work areas in, so the
   * two need no scale conversion between them (see `electron-screen.ts`).
   * `get_frame_rect` rather than `get_buffer_rect` so the numbers cover the
   * titlebar and exclude the invisible shadow margin, matching what the user
   * sees as the window's edges.
   */
  GetRect(id) {
    const win = windowById(id);
    if (!win) return [false, 0, 0, 0, 0];
    const rect = win.get_frame_rect();
    return [true, rect.x, rect.y, rect.width, rect.height];
  }

  /**
   * Moves and resizes the window. Maximized and fullscreen states are cleared
   * first: Mutter keeps enforcing them over an explicit frame change, so
   * snapping a maximized window would otherwise appear to do nothing at all.
   * A minimized window is restored for the same reason — the move would
   * otherwise land on something the user can't see.
   */
  MoveResize(id, x, y, width, height) {
    const win = windowById(id);
    if (!win) return false;

    if (win.is_fullscreen()) win.unmake_fullscreen();
    if (isMaximized(win)) win.unmaximize(Meta.MaximizeFlags.BOTH);
    if (win.minimized) win.unminimize();

    // `true` = "user operation": tells Mutter this is a deliberate placement,
    // so it won't second-guess it with its own auto-placement heuristics.
    win.move_resize_frame(true, x, y, width, height);
    return true;
  }

  ToggleFullscreen(id) {
    const win = windowById(id);
    if (!win) return false;
    if (win.is_fullscreen()) win.unmake_fullscreen();
    else win.make_fullscreen();
    return true;
  }
}

export default class MagibarExtension {
  enable() {
    this._service = new WindowManagerService();
    this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE, this._service);
    this._exported.export(Gio.DBus.session, OBJECT_PATH);

    // Claimed only after the object is exported, so the name never has an
    // owner that can't yet answer a call — Magibar treats "name has an owner"
    // as "the API is ready".
    this._nameId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
      null,
    );
  }

  disable() {
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = null;
    }
    this._exported?.unexport();
    this._exported = null;
    this._service = null;
  }
}
