import {
  BrowserWindow,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
} from "electron";
import { IPC_CHANNELS } from "../shared/types";
import type {
  SettingsStore,
  WindowBounds,
  WindowBoundsKey,
} from "./settings/store";

/**
 * Constructor options shared by the framed windows (Settings, Widget), which
 * hide the OS title bar and draw their own via `renderer/src/shared/ui/WindowFrame`.
 *
 * They also get a translucent backing so the desktop shows through, the same
 * idea as the launcher (see `window.ts`): acrylic on Windows, vibrancy on macOS.
 * The renderer paints a semi-transparent panel on top — see `window-frame.css`.
 *
 * - macOS keeps its traffic lights (`titleBarStyle: 'hidden'`) sitting over the
 *   left of our title bar, and gets `under-window` vibrancy. No liquid glass
 *   here — that needs its own native view and fights `vibrancy` (see glass.ts).
 * - Windows/Linux drop the frame entirely; the renderer draws the min/max/close
 *   buttons and calls back through `window.api.windowControls`. Windows gets the
 *   `acrylic` background material; Linux just goes transparent.
 */
export const framelessChrome: BrowserWindowConstructorOptions = {
  // A translucent (fully transparent) backing colour so acrylic/vibrancy isn't
  // painted over. The renderer's `.window-frame` panel provides the tint.
  backgroundColor: "#00000000",
  ...(process.platform === "darwin"
    ? {
        titleBarStyle: "hidden" as const,
        // Centers the traffic lights in the 36px (`h-9`) title bar `WindowFrame`
        // draws — measured against the title text's own (correctly centered)
        // baseline: `y: 16` sits the button cluster ~5px low, most visible
        // next to a short title like "Welcome to Magibar".
        trafficLightPosition: { x: 16, y: 11 },
        vibrancy: "under-window" as const,
      }
    : process.platform === "win32"
      ? { frame: false, backgroundMaterial: "acrylic" as const }
      : { frame: false, transparent: true }),
};

/**
 * Wires the `window:*` channels once. Each acts on whichever `BrowserWindow` the
 * message came from, so a single registration covers every framed window.
 */
export function registerWindowControlsIpc(): void {
  ipcMain.on(IPC_CHANNELS.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

/** True if `bounds` overlaps some connected display's work area — a saved position can go stale (e.g. a monitor gets unplugged). */
function isOnScreen(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y
    );
  });
}

/**
 * The saved position+size for `key` if there is one and it still lands on a
 * connected display, else `fallback` — spread this into `BrowserWindow`
 * constructor options.
 */
export function restoredBounds(
  settings: SettingsStore,
  key: WindowBoundsKey,
  fallback: { width: number; height: number },
): WindowBounds | { width: number; height: number } {
  const saved = settings.getWindowBounds(key);
  return saved && isOnScreen(saved) ? saved : fallback;
}

/**
 * The saved top-left position for `key` if there is one and it still lands on
 * a connected display, else `null`. For a fixed-size window (the launcher),
 * which repositions on every show rather than reading bounds once at
 * construction — see `showLauncher`.
 */
export function restoredPosition(
  settings: SettingsStore,
  key: WindowBoundsKey,
): { x: number; y: number } | null {
  const saved = settings.getWindowBounds(key);
  return saved && isOnScreen(saved) ? { x: saved.x, y: saved.y } : null;
}

/**
 * Saves `win`'s position+size under `key` when it closes, so the next window
 * created for `key` can reopen there (see `restoredBounds`). Reads bounds on
 * `close` rather than `moved`/`resized` so dragging doesn't hit disk on every
 * intermediate frame; a maximized/minimized window skips saving since its
 * bounds aren't a position the user chose to be restored to.
 */
export function persistWindowBounds(
  win: BrowserWindow,
  settings: SettingsStore,
  key: WindowBoundsKey,
): void {
  win.on("close", () => {
    if (win.isMinimized() || win.isMaximized()) return;
    settings.setWindowBounds(key, win.getBounds());
  });
}
