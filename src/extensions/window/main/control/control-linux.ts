import { app, dialog } from "electron";
import { createRequire } from "node:module";
import {
  allDisplays,
  currentDisplay,
  toRect,
  workAreaFor,
} from "./electron-screen";
import {
  computeCustomRect,
  computeEdgeMove,
  computeTargetRect,
  mapRectToDisplay,
  pickAdjacentDisplay,
  type Rect,
} from "./layout";
import { popRestore, saveForRestore } from "./restore-stack";
import {
  install as installGnomeExtension,
  isGnomeSession,
  isOutdated as gnomeExtensionOutdated,
  requestLogout,
  status as gnomeExtensionStatus,
} from "./gnome-extension";
import type { CustomLayoutGeometry, EdgeDirection, SnapRegion } from "./layout";

export type { CustomLayoutGeometry, EdgeDirection, SnapRegion } from "./layout";

/**
 * `@magibar/linux` is an optionalDependency that only installs on linux, so
 * it can't be a static import here — that would crash at module-load time on
 * every other platform, well before the `process.platform` checks below run.
 * `createRequire` gives us a synchronous, lazily-invoked load from this ESM
 * module without pulling in a top-level `require`.
 */
type NativeLinux = typeof import("@magibar/linux");
const nodeRequire = createRequire(import.meta.url);
let native: NativeLinux | null | undefined;

function loadNative(): NativeLinux | null {
  if (native !== undefined) return native;
  if (process.platform !== "linux") return (native = null);
  try {
    native = nodeRequire("@magibar/linux") as NativeLinux;
  } catch (error) {
    console.error("[window/linux] Failed to load @magibar/linux:", error);
    native = null;
  }
  return native;
}

/**
 * Linux-side window control, over two backends that address windows in
 * completely different ways — hence `CapturedWindow` below, which records
 * *which* one a capture came from rather than assuming.
 *
 * **GNOME Shell extension (preferred).** On a Wayland session no external
 * process can move another application's window: Wayland's security model has
 * no cross-app window-control protocol at all. The only supported way in is to
 * run code inside the compositor, so Magibar ships a GNOME Shell extension
 * (`resources/gnome-extension/magibar@magibar.app`) exposing a private D-Bus
 * API, which the native addon calls (`gnomeShellAvailable` and friends). This
 * is the path that works for ordinary GNOME apps today, since they are
 * overwhelmingly Wayland-native.
 *
 * **X11/EWMH (fallback).** Direct EWMH-over-X11 calls through the native
 * addon, for every other desktop — KDE, XFCE, i3, and any GNOME session where
 * the extension isn't installed. Also the path for XWayland-backed windows.
 * It cannot see, let alone move, a Wayland-native window; that isn't a gap in
 * this implementation but the platform limit described above.
 *
 * The two are tried in that order per capture, so a GNOME user who hasn't
 * installed the extension still gets working window management for whatever
 * XWayland apps they run, and a non-GNOME user is unaffected by any of it.
 */

/**
 * Magibar's own application id, so a capture that happens while the launcher
 * itself holds focus is discarded rather than acted on later. The GNOME
 * counterpart of the X11 path's `exclude` window id — the two can't share a
 * value because Mutter's stable sequence and an X11 window id are unrelated
 * numbers for unrelated things.
 */
function ownAppId(): string {
  return app.getName();
}

type CapturedWindow =
  { backend: "gnome"; id: number } | { backend: "x11"; id: number };

/** The window captured just before the launcher took focus; `null` when none. */
let captured: CapturedWindow | null = null;

/**
 * Whether the GNOME extension is answering on D-Bus *right now*. Not cached:
 * the user can install, enable, or disable it — and GNOME Shell itself can
 * restart — while Magibar keeps running, and the previous version of this
 * file cached exactly this kind of answer for the process's lifetime, which
 * is what made window management stay hidden for a whole session.
 */
function gnomeReady(): boolean {
  return loadNative()?.gnomeShellAvailable() ?? false;
}

