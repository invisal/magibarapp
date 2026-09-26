/**
 * Turns the reconciler's `fileicon:<path>` icons (`{ fileIcon }`, an app
 * bundle, an `.icns` — see `api-shim/src/reconciler.ts`'s
 * `FILE_ICON_PREFIX`) into `data:` URIs. Only main can: the plugin process
 * has no Electron APIs, and the renderer can't read files.
 *
 * `resolveIcons` is injectable so the tree walk is testable without
 * Electron (see `file-icons.test.ts`).
 */
import type { PluginViewTree } from "./protocol.ts";

const FILE_ICON_PREFIX = "fileicon:";

/** The keys a tree carries an image under: every `icon`, plus a Grid
 *  item's `content`. Only these are rewritten — a title that happens to
 *  start with the prefix stays text. */
const ICON_KEYS = new Set(["icon", "content"]);

function isFileIcon(key: string, value: unknown): value is string {
  return (
    ICON_KEYS.has(key) &&
    typeof value === "string" &&
    value.startsWith(FILE_ICON_PREFIX)
  );
}

/** Every `fileicon:` path in `value`. */
function collectPaths(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (isFileIcon(key, item)) into.add(item.slice(FILE_ICON_PREFIX.length));
      else collectPaths(item, into);
    }
  }
}

/** `value` with each `fileicon:` icon replaced (unresolvable ones dropped,
 *  so the renderer shows an empty icon slot). */
function replacePaths(
  value: unknown,
  icons: Map<string, string | null>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => replacePaths(v, icons));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isFileIcon(key, item)
        ? (icons.get(item.slice(FILE_ICON_PREFIX.length)) ?? undefined)
        : replacePaths(item, icons);
    }
    return out;
  }
  return value;
}

export type IconLoader = (path: string) => Promise<string | null>;

/** Icons by path — process-wide, since the same apps show up in every
 *  refresh (Kill Process re-renders every few seconds). Promises, so two
 *  quick renders share one load. */
const cache = new Map<string, Promise<string | null>>();

export async function resolveFileIcons(
  tree: PluginViewTree,
  load: IconLoader,
): Promise<PluginViewTree> {
  const paths = new Set<string>();
  collectPaths(tree, paths);
  if (paths.size === 0) return tree;
  const icons = new Map<string, string | null>();
  await Promise.all(
    [...paths].map(async (path) => {
      let pending = cache.get(path);
      if (!pending) {
        pending = load(path).catch(() => null);
        cache.set(path, pending);
      }
      icons.set(path, await pending);
    }),
  );
  return replacePaths(tree, icons) as PluginViewTree;
}
