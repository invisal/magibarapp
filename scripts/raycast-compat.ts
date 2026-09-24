/**
 * Raycast-extension compatibility smoke test (dev only, needs network):
 * installs real extensions from the Raycast Store into a temp plugins root
 * through the same `installPlugin` the app uses, then loads every command
 * through the same `host/runtime.ts`:
 *
 *  - view commands are rendered against a fake host transport for a moment,
 *    recording the view type they produced or the error they hit;
 *  - no-view commands are only *loaded* (module evaluation), never run —
 *    running them would perform their real side effects on this machine.
 *
 * View commands can have side effects on mount too (brew's "Upgrade" view
 * starts upgrading as soon as it renders), so `child_process` is disabled
 * for the whole run: an extension that shells out sees an error instead of
 * touching this machine. Network requests still go through.
 *
 * Reports per-command results plus every `@raycast/api` export extensions
 * asked for that the shim doesn't implement — the to-do list for the shim.
 *
 *   node --disable-warning=ExperimentalWarning scripts/raycast-compat.ts
 *   node --disable-warning=ExperimentalWarning scripts/raycast-compat.ts emoji github brew
 */
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin } from "../src/plugin-engine/install/install.ts";
import {
  getMissingApiNames,
  installModuleHook,
  loadCommand,
  startView,
} from "../src/plugin-engine/host/runtime.ts";
import { configurePluginContext } from "../src/plugin-engine/api-shim/src/context.ts";
import { configureHostTransport } from "../src/plugin-engine/api-shim/src/host-bridge.ts";
import {
  pluginAssetsDir,
  pluginBundlePath,
  pluginCacheFilePath,
  pluginStorageFilePath,
  pluginSupportDir,
} from "../src/plugin-engine/paths.ts";
import { resolvePreferenceValues } from "../src/plugin-engine/preferences.ts";
import type { PluginRegistryEntry } from "../src/plugin-engine/registry.ts";
import type { CommandRunInput } from "../src/plugin-engine/host/list-host-messages.ts";
import type { PluginViewTree } from "../src/plugin-engine/host/protocol.ts";

const DEFAULT_EXTENSIONS = [
  "emoji",
  "ray-so",
  "base64",
  "kill-process",
  "port-manager",
  "color-picker",
  "coffee",
  "docker",
  "tailwindcss",
  "search-npm",
  "speedtest",
  "visual-studio-code",
  "raycast-wallpaper",
  "dictionary",
  "weather",
  "brew",
  "github",
  "linear",
  "todoist",
  "notion",
  "spotify-player",
  "timers",
  "translate",
  "raycast-system-monitor",
  "lorem-ipsum",
  "cheatsheets",
  "hacker-news",
  "unicode-symbols",
  "iconify",
  "random",
  "apple-reminders",
  "safari",
  "wikipedia",
  "gif-search",
  "pomodoro",
  "youtube",
];

const RENDER_WAIT_MS = 1_500;

interface CommandResult {
  extension: string;
  command: string;
  mode: string;
  outcome: "ok" | "load-error" | "render-error" | "no-output" | "needs-sign-in";
  detail?: string;
}

function runInput(
  root: string,
  entry: PluginRegistryEntry,
  commandName: string,
  mode: "view" | "no-view",
): CommandRunInput {
  // Required preferences get placeholder values so commands get past their
  // own "missing token" checks and exercise real rendering.
  // Dropdowns/checkboxes already fall back to their manifest defaults.
  const values = { ...entry.preferenceValues };
  const needsPlaceholder = (p: { required?: boolean; type: string }) =>
    p.required && (p.type === "textfield" || p.type === "password");
  for (const p of entry.preferences ?? []) {
    if (needsPlaceholder(p) && values[p.name] === undefined)
      values[p.name] = "compat-test";
  }
  for (const c of entry.commands) {
    for (const p of c.preferences ?? []) {
      const key = `${c.name}.${p.name}`;
      if (needsPlaceholder(p) && values[key] === undefined)
        values[key] = "compat-test";
    }
  }
  return {
    bundlePath: pluginBundlePath(root, entry.id, commandName),
    pluginId: entry.id,
    pluginTitle: entry.title,
    extensionName: entry.name ?? entry.id,
    commandName,
    commandMode: mode,
    appearance: "dark",
    storageFilePath: pluginStorageFilePath(root, entry.id),
    cacheFilePath: pluginCacheFilePath(root, entry.id),
    supportPath: pluginSupportDir(root, entry.id),
    assetsPath: pluginAssetsDir(root, entry.id),
    preferenceValues: resolvePreferenceValues(
      { ...entry, preferenceValues: values },
      commandName,
    ),
    launchArguments: {},
  };
}

const fakeRequest = async (request: { method: string }): Promise<unknown> => {
  switch (request.method) {
    case "clipboard-read":
      return "";
    case "confirm-alert":
      return false;
    case "get-applications":
      return [];
    default:
      throw new Error(`${request.method} unavailable in the compat harness`);
  }
};