/**
 * Whether any real application window is reachable via X11/XWayland. On a
 * Wayland session where every running app is a native Wayland client there are
 * no XWayland windows for the X11 connection to act on, not even in principle.
 *
 * Re-checked on each call rather than cached for the process's lifetime: an
 * X11 app started after Magibar is an entirely normal thing to do, and caching
 * the startup answer meant the feature stayed switched off for the rest of the
 * session no matter what the user opened afterwards.
 */
export function hasXWaylandWindows(): boolean {
  return loadNative()?.hasXwaylandWindows() ?? false;
}

/**
 * Whether to offer window-management commands at all.
 *
 * True on any GNOME session even with the extension not yet installed —
 * running a command there prompts to install it (see `reportUnavailable`),
 * which is a real, actionable path to the feature working rather than the
 * silent no-op this check exists to prevent. Elsewhere it comes down to
 * whether there's an X11 window to act on.
 */
export function isSupported(): boolean {
  return isGnomeSession() || gnomeReady() || hasXWaylandWindows();
}

/**
 * Records the currently active window. `exclude` is the launcher's own X11
 * window id (see `launcherHandle()` in `index.ts`), used only by the X11
 * backend; the GNOME backend excludes by application id instead.
 */
export function capture(exclude?: number): void {
  captured = null;
  const linux = loadNative();
  if (!linux) return;

  if (gnomeReady()) {
    const id = linux.gnomeActiveWindow(ownAppId());
    if (id !== 0) {
      captured = { backend: "gnome", id };
      return;
    }
  }

  const id = linux.activeWindow(exclude ?? 0);
  if (id !== 0) captured = { backend: "x11", id };
}

function restoreKey(target: CapturedWindow): string {
  return `linux:${target.backend}:${target.id}`;
}

function readFrame(target: CapturedWindow): Rect | null {
  const linux = loadNative();
  const rect =
    target.backend === "gnome"
      ? (linux?.gnomeGetWindowRect(target.id) ?? null)
      : (linux?.getWindowRect(target.id) ?? null);
  if (!rect) void reportUnavailable();
  return rect;
}

function writeFrame(target: CapturedWindow, rect: Rect): boolean {
  const linux = loadNative();
  const ok =
    target.backend === "gnome"
      ? (linux?.gnomeApplyWindowRect(target.id, rect) ?? false)
      : (linux?.applyWindowRect(target.id, rect) ?? false);
  if (!ok) void reportUnavailable();
  return ok;
}

/**
 * Explains why a command did nothing, and — on GNOME, where there is something
 * the user can actually do about it — offers to fix it.
 *
 * Shown at most once per session so a run of failures doesn't stack dialogs,
 * except that a successful install resets it: the next failure after that is
 * genuinely new information rather than a repeat of the same complaint.
 */
let unavailableDialogShown = false;
async function reportUnavailable(): Promise<void> {
  if (unavailableDialogShown) return;
  unavailableDialogShown = true;

  if (!isGnomeSession() || gnomeReady()) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Magibar couldn't move this window",
      detail:
        "Window Management needs a reachable X server (this includes XWayland-backed apps under a Wayland session). A Wayland-native window can't be moved by any external app — that's a Wayland platform limitation, not something Magibar can work around.",
      buttons: ["OK"],
      defaultId: 0,
    });
    return;
  }

  // Installed and enabled already, just not loaded — offering to install it
  // again would be busywork that changes nothing, since only a login loads it.
  if ((await gnomeExtensionStatus()) === "needs-restart") {
    await offerLogout(
      "Magibar's GNOME extension is waiting for a restart",
      "The extension is installed and enabled, but GNOME only loads extensions at login. Log out and back in to finish enabling it — Window Management will work on all your windows from then on.",
    );
    return;
  }

  const outdated = await gnomeExtensionOutdated();
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: outdated
      ? "Magibar's GNOME extension needs updating"
      : "Window Management needs a GNOME extension",
    detail:
      "On a Wayland session, no application can move another app's windows on its own — Wayland has no protocol for it. Magibar works around this with a small GNOME Shell extension that does the moving from inside GNOME.\n\nMagibar can install it for you. GNOME only loads new extensions at login, so it takes effect after you log out and back in.",
    buttons: [outdated ? "Update and Enable" : "Install and Enable", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  await installGnomeExtension();
  unavailableDialogShown = false;
  await offerLogout(
    "Extension installed",
    "Log out and back in to finish enabling it. Window Management commands will work on all your windows from then on.",
  );
}

