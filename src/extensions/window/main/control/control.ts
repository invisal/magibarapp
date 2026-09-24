import * as linux from "./control-linux";
import * as mac from "./control-mac";
import * as win from "./control-win";

export type {
  CustomLayoutGeometry,
  EdgeDirection,
  FractionSpan,
  GridRegion,
  SnapRegion,
} from "./layout";
export { GRID_REGION_IDS, regionSpan } from "./layout";
import type { CustomLayoutGeometry, EdgeDirection, SnapRegion } from "./layout";

/**
 * Platform dispatcher for window control — mirrors the `apps.ts` →
 * `apps-mac.ts`/`apps-worker.ts` split. Callers (the `win:` action source, and
 * the global-shortcut handlers in `index.ts`) go through this module only, so
 * none of them needs a `process.platform` branch of its own.
 */
function impl(): typeof win | typeof mac | typeof linux | null {
  if (process.platform === "win32") return win;
  if (process.platform === "darwin") return mac;
  if (process.platform === "linux") return linux;
  return null;
}

/**
 * Whether window management can actually work here — beyond just "is there a
 * backend for this platform at all" (`impl()` above). win32/darwin always
 * have a real native window to act on; on Linux it depends on the desktop and
 * on what's running right now, so `control-linux.ts` decides (see
 * `isSupported` there).
 *
 * Deliberately answered fresh on every call rather than cached, because on
 * Linux it genuinely changes during a session: the user can install or enable
 * Magibar's GNOME Shell extension, GNOME Shell can restart, and an X11 app can
 * be started long after Magibar. Caching this once at startup is what
 * previously made the whole feature stay hidden for the rest of the session.
 * Callers must not hoist it into a module-level constant for the same reason.
 */
export function isSupported(): boolean {
  if (process.platform === "win32" || process.platform === "darwin")
    return true;
  if (process.platform === "linux") return linux.isSupported();
  return false;
}

/**
 * Records the window/app the user was focused on before it loses focus.
 * `excludeHandle` is the launcher's own window handle on Windows/Linux (so a
 * stray capture of the launcher itself isn't moved later); macOS self-excludes
 * via pid and ignores this parameter.
 */
export function captureFocusedWindow(excludeHandle?: number): void {
  switch (process.platform) {
    case "win32":
      win.capture(excludeHandle);
      return;
    case "darwin":
      mac.capture();
      return;
    case "linux":
      linux.capture(excludeHandle);
      return;
    default:
      return;
  }
}

export function applyRegion(region: SnapRegion): Promise<boolean> {
  return impl()?.applyRegion(region) ?? Promise.resolve(false);
}

export function applyCustomLayout(
  layout: CustomLayoutGeometry,
  useGap: boolean,
  gapPx: number,
): Promise<boolean> {
  return (
    impl()?.applyCustomLayout(layout, useGap, gapPx) ?? Promise.resolve(false)
  );
}

export function moveToDisplay(
  direction: "next" | "previous",
): Promise<boolean> {
  return impl()?.moveToDisplay(direction) ?? Promise.resolve(false);
}

export function moveToEdge(direction: EdgeDirection): Promise<boolean> {
  return impl()?.moveToEdge(direction) ?? Promise.resolve(false);
}

export function restore(): Promise<boolean> {
  return impl()?.restore() ?? Promise.resolve(false);
}

export function toggleFullscreen(): Promise<boolean> {
  return impl()?.toggleFullscreen() ?? Promise.resolve(false);
}
