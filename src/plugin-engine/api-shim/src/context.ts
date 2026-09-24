/**
 * Static, per-run plugin context: preference values, storage location, and
 * environment info resolved once at spawn time and never round-tripped — set
 * by `no-view-worker.ts` / `list-host-process.ts` before invoking the
 * command's entry point. `apis/preferences.ts`, `apis/environment.ts`, and
 * `apis/local-storage.ts` all read from this.
 */

export interface PluginContext {
  pluginId: string;
  pluginTitle: string;
  /** The manifest `name` (`environment.extensionName`) — distinct from
   *  `pluginId`, which is sanitized for use as a directory name. */
  extensionName?: string;
  ownerOrAuthorName?: string;
  commandName: string;
  commandMode?: "view" | "no-view";
  launchType?: "userInitiated" | "background";
  appearance?: "light" | "dark";
  storageFilePath: string;
  cacheFilePath: string;
  supportPath: string;
  assetsPath: string;
  preferenceValues: Record<string, unknown>;
}

let context: PluginContext | null = null;

export function configurePluginContext(next: PluginContext): void {
  context = next;
}

export function getPluginContext(): PluginContext {
  if (!context) {
    throw new Error(
      "[@raycast/api shim] plugin context was read before configurePluginContext() ran",
    );
  }
  return context;
}