/**
 * The "you need to log back in" prompt, shared by the just-installed and
 * already-installed-but-not-loaded paths — the only difference between them is
 * the wording, since the remaining step is identical.
 */
async function offerLogout(message: string, detail: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "info",
    message,
    detail,
    buttons: ["Log Out Now", "Later"],
    defaultId: 1,
    cancelId: 1,
  });
  // Hands off to GNOME's own logout flow, which prompts again and lets the
  // user cancel — logging out discards whatever else they have open, so this
  // never happens silently on Magibar's say-so.
  if (response === 0) void requestLogout();
}

/**
 * Shared by `applyRegion`/`applyCustomLayout`: capture check, read the current
 * frame, compute, save-for-restore, write.
 */
async function applyComputedRect(
  computeRect: (workArea: Rect, currentRect: Rect) => Rect,
): Promise<boolean> {
  const target = captured;
  if (!target) return notifyNoTarget();

  const current = readFrame(target);
  if (!current) return false;

  const next = computeRect(workAreaFor(current), current);
  saveForRestore(restoreKey(target), current);
  return writeFrame(target, next);
}

/**
 * Nothing was captured at all — which on GNOME almost always means the
 * extension isn't running (the X11 backend can't see Wayland windows, so it
 * had nothing to capture either). Routed through the same reporting path so
 * the user gets the install offer instead of a command that silently does
 * nothing.
 */
async function notifyNoTarget(): Promise<boolean> {
  await reportUnavailable();
  return false;
}

export function applyRegion(region: SnapRegion): Promise<boolean> {
  return applyComputedRect((workArea, currentRect) =>
    computeTargetRect(region, { workArea, currentRect }),
  );
}

export function applyCustomLayout(
  layout: CustomLayoutGeometry,
  useGap: boolean,
  gapPx: number,
): Promise<boolean> {
  return applyComputedRect((workArea, currentRect) =>
    computeCustomRect(layout, { workArea, currentRect, useGap, gapPx }),
  );
}

export async function moveToDisplay(
  direction: "next" | "previous",
): Promise<boolean> {
  const target = captured;
  if (!target) return notifyNoTarget();

  const current = readFrame(target);
  if (!current) return false;

  const display = currentDisplay(current);
  const next = pickAdjacentDisplay(allDisplays(), display.id, direction);
  if (!next) return false;

  const rect = mapRectToDisplay(
    current,
    toRect(display.workArea),
    next.workArea,
  );
  saveForRestore(restoreKey(target), current);
  return writeFrame(target, rect);
}

export async function moveToEdge(direction: EdgeDirection): Promise<boolean> {
  const target = captured;
  if (!target) return notifyNoTarget();

  const current = readFrame(target);
  if (!current) return false;

  const next = computeEdgeMove(direction, workAreaFor(current), current);
  saveForRestore(restoreKey(target), current);
  return writeFrame(target, next);
}

export async function restore(): Promise<boolean> {
  const target = captured;
  if (!target) return notifyNoTarget();

  const previous = popRestore(restoreKey(target));
  if (!previous) return false;
  return writeFrame(target, previous);
}

/**
 * GNOME's `make_fullscreen`/`unmake_fullscreen` via the extension, or EWMH
 * `_NET_WM_STATE_FULLSCREEN` (broadly supported across X11 window managers) on
 * the fallback path.
 */
export async function toggleFullscreen(): Promise<boolean> {
  const target = captured;
  if (!target) return notifyNoTarget();

  const linux = loadNative();
  const ok =
    target.backend === "gnome"
      ? (linux?.gnomeToggleFullscreen(target.id) ?? false)
      : (linux?.toggleFullscreen(target.id) ?? false);
  if (!ok) void reportUnavailable();
  return ok;
}
