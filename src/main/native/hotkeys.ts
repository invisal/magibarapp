/**
 * Cross-platform global-hotkey manager, replacing direct `globalShortcut` calls
 * for both the toggle shortcut and per-action hotkeys (`actionHotkeys` in
 * `main/actions.ts`).
 *
 * On Windows, backed by `@magibar/win`'s `HotkeyWatcher` — a `WH_KEYBOARD_LL`
 * hook (see `native/win/src/lib.rs` for why: `RegisterHotKey`, which Electron's
 * `globalShortcut` wraps, can't win against Explorer's hardcoded `Win+<key>`
 * shortcuts and can't represent a lone-modifier tap at all). On mac, backed by
 * `@magibar/mac`'s `HotkeyWatcher` — a session-level `CGEventTap` (see
 * `native/mac/src/lib.rs`: `globalShortcut`/Carbon's `RegisterEventHotKey` has
 * the same two gaps — a combo already claimed by another app never reaches
 * this process at all, and there's no way to represent a modifier-only chord
 * like `Shift+Command`). On Linux, backed by `@magibar/linux`'s
 * `HotkeyWatcher` — a GNOME "custom keyboard shortcut runs a command" entry
 * per hotkey id, managed via the `gsettings`/`dconf` CLIs, whose command
 * relays back to this process over a small D-Bus service this same module
 * hosts (see `native/linux/src/lib.rs`'s module doc for the full story,
 * including why: GNOME hard-reserves the default toggle accelerator at the
 * compositor level regardless of what's picked, and GNOME >= 49 additionally
 * stopped forwarding *any* global key grab to XWayland clients at all —
 * exactly the mechanism `globalShortcut` (and a raw `XGrabKey`, tried first)
 * relies on, so neither can work there; the `org.freedesktop.portal.
 * GlobalShortcuts` D-Bus portal was tried after that and bound shortcuts
 * that sat correctly in `dconf` without reliably ever firing, which is what
 * led here instead). Wherever a platform's native addon fails to load, a
 * thin pass-through to `electron.globalShortcut`.
 *
 * Every call site goes through this module only, so nothing outside it needs a
 * `process.platform` branch or a native-addon import of its own — mirrors
 * `sources/apps.ts`/`extensions/window/main/control/control.ts`.
 */
import { createRequire } from "node:module";
import { globalShortcut } from "electron";

/**
 * Sentinel accelerator for "the Windows/Command key alone". Electron's
 * accelerator grammar has no way to express a modifier with no key, so this
 * literal (never a real `Accelerator` string) is what `SettingsStore`/
 * `HotkeyBindingStore` persist and what the renderer's capture UI produces for
 * a clean tap. Only meaningful on Windows and mac, and only when each
 * platform's native addon is loaded — registering it elsewhere (Linux
 * included: a GNOME custom keybinding has no modifier-only-chord
 * representation either, same gap as `native/win`'s `RegisterHotKey`-based
 * fallback would have — see `accelerator_to_binding` in
 * `native/linux/src/lib.rs`) always fails (see `createElectronEngine`'s
 * `register` below).
 */
export const LONE_SUPER_HOTKEY = "Super";

/** The `HotkeyWatcher` instance shape `@magibar/win`, `@magibar/mac`, and `@magibar/linux` all export. */
interface NativeHotkeyWatcher {
  /**
   * Whether the OS-level hook was actually installed. Only `@magibar/mac`
   * exports it (its `CGEventTap` is refused, silently, without the right
   * privacy grants); absent elsewhere, where a load failure is the only
   * failure mode.
   */
  isActive?(): boolean;
  register(id: string, accelerator: string): boolean;
  unregister(id: string): void;
  startCapture(callback: (error: Error | null, accelerator: string) => void): void;
  stopCapture(): void;
  stop(): void;
}

