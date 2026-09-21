/**
 * Cross-platform global-hotkey manager, replacing direct `globalShortcut` calls
 * for both the toggle shortcut and per-action hotkeys (`actionHotkeys` in
 * `main/actions.ts`).
 *
 * On Windows, backed by `@magibar/win`'s `HotkeyWatcher` — a `WH_KEYBOARD_LL`
 * hook (see `native/win/src/lib.rs` for why: `RegisterHotKey`, which Electron's
 * `globalShortcut` wraps, can't win against Explorer's hardcoded `Win+<key>`
 * shortcuts and can't represent a lone-modifier tap at all). On mac/linux, a
 * thin pass-through to `electron.globalShortcut` — unchanged behavior; neither
 * platform has this problem to the same degree, and neither has the native hook
 * built (see the mac follow-up noted in code review).
 *
 * Every call site goes through this module only, so nothing outside it needs a
 * `process.platform` branch or an `@magibar/win` import of its own — mirrors
 * `sources/apps.ts`/`extensions/window/main/control/control.ts`.
 */
import { createRequire } from "node:module";
import { globalShortcut } from "electron";

/**
 * Sentinel accelerator for "the Windows/Command key alone". Electron's
 * accelerator grammar has no way to express a modifier with no key, so this
 * literal (never a real `Accelerator` string) is what `SettingsStore`/
 * `HotkeyBindingStore` persist and what the renderer's capture UI produces for
 * a clean tap. Only meaningful on Windows today — registering it elsewhere
 * always fails (see `register` below).
 */
export const LONE_SUPER_HOTKEY = "Super";

type NativeWin = typeof import("@magibar/win");
const nodeRequire = createRequire(import.meta.url);
let native: NativeWin | null | undefined;

function loadNative(): NativeWin | null {
  if (native !== undefined) return native;
  if (process.platform !== "win32") return (native = null);
  try {
    native = nodeRequire("@magibar/win") as NativeWin;
  } catch (error) {
    console.error("[hotkeys] Failed to load @magibar/win:", error);
    native = null;
  }
  return native;
}

interface HotkeyEngine {
  /** Idempotent: safe to call repeatedly with the same `id`/`accelerator`. */
  register(id: string, accelerator: string, onTrigger: () => void): boolean;
  unregister(id: string): void;
  unregisterAll(): void;
  /**
   * Starts/stops reporting `Win`-involving keystrokes to `onCapture` for a
   * shortcut-recorder UI — see the `IPC_CHANNELS.hotkeyCapture*` doc comment
   * in `shared/types.ts` for why this exists. A no-op pair where there's
   * nothing to add (mac/linux, or Windows without the native addon) — those
   * platforms' recorder UI stays DOM-only, unaffected.
   */
  startCapture(onCapture: (accelerator: string) => void): void;
  stopCapture(): void;
}

/**
 * The native engine: one `HotkeyWatcher`/hook for the process, callbacks
 * resolved locally by id since the native side only reports the id string
 * back. Lazily started on first use rather than at module load, so a platform
 * where `@magibar/win` fails to load never spends anything on it.
 */
function createWindowsEngine(win: NativeWin): HotkeyEngine {
  const callbacks = new Map<string, () => void>();
  let watcher: InstanceType<NativeWin["HotkeyWatcher"]> | null = null;

  function ensureWatcher(): InstanceType<NativeWin["HotkeyWatcher"]> {
    if (watcher) return watcher;
    watcher = win.startHotkeyWatcher((error, id) => {
      if (error) {
        console.error("[hotkeys] startHotkeyWatcher callback error:", error);
        return;
      }
      callbacks.get(id)?.();
    });
    return watcher;
  }

  return {
    register(id, accelerator, onTrigger) {
      const ok = ensureWatcher().register(id, accelerator);
      if (ok) callbacks.set(id, onTrigger);
      return ok;
    },
    unregister(id) {
      watcher?.unregister(id);
      callbacks.delete(id);
    },
    unregisterAll() {
      for (const id of callbacks.keys()) watcher?.unregister(id);
      callbacks.clear();
    },
    startCapture(onCapture) {
      ensureWatcher().startCapture((error, accelerator) => {
        if (error) {
          console.error("[hotkeys] startCapture callback error:", error);
          return;
        }
        onCapture(accelerator);
      });
    },
    stopCapture() {
      watcher?.stopCapture();
    },
  };
}

/**
 * The `globalShortcut` fallback for mac/linux, and for Windows if
 * `@magibar/win` fails to load. Tracks accelerators by id itself (mirroring
 * the native engine's shape) since `globalShortcut` only knows accelerators,
 * not ids — lets callers stay id-based regardless of which engine backs them.
 */
function createElectronEngine(): HotkeyEngine {
  const accelerators = new Map<string, string>();

  return {
    register(id, accelerator, onTrigger) {
      if (accelerator === LONE_SUPER_HOTKEY) return false; // not representable via globalShortcut
      if (globalShortcut.isRegistered(accelerator)) {
        // Someone (possibly this same id, previously) already holds it —
        // treat as success only if it's genuinely this id's own binding, so
        // a stale registration doesn't masquerade as a fresh one for a
        // *different* id trying to reuse the same combo.
        return accelerators.get(id) === accelerator;
      }
      const previous = accelerators.get(id);
      if (previous) globalShortcut.unregister(previous);
      let ok: boolean;
      try {
        ok = globalShortcut.register(accelerator, onTrigger);
      } catch {
        ok = false; // a malformed accelerator string throws rather than returning false
      }
      if (ok) {
        accelerators.set(id, accelerator);
      } else if (previous) {
        globalShortcut.register(previous, onTrigger);
      }
      return ok;
    },
    unregister(id) {
      const accelerator = accelerators.get(id);
      if (accelerator) globalShortcut.unregister(accelerator);
      accelerators.delete(id);
    },
    unregisterAll() {
      globalShortcut.unregisterAll();
      accelerators.clear();
    },
    // No native hook here — the renderer's existing DOM-based capture
    // already handles everything this platform/fallback can register.
    startCapture() {},
    stopCapture() {},
  };
}

let engine: HotkeyEngine | undefined;

function hotkeyEngine(): HotkeyEngine {
  if (engine) return engine;
  const win = loadNative();
  engine = win ? createWindowsEngine(win) : createElectronEngine();
  return engine;
}

/**
 * Registers `accelerator` (or re-asserts it if already registered) under
 * `id`, so `onTrigger` runs whenever it fires. Safe to call on every "make
 * sure this is still active" pass (see `ensureToggleShortcutRegistered`/
 * `ensureActionHotkeysRegistered` in `main/index.ts`) — a no-op if nothing
 * changed. Returns whether the accelerator is registered under `id` now.
 */
export function registerHotkey(
  id: string,
  accelerator: string,
  onTrigger: () => void,
): boolean {
  return hotkeyEngine().register(id, accelerator, onTrigger);
}

export function unregisterHotkey(id: string): void {
  hotkeyEngine().unregister(id);
}

/** Called from `main/index.ts`'s `will-quit` handler. */
export function unregisterAllHotkeys(): void {
  hotkeyEngine().unregisterAll();
}

/**
 * Starts forwarding `Win`-involving keystrokes as captured accelerator
 * strings, for as long as a shortcut recorder is open. Replaces any
 * previously-registered `onCapture` if already capturing (a fresh
 * `captureStart` from a newly-opened recorder always wins).
 */
export function startHotkeyCapture(
  onCapture: (accelerator: string) => void,
): void {
  hotkeyEngine().startCapture(onCapture);
}

export function stopHotkeyCapture(): void {
  hotkeyEngine().stopCapture();
}
