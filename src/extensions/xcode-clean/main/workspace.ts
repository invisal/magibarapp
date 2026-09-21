import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The project a DerivedData folder was built for, read from its `info.plist`
 *  (`WorkspacePath`). `undefined` when the plist is missing or unreadable. */
export async function workspacePath(
  derivedDataDir: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await run("plutil", [
      "-extract",
      "WorkspacePath",
      "raw",
      "-o",
      "-",
      join(derivedDataDir, "info.plist"),
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Whether the Xcode app is running — `pgrep -x` matches the exact process name. */
export async function isXcodeRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-x", "Xcode"]);
    return true;
  } catch {
    return false;
  }
}

/** Whether any Xcode app is installed — Spotlight by bundle id (finds it in
 *  any folder, betas included), falling back to a look in `/Applications`. */
export async function isXcodeInstalled(): Promise<boolean> {
  try {
    const { stdout } = await run("mdfind", [
      "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'",
    ]);
    if (stdout.trim()) return true;
  } catch {
    // Spotlight off or unavailable — fall through.
  }
  try {
    return (await readdir("/Applications")).some((name) =>
      /^Xcode.*\.app$/.test(name),
    );
  } catch {
    return false;
  }
}
