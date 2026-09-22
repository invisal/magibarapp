export type LauncherActionType =
  | "application"
  | "command"
  | "quicklink"
  | "widget"
  /** A pinned calculation (Calculator History) — a live value, like a Widget row. */
  | "calculation";

/**
 * The section a launcher row is listed under. "Results" is what every row
 * becomes once the user types a query.
 */
export type ActionGroup = "Pinned" | "Commands" | "Applications" | "Results";

/** Section order in the empty-query list. "Results" only ever appears alone. */
export const ACTION_GROUP_ORDER: readonly ActionGroup[] = [
  "Pinned",
  "Commands",
  "Applications",
  "Results",
];

/** The group an action lands in when its source doesn't pick one; pinned ones head the list. */
export function defaultActionGroup(
  action: Pick<LauncherAction, "type" | "pinned">,
): ActionGroup {
  if (action.pinned) return "Pinned";
  return action.type === "application" ? "Applications" : "Commands";
}

export interface LauncherAction {
  id: string;
  title: string;
  /**
   * Section this row is listed under. A source may set it; `query()` always
   * fills it in before it crosses IPC (defaulting from `type`, and forcing
   * "Results" while a query is typed), so the renderer can rely on it.
   */
  group?: ActionGroup;
  subtitle?: string;
  /** Emoji, single/few characters, or an image URL (http(s):/data:/file:) */
  icon?: string;
  type: LauncherActionType;
  /** Electron accelerator string, e.g. "CommandOrControl+1" */
  shortcut?: string;
  /**
   * Short alias that invokes this action when typed as the query's first word
   * (e.g. "g" for a Google quicklink). Everything after it becomes the argument.
   */
  keyword?: string;
  /**
   * The action takes a typed argument (a quicklink with a `{query}`
   * placeholder). The launcher offers Tab to capture one into a chip.
   */
  takesArgument?: boolean;
  /**
   * Other names this action goes by ("Kill Process" for "Quit Processes"),
   * searched like a second title but ranked just below the real one. Unlike
   * `tags` (exact words) these are fuzzy-matched, and unlike `keyword` they
   * don't take an argument.
   */
  altNames?: string[];
  /** Extra terms this action should also match on (e.g. a quicklink's tags). */
  tags?: string[];
  /** Quicklink is pinned — sorts above unpinned actions in the root list. */
  pinned?: boolean;
  /** Quicklink is hidden from the root list (still returned for an explicit search). */
  hidden?: boolean;
  /**
   * The action is resolving a value in the background (e.g. a Widget running
   * its async function). The list shows a spinner instead of the subtitle.
   */
  isLoading?: boolean;
  /**
   * The subtitle isn't computed up front — it needs an IPC round-trip to fetch
   * (e.g. a Widget's cached/live value). The renderer requests it only once
   * the row actually renders (virtualization keeps this lazy: off-screen rows
   * never fire the request), rather than the action source computing it eagerly
   * for every row on every `provide()`.
   */
  isDeferredSubtitle?: boolean;
}

/** Options for `requestSubtitle`. `force` bypasses any staleness cache (e.g. "Refresh"). */
export interface RequestSubtitleOptions {
  force?: boolean;
}

/** One run of an expression, classified for syntax highlighting. */
export type CalcTokenKind =
  | "number"
  | "operator"
  | "paren"
  | "function"
  | "constant"
  | "unit"
  | "punct"
  | "whitespace";

export interface CalcToken {
  text: string;
  kind: CalcTokenKind;
}

/** An evaluated expression the query itself resolved to (e.g. `"1 + 2"` → `"3"`). */
export interface Calculation {
  /** The normalized expression — spoken forms rewritten to symbols, trimmed. */
  expression: string;
  /** The formatted result, ready to display or copy. */
  value: string;
  /** The result without grouping separators, for pasting into code / feeding back in. */
  rawValue: string;
  /** `expression` split for syntax highlighting; absent when it could not be tokenized. */
  tokens?: CalcToken[];
  /**
   * Replaces `value` with a row of label/value chips — timezone's multi-zone
   * country listing (`time in Australia`).
   */
  items?: { label: string; value: string }[];
  /**
   * Secondary label/value chips shown *under* `value` — the extras a result
   * carries beyond its headline number: "You save £16", "Total 48.30", a
   * ratio's decimal/percent, other unit conversions.
   */
  details?: { label: string; value: string }[];
  /** Small print shown bottom-right of the result — e.g. currency's "Updated 2 days ago". */
  footnote?: string;
}

/** How calculator numbers are written: follow the OS locale, or force `1,234.5` / `1.234,5`. */
export type NumberFormatPreference = "system" | "dot" | "comma";

