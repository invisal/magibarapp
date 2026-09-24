import { registerUpdater } from "./updater";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  type WebContents,
} from "electron";
import { captureFocusedWindow } from "@extensions/window/main/control/control";
import {
  registerHotkey,
  unregisterHotkey,
  unregisterAllHotkeys,
  startHotkeyCapture,
  stopHotkeyCapture,
} from "./native/hotkeys";
import {
  IPC_CHANNELS,
  type CalculatorSettings,
  type RequestSubtitleOptions,
} from "../shared/types";
import {
  quitProcess,
  xcodeClean,
  actionAliases,
  actionHotkeys,
  clipboardHistory,
  actionUsage,
  executeAction,
  getCalculatorSettings,
  updateCalculatorSettings,
  initActionSources,
  openQuicklinkWith,
  query,
  quicklinkSource,
  refreshActionSources,
  registerActionSourcesIpc,
  requestSubtitle,
  settings,
} from "./actions";
import { listHostManager } from "@plugin-engine/host/list-host-manager";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "./login-item";
import { QUIT_PROCESS_CHANNELS } from "@extensions/quit-process/shared/types";
import { XCODE_CLEAN_CHANNELS } from "@extensions/xcode-clean/shared/types";
import { CLIPBOARD_HISTORY_CHANNELS } from "@extensions/clipboard-history/shared/types";
import {
  HOTKEY_CHANNELS,
  type ActionHotkeyBinding,
  type ActionHotkeySetResult,
} from "@extensions/hotkey/shared/types";
import { ALIAS_CHANNELS } from "@extensions/alias/shared/types";
import { registerQuicklinkIpc } from "@extensions/quicklink/ipc/handlers";
import { registerWindowControlsIpc } from "./window-chrome";
import {
  createLauncherWindow,
  getLauncherWindow,
  hideLauncher,
  showLauncher,
} from "./window";
import { createTray, refreshTrayMenu } from "./tray";
import {
  notifyLauncherShown,
  openOnboardingWindow,
  registerOnboardingIpc,
} from "./onboarding-window";

// The default toggle shortcut (see `DEFAULT_HOTKEY` in `settings/store.ts` for
// why macOS/Windows differ) can be rebound from Settings; the currently bound
// accelerator always lives in `settings.getHotkey()`, never a local constant.
// On Linux, Alt+Space is additionally hard-bound at the window-manager level
// on GNOME (`activate-window-menu`, and almost every other Linux DE reserves
// it the same way for a "window menu" convention going back to Windows 3.x) —
// the compositor grabs it before any app can, so `globalShortcut.register`
// always fails for it no matter what accelerator is picked. On top of that,
// GNOME ≥ 49 stopped honoring global key grabs from XWayland clients at all,
// and Electron's Wayland-native replacement (the
// `org.freedesktop.portal.GlobalShortcuts` portal) is broken by an open
// upstream bug against xdg-desktop-portal ≥ 1.20 / GNOME 50
// (electron/electron#51875) — so `globalShortcut.register` below can fail on
// Linux independent of which accelerator is picked, with no code-level fix.
// The workaround: GNOME's own custom-keybindings feature (Settings →
// Keyboard → Custom Shortcuts) can always run an arbitrary command, so
// pointing one at this same binary with `--toggle` and relaying that to the
// already-running instance (via the single-instance lock below) reaches
// `toggleLauncher` without ever asking Electron to grab the key itself.
const CLI_TOGGLE_FLAG = "--toggle";

/** Reserved hotkey id for the toggle shortcut — distinct from any action id (which are always namespaced, e.g. `cmd:settings`), so it can share the same `registerHotkey` id-space as `actionHotkeys` without colliding. */
const TOGGLE_HOTKEY_ID = "__toggle__";

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let pinned = false;
/**
 * Set while a modal picker (the file/folder dialog) is open, so the launcher's
 * blur-to-hide doesn't fire when the dialog steals focus — otherwise the window
 * vanishes and the user has to re-open it after choosing a path.
 */
