/**
 * Runs one command's prebuilt bundle — the single runtime every installed
 * plugin goes through, whether it came from the Raycast Store (whose zips
 * ship `ray build` output) or was built from source (`install/bundle.ts`
 * emits the same shape). Either way the bundle is plain CommonJS with every
 * npm dependency inlined and exactly these left as bare `require`s:
 * `@raycast/api`, `react`, `react/jsx-runtime`, and Node built-ins.
 *
 * `installModuleHook` answers those `require`s with *this* process's own
 * modules: the API shim, and the one React instance the shim's reconciler is
 * built against (a second React copy would break hooks). Both are compiled
 * into the host entry (`plugin-list-host.js` / `plugin-noview-worker.js`) by
 * electron-vite, so nothing here depends on `node_modules` existing at
 * runtime — which it doesn't, in a packaged app.
 *
 * Imports nothing from Electron, so `node --test` can load it directly (see
 * `runtime.test.ts`).
 */
import fs, { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import { createElement, type ComponentType } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as raycastApi from "../api-shim/src/index.ts";
import { configurePluginContext } from "../api-shim/src/context.ts";
import {
  actionRegistry,
  configureHostTransport,
  dropdownChangeStore,
  formFieldChangeStore,
  formSubmitStore,
  listCallbackStore,
  searchTextStore,
  type HostTransport,
} from "../api-shim/src/host-bridge.ts";
import { createPluginRoot, flushSync } from "../api-shim/src/reconciler.ts";
import * as navigation from "../api-shim/src/navigation.ts";
import {
  missingApi,
  UnsupportedApiError,
} from "../api-shim/src/unsupported.ts";
import { hostPlatform } from "../api-shim/src/platform.ts";
import type { CommandRunInput } from "./list-host-messages.ts";
import { wrapChildProcess } from "./linux-binaries.ts";
import { wrapFsModule } from "./linux-paths.ts";

/* ------------------------------ module hook ------------------------------ */

const missingApiNames = new Set<string>();

/** Every `@raycast/api` name a loaded bundle asked for that the shim doesn't
 *  export — `scripts/raycast-compat.ts` reports these. */
export function getMissingApiNames(): string[] {
  return [...missingApiNames].sort();
}

const IGNORED_MISSING = new Set(["__esModule", "then", "default", "toJSON"]);

function reportMissing(name: string): void {
  if (missingApiNames.has(name)) return;
  missingApiNames.add(name);
  console.warn(`[plugin-engine] @raycast/api "${name}" is not implemented`);
}

interface MissingActionProps {
  title?: string;
  icon?: unknown;
  shortcut?: Parameters<typeof raycastApi.Action>[0]["shortcut"];
}

/** Stand-in for a sub-component Raycast added after this shim was written
 *  (`Action.InstallMCPServer`): an action that explains itself, or nothing —
 *  either way the rest of the view still renders. */
function missingSubComponent(name: string): ComponentType<MissingActionProps> {
  if (!name.startsWith("Action.")) return () => null;
  return ({ title, icon, shortcut }) =>
    createElement(raycastApi.Action, {
      title: title ?? name.slice("Action.".length),
      icon,
      shortcut,
      onAction: async () => {
        await raycastApi.showToast({
          style: raycastApi.Toast.Style.Failure,
          title: `"${name}" is not supported in Magibar yet.`,
        });
      },
    });
}

/** A component namespace (`List`, `Action`, …) whose unknown capitalized
 *  members come back as `missingSubComponent`s instead of `undefined` —
 *  which React would turn into an error for the whole view. */
function tolerantComponent<T extends object>(component: T, path: string): T {
  const members = new Map<string, unknown>();
  return new Proxy(component, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !/^[A-Z]/.test(prop)) return value;
      let member = members.get(prop);
      if (member === undefined) {
        const name = `${path}.${prop}`;
        if (value === undefined) reportMissing(name);
        member =
          value === undefined
            ? missingSubComponent(name)
            : typeof value === "function"
              ? tolerantComponent(value, name)
              : value;
        members.set(prop, member);
      }
      return member;
    },
  });
}

const apiExports: Record<string, unknown> = { ...raycastApi };
for (const name of [
  "Action",
  "ActionPanel",
  "Detail",
  "Form",
  "Grid",
  "List",
] as const) {
  apiExports[name] = tolerantComponent(raycastApi[name], name);
}

const apiModule = new Proxy(apiExports, {
  get(target, prop, receiver) {
    if (
      typeof prop !== "string" ||
      prop in target ||
      IGNORED_MISSING.has(prop)
    ) {
      return Reflect.get(target, prop, receiver);
    }
    reportMissing(prop);
    return missingApi(prop);
  },
});

