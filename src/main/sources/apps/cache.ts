/**
 * On-disk cache for the last successful application list, so a launch can serve
 * the previously-known list instantly instead of waiting for the native worker to
 * finish its first (multi-second, cold) run. `InstalledAppSource` serves this
 * stale list on startup and re-runs `listApplications()` in the background to
 * refresh it.
 *
 * Unlike the native icon cache this runs in the main process, so it owns the file
 * path via Electron's `app`. The cache is purely advisory: every failure is
 * swallowed (with a `[apps-cache]` prefix) and leaves the caller to fall back to a
 * fresh worker run.
 */
import { app } from "electron";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppsWorkerResult } from "../../native";

/** Bumped when the persisted shape changes, to invalidate old files. */
const CACHE_VERSION = 3;

interface CacheFile {
  version: number;
  savedAt: number;
  result: AppsWorkerResult;
}

function cachePath(): string {
  return join(app.getPath("userData"), "apps-cache.json");
}

function isValidResult(value: unknown): value is AppsWorkerResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppsWorkerResult>;
  return (
    Array.isArray(candidate.shortcuts) && Array.isArray(candidate.packaged)
  );
}

/** Returns the persisted worker result, or `null` on any error / version mismatch. */
export async function readAppsCache(): Promise<AppsWorkerResult | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    if (parsed.version !== CACHE_VERSION || !isValidResult(parsed.result))
      return null;
    return parsed.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[apps-cache] Failed to read cache:", error);
    }
    return null;
  }
}

/** Persists `result` via a temp file + atomic rename so a torn read is impossible. */
export function writeAppsCache(result: AppsWorkerResult): void {
  const file = cachePath();
  const tmp = `${file}.tmp`;
  const payload: CacheFile = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    result,
  };
  try {
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, file);
  } catch (error) {
    console.error("[apps-cache] Failed to write cache:", error);
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}