let suppressAutoHide = false;

/**
 * The `WebContents` a `'destroyed'` listener is currently attached to for
 * hotkey-capture auto-stop (see `hotkeyCaptureStart` below) — at most one at
 * a time, since only one capture session is ever active. Tracked so a clean
 * stop (Escape, a successful capture, `hotkeyCaptureStop`) can remove its own
 * listener instead of leaving it attached forever: without this, starting and
 * stopping capture repeatedly on the same window — e.g. a shortcut-recorder
 * row a user tries a few times — pegs a fresh `'destroyed'` listener onto that
 * window's `WebContents` every time, past Node's default max-listeners
 * warning threshold, even though none of them will ever fire.
 */
let hotkeyCaptureSender: WebContents | null = null;

/** The `'destroyed'` handler itself — a stable reference, so `detachHotkeyCaptureSender` can remove exactly the listener `hotkeyCaptureStart` attached. */
function onHotkeyCaptureSenderDestroyed(): void {
  stopHotkeyCapture();
  hotkeyCaptureSender = null;
}

function detachHotkeyCaptureSender(): void {
  if (hotkeyCaptureSender && !hotkeyCaptureSender.isDestroyed()) {
    hotkeyCaptureSender.removeListener(
      "destroyed",
      onHotkeyCaptureSenderDestroyed,
    );
  }
  hotkeyCaptureSender = null;
}

/** Whether the launcher should stay visible on focus loss right now. */
function keepLauncherOpen(): boolean {
  return pinned || suppressAutoHide;
}

/**
 * The launcher's own window handle, so window-management commands never target
 * the launcher itself. Only meaningful on win32 (HWND) and linux (X11 window
 * id) — both are 32-bit values, so the low 32 bits of the native handle buffer
 * is the id either way. macOS excludes itself via pid instead (see
 * `control-mac.ts`), so this returns 0 there.
 */
function launcherHandle(win: BrowserWindow): number {
  if (process.platform !== "win32" && process.platform !== "linux") return 0;
  return win.getNativeWindowHandle().readUInt32LE(0);
}

function toggleLauncher(): void {
  const win = getLauncherWindow();
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  // Grab the window the user is in now, before show()/focus() makes it the launcher.
  captureFocusedWindow(launcherHandle(win));
  showLauncher();
  notifyLauncherShown();
  // Pick up changes since the last run (e.g. apps installed/removed); sources throttle.
  refreshActionSources();
}

/**
 * (Re-)grabs the currently configured accelerator if it isn't actually held
 * right now. Registration can silently lapse without any `hotkeySet` call —
 * a crashed previous instance can leave the OS-level grab orphaned until it
 * exits, an `electron-vite` dev-mode main-process restart can race the old
 * process's `will-quit` cleanup, etc. Called on startup and whenever Settings
 * asks for the current hotkey, so the UI never reports a binding as active
 * that isn't actually working.
 */
function ensureToggleShortcutRegistered(): void {
  const accelerator = settings.getHotkey();
  if (!registerHotkey(TOGGLE_HOTKEY_ID, accelerator, toggleLauncher)) {
    console.error(`Failed to register global shortcut: ${accelerator}`);
  }
}

/**
 * Runs the action bound to `actionId` the way pressing Enter on its row
 * would — but without ever showing the launcher, unless the action itself
 * asks to navigate somewhere (e.g. it opens an editor screen). Widget and
 * pinned-calculation rows don't "run" so much as hold a value: selecting them
 * in the launcher copies that value rather than calling `execute()` (see
 * `LauncherScreen.runRow`), so a hotkey bound to one reproduces that copy
 * here instead, main-side, since there's no renderer round-trip otherwise.
 */
