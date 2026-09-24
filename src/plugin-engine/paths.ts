/**
 * Filesystem layout for installed plugins, all under `<userData>/plugins/` —
 * deliberately separate from `@core/base.ts`'s `configureExtensions` root
 * (`<userData>/extensions/`), since first-party extensions and dynamically
 * installed plugins never share a namespace.
 *
 *   plugins/
 *     registry.json
 *     <pluginId>/source/            package.json, assets/, and (source builds)
 *                                    the unbundled source + node_modules
 *     <pluginId>/source/assets/     real Raycast's `environment.assetsPath`
 *     <pluginId>/support/           real Raycast's `environment.supportPath` —
 *                                    a writable scratch dir extensions use for
 *                                    caching downloaded helpers, temp files, etc.
 *     <pluginId>/dist/<command>.js  one CommonJS bundle per command — straight
 *                                    from the Store zip, or built by
 *                                    `install/bundle.ts`; `@raycast/api` and
 *                                    React stay external (see host/runtime.ts)
 *     <pluginId>/storage.json       this plugin's LocalStorage-backed document
 *     <pluginId>/cache.json         this plugin's Cache-backed document — kept
 *                                    separate from storage.json so Cache.clear()
 *                                    can never touch LocalStorage data
 */
import { join } from "node:path";

/** `my-cool-extension!` -> `my-cool-extension` — a manifest `name` used
 *  as a directory name and action-id prefix. */
export function pluginIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function pluginsRootDir(userDataDir: string): string {
  return join(userDataDir, "plugins");
}

export function registryFilePath(pluginsRoot: string): string {
  return join(pluginsRoot, "registry.json");
}

export function pluginSourceDir(pluginsRoot: string, pluginId: string): string {
  return join(pluginsRoot, pluginId, "source");
}

export function pluginDir(pluginsRoot: string, pluginId: string): string {
  return join(pluginsRoot, pluginId);
}

export function pluginDistDir(pluginsRoot: string, pluginId: string): string {
  return join(pluginsRoot, pluginId, "dist");
}

export function pluginBundlePath(
  pluginsRoot: string,
  pluginId: string,
  commandName: string,
): string {
  return join(pluginDistDir(pluginsRoot, pluginId), `${commandName}.js`);
}

export function pluginStorageFilePath(
  pluginsRoot: string,
  pluginId: string,
): string {
  return join(pluginsRoot, pluginId, "storage.json");
}

export function pluginCacheFilePath(
  pluginsRoot: string,
  pluginId: string,
): string {
  return join(pluginsRoot, pluginId, "cache.json");
}

export function pluginSupportDir(
  pluginsRoot: string,
  pluginId: string,
): string {
  return join(pluginsRoot, pluginId, "support");
}

export function pluginAssetsDir(pluginsRoot: string, pluginId: string): string {
  return join(pluginSourceDir(pluginsRoot, pluginId), "assets");
}
