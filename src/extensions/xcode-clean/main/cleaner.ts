import { realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CleanResult } from "../shared/types.ts";
import type { ScanEntry } from "./scanner.ts";

/**
 * Whether `entry` is really where the scan found it: a `children` item must
 * still sit *directly* inside its category root (after resolving symlinks, so
 * a folder swapped for a link can't redirect the delete), and a `self` item
 * must still be the exact directory the category registered.
 */
async function isWhereWeFoundIt(entry: ScanEntry): Promise<boolean> {
  try {
    if (entry.mode === "self") return entry.item.path === entry.root;
    return (
      (await realpath(dirname(entry.item.path))) ===
      (await realpath(entry.root))
    );
  } catch {
    return false;
  }
}

/**
 * Deletes the folders behind `ids` (permanently — these are caches, and the UI
 * asks for confirmation first). Ids the scanner doesn't know, or whose path no
 * longer checks out, are refused rather than trusted. `remove` is injectable
 * for tests.
 */
export async function cleanItems(
  ids: string[],
  lookup: (id: string) => ScanEntry | undefined,
  remove: (path: string) => Promise<void> = (path) =>
    rm(path, { recursive: true, force: true }),
): Promise<CleanResult> {
  const result: CleanResult = { freedBytes: 0, failed: [] };
  for (const id of new Set(ids)) {
    const entry = lookup(id);
    if (!entry || !(await isWhereWeFoundIt(entry))) {
      result.failed.push({ id, error: "Not a known Xcode folder" });
      continue;
    }
    try {
      await remove(entry.item.path);
      result.freedBytes += entry.item.bytes ?? 0;
    } catch (error) {
      result.failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