/** The module shape `@magibar/win`, `@magibar/mac`, and `@magibar/linux` all export. */
interface NativeHotkeyModule {
  startHotkeyWatcher(
    callback: (error: Error | null, id: string) => void,
  ): NativeHotkeyWatcher;
  /** mac only: whether Input Monitoring + Accessibility are both granted. Never prompts. */
  hasEventAccess?(): boolean;
  /** mac only: shows the system prompts for whichever grant is missing. */
  requestEventAccess?(): boolean;
}

const nodeRequire = createRequire(import.meta.url);
let native: NativeHotkeyModule | null | undefined;

/** The native addon name for the current platform. */
function nativeModuleName(): string | null {
  if (process.platform === "win32") return "@magibar/win";
  if (process.platform === "darwin") return "@magibar/mac";
  if (process.platform === "linux") return "@magibar/linux";
  return null;
}

function loadNative(): NativeHotkeyModule | null {
  if (native !== undefined) return native;
  const moduleName = nativeModuleName();
  if (!moduleName) return (native = null);
  try {
    native = nodeRequire(moduleName) as NativeHotkeyModule;
  } catch (error) {
    console.error(`[hotkeys] Failed to load ${moduleName}:`, error);
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
   * Starts/stops reporting keystrokes a shortcut-recorder UI couldn't
   * otherwise observe (see `IPC_CHANNELS.hotkeyCapture*` in `shared/types.ts`)
   * to `onCapture`. A no-op pair on Linux, or wherever a platform's native
   * addon fails to load — those recorder UIs stay DOM-only, unaffected.
   */
  startCapture(onCapture: (accelerator: string) => void): void;
  stopCapture(): void;
}

/**
 * The native engine: one `HotkeyWatcher`/hook for the process, callbacks
 * resolved locally by id since the native side only reports the id string
 * back. Lazily started on first use rather than at module load, so a platform
 * whose native addon fails to load never spends anything on it. Shared
 * between Windows (`@magibar/win`, a `WH_KEYBOARD_LL` hook) and mac
 * (`@magibar/mac`, a `CGEventTap`) — both export the identical
 * `HotkeyWatcher`/`startHotkeyWatcher` shape `NativeHotkeyModule` describes,
 * even though what's underneath differs completely per platform.
 */
interface NativeEngine extends HotkeyEngine {
  /** Whether the OS-level hook is installed (always true where the addon can't report otherwise). */
  isActive(): boolean;
  /**
   * Tears the watcher down and starts a fresh one — what picks up a privacy
   * grant made after launch, since a refused tap is never retried on its own.
   * Bindings already registered are carried over. Returns `isActive()`.
   */
  restart(): boolean;
}

function createNativeEngine(nativeModule: NativeHotkeyModule): NativeEngine {
  const callbacks = new Map<string, () => void>();
  const accelerators = new Map<string, string>();
  let watcher: NativeHotkeyWatcher | null = null;

  function ensureWatcher(): NativeHotkeyWatcher {
    if (watcher) return watcher;
    watcher = nativeModule.startHotkeyWatcher((error, id) => {
      if (error) {
        console.error("[hotkeys] startHotkeyWatcher callback error:", error);
        return;
      }
      callbacks.get(id)?.();
    });
    return watcher;
  }

  return {
    isActive() {
      return ensureWatcher().isActive?.() ?? true;
    },
    restart() {
      watcher?.stop();
      watcher = null;
      const fresh = ensureWatcher();
      for (const [id, accelerator] of accelerators) fresh.register(id, accelerator);
      return fresh.isActive?.() ?? true;
    },
    register(id, accelerator, onTrigger) {
      const ok = ensureWatcher().register(id, accelerator);
      if (ok) {
        callbacks.set(id, onTrigger);
        accelerators.set(id, accelerator);
      }
      return ok;
    },
    unregister(id) {
      watcher?.unregister(id);
      callbacks.delete(id);
      accelerators.delete(id);
    },
    unregisterAll() {
      for (const id of callbacks.keys()) watcher?.unregister(id);
      callbacks.clear();
      accelerators.clear();
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
  const triggers = new Map<string, () => void>();
  let capturing = false;

  function reregisterAll(): void {
    for (const [id, accelerator] of accelerators) {
      const onTrigger = triggers.get(id);
      if (!onTrigger) continue;
      try {
        globalShortcut.register(accelerator, onTrigger);
      } catch {
        // Best-effort restore — a binding that no longer registers cleanly
        // (e.g. another app grabbed it while we'd let go) just stays dropped
        // until the next `ensure*Registered` pass notices and retries.
      }
    }
  }

  /**
   * Whether some *other* id already holds `accelerator`, per our own
   * bookkeeping rather than `globalShortcut.isRegistered()`. The OS-level
   * query only reflects what's currently grabbed, which `startCapture`
   * intentionally lets lapse for every id at once — relying on it here would
   * let a genuine conflict through undetected for the entire time a recorder
   * is open (and briefly after, until `stopCapture` catches up), which is
   * exactly the "still opens the other bound app" bug this guards against:
   * without it, a conflicting combo gets accepted as this id's own during
   * capture, and `stopCapture`'s `reregisterAll` then just lets whichever id
   * re-registers the shared accelerator last silently win the OS grab.
   */
  function heldByAnotherId(id: string, accelerator: string): boolean {
    for (const [otherId, otherAccelerator] of accelerators) {
      if (otherId !== id && otherAccelerator === accelerator) return true;
    }
    return false;
  }

  return {
    register(id, accelerator, onTrigger) {
      if (accelerator === LONE_SUPER_HOTKEY) return false; // not representable via globalShortcut
      if (heldByAnotherId(id, accelerator)) return false;
      if (capturing) {
        // Don't grab anything at the OS level while a recorder is
        // capturing — see `startCapture`. Just remember the binding so
        // `stopCapture` can re-assert it once recording ends; otherwise a
        // stray `ensure*Registered` pass mid-recording (e.g. Settings
        // polling `hotkeyGet`) would silently re-open the exact race this
        // capture mode exists to close.
        accelerators.set(id, accelerator);
        triggers.set(id, onTrigger);
        return true;
      }
      const previous = accelerators.get(id);
      if (previous === accelerator && globalShortcut.isRegistered(accelerator)) {
        return true; // already exactly this id's own live binding — nothing to do
      }
      if (previous) globalShortcut.unregister(previous);
      let ok: boolean;
      try {
        ok = globalShortcut.register(accelerator, onTrigger);
      } catch {
        ok = false; // a malformed accelerator string throws rather than returning false
      }
      if (ok) {
        accelerators.set(id, accelerator);
        triggers.set(id, onTrigger);
      } else if (previous) {
        globalShortcut.register(previous, onTrigger);
      }
      return ok;
    },
    unregister(id) {
      const accelerator = accelerators.get(id);
      if (accelerator) globalShortcut.unregister(accelerator);
      accelerators.delete(id);
      triggers.delete(id);
    },
    unregisterAll() {
      globalShortcut.unregisterAll();
      accelerators.clear();
      triggers.clear();
    },
    // `globalShortcut` grabs a combo at the OS level, so a key already bound
    // to some action never reaches this window's DOM listeners at all while
    // recording — the OS routes it straight to that action's callback
    // instead of delivering a normal keydown (the mac/linux mirror of why
    // Windows needs its own low-level hook here). Releasing every grab for
    // the duration of capture — keeping the id/accelerator bookkeeping
    // intact — lets the renderer's existing DOM-based capture see *any* key
    // combo while recording, then `stopCapture` re-asserts everything.
    startCapture() {
      if (capturing) return;
      capturing = true;
      globalShortcut.unregisterAll();
    },
    stopCapture() {
      if (!capturing) return;
      capturing = false;
      reregisterAll();
    },
  };
}

/**
 * Wraps the native engine with a `globalShortcut` fallback for when the OS
 * refuses to install the hook. On mac that's the normal failure shape of a
 * missing/stale Input Monitoring or Accessibility grant — the addon loads
 * fine and `register()` "succeeds", but nothing would ever fire. In that
 * state bindings go through `globalShortcut` instead (most combos still
 * work; ones another app or the system owns, like Spotlight's `Cmd+Space`,
 * and modifier-only chords don't), and every `register` re-tries the native
 * hook first so a grant made while running is picked up without a relaunch.
 */
function createResilientEngine(native: NativeEngine): ResilientEngine {
  const fallback = createElectronEngine();
  const bindings = new Map<string, { accelerator: string; onTrigger: () => void }>();
  let mode: "native" | "fallback" = native.isActive() ? "native" : "fallback";

  function refreshMode(): "native" | "fallback" {
    if (mode === "native") {
      if (native.isActive()) return mode;
      mode = "fallback";
    }
    if (native.restart()) {
      // The hook came up (permission granted since): hand everything over.
      fallback.unregisterAll();
      for (const [id, { accelerator, onTrigger }] of bindings) {
        native.register(id, accelerator, onTrigger);
      }
      mode = "native";
    }
    return mode;
  }

  function current(): HotkeyEngine {
    return refreshMode() === "native" ? native : fallback;
  }

  return {
    register(id, accelerator, onTrigger) {
      const ok = current().register(id, accelerator, onTrigger);
      if (ok) bindings.set(id, { accelerator, onTrigger });
      return ok;
    },
    unregister(id) {
      bindings.delete(id);
      native.unregister(id);
      fallback.unregister(id);
    },
    unregisterAll() {
      bindings.clear();
      native.unregisterAll();
      fallback.unregisterAll();
    },
    startCapture: (onCapture) => current().startCapture(onCapture),
    stopCapture() {
      native.stopCapture();
      fallback.stopCapture();
    },
    isDegraded: () => refreshMode() === "fallback",
  };
}

interface ResilientEngine extends HotkeyEngine {
  /** Whether bindings are running on the `globalShortcut` fallback because the native hook couldn't start. */
  isDegraded(): boolean;
}

let engine: HotkeyEngine | undefined;
let degradable: ResilientEngine | undefined;

function hotkeyEngine(): HotkeyEngine {
  if (engine) return engine;
  const nativeModule = loadNative();
  if (!nativeModule) {
    engine = createElectronEngine();
  } else {
    const nativeEngine = createNativeEngine(nativeModule);
    // Only mac's addon can report a refused hook; elsewhere it's all-or-nothing.
    if (process.platform === "darwin") {
      engine = degradable = createResilientEngine(nativeEngine);
    } else {
      engine = nativeEngine;
    }
  }
  return engine;
}

/**
 * Whether the toggle/action hotkeys are running degraded — true only on mac,
 * when the system refused the native hook (missing or stale privacy grant).
 * Re-tries the hook as a side effect, so polling this also picks up a grant
 * made in System Settings while the app is running.
 */
export function isHotkeyEngineDegraded(): boolean {
  hotkeyEngine();
  return degradable?.isDegraded() ?? false;
}

/**
 * mac only: at startup, asks for Input Monitoring / Accessibility if either is
 * missing. Requesting is what makes the app appear in those System Settings
 * lists at all — macOS has no install-time hook and never lets an app add
 * itself — and it shows the system prompt. macOS only prompts while a grant is
 * undetermined (a denial is remembered), so calling this every launch never
 * nags; Settings' repair row covers the denied/stale cases.
 */
export function requestHotkeyPermissionsIfMissing(): void {
  if (process.platform !== "darwin") return;
  const nativeModule = loadNative();
  if (nativeModule?.hasEventAccess?.() === false) {
    nativeModule.requestEventAccess?.();
  }
}

/** mac only: shows the system permission prompts for whichever grant is missing. */
export function requestHotkeyPermissions(): void {
  loadNative()?.requestEventAccess?.();
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