async function runBoundAction(
  actionId: string,
  type: ActionHotkeyBinding["type"],
): Promise<void> {
  try {
    if (type === "widget" || type === "calculation") {
      const subtitle = await requestSubtitle(actionId);
      if (subtitle) clipboard.writeText(subtitle);
      return;
    }

    const result = await executeAction(actionId, "");
    if (!result.navigate) return;

    const win = getLauncherWindow();
    if (!win) return;
    captureFocusedWindow(launcherHandle(win));
    showLauncher();
    win.webContents.send(HOTKEY_CHANNELS.triggerNavigate, result.navigate);
  } catch (error) {
    // A bound action can go stale after the fact (the app it opens gets
    // uninstalled, the quicklink it points at gets deleted, …) — this runs
    // off a bare `globalShortcut` callback with nothing downstream to catch
    // a rejection, unlike the renderer-invoked `execute` IPC path.
    console.error(`Failed to run hotkey-bound action ${actionId}:`, error);
  }
}

/** Registers one action's hotkey, wired to run it via `runBoundAction`. */
function registerActionHotkey(
  actionId: string,
  binding: ActionHotkeyBinding,
): boolean {
  return registerHotkey(
    actionId,
    binding.accelerator,
    () => void runBoundAction(actionId, binding.type),
  );
}

/** (Re-)asserts every persisted action hotkey — see `ensureToggleShortcutRegistered`; `registerHotkey` is itself a no-op if nothing lapsed. */
function ensureActionHotkeysRegistered(): void {
  for (const [actionId, binding] of Object.entries(actionHotkeys.list())) {
    if (!registerActionHotkey(actionId, binding)) {
      console.error(
        `Failed to register hotkey for ${actionId}: ${binding.accelerator}`,
      );
    }
  }
}

/**
 * Toggles the launcher from argv — what a GNOME custom keyboard shortcut
 * invokes instead of a hotkey Electron can't grab directly on this desktop
 * (see `DEFAULT_HOTKEY` in `settings/store.ts`). A relaunch while Magibar is
 * already running relays its argv here via `second-instance`; the very first
 * launch checks its own `process.argv` the same way, in case that launch
 * itself was the GNOME shortcut firing before anything was running yet.
 */
function handleCliAction(argv: string[]): void {
  if (argv.includes(CLI_TOGGLE_FLAG)) toggleLauncher();
}

app.on("second-instance", (_event, argv) => {
  handleCliAction(argv);
});

