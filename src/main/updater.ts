import { app, ipcMain, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { IPC_CHANNELS, type UpdateStatus } from "../shared/types";

const { autoUpdater } = electronUpdater;

const RECHECK_MS = 6 * 60 * 60 * 1000;

let status: UpdateStatus = { state: "idle" };

/** Checks GitHub releases for a newer version (see `publish` in
 *  electron-builder.yml) and exposes status/install to the launcher footer. */
export function registerUpdater(
  getWindow: () => BrowserWindow | null | undefined,
): void {
  const set = (next: UpdateStatus): void => {
    status = next;
    getWindow()?.webContents.send(IPC_CHANNELS.updateStatus, status);
  };

  // Updating only works in a packaged build.
  const enabled = app.isPackaged;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    set({ state: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => set({ state: "idle" }));
  autoUpdater.on("download-progress", (p) => {
    const version = "version" in status ? status.version : "";
    set({ state: "downloading", version, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    set({ state: "ready", version: info.version });
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (err) =>
    set({ state: "error", message: err?.message ?? "Update failed" }),
  );

  const check = async (): Promise<void> => {
    if (!enabled) return;
    if (status.state === "downloading" || status.state === "ready") return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // surfaced through the "error" event
    }
  };

  ipcMain.handle(IPC_CHANNELS.updateGet, () => ({
    version: app.getVersion(),
    status,
  }));
  ipcMain.handle(IPC_CHANNELS.updateCheck, check);
  ipcMain.handle(IPC_CHANNELS.updateInstall, async () => {
    if (!enabled || status.state !== "available") return;
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // surfaced through the "error" event
    }
  });

  if (enabled) {
    setTimeout(() => void check(), 5000);
    setInterval(() => void check(), RECHECK_MS).unref();
  }
}