/**
 * An element whose type is `undefined` is an `@raycast/api` sub-component the
 * shim doesn't have (`<Foo.Bar>` with no `Bar`) — React reports it as the
 * minified error #130, which tells the user nothing. Swap in a component that
 * throws a plain-language error when rendered, so the screen can say what's
 * wrong; the props hint at which element it was.
 */
function describeMissing(props: unknown): string {
  const p = (props ?? {}) as Record<string, unknown>;
  const hint = [p.title, p.name, p.id].find((v) => typeof v === "string");
  return `This extension uses a component Magibar doesn't support yet${
    hint ? ` ("${hint}")` : ""
  }.`;
}

// biome-ignore lint/suspicious/noExplicitAny: wraps React's overloaded jsx fns
function guardJsx<F extends (...args: any[]) => unknown>(jsxFn: F): F {
  return ((type: unknown, props: unknown, ...rest: unknown[]) => {
    const safeType =
      type === undefined
        ? function MissingComponent(): never {
            throw new UnsupportedApiError(describeMissing(props));
          }
        : type;
    return jsxFn(safeType, props, ...rest);
  }) as F;
}

const guardedJsxRuntime = {
  ...jsxRuntime,
  jsx: guardJsx(jsxRuntime.jsx),
  jsxs: guardJsx(jsxRuntime.jsxs),
};
const guardedJsxDevRuntime = {
  ...jsxDevRuntime,
  jsxDEV: guardJsx(jsxDevRuntime.jsxDEV),
};

const MODULE_OVERRIDES: Record<string, unknown> = {
  "@raycast/api": apiModule,
  react: React,
  "react/jsx-runtime": guardedJsxRuntime,
  "react/jsx-dev-runtime": guardedJsxDevRuntime,
};

/**
 * Linux: extensions only know macOS and Windows — many build their paths and
 * app tables in `if (darwin) … if (win32) …` and leave Linux with nothing,
 * or refuse "unsupported operating system". So the plugin hosts present
 * Linux as macOS (`process.platform`, `os.platform()`, `os.type()`), and map
 * what the macOS branch then reaches for onto Linux: paths (linux-paths.ts),
 * helper binaries and tool paths (linux-binaries.ts), and the tools
 * themselves (linux-shims.ts). Magibar's own shim code reads the real
 * platform from `api-shim/src/platform.ts`. `MAGIBAR_REAL_PLATFORM=1` turns
 * the disguise off, for debugging.
 */
const presentAsMacOS =
  hostPlatform === "linux" && !process.env.MAGIBAR_REAL_PLATFORM;

if (hostPlatform === "linux") {
  const overrides: Record<string, unknown> = {
    child_process: wrapChildProcess(),
    fs: wrapFsModule(fs),
    "fs/promises": wrapFsModule(fsPromises),
  };
  if (presentAsMacOS) {
    overrides.os = new Proxy(os, {
      get: (target, prop, receiver) =>
        prop === "platform"
          ? () => "darwin"
          : prop === "type"
            ? () => "Darwin"
            : Reflect.get(target, prop, receiver),
    });
  }
  for (const [name, module] of Object.entries(overrides)) {
    MODULE_OVERRIDES[name] = module;
    MODULE_OVERRIDES[`node:${name}`] = module;
  }
}

let hookInstalled = false;

