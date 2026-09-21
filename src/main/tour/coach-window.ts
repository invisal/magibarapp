import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../shared/types";
import type { CoachLayout } from "../../shared/tour";

/** Anchored to the tray icon: tall enough for the callout to clear the tray menu that drops from / rises to the icon. */
const ANCHOR_SIZE = { width: 400, height: 460 };
/** Centered on screen for the "press your shortcut" prompt and the closing card. */
const CENTER_SIZE = { width: 520, height: 320 };
/** Gap between the icon and the screen edge the overlay must keep. */
const EDGE = 8;

/**
 * The tour's overlay: a transparent, always-on-top, click-through window that
 * draws a pulsing ring over the *tray icon* — native OS UI no web page can
 * reach into. Only the tray and "press your shortcut" steps use it; every
 * other step is drawn inside the window it's about (Settings, the launcher).
 *
 * It never takes focus (so it can't disturb what the user is doing or trip the
 * launcher's blur-to-hide) and passes clicks through everywhere except its
 * card, which asks for them while hovered — see `IPC_CHANNELS.tourCoachInteractive`.
 */
let coach: BrowserWindow | null = null;
let ready: Promise<void> | null = null;

function ensureCoach(): BrowserWindow {
  if (coach && !coach.isDestroyed()) return coach;

  const win = new BrowserWindow({
    ...ANCHOR_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    // macOS otherwise clamps a window below the menu bar, which is exactly where the tray icon is.
    enableLargerThanScreen: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Above the menu bar / taskbar, and over full-screen apps.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("closed", () => {
    if (coach === win) {
      coach = null;
      ready = null;
    }
  });

  ready = new Promise((resolve) =>
    win.webContents.once("did-finish-load", () => resolve()),
  );
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/coach.html`);
  } else {
    win.loadFile(join(__dirname, "../renderer/coach.html"));
  }
  coach = win;
  return win;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Shows the overlay pointing at the tray icon at `trayBounds`. */
export function showCoachAtTray(trayBounds: Rectangle): void {
  const display = screen.getDisplayMatching(trayBounds);
  const area = display.bounds;
  const { width, height } = ANCHOR_SIZE;

  const cx = trayBounds.x + trayBounds.width / 2;
  const cy = trayBounds.y + trayBounds.height / 2;
  // Menu bar sits at the top (callout hangs below); a taskbar at the bottom
  // (callout rises above).
  const placement: CoachLayout["placement"] =
    cy < area.y + area.height / 2 ? "below" : "above";

  const x = clamp(
    Math.round(cx - width / 2),
    area.x + EDGE,
    area.x + area.width - width - EDGE,
  );
  const y =
    placement === "below"
      ? Math.round(trayBounds.y - 6)
      : Math.round(trayBounds.y + trayBounds.height + 6 - height);

  present(
    { x, y, ...ANCHOR_SIZE },
    {
      kind: "anchor",
      ringX: cx - x,
      ringY: cy - y,
      placement,
      ...ANCHOR_SIZE,
    },
  );
}

/** Shows the overlay as a centred prompt on the display under the cursor. */
export function showCoachCentered(): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const size = CENTER_SIZE;
  present(
    {
      x: Math.round(x + (width - size.width) / 2),
      y: Math.round(y + height * 0.6),
      ...size,
    },
    { kind: "center", ringX: 0, ringY: 0, placement: "below", ...size },
  );
}

function present(bounds: Rectangle, layout: CoachLayout): void {
  const win = ensureCoach();
  win.setBounds(bounds);
  void ready?.then(() => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC_CHANNELS.tourCoachLayout, layout);
    // `showInactive`: never steal focus from what the user is doing.
    win.showInactive();
  });
}

export function hideCoach(): void {
  if (coach && !coach.isDestroyed()) coach.hide();
}

export function destroyCoach(): void {
  if (coach && !coach.isDestroyed()) coach.destroy();
  coach = null;
  ready = null;
}

export function registerCoachIpc(): void {
  ipcMain.on(
    IPC_CHANNELS.tourCoachInteractive,
    (_event, interactive: boolean) => {
      if (!coach || coach.isDestroyed()) return;
      coach.setIgnoreMouseEvents(!interactive, { forward: true });
    },
  );
}
