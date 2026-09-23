import { shell } from "electron";
import { execFile } from "node:child_process";
import type { ActionDefinition } from "../../types";
import { listApplications, type AppsWorkerResult } from "../../native";
import { launchLinuxApp } from "../../native/apps-linux";
import { CachedActionSource } from "../base";
import { readAppsCache, writeAppsCache } from "./cache";

/**
 * Installed applications. On Windows: Start Menu shortcuts (`app:` ids) and
 * packaged apps (`pkg:` ids); on macOS: `.app` bundles (`app:` ids); on Linux:
 * `.desktop` entries (`app:` ids). The list
 * comes from the native `listApplications()` capability, which is slow to run
 * cold, so this source persists each result (see
 * cache.ts), seeds from that on-disk copy, and refreshes in the background at
 * startup and whenever the launcher is shown.
 */
export class InstalledAppSource extends CachedActionSource {
  readonly id = "app";

  owns(actionId: string): boolean {
    return actionId.startsWith("app:") || actionId.startsWith("pkg:");
  }

  protected async fetch(): Promise<ActionDefinition[]> {
    const result = await listApplications();
    if (!result) return [];
    // Persist the raw result so the next launch can serve it instantly while a
    // fresh run happens in the background.
    writeAppsCache(result);
    return toActionDefinitions(result);
  }

  protected async loadStale(): Promise<ActionDefinition[] | null> {
    const cached = await readAppsCache();
    return cached ? toActionDefinitions(cached) : null;
  }
}

/**
 * Turns a serializable `AppsWorkerResult` into `ActionDefinition`s, building the
 * main-process `run` handlers that can't be persisted. Shared by the live fetch
 * path and the on-disk cache path.
 */
function toActionDefinitions(result: AppsWorkerResult): ActionDefinition[] {
  const classicDefinitions: ActionDefinition[] = result.shortcuts.map(
    (entry) => ({
      action: {
        id: `app:${entry.path.toLowerCase()}`,
        title: entry.title,
        icon: entry.icon,
        type: "application",
      },
      run: async () => {
        // Linux entries are `.desktop` files, and `shell.openPath` on one asks
        // the desktop to *open that file* — usually in a text editor. It has to
        // go through the desktop's launcher instead.
        if (process.platform === "linux") {
          await launchLinuxApp(entry);
          return;
        }
        const openError = await shell.openPath(entry.path);
        if (openError)
          console.error(`[main] Failed to open ${entry.path}: ${openError}`);
      },
    }),
  );

  const packagedDefinitions: ActionDefinition[] = result.packaged.map(
    (entry) => ({
      action: {
        id: `pkg:${entry.appId.toLowerCase()}`,
        title: entry.title,
        icon: entry.icon,
        type: "application",
      },
      run: () => {
        execFile(
          "explorer.exe",
          [`shell:AppsFolder\\${entry.appId}`],
          (error) => {
            if (error)
              console.error(`[main] Failed to open ${entry.title}:`, error);
          },
        );
      },
    }),
  );

  const definitions = [...classicDefinitions, ...packagedDefinitions];
  return definitions.sort((a, b) =>
    a.action.title.localeCompare(b.action.title),
  );
}