export function installModuleHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  if (presentAsMacOS) {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      enumerable: true,
      configurable: true,
    });
  }
  const M = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = M._load;
  M._load = function load(request, parent, isMain) {
    if (Object.hasOwn(MODULE_OVERRIDES, request)) {
      return MODULE_OVERRIDES[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

type CommandFunction = (props: LaunchProps) => unknown;

export interface LaunchProps {
  arguments: Record<string, unknown>;
  launchType: "userInitiated" | "background";
  launchContext?: unknown;
  fallbackText?: string;
}

/** Raycast ships command bundles next to `assets/`, so bundles read
 *  `join(__dirname, "assets", …)`; ours live in `dist/` with the assets in
 *  `source/assets` (see `paths.ts`) — link one to the other. */
function linkAssets(bundlePath: string): void {
  const link = join(dirname(bundlePath), "assets");
  const target = join(dirname(bundlePath), "..", "source", "assets");
  if (existsSync(link) || !existsSync(target)) return;
  try {
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    fs.symlinkSync(target, link, "junction");
  } catch (error) {
    console.warn("[plugin-engine] couldn't link assets for __dirname:", error);
  }
}

/** `require`s a command bundle and returns its default export. Must run
 *  *after* `configurePluginContext`: a bundle's own top-level code often
 *  reads `getPreferenceValues()`/`environment` at module-eval time. */
export function loadCommand(bundlePath: string): CommandFunction {
  installModuleHook();
  linkAssets(bundlePath);
  const mod = Module.createRequire(bundlePath)(bundlePath) as
    { default?: unknown } | CommandFunction;
  const exported =
    typeof mod === "function" ? mod : (mod as { default?: unknown }).default;
  const command =
    typeof exported === "function"
      ? exported
      : (exported as { default?: unknown } | undefined)?.default;
  if (typeof command !== "function") {
    // The pre-Store install pipeline bundled a harness exporting these.
    const legacy = mod as { start?: unknown; run?: unknown };
    if (
      typeof legacy.start === "function" ||
      typeof legacy.run === "function"
    ) {
      throw new Error(
        "This extension was built by an older version of Magibar — reinstall it from Manage Extensions.",
      );
    }
    throw new Error(`${bundlePath} has no default-exported command function`);
  }
  return command as CommandFunction;
}

function launchProps(input: CommandRunInput): LaunchProps {
  return {
    arguments: input.launchArguments ?? {},
    launchType: "userInitiated",
    launchContext: input.launchContext,
    fallbackText: input.fallbackText,
  };
}

function configureContext(input: CommandRunInput): void {
  configurePluginContext({
    pluginId: input.pluginId,
    pluginTitle: input.pluginTitle,
    extensionName: input.extensionName,
    ownerOrAuthorName: input.ownerOrAuthorName,
    commandName: input.commandName,
    commandMode: input.commandMode,
    launchType: "userInitiated",
    appearance: input.appearance,
    storageFilePath: input.storageFilePath,
    cacheFilePath: input.cacheFilePath,
    supportPath: input.supportPath,
    assetsPath: input.assetsPath,
    preferenceValues: input.preferenceValues,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------- no-view -------------------------------- */

export type NoViewTransport = Pick<HostTransport, "sendEffect" | "request">;

/** Runs a no-view command to completion. Rejects with whatever the command
 *  threw — the caller reports it. */
export async function runNoView(
  input: CommandRunInput,
  transport: NoViewTransport,
): Promise<void> {
  configureContext(input);
  configureHostTransport({
    sendRenderTree() {},
    sendRenderError() {},
    sendEffect: transport.sendEffect,
    request: transport.request,
    popToRoot() {},
    clearSearchBar() {},
  });
  const Command = loadCommand(input.bundlePath);
  await Command(launchProps(input));
}

/* ---------------------------------- view --------------------------------- */

export type ViewTransport = HostTransport;

export interface RunningView {
  handleSearchTextChanged(text: string): void;
  handleActionInvoked(actionId: string): void;
  handleDropdownValueChanged(value: string): void;
  handleFormValueChanged(fieldId: string, value: unknown): void;
  handleFormSubmit(values: Record<string, unknown>): void;
  handlePop(): void;
  handleSelectionChanged(itemId: string | null): void;
  handleLoadMore(): void;
  dispose(): void;
}

/** Mounts a view command. Rejects if the bundle can't even be loaded; render
 *  errors after that are reported through `transport.sendRenderError`. */
export function startView(
  input: CommandRunInput,
  transport: ViewTransport,
): RunningView {
  configureContext(input);
  configureHostTransport(transport);
  searchTextStore.reset();
  listCallbackStore.clearSelection();

  const Command = loadCommand(input.bundlePath) as ComponentType<LaunchProps>;
  const root = createPluginRoot();
  root.render(createElement(Command, launchProps(input)));

  // An action/submit handler that throws would otherwise be an unhandled
  // rejection nobody sees — surface it the way Raycast does, as a toast.
  const reportFailure = (error: unknown): void => {
    console.error("[plugin-engine] action failed:", error);
    transport.sendEffect({
      op: "toast",
      title: "Action failed",
      message: errorMessage(error),
      style: "failure",
    });
  };

  return {
    handleSearchTextChanged(text) {
      flushSync(() => searchTextStore.setText(text));
    },
    handleActionInvoked(actionId) {
      flushSync(() => {
        actionRegistry.invoke(actionId).catch(reportFailure);
      });
    },
    handleDropdownValueChanged(value) {
      flushSync(() => dropdownChangeStore.invoke(value));
    },
    handleFormValueChanged(fieldId, value) {
      flushSync(() => formFieldChangeStore.invoke(fieldId, value));
    },
    handleFormSubmit(values) {
      flushSync(() => {
        formSubmitStore.invoke(values).catch(reportFailure);
      });
    },
    handlePop() {
      flushSync(() => navigation.navigationController?.pop());
    },
    handleSelectionChanged(itemId) {
      flushSync(() => listCallbackStore.selectionChanged(itemId));
    },
    handleLoadMore() {
      flushSync(() => listCallbackStore.loadMore());
    },
    dispose() {
      root.dispose();
    },
  };
}
