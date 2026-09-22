/**
 * The Linux half of "Launch at login" (`login-item.ts`) — kept Electron-free
 * (mirrors `settings/store.ts`) so `node --test` can exercise it directly:
 * `electron`'s own named exports don't resolve outside the Electron binary,
 * so anything that imports `electron` at module scope can't be loaded by a
 * plain Node test runner at all, not even for its Electron-free parts.
 */
import { join } from "node:path";

const LINUX_DESKTOP_FILE = "magibar-autostart.desktop";

/** Where the autostart entry lives, given `$HOME` (injected so this is testable without touching the real one). */
export function autostartDesktopPath(homeDir: string): string {
  return join(homeDir, ".config", "autostart", LINUX_DESKTOP_FILE);
}

/** The `.desktop` file's contents for `execPath` — quoted, since an install path can contain spaces. */
export function autostartDesktopEntry(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Magibar",
    `Exec="${execPath}"`,
    "X-GNOME-Autostart-enabled=true",
    "Hidden=false",
    "",
  ].join("\n");
}