app.whenReady().then(() => {
  createLauncherWindow(keepLauncherOpen);
  createTray(toggleLauncher, () => settings.getHotkey());
  handleCliAction(process.argv);

  // Warm every action source now (apps: disk cache, then a background worker run)
  // instead of waiting for the renderer's first search.
  initActionSources();

  // Push a lightweight "list changed" event to the launcher window whenever
  // the poller records a new entry in the background, so the history screen
  // refreshes live instead of only on its next mount.
  clipboardHistory.onRecord(() => {
    getLauncherWindow()?.webContents.send(CLIPBOARD_HISTORY_CHANNELS.updated);
  });

  // Push the fresh process snapshot to the launcher window on every poll
  // tick (only running while the Activity Monitor screen is open — see
  // `QuitProcessExtension`), so the list stays live without the
  // renderer having to re-fetch on its own timer.
  quitProcess.onRefresh((rows) => {
    getLauncherWindow()?.webContents.send(QUIT_PROCESS_CHANNELS.updated, rows);
  });

  // Push each category's sizes to the launcher window as the native scan
  // finishes them (Clean Xcode), so its list fills in live.
  xcodeClean.onScan((snapshot) => {
    getLauncherWindow()?.webContents.send(
      XCODE_CLEAN_CHANNELS.updated,
      snapshot,
    );
  });

  // Each extension wires its own `ipcMain` handlers via `registerIpc()`.
  registerActionSourcesIpc(ipcMain);
  registerWindowControlsIpc();
  registerOnboardingIpc();
  // Quicklink's IPC needs the launcher window's own state (pinned,
  // blur-suppression, the window itself), which only `index.ts` owns, so it
  // stays wired here rather than through `registerIpc()`.
  registerQuicklinkIpc(quicklinkSource, openQuicklinkWith, {
    getLauncherWindow,
    setSuppressAutoHide: (value) => {
      suppressAutoHide = value;
    },
    hideAfterOpen: () => {
      if (!pinned) hideLauncher();
    },
    usageOf: actionUsage,
    aliasOf: (actionId) => actionAliases.get(actionId),
  });

  ipcMain.handle(IPC_CHANNELS.query, (_event, text: string) => {
    return query(text);
  });

  ipcMain.handle(
    IPC_CHANNELS.execute,
    async (_event, id: string, text: string, argument?: string) => {
      // `text` is threaded through so usage tracking can learn "typed X, picked Y".
      const result = await executeAction(id, text, argument);
      // Hide as soon as execute() resolves, rather than waiting for the launched
      // app to grab focus and trigger `blur` — unless the action asked the
      // launcher to navigate instead (`ctx.navigate`), in which case it stays
      // open showing the pushed screen.
      if (!result.navigate && !pinned) hideLauncher();
      return result;
    },
  );

  ipcMain.on(IPC_CHANNELS.hide, () => {
    hideLauncher();
  });

  ipcMain.handle(
    IPC_CHANNELS.requestSubtitle,
    (_event, id: string, opts?: RequestSubtitleOptions) =>
      requestSubtitle(id, opts),
  );

  ipcMain.handle(IPC_CHANNELS.calculatorSettingsGet, () =>
    getCalculatorSettings(),
  );
  ipcMain.handle(
    IPC_CHANNELS.calculatorSettingsSet,
    (_event, patch: Partial<CalculatorSettings>) =>
      updateCalculatorSettings(patch),
  );

  ipcMain.handle(IPC_CHANNELS.launchAtLoginGet, () => isLaunchAtLoginEnabled());
  ipcMain.handle(IPC_CHANNELS.launchAtLoginSet, (_event, enabled: boolean) =>
    setLaunchAtLogin(enabled),
  );

  ipcMain.handle(IPC_CHANNELS.togglePin, () => {
    pinned = !pinned;
    return pinned;
  });

  registerUpdater(getLauncherWindow);

  ensureToggleShortcutRegistered();

  ipcMain.handle(IPC_CHANNELS.hotkeyGet, () => {
    // Self-heal a lapsed registration before answering, so Settings never
    // shows a binding as active that has silently stopped working.
    ensureToggleShortcutRegistered();
    return settings.getHotkey();
  });

  ipcMain.handle(IPC_CHANNELS.hotkeySet, (_event, accelerator: string) => {
    const previous = settings.getHotkey();
    if (accelerator === previous) return { success: true, hotkey: previous };

    // `registerHotkey` replaces whatever was previously registered under
    // `TOGGLE_HOTKEY_ID` internally, so no separate unregister step first.
    const registered = registerHotkey(
      TOGGLE_HOTKEY_ID,
      accelerator,
      toggleLauncher,
    );

    if (!registered) {
      // Couldn't grab the new accelerator (bad format, or — on mac/linux,
      // still `globalShortcut`-backed — another app already holds it) —
      // restore the previous one so the launcher stays reachable.
      registerHotkey(TOGGLE_HOTKEY_ID, previous, toggleLauncher);
      return { success: false, hotkey: previous };
    }

    settings.setHotkey(accelerator);
    refreshTrayMenu();
    return { success: true, hotkey: accelerator };
  });

  // Shared by every shortcut-recorder UI (the toggle row in Settings and
  // `HotkeyPanel`'s per-action "Set Hotkey…" in the launcher window) — see
  // the `hotkeyCapture*` doc comment in `shared/types.ts`. Targets whichever
  // window asked to start capturing; auto-stops if that window goes away
  // mid-recording so a closed Settings window can never leave the native
  // hook stuck suppressing `Win`-involving keys system-wide.
  ipcMain.on(IPC_CHANNELS.hotkeyCaptureStart, (event) => {
    const sender = event.sender;
    startHotkeyCapture((accelerator) => {
      if (sender.isDestroyed()) return;
      sender.send(IPC_CHANNELS.hotkeyCaptured, accelerator);
    });
    // A restart (recording, cancelling, recording again) replaces the tracked
    // sender rather than adding to it — see `hotkeyCaptureSender`'s doc comment.
    detachHotkeyCaptureSender();
    hotkeyCaptureSender = sender;
    sender.once("destroyed", onHotkeyCaptureSenderDestroyed);
  });

  ipcMain.on(IPC_CHANNELS.hotkeyCaptureStop, () => {
    stopHotkeyCapture();
    detachHotkeyCaptureSender();
  });

  ensureActionHotkeysRegistered();

  // Last, so the shortcut the tour asks the user to press is already live.
  if (!settings.isOnboardingCompleted()) openOnboardingWindow();

  ipcMain.handle(
    HOTKEY_CHANNELS.list,
    (): Record<string, ActionHotkeyBinding> => {
      ensureActionHotkeysRegistered();
      return actionHotkeys.list();
    },
  );

  ipcMain.handle(
    HOTKEY_CHANNELS.set,
    (
      _event,
      actionId: string,
      accelerator: string,
      type: ActionHotkeyBinding["type"],
      force?: boolean,
    ): ActionHotkeySetResult => {
      const previous = actionHotkeys.get(actionId);
      if (accelerator === previous?.accelerator) {
        return { success: true, binding: previous ?? null };
      }

      // The toggle shortcut lives in `settings`, not `actionHotkeys` — never
      // reassign it here even with `force`, since silently stealing it would
      // leave the user unable to reopen the launcher by keyboard, with no
      // obvious way back short of Settings.
      if (accelerator === settings.getHotkey()) {
        return { success: false, binding: previous ?? null, reason: "toggle" };
      }

      const conflictingId = Object.entries(actionHotkeys.list()).find(
        ([id, binding]) =>
          id !== actionId && binding.accelerator === accelerator,
      )?.[0];
      if (conflictingId) {
        if (!force) {
          return {
            success: false,
            binding: previous ?? null,
            reason: "conflict",
          };
        }
        unregisterHotkey(conflictingId);
        actionHotkeys.remove(conflictingId);
      }

      // `registerActionHotkey` replaces whatever was previously registered
      // under this `actionId` internally, so no separate unregister step first.
      const binding: ActionHotkeyBinding = { accelerator, type };
      const registered = registerActionHotkey(actionId, binding);

      if (!registered) {
        // Couldn't grab the new accelerator — restore the previous binding
        // (if any) so the action stays reachable the way it was.
        if (previous) registerActionHotkey(actionId, previous);
        return { success: false, binding: previous ?? null };
      }

      actionHotkeys.set(actionId, binding);
      return { success: true, binding };
    },
  );

  ipcMain.handle(HOTKEY_CHANNELS.remove, (_event, actionId: string) => {
    unregisterHotkey(actionId);
    actionHotkeys.remove(actionId);
  });

  // Aliases are plain data with no OS-level side effect to register/roll
  // back — unlike hotkeys, `set`/`remove` are unconditional writes.
  ipcMain.handle(ALIAS_CHANNELS.list, (): Record<string, string> =>
    actionAliases.list(),
  );
  ipcMain.handle(
    ALIAS_CHANNELS.set,
    (_event, actionId: string, alias: string) => {
      actionAliases.set(actionId, alias);
    },
  );
  ipcMain.handle(ALIAS_CHANNELS.remove, (_event, actionId: string) => {
    actionAliases.remove(actionId);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createLauncherWindow(keepLauncherOpen);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  unregisterAllHotkeys();
  clipboardHistory.stopPolling();
  quitProcess.stopPolling();
  listHostManager.disposeAll();
});
