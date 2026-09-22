/**
 * Persisted user settings — today just the custom-layout gap size, laid out so
 * more settings can join `SettingsFile` later without a migration (a missing
 * key just falls back to its default).
 *
 * Deliberately Electron-free (mirrors `usage/store.ts`): the `userData` directory
 * is injected by the caller, so `node --test` can exercise it against a temp dir.
 * Advisory, like the usage store — every filesystem failure is swallowed with a
 * `[settings]` prefix and leaves the in-memory state intact.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CalculatorSettings,
  NumberFormatPreference,
} from "../../shared/types";

/** Bumped when the persisted shape changes, to invalidate old files. */
const SETTINGS_VERSION = 1;

/** Default "preferred gap" (px) a custom layout's `useGap` inserts around it, absent a saved override. */
const DEFAULT_GAP_PX = 8;

/**
 * Default global toggle shortcut, absent a saved override. Alt+Space is free
 * on Windows, but on macOS Option+Space is commonly remapped (e.g. to Mission
 * Control/Spotlight variants) and Cmd+Space/Cmd+Option+Space/Cmd+Ctrl+Space
 * are all reserved by the OS, so macOS gets its own default. See `main/index.ts`
 * for why Linux additionally can't rely on `globalShortcut.register` at all.
 */
const DEFAULT_HOTKEY =
  process.platform === "darwin" ? "Command+Shift+Space" : "Alt+Space";

/** Which movable/resizable window a saved position+size belongs to. */
export type WindowBoundsKey = "settings" | "widget" | "launcher";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WINDOW_BOUNDS_KEYS: readonly WindowBoundsKey[] = [
  "settings",
  "widget",
  "launcher",
];

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowBounds>;
  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number"
  );
}

interface SettingsFile {
  version: number;
  savedAt: number;
  /**
   * The user's preferred gap (px), for a custom layout's "Use preferred gap
   * settings" toggle. Optional so a `SETTINGS_VERSION` 1 file saved before this
   * existed still validates — a missing value just falls back to `DEFAULT_GAP_PX`.
   */
  gapPx?: number;
  /** Calculator: fetch live crypto prices. Optional — missing means the default (on). */
  cryptoEnabled?: boolean;
  /** Calculator: number format. Optional — missing means `system`. */
  numberFormat?: NumberFormatPreference;
  /** Last position+size of each movable window, keyed by `WindowBoundsKey`. Optional — missing means "let Electron pick". */
  windowBounds?: Partial<Record<WindowBoundsKey, WindowBounds>>;
  /** Electron accelerator string for the global toggle shortcut. Optional — missing means the platform default. */
  hotkey?: string;
  /** The first-run welcome tour was finished or dismissed. Optional — missing means it hasn't been shown yet. */
  onboardingCompleted?: boolean;
}

/** In-memory state — unlike `SettingsFile`, every field is populated (defaulted on load). */
interface State extends CalculatorSettings {
  gapPx: number;
  windowBounds: Partial<Record<WindowBoundsKey, WindowBounds>>;
  hotkey: string;
  onboardingCompleted: boolean;
}

const DEFAULT_CALCULATOR: CalculatorSettings = {
  cryptoEnabled: true,
  numberFormat: "system",
};

const NUMBER_FORMATS: readonly NumberFormatPreference[] = [
  "system",
  "dot",
  "comma",
];

function emptyState(): State {
  return {
    gapPx: DEFAULT_GAP_PX,
    windowBounds: {},
    hotkey: DEFAULT_HOTKEY,
    onboardingCompleted: false,
    ...DEFAULT_CALCULATOR,
  };
}

function isSettingsFile(value: unknown): value is SettingsFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SettingsFile>;
  if (candidate.version !== SETTINGS_VERSION) return false;
  return (
    (candidate.gapPx === undefined || typeof candidate.gapPx === "number") &&
    (candidate.cryptoEnabled === undefined ||
      typeof candidate.cryptoEnabled === "boolean") &&
    (candidate.numberFormat === undefined ||
      NUMBER_FORMATS.includes(candidate.numberFormat)) &&
    (candidate.windowBounds === undefined ||
      (typeof candidate.windowBounds === "object" &&
        candidate.windowBounds !== null &&
        Object.entries(candidate.windowBounds).every(
          ([key, bounds]) =>
            WINDOW_BOUNDS_KEYS.includes(key as WindowBoundsKey) &&
            isWindowBounds(bounds),
        ))) &&
    (candidate.hotkey === undefined ||
      (typeof candidate.hotkey === "string" && candidate.hotkey.length > 0)) &&
    (candidate.onboardingCompleted === undefined ||
      typeof candidate.onboardingCompleted === "boolean")
  );
}

