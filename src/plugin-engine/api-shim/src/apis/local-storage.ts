/**
 * `LocalStorage`. Backed directly by this plugin's own `ExtensionStorage`
 * document (`@core/storage`) via plain `fs` — no RPC needed, since both
 * process kinds (the no-view worker and the List `utilityProcess`) run real
 * Node with unrestricted filesystem access. A no-view run and an open List
 * host for the same plugin racing on the same file is a small accepted risk,
 * the same class `ExtensionStorage` already accepts elsewhere.
 *
 * Real Raycast's `LocalStorage` is async, so every method returns a Promise
 * even though the underlying store is synchronous.
 *
 * A relative import rather than the `@core/storage` alias: the shim is
 * compiled into the plugin host entries by electron-vite *and* loaded raw by
 * `node --test` (see `host/runtime.test.ts`), and only a relative path
 * resolves the same way in both.
 */
import { ExtensionStorage } from "../../../../core/storage.ts";
import { getPluginContext } from "../context.ts";

const NAMESPACE = "local-storage:";

let cached: ExtensionStorage | null = null;

function storage(): ExtensionStorage {
  if (!cached) {
    const ctx = getPluginContext();
    cached = new ExtensionStorage(
      ctx.storageFilePath,
      `plugin:${ctx.pluginId}`,
    );
  }
  return cached;
}

export type LocalStorageValue = string | number | boolean;

export const LocalStorage = {
  async getItem<T extends LocalStorageValue = LocalStorageValue>(
    key: string,
  ): Promise<T | undefined> {
    return storage().get<T>(NAMESPACE + key);
  },
  async setItem(key: string, value: LocalStorageValue): Promise<void> {
    storage().set(NAMESPACE + key, value);
  },
  async removeItem(key: string): Promise<void> {
    storage().delete(NAMESPACE + key);
  },
  async allItems<
    T extends Record<string, LocalStorageValue> = Record<
      string,
      LocalStorageValue
    >,
  >(): Promise<T> {
    const result: Record<string, LocalStorageValue> = {};
    for (const key of storage().keys()) {
      if (!key.startsWith(NAMESPACE)) continue;
      result[key.slice(NAMESPACE.length)] = storage().get(
        key,
      ) as LocalStorageValue;
    }
    return result as T;
  },
  async clear(): Promise<void> {
    for (const key of storage().keys()) {
      if (key.startsWith(NAMESPACE)) storage().delete(key);
    }
  },
};
