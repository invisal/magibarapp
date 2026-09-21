import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** On-disk size of one path. */
export interface Measured {
  path: string;
  bytes: number;
  fileCount: number;
  /** Epoch ms; 0 when unknown. */
  modifiedMs: number;
}

/**
 * `@magibar/mac` only installs on darwin, so it's loaded lazily rather than
 * imported — same pattern as `quit-process/main/process-source-mac.ts`.
 */
type NativeMac = typeof import("@magibar/mac");
const nodeRequire = createRequire(import.meta.url);
let native: NativeMac | null | undefined;

function loadNative(): NativeMac | null {
  if (native !== undefined) return native;
  if (process.platform !== "darwin") return (native = null);
  try {
    native = nodeRequire("@magibar/mac") as NativeMac;
  } catch (error) {
    console.error("[xcode-clean] Failed to load @magibar/mac:", error);
    native = null;
  }
  return native;
}

/** `du -sk` fallback for when the addon is unavailable (e.g. not rebuilt yet). */
async function measureWithDu(path: string): Promise<Measured> {
  try {
    const { stdout } = await run("du", ["-sk", path], { maxBuffer: 1 << 20 });
    const kb = Number.parseInt(stdout.split("\t")[0] ?? "", 10);
    const modifiedMs = (await stat(path)).mtimeMs;
    return {
      path,
      bytes: (Number.isNaN(kb) ? 0 : kb) * 1024,
      fileCount: 0,
      modifiedMs,
    };
  } catch {
    return { path, bytes: 0, fileCount: 0, modifiedMs: 0 };
  }
}

/** Sizes `paths` off the main thread, results in the same order. */
export async function measurePaths(paths: string[]): Promise<Measured[]> {
  if (paths.length === 0) return [];
  const mac = loadNative();
  if (mac && typeof mac.dirSize === "function") {
    return (await mac.dirSize(paths)).map((r) => ({
      path: r.path,
      bytes: r.bytes,
      fileCount: r.fileCount,
      modifiedMs: r.modifiedMs,
    }));
  }
  return Promise.all(paths.map(measureWithDu));
}