async function checkView(
  input: CommandRunInput,
): Promise<Omit<CommandResult, "extension" | "command" | "mode">> {
  let tree: PluginViewTree | null = null;
  let error: string | null = null;
  let view: ReturnType<typeof startView> | null = null;
  try {
    view = startView(input, {
      sendRenderTree: (t) => (tree = t),
      sendRenderError: (message) => (error ??= message),
      sendEffect() {},
      request: fakeRequest,
      popToRoot() {},
      clearSearchBar() {},
    });
  } catch (e) {
    return {
      outcome: "load-error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT_MS));
  try {
    view.dispose();
  } catch {
    // Disposal errors don't change the verdict.
  }
  if (error) {
    // OAuth sign-in isn't supported (deliberately) — tracked separately so
    // it doesn't drown out real compatibility bugs.
    return {
      outcome: /^Signing in with /.test(error)
        ? "needs-sign-in"
        : "render-error",
      detail: error,
    };
  }
  const rendered = tree as PluginViewTree | null;
  if (!rendered) return { outcome: "no-output" };
  return { outcome: "ok", detail: rendered.type };
}

function checkNoViewLoads(
  input: CommandRunInput,
): Omit<CommandResult, "extension" | "command" | "mode"> {
  configurePluginContext({
    pluginId: input.pluginId,
    pluginTitle: input.pluginTitle,
    extensionName: input.extensionName,
    commandName: input.commandName,
    commandMode: "no-view",
    storageFilePath: input.storageFilePath,
    cacheFilePath: input.cacheFilePath,
    supportPath: input.supportPath,
    assetsPath: input.assetsPath,
    preferenceValues: input.preferenceValues,
  });
  configureHostTransport({
    sendRenderTree() {},
    sendRenderError() {},
    sendEffect() {},
    request: fakeRequest,
    popToRoot() {},
    clearSearchBar() {},
  });
  try {
    loadCommand(input.bundlePath);
    return { outcome: "ok", detail: "loads" };
  } catch (e) {
    return {
      outcome: "load-error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Makes every way of starting a process throw — bundles `require`
 *  `child_process` and get this same (patched) module object. */
function blockChildProcesses(): void {
  const blocked = (name: string) => () => {
    throw new Error(`child_process.${name} is disabled in the compat harness`);
  };
  const cp = childProcess as unknown as Record<string, unknown>;
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    cp[name] = blocked(name);
  }
}

async function main(): Promise<void> {
  const names =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : DEFAULT_EXTENSIONS;
  const root = mkdtempSync(join(tmpdir(), "magibar-compat-"));
  process.on("unhandledRejection", () => {});
  process.on("uncaughtException", () => {});
  installModuleHook();
  blockChildProcesses();

  const installFailures: { extension: string; error: string }[] = [];
  const results: CommandResult[] = [];
  // Extensions log freely; keep the report readable.
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const mute = (): void => {
    console.log = console.warn = console.error = () => {};
  };
  const unmute = (): void => Object.assign(console, quiet);

  for (const name of names) {
    process.stdout.write(`${name.padEnd(24)} `);
    const installed = await installPlugin(root, { kind: "store", name });
    if (!installed.ok) {
      installFailures.push({ extension: name, error: installed.error });
      console.log(`install failed: ${installed.error}`);
      continue;
    }
    const entry = installed.entry;
    const summary: string[] = [];
    for (const command of entry.commands) {
      const input = runInput(root, entry, command.name, command.mode);
      mute();
      const result =
        command.mode === "view"
          ? await checkView(input)
          : checkNoViewLoads(input);
      unmute();
      results.push({
        extension: name,
        command: command.name,
        mode: command.mode,
        ...result,
      });
      summary.push(
        result.outcome === "ok"
          ? "✓"
          : result.outcome === "needs-sign-in"
            ? "🔑"
            : "✗",
      );
    }
    console.log(summary.join(""));
  }

  const ok = results.filter((r) => r.outcome === "ok");
  const signIn = results.filter((r) => r.outcome === "needs-sign-in");
  console.log("\n— failures —");
  for (const r of results.filter(
    (r) => r.outcome !== "ok" && r.outcome !== "needs-sign-in",
  )) {
    console.log(
      `${r.extension}/${r.command} [${r.mode}] ${r.outcome}: ${(r.detail ?? "").slice(0, 200)}`,
    );
  }
  console.log("\n— summary —");
  console.log(
    `extensions installed: ${names.length - installFailures.length}/${names.length}`,
  );
  console.log(`commands ok: ${ok.length}/${results.length}`);
  console.log(
    `commands needing OAuth sign-in (unsupported; work with a token preference where offered): ${signIn.length}`,
  );
  const byView = new Map<string, number>();
  for (const r of ok)
    byView.set(r.detail ?? "", (byView.get(r.detail ?? "") ?? 0) + 1);
  console.log(
    `ok by kind: ${[...byView].map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
  console.log(
    `unimplemented @raycast/api names hit: ${getMissingApiNames().join(", ") || "none"}`,
  );

  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

void main();