export class SettingsStore {
  private readonly dir: string;
  private state = emptyState();
  private loaded = false;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  /** Load `settings.json` into memory. Corrupt / missing / old-version -> empty state. */
  init(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(), "utf8"));
      if (isSettingsFile(parsed)) {
        this.state = {
          gapPx: parsed.gapPx ?? DEFAULT_GAP_PX,
          cryptoEnabled:
            parsed.cryptoEnabled ?? DEFAULT_CALCULATOR.cryptoEnabled,
          numberFormat: parsed.numberFormat ?? DEFAULT_CALCULATOR.numberFormat,
          windowBounds: parsed.windowBounds ?? {},
          hotkey: parsed.hotkey ?? DEFAULT_HOTKEY,
          onboardingCompleted: parsed.onboardingCompleted ?? false,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[settings] Failed to read store:", error);
      }
    }
  }

  /** The user's preferred gap (px) for a custom layout's "Use preferred gap settings" toggle. */
  getGapSize(): number {
    this.init();
    return this.state.gapPx;
  }

  /** Persists immediately. */
  setGapSize(px: number): void {
    this.init();
    this.state.gapPx = Math.max(0, px);
    this.persist();
  }

  getCalculatorSettings(): CalculatorSettings {
    this.init();
    return {
      cryptoEnabled: this.state.cryptoEnabled,
      numberFormat: this.state.numberFormat,
    };
  }

  /** Merge `patch` (invalid fields ignored), persist, and return the result. */
  setCalculatorSettings(
    patch: Partial<CalculatorSettings>,
  ): CalculatorSettings {
    this.init();
    if (typeof patch.cryptoEnabled === "boolean")
      this.state.cryptoEnabled = patch.cryptoEnabled;
    if (patch.numberFormat && NUMBER_FORMATS.includes(patch.numberFormat)) {
      this.state.numberFormat = patch.numberFormat;
    }
    this.persist();
    return this.getCalculatorSettings();
  }

  /** The global toggle shortcut, as an Electron accelerator string. */
  getHotkey(): string {
    this.init();
    return this.state.hotkey;
  }

  /** Persists immediately. Caller is responsible for actually re-registering the accelerator with `globalShortcut`. */
  setHotkey(accelerator: string): void {
    this.init();
    this.state.hotkey = accelerator;
    this.persist();
  }

  /** Whether the first-run welcome tour has been finished or dismissed. */
  isOnboardingCompleted(): boolean {
    this.init();
    return this.state.onboardingCompleted;
  }

  /** Persists immediately. */
  setOnboardingCompleted(completed: boolean): void {
    this.init();
    this.state.onboardingCompleted = completed;
    this.persist();
  }

  /** The last saved position+size for `key`, or `undefined` if it's never been moved/resized. */
  getWindowBounds(key: WindowBoundsKey): WindowBounds | undefined {
    this.init();
    return this.state.windowBounds[key];
  }

  /** Persists immediately. */
  setWindowBounds(key: WindowBoundsKey, bounds: WindowBounds): void {
    this.init();
    this.state.windowBounds = { ...this.state.windowBounds, [key]: bounds };
    this.persist();
  }

  private path(): string {
    return join(this.dir, "settings.json");
  }

  /** Atomic temp-write + rename, mirroring `usage/store.ts`. */
  private persist(): void {
    const file = this.path();
    const tmp = `${file}.tmp`;
    const payload: SettingsFile = {
      version: SETTINGS_VERSION,
      savedAt: Date.now(),
      gapPx: this.state.gapPx,
      cryptoEnabled: this.state.cryptoEnabled,
      numberFormat: this.state.numberFormat,
      windowBounds: this.state.windowBounds,
      hotkey: this.state.hotkey,
      onboardingCompleted: this.state.onboardingCompleted,
    };
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, file);
    } catch (error) {
      console.error("[settings] Failed to write store:", error);
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
    }
  }
}
