import { BrowserWindow } from "electron";
import { join } from "node:path";
import {
  framelessChrome,
  persistWindowBounds,
  restoredBounds,
} from "./window-chrome";
import { settings } from "./actions";

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 560;

/**
 * The settings panel lives in its own framed BrowserWindow with its own renderer
 * entry (`settings.html`) — separate from the frameless, always-on-top launcher.
 * It's a singleton: opening it again just focuses the existing window.
 */
let settingsWindow: BrowserWindow | null = null;

export function openSettingsWindow(): void {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    ...restoredBounds(settings, "settings", {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    }),
    minWidth: 480,
    minHeight: 400,
    title: "Magibar Settings",
    show: false,
    autoHideMenuBar: true,
    ...framelessChrome,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  persistWindowBounds(settingsWindow, settings, "settings");
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    settingsWindow.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}/settings.html`,
    );
  } else {
    settingsWindow.loadFile(join(import.meta.dirname, "../renderer/settings.html"));
  }
}
