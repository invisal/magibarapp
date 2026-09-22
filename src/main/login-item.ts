/**
 * "Launch at login" (Settings → General). macOS and Windows go through
 * Electron's own login-item API; Linux has no such API (`setLoginItemSettings`
 * is a no-op there — see the Electron docs), so it's done by hand with an XDG
 * autostart `.desktop` file instead, the same mechanism GNOME/KDE/etc. all
 * read on session start — see `login-item-linux.ts` for that file's shape.
 */
import { app } from "electron";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  autostartDesktopEntry,
  autostartDesktopPath,
} from "./login-item-linux";

/** Whether Magibar is currently set to launch at login. */
export function isLaunchAtLoginEnabled(): boolean {
  if (process.platform === "linux") {
    return existsSync(autostartDesktopPath(app.getPath("home")));
  }
  return app.getLoginItemSettings().openAtLogin;
}

/**
 * Enables/disables launching at login, and returns the setting actually in
 * effect afterward (a Linux filesystem write can fail — e.g. a read-only
 * `~/.config` — so this is the truth the caller should persist/display, not
 * an echo of `enabled`).
 */
export function setLaunchAtLogin(enabled: boolean): boolean {
  if (process.platform === "linux") {
    const path = autostartDesktopPath(app.getPath("home"));
    try {
      if (enabled) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, autostartDesktopEntry(process.execPath));
      } else {
        rmSync(path, { force: true });
      }
    } catch (error) {
      console.error("[login-item] Failed to update autostart entry:", error);
    }
    return isLaunchAtLoginEnabled();
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
  return isLaunchAtLoginEnabled();
}
