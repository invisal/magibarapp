/**
 * `environment`. A number of real extensions read `supportPath`/`assetsPath`
 * directly (speedtest's `cli.ts` caches a downloaded helper binary under
 * `supportPath`, for one) — without them, `path.join(undefined, ...)` throws
 * inside the extension's own code, typically masked by its own try/catch as
 * a generic failure rather than surfacing here.
 *
 * `@raycast/utils` reads `launchType`/`commandMode` and calls `canAccess()`
 * at runtime, so every field real Raycast documents is present.
 */
import { mkdirSync } from "node:fs";
import { getPluginContext } from "../context.ts";

export interface Environment {
  extensionName: string;
  commandName: string;
  commandMode: "view" | "no-view" | "menu-bar";
  launchType: "userInitiated" | "background";
  ownerOrAuthorName: string;
  isDevelopment: boolean;
  raycastVersion: string;
  supportPath: string;
  assetsPath: string;
  appearance: "light" | "dark";
  /** Deprecated alias of `appearance`, still read by older extensions. */
  theme: "light" | "dark";
  textSize: "medium" | "large";
  /** Whether the user can use an API gated behind Raycast Pro (`AI`,
   *  `BrowserExtension`, …) — none of those exist here. */
  canAccess(api: unknown): boolean;
}

/** Recent enough that extensions' own version gates don't refuse to run. */
export const RAYCAST_VERSION = "1.100.0";

const ensuredSupportPaths = new Set<string>();

export function getEnvironment(): Environment {
  const ctx = getPluginContext();
  // Real Raycast guarantees `supportPath` exists — extensions routinely
  // `fs.writeFile` into it without `mkdir`-ing first.
  if (!ensuredSupportPaths.has(ctx.supportPath)) {
    mkdirSync(ctx.supportPath, { recursive: true });
    ensuredSupportPaths.add(ctx.supportPath);
  }
  const appearance = ctx.appearance ?? "dark";
  return {
    extensionName: ctx.extensionName ?? ctx.pluginId,
    commandName: ctx.commandName,
    commandMode: ctx.commandMode ?? "view",
    launchType: ctx.launchType ?? "userInitiated",
    ownerOrAuthorName: ctx.ownerOrAuthorName ?? "",
    isDevelopment: false,
    raycastVersion: RAYCAST_VERSION,
    supportPath: ctx.supportPath,
    assetsPath: ctx.assetsPath,
    appearance,
    theme: appearance,
    textSize: "medium",
    canAccess: () => false,
  };
}
