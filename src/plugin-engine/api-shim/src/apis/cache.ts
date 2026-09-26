/**
 * `Cache`. Same backing mechanism as `LocalStorage` (`ExtensionStorage` via
 * `core/storage.ts`, see that file's doc comment for the relative-import note),
 * but its own file (`ctx.cacheFilePath`, not `storageFilePath`) — real
 * Raycast keeps the two namespaces separate, and a shared file with just a
 * different key prefix would let a `Cache.clear()` bug reach into
 * `LocalStorage` data.
 *
 * `capacity` is accepted for signature compatibility but not enforced — no
 * LRU eviction in v1, matching this codebase's "accept but don't enforce"
 * treatment of other decorative options (e.g. `AlertActionOptions.style`).
 */
import { ExtensionStorage } from "../../../../core/storage.ts";
import { getPluginContext } from "../context.ts";

type CacheSubscriber = (
  key: string | undefined,
  data: string | undefined,
) => void;

let cached: ExtensionStorage | null = null;

function storage(): ExtensionStorage {
  if (!cached) {
    const ctx = getPluginContext();
    cached = new ExtensionStorage(
      ctx.cacheFilePath,
      `plugin-cache:${ctx.pluginId}`,
    );
  }
  return cached;
}

/** Keyed by namespace, so two `Cache` instances sharing one notify each
 *  other's subscribers — matches real Raycast. */
const subscribers = new Map<string, Set<CacheSubscriber>>();

function notify(
  namespace: string,
  key: string | undefined,
  data: string | undefined,
): void {
  for (const subscriber of subscribers.get(namespace) ?? [])
    subscriber(key, data);
}

export interface CacheOptions {
  capacity?: number;
  namespace?: string;
}

/**
 * Every method is an arrow-function property, not a prototype method:
 * `@raycast/utils` passes them around unbound (`useSyncExternalStore(
 * cache.subscribe, …)`), which works in real Raycast because its methods
 * are bound too.
 */
export class Cache {
  private readonly namespace: string;
  private readonly prefix: string;

  constructor(options?: CacheOptions) {
    this.namespace = options?.namespace ?? "";
    this.prefix = `cache:${this.namespace}:`;
  }

  get = (key: string): string | undefined => {
    return storage().get<string>(this.prefix + key);
  };

  has = (key: string): boolean => {
    return storage().get<string>(this.prefix + key) !== undefined;
  };

  set = (key: string, data: string): void => {
    storage().set(this.prefix + key, data);
    notify(this.namespace, key, data);
  };

  remove = (key: string): boolean => {
    const existed = this.has(key);
    storage().delete(this.prefix + key);
    if (existed) notify(this.namespace, key, undefined);
    return existed;
  };

  clear = (options?: { notifySubscribers?: boolean }): void => {
    for (const key of storage().keys()) {
      if (key.startsWith(this.prefix)) storage().delete(key);
    }
    if (options?.notifySubscribers !== false) {
      notify(this.namespace, undefined, undefined);
    }
  };

  get isEmpty(): boolean {
    return !storage()
      .keys()
      .some((key) => key.startsWith(this.prefix));
  }

  subscribe = (callback: CacheSubscriber): (() => void) => {
    let set = subscribers.get(this.namespace);
    if (!set) {
      set = new Set();
      subscribers.set(this.namespace, set);
    }
    set.add(callback);
    return () => set!.delete(callback);
  };
}
