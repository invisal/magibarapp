/**
 * The "Open With" list for the Create Quicklink form: every installed app the
 * launcher can hand a path or URL to as an argument. That's the browsers
 * registered under `Clients\StartMenuInternet` plus every Start-Menu shortcut
 * whose `.lnk` resolves to an `.exe` (from the persisted apps cache, so this is
 * cheap — no worker run). Packaged / Store apps are left out: they can't be
 * launched with an argument.
 *
 * Each app carries an icon: the one already extracted for the Start-Menu list
 * when there is one, otherwise a fresh `app.getFileIcon()` of the executable
 * (which also covers registry-only browsers). The whole list is built once per
 * session.
 */
import { app } from "electron";
import type { OpenWithApp } from "@extensions/quicklink/shared/types.ts";
import { listBrowsers } from "../../native";
import { readAppsCache } from "./cache";

let cache: OpenWithApp[] | null = null;
let inFlight: Promise<OpenWithApp[]> | null = null;

export function listOpenWithApps(): Promise<OpenWithApp[]> {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) inFlight = build().finally(() => (inFlight = null));
  return inFlight;
}

async function build(): Promise<OpenWithApp[]> {
  const [browsers, appsCache] = await Promise.all([
    listBrowsers(),
    readAppsCache(),
  ]);

  const byPath = new Map<string, OpenWithApp>();
  const add = (name: string, path: string, icon?: string): void => {
    const key = path.toLowerCase();
    const existing = byPath.get(key);
    if (!existing) byPath.set(key, { name, path, ...(icon ? { icon } : {}) });
    else if (icon && !existing.icon) existing.icon = icon;
  };

  for (const browser of browsers) add(browser.name, browser.path);
  for (const shortcut of appsCache?.shortcuts ?? []) {
    // Windows: only shortcuts whose `.lnk` resolves to an `.exe` are launchable
    // with an argument. Linux: the `.desktop` file can't take one either, so the
    // `Exec` program it resolves to is the target. macOS: every `.app` bundle's
    // own path is the target — no shortcut-vs-resolved-target distinction.
    const launchPath =
      process.platform === "darwin" ? shortcut.path : shortcut.target;
    if (launchPath) add(shortcut.title, launchPath, shortcut.icon);
  }

  // Fill in any missing icons straight from the executable (browsers, mostly).
  await Promise.all(
    [...byPath.values()]
      .filter((entry) => !entry.icon)
      .map(async (entry) => {
        try {
          const image = await app.getFileIcon(entry.path, { size: "normal" });
          if (!image.isEmpty()) entry.icon = image.toDataURL();
        } catch {
          /* leave it iconless */
        }
      }),
  );

  const list = [...byPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // Only lock in the result once the Start-Menu list was actually available;
  // otherwise a call made before the apps worker finished would pin a
  // browsers-only list for the whole session.
  if (appsCache) cache = list;
  return list;
}
