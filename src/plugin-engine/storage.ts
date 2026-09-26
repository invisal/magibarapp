/**
 * Per-plugin `LocalStorage`. Each installed plugin gets its own
 * `ExtensionStorage` document at `<userData>/plugins/<id>/storage.json`,
 * separate from every other plugin's — this is the file the shim's
 * `LocalStorage` API (`api-shim/src/apis/local-storage.ts`) reads and writes.
 */
import { ExtensionStorage } from "@core/storage";
import { pluginStorageFilePath } from "./paths.ts";

export function createPluginStorage(
  pluginsRoot: string,
  pluginId: string,
): ExtensionStorage {
  return new ExtensionStorage(
    pluginStorageFilePath(pluginsRoot, pluginId),
    `plugin:${pluginId}`,
  );
}
