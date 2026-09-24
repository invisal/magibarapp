import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { applyLiquidGlass } from "./native";
import { restoredPosition } from "./window-chrome";
import { settings } from "./actions";

const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 500;

/** How long to wait after the last `moved` event before writing the launcher's position to disk. */
const MOVE_SAVE_DEBOUNCE_MS = 400;

/**
 * The launcher's own window — a singleton owned here rather than by the app
 * entry, so other main-process modules (e.g. the Widget editor window) can
 * bring it back to the front without importing `index.ts` and creating an
 * import cycle through the entry point.
 */
let launcherWindow: BrowserWindow | null = null;

/** The launcher window, or `null` before it's created / after it's destroyed. */
export function getLauncherWindow(): BrowserWindow | null {
  return launcherWindow;
}

export function createLauncherWindow(keepOpen: () => boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: "#00000000",
    ...(process.platform === "win32"
      ? { backgroundMaterial: "acrylic" as const }
      : {}),
    // macOS gets its blur from `electron-liquid-glass` (applied after the window
    // is created). That native view needs a transparent window with `vibrancy`
    // unset — combining the two makes the compositing wrong.
    ...(process.platform === "darwin" ? { transparent: true } : {}),
    ...(process.platform === "linux" ? { transparent: true } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.platform === "darwin") {
    // Attach the glass view once the web contents have painted, so it composites
    // under a live renderer rather than a blank frame.
    win.webContents.once("did-finish-load", () => applyLiquidGlass(win));
    // Without this, showing the window switches macOS to whatever Space/full-screen
    // app it "belongs to" instead of overlaying the one the user is currently on.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.on("blur", () => {
    if (!keepOpen()) {
      win.hide();
    }
  });

  // The launcher is a draggable-header window (see `Footer`/`ListScreen`'s
  // `-webkit-app-region: drag`), but it's almost never destroyed mid-session —
  // it's hidden and reshown on every toggle instead — so unlike the Settings/
  // Widget windows we can't wait for `close` to persist a moved position.
  // Debounced instead of writing on every intermediate drag frame.
  let moveSaveTimer: NodeJS.Timeout | null = null;
  win.on("moved", () => {
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const bounds = win.getBounds();
      const saved = settings.getWindowBounds("launcher");
      // Skip the write if this "move" was actually just `showLauncher`
      // re-applying the position it already restored (or re-centering).
      if (saved && saved.x === bounds.x && saved.y === bounds.y) return;
      settings.setWindowBounds("launcher", bounds);
    }, MOVE_SAVE_DEBOUNCE_MS);
  });

  win.on("closed", () => {
    if (launcherWindow === win) launcherWindow = null;
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  launcherWindow = win;
  return win;
}

/**
 * Bring the launcher to the front — at the position the user last dragged it
 * to, or centered on the display under the cursor if it's never been moved
 * (or that position no longer lands on a connected display). Does not capture
 * the foreground window — callers that need window-management commands to
 * target whatever the user was in must do that first (see `toggleLauncher` in
 * the app entry). Returning from the Widget editor window deliberately keeps
 * the capture from when the launcher was first opened.
 */
export function showLauncher(): void {
  if (!launcherWindow) return;
  const saved = restoredPosition(settings, "launcher");
  if (saved) {
    launcherWindow.setPosition(saved.x, saved.y);
  } else {
    centerOnActiveDisplay(launcherWindow);
  }
  launcherWindow.show();
  launcherWindow.focus();
}

export function hideLauncher(): void {
  launcherWindow?.hide();
}

export function centerOnActiveDisplay(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const bounds = win.getBounds();
  win.setPosition(
    Math.round(x + (width - bounds.width) / 2),
    Math.round(y + (height - bounds.height) / 3),
  );
}
