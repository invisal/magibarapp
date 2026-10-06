/**
 * Best-effort scan of a Store bundle for macOS-only dependencies. Raycast
 * ships no Linux builds, so Linux installs everything and this is how the
 * user hears that a command is likely to fail — it never blocks the install.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAC_ONLY_MARKERS: Array<[RegExp, string]> = [
  [/osascript/, "AppleScript"],
  [/\.app\/Contents/, "macOS app bundles"],
  [/\/usr\/bin\/(?:defaults|mdfind|sips|say|screencapture)\b/, "macOS tools"],
  [/~\/Library\/|\/Library\/Application Support/, "macOS ~/Library paths"],
];

/** Labels of the macOS-only features `source` appears to use. */
export function findMacOnlyUsage(source: string): string[] {
  return MAC_ONLY_MARKERS.filter(([re]) => re.test(source)).map(
    ([, label]) => label,
  );
}

/** Scans every command bundle in `distDir`; returns command name → labels. */
export async function scanBundlesForMacOnlyUsage(
  distDir: string,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const file of await readdir(distDir)) {
    if (!file.endsWith(".js")) continue;
    const labels = findMacOnlyUsage(
      await readFile(join(distDir, file), "utf8"),
    );
    if (labels.length > 0) found.set(file.replace(/\.js$/, ""), labels);
  }
  return found;
}
