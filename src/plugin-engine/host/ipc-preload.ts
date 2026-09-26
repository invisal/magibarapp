/**
 * `window.api.pluginEngine` / `window.api.pluginList` — the preload bridge
 * for `ipc.ts`'s channels. Imported by `src/preload/index.ts`, the same way
 * every extension's own `ipc/preload.ts` is.
 */
import { ipcRenderer } from "electron";
import {
  PLUGIN_ENGINE_CHANNELS,
  type InstallProgress,
  type InstallResponse,
  type InstallSourceInput,
  type InstalledPluginSummary,
  type PluginHostMessage,
  type PluginInboundEvent,
  type PluginPreferencesPayload,
  type SearchStoreResponse,
  type StoreDetailResponse,
} from "./protocol.ts";

/** Mirrors `PluginHostSource`'s `LaunchOptions`/`LaunchOutcome` — declared
 *  here too so the preload bundle never imports main-process code. */
export interface LaunchOptionsInput {
  arguments?: Record<string, unknown>;
  launchContext?: unknown;
  fallbackText?: string;
}

export interface LaunchOutcomeResult {
  navigate?: { name: string; payload?: unknown };
  error?: string;
}

export const pluginEngineApi = {
  install: (
    source: InstallSourceInput,
    requestId: string,
  ): Promise<InstallResponse> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.install, { source, requestId }),
  onInstallProgress: (
    callback: (progress: InstallProgress) => void,
  ): (() => void) => {
    const listener = (_event: unknown, progress: InstallProgress): void =>
      callback(progress);
    ipcRenderer.on(PLUGIN_ENGINE_CHANNELS.installProgress, listener);
    return () =>
      ipcRenderer.removeListener(
        PLUGIN_ENGINE_CHANNELS.installProgress,
        listener,
      );
  },
  searchStore: (query: string): Promise<SearchStoreResponse> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.searchStore, query),
  listInstalled: (): Promise<InstalledPluginSummary[]> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.listInstalled),
  getPreferences: (
    pluginId: string,
  ): Promise<PluginPreferencesPayload | null> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.getPreferences, pluginId),
  setPreferences: (
    pluginId: string,
    values: Record<string, unknown>,
  ): Promise<boolean> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.setPreferences, pluginId, values),
  /** Rebuild/update an installed plugin from its original source. */
  reinstall: (pluginId: string, requestId: string): Promise<InstallResponse> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.reinstall, pluginId, requestId),
  uninstall: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.uninstall, pluginId),
  /** Launch a command once its preferences/arguments are collected. */
  launch: (
    actionId: string,
    options: LaunchOptionsInput,
  ): Promise<LaunchOutcomeResult> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.launch, actionId, options),
  openStorePage: (author: string, name: string): Promise<void> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.openStorePage, author, name),
  storeDetail: (author: string, name: string): Promise<StoreDetailResponse> =>
    ipcRenderer.invoke(PLUGIN_ENGINE_CHANNELS.storeDetail, author, name),
};

export const pluginListApi = {
  /** Call on mount — starts (or re-attaches to) the command instance. */
  attach: (instanceId: string, actionId: string): void =>
    ipcRenderer.send(PLUGIN_ENGINE_CHANNELS.listAttach, instanceId, actionId),
  /** Call on unmount. */
  detach: (instanceId: string): void =>
    ipcRenderer.send(PLUGIN_ENGINE_CHANNELS.listDetach, instanceId),
  sendEvent: (instanceId: string, event: PluginInboundEvent): void =>
    ipcRenderer.send(PLUGIN_ENGINE_CHANNELS.listSendEvent, instanceId, event),
  /** Fires for every running instance — a screen filters by its own
   *  `instanceId`. Returns an unsubscribe function. */
  onMessage: (callback: (message: PluginHostMessage) => void): (() => void) => {
    const listener = (_event: unknown, message: PluginHostMessage): void =>
      callback(message);
    ipcRenderer.on(PLUGIN_ENGINE_CHANNELS.listMessage, listener);
    return () =>
      ipcRenderer.removeListener(PLUGIN_ENGINE_CHANNELS.listMessage, listener);
  },
};
