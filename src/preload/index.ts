import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC_CHANNELS,
  type CalculatorSettings,
  type ExecuteResult,
  type HotkeySetResult,
  type QueryResult,
  type RequestSubtitleOptions,
  type UpdateStatus,
} from "../shared/types";
import { quitProcessApi } from "@extensions/quit-process/ipc/preload";
import { xcodeCleanApi } from "@extensions/xcode-clean/ipc/preload";
import { calculatorHistoryApi } from "@extensions/calculator-history/ipc/preload";
import { clipboardHistoryApi } from "@extensions/clipboard-history/ipc/preload";
import { groupApi } from "@extensions/group/ipc/preload";
import { actionHotkeysApi } from "@extensions/hotkey/ipc/preload";
import { actionAliasesApi } from "@extensions/alias/ipc/preload";
import { quicklinkApi } from "@extensions/quicklink/ipc/preload";
import { widgetApi } from "@extensions/widget/ipc/preload";
import { windowApi } from "@extensions/window/ipc/preload";
import { pluginEngineApi, pluginListApi } from "@plugin-engine/host/ipc-preload";

const api = {
  platform: process.platform,
  query: (text: string): Promise<QueryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.query, text),
  /** `argument` is the text typed into the launcher's argument chip, if any. */
  execute: (
    id: string,
    text: string,
    argument?: string,
  ): Promise<ExecuteResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.execute, id, text, argument),
  hide: (): void => ipcRenderer.send(IPC_CHANNELS.hide),
  togglePin: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.togglePin),

  /** Settings → Calculator: crypto prices on/off, number format. */
  calculatorSettings: {
    get: (): Promise<CalculatorSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.calculatorSettingsGet),
    set: (patch: Partial<CalculatorSettings>): Promise<CalculatorSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.calculatorSettingsSet, patch),
  },

  /** Settings → General: read / set "Launch at login". */
  launchAtLogin: {
    get: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.launchAtLoginGet),
    /** Resolves with the setting actually in effect (see `setLaunchAtLogin`'s doc comment). */
    set: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.launchAtLoginSet, enabled),
  },

  /** Settings → General: read / rebind the global toggle shortcut. */
  hotkey: {
    get: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.hotkeyGet),
    set: (accelerator: string): Promise<HotkeySetResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.hotkeySet, accelerator),
    /**
     * Shared by every shortcut-recorder UI, not just this row — see the
     * `hotkeyCapture*` doc comment in `shared/types.ts`. A recorder calls
     * `captureStart()` on entering recording mode and `captureStop()` on
     * leaving it (confirmed, cancelled, or unmounted), and subscribes via
     * `onCaptured` for the `Win`-involving accelerators it wouldn't
     * otherwise see through its own `keydown` listener.
     */
    captureStart: (): void => ipcRenderer.send(IPC_CHANNELS.hotkeyCaptureStart),
    captureStop: (): void => ipcRenderer.send(IPC_CHANNELS.hotkeyCaptureStop),
    onCaptured: (cb: (accelerator: string) => void): (() => void) => {
      const listener = (_: unknown, accelerator: string): void =>
        cb(accelerator);
      ipcRenderer.on(IPC_CHANNELS.hotkeyCaptured, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.hotkeyCaptured, listener);
    },
  },

  /** First-run welcome tour ↔ main. */
  onboarding: {
    /** Marks the tour done, closes its window and opens the launcher. */
    finish: (): void => ipcRenderer.send(IPC_CHANNELS.onboardingFinish),
    /** Replays the tour (Settings → General). */
    open: (): void => ipcRenderer.send(IPC_CHANNELS.onboardingOpen),
    /** Fires whenever the launcher is shown, e.g. by its global shortcut. */
    onLauncherShown: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on(IPC_CHANNELS.onboardingLauncherShown, listener);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.onboardingLauncherShown,
          listener,
        );
    },
  },

  /** Launcher: a deferred-subtitle row rendered (or force-refreshed) — resolves with the fresh subtitle. */
  requestSubtitle: (
    actionId: string,
    opts?: RequestSubtitleOptions,
  ): Promise<string | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.requestSubtitle, actionId, opts),

  /** Window-chrome controls for the framed windows (Settings, Widget), which
   *  render their own title bar. Each acts on the calling window. */
  windowControls: {
    minimize: (): void => ipcRenderer.send(IPC_CHANNELS.windowMinimize),
    toggleMaximize: (): void =>
      ipcRenderer.send(IPC_CHANNELS.windowToggleMaximize),
    close: (): void => ipcRenderer.send(IPC_CHANNELS.windowClose),
  },

  /** App version + auto-update (launcher footer) <-> main. */
  update: {
    get: (): Promise<{ version: string; status: UpdateStatus }> =>
      ipcRenderer.invoke(IPC_CHANNELS.updateGet),
    check: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    install: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_: unknown, status: UpdateStatus): void => cb(status);
      ipcRenderer.on(IPC_CHANNELS.updateStatus, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.updateStatus, listener);
    },
  },

  /** Widget manager window ↔ main. */
  widget: widgetApi,

  /** Window management (OS-level control + the custom-layout manager) ↔ main. */
  window: windowApi,

  /** Calculator History (record, list, pin) ↔ main. */
  calculatorHistory: calculatorHistoryApi,

  /** Clipboard History (list, pin, delete, copy-again) ↔ main. */
  clipboardHistory: clipboardHistoryApi,

  /** Activity Monitor (list, start/stop polling, kill) ↔ main. */
  quitProcess: quitProcessApi,

  /** Clean Xcode (scan, clean, reveal) ↔ main. */
  xcodeClean: xcodeCleanApi,

  /** Quicklinks: the Create/Edit/Duplicate form and the Ctrl+K menu ↔ main. */
  quicklink: quicklinkApi,

  /** Group manager screen ↔ main. */
  group: groupApi,

  /** Per-action global hotkeys (Ctrl+K menu's "Set Hotkey…") ↔ main. */
  actionHotkeys: actionHotkeysApi,

  /** Per-action aliases (Ctrl+K menu's "Alias" row) ↔ main. */
  actionAliases: actionAliasesApi,

  /** Install-plugin screen ↔ main (`src/plugin-engine`). */
  pluginEngine: pluginEngineApi,

  /** `PluginListScreen` ↔ its running command instance. */
  pluginList: pluginListApi,

  /** A picked `File`'s real filesystem path — Electron removed
   *  `File.path` (regardless of sandbox settings), so `PluginFormScreen`'s
   *  `Form.FilePicker` resolves it here instead, via `electron.webUtils`
   *  (only reachable from the preload script under `contextIsolation`). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("api", api);

export type LauncherApi = typeof api;
