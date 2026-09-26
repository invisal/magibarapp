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
import Module from "node:module";
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
import { missingApi } from "../api-shim/src/unsupported.ts";
import type { CommandRunInput } from "./list-host-messages.ts";

/* ------------------------------ module hook ------------------------------ */

const missingApiNames = new Set<string>();

/** Every `@raycast/api` name a loaded bundle asked for that the shim doesn't
 *  export — `scripts/raycast-compat.ts` reports these. */
export function getMissingApiNames(): string[] {
  return [...missingApiNames].sort();
}

const IGNORED_MISSING = new Set(["__esModule", "then", "default", "toJSON"]);

const apiModule = new Proxy({ ...raycastApi } as Record<string, unknown>, {
  get(target, prop, receiver) {
    if (
      typeof prop !== "string" ||
      prop in target ||
      IGNORED_MISSING.has(prop)
    ) {
      return Reflect.get(target, prop, receiver);
    }
    if (!missingApiNames.has(prop)) {
      missingApiNames.add(prop);
      console.warn(`[plugin-engine] @raycast/api "${prop}" is not implemented`);
    }
    return missingApi(prop);
  },
});

const MODULE_OVERRIDES: Record<string, unknown> = {
  "@raycast/api": apiModule,
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxDevRuntime,
};

let hookInstalled = false;

export function installModuleHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
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

/** `require`s a command bundle and returns its default export. Must run
 *  *after* `configurePluginContext`: a bundle's own top-level code often
 *  reads `getPreferenceValues()`/`environment` at module-eval time. */
export function loadCommand(bundlePath: string): CommandFunction {
  installModuleHook();
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
