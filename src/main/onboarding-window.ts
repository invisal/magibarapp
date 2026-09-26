import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { framelessChrome } from "./window-chrome";
import { getLauncherWindow, showLauncher } from "./window";
import { settings } from "./actions";
import { IPC_CHANNELS } from "../shared/types";

const WINDOW_WIDTH = 820;
const WINDOW_HEIGHT = 720;

/**
 * The first-run welcome tour: a small fixed-size framed window with its own
 * renderer entry (`onboarding.html`), like Settings. A singleton — replaying it
 * from Settings just focuses the one that's already open.
 */
let onboardingWindow: BrowserWindow | null = null;

export function openOnboardingWindow(): void {
  if (onboardingWindow) {
    if (onboardingWindow.isMinimized()) onboardingWindow.restore();
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    title: "Welcome to Magibar",
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
  onboardingWindow = win;

  win.once("ready-to-show", () => win.show());
  // However it's closed (finished, or dismissed with the window's X), the tour
  // is done — never nag on the next launch. Settings can replay it.
  win.on("closed", () => {
    onboardingWindow = null;
    settings.setOnboardingCompleted(true);
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/onboarding.html`);
  } else {
    win.loadFile(join(import.meta.dirname, "../renderer/onboarding.html"));
  }
}

/** Tells the tour the launcher just appeared — its "try the shortcut" step advances on this. */
export function notifyLauncherShown(): void {
  if (!onboardingWindow || onboardingWindow.isDestroyed()) return;
  onboardingWindow.webContents.send(IPC_CHANNELS.onboardingLauncherShown);
}

export function registerOnboardingIpc(): void {
  ipcMain.on(IPC_CHANNELS.onboardingOpen, () => openOnboardingWindow());

  ipcMain.on(IPC_CHANNELS.onboardingFinish, () => {
    onboardingWindow?.close();
    // A parting payoff: hand the user straight to the launcher.
    if (getLauncherWindow()) showLauncher();
  });
}