/** The calculator's user preferences (Settings → Calculator). */
export interface CalculatorSettings {
  /** Fetch live crypto prices for `5 btc in gbp`. Off = no crypto network call. */
  cryptoEnabled: boolean;
  numberFormat: NumberFormatPreference;
}

/** What a query resolves to: the ranked actions, plus an optional inline answer. */
export interface QueryResult {
  result: LauncherAction[];
  calculation?: Calculation;
}

/**
 * A screen to push onto the launcher's navigation stack — `name` matches a
 * `Route`/`ScreenDefinition` name the renderer's router knows about (a core
 * route, or one an extension registered via its `screen.tsx`). Returned from
 * `execute()` (see `Extension`'s `ctx.navigate` / `main/navigate.ts`) instead
 * of a static field on the action, so the launcher only stays open — instead
 * of hiding once `execute()` resolves — for the one call that actually asked
 * to navigate.
 */
export interface NavigateRequest {
  name: string;
  payload?: unknown;
}

/** What `execute()` resolves with. */
export interface ExecuteResult {
  navigate?: NavigateRequest;
}

/**
 * Result of a `hotkeySet` call. `false` means the accelerator couldn't be
 * grabbed (e.g. another app already holds it) — `hotkey` is then the
 * previous binding, which stays registered so the launcher remains reachable.
 */
export interface HotkeySetResult {
  success: boolean;
  hotkey: string;
}

/** Auto-update state, pushed main -> launcher. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export const IPC_CHANNELS = {
  updateGet: "update:get",
  updateCheck: "update:check",
  /** Downloads the update, then quits and installs. */
  updateInstall: "update:install",
  updateStatus: "update:status",
  query: "launcher:query",
  execute: "launcher:execute",
  hide: "launcher:hide",
  togglePin: "launcher:toggle-pin",
  /** launcher → main: a deferred-subtitle row (`isDeferredSubtitle`) rendered
   *  (or asked to force-refresh); whichever source owns it resolves with the
   *  fresh subtitle. Not Widget-specific — there is no separate push
   *  channel, the resolved value IS the update. */
  requestSubtitle: "launcher:request-subtitle",
  /** Renderer → main window-chrome controls for the framed windows (Settings,
   *  Widget), which draw their own title bar via `shared/ui/WindowFrame`.
   *  Each targets whichever `BrowserWindow` the sender belongs to. */
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  /** Settings window ↔ main: read / patch `CalculatorSettings`. */
  calculatorSettingsGet: "settings:calculator-get",
  calculatorSettingsSet: "settings:calculator-set",
  /** Settings window ↔ main: read / set "Launch at login". */
  launchAtLoginGet: "settings:launch-at-login-get",
  launchAtLoginSet: "settings:launch-at-login-set",
  /** Settings window ↔ main: read / rebind the global toggle shortcut. */
  hotkeyGet: "settings:hotkey-get",
  hotkeySet: "settings:hotkey-set",
  /**
   * Shared by every shortcut-recorder UI (the toggle row in Settings, and
   * `HotkeyPanel`'s per-action "Set Hotkey…" in the launcher window) — not
   * settings-specific, so no `settings:` prefix. On Windows, `captureStart`
   * turns on native forwarding of `Win`-involving keystrokes (see
   * `main/native/hotkeys.ts` / `HotkeyWatcher::start_capture` in
   * `native/win/src/lib.rs`) for as long as recording is active, since a
   * lone `Win` tap or a `Win+<key>` combo never reaches a plain focused
   * window's own keydown handler at all — the same interception problem
   * `RegisterHotKey` has for *registering* one, just hit during capture
   * instead. `hotkeyCaptured` is the push channel carrying each captured
   * accelerator string; a key that doesn't involve `Win` is untouched and
   * keeps reaching the renderer's own keydown listener exactly as before,
   * so this is additive, not a replacement for DOM-based capture. A no-op
   * pair on mac/linux (or if the native addon fails to load) — that capture
   * path there is unchanged, DOM-only.
   */
  hotkeyCaptureStart: "hotkey:capture-start",
  hotkeyCaptureStop: "hotkey:capture-stop",
  hotkeyCaptured: "hotkey:captured",
  /** Onboarding window → main: the tour was finished (hides it, marks it done, opens the launcher). */
  onboardingFinish: "onboarding:finish",
  /** Settings window → main: replay the tour. */
  onboardingOpen: "onboarding:open",
  /** main → onboarding window: the launcher was just shown (the "try the shortcut" step listens for this). */
  onboardingLauncherShown: "onboarding:launcher-shown",
} as const;
