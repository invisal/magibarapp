/**
 * Formats Electron accelerator strings (e.g. "CommandOrControl+Shift+K")
 * into the symbols/labels users expect on their platform.
 */

export function isMac(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /Mac|iPhone|iPod|iPad/i.test(platform);
}

const MAC_SYMBOLS: Record<string, string> = {
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  command: "⌘",
  cmd: "⌘",
  control: "⌃",
  ctrl: "⌃",
  option: "⌥",
  alt: "⌥",
  shift: "⇧",
  super: "⌘",
  meta: "⌘",
  space: "Space",
  plus: "+",
  enter: "⏎",
  return: "⏎",
  backspace: "⌫",
  delete: "⌦",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

const OTHER_LABELS: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  command: "Ctrl",
  cmd: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  option: "Alt",
  alt: "Alt",
  shift: "Shift",
  super: "Win",
  meta: "Super",
  space: "Space",
  plus: "+",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * Does this keydown event satisfy an Electron accelerator string
 * (e.g. "CommandOrControl+Enter", "Escape")? Modifiers must match exactly.
 */
export function matchesShortcut(
  accelerator: string,
  event: KeyboardEvent,
  mac: boolean = isMac(),
): boolean {
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (const token of accelerator.split("+").filter(Boolean)) {
    switch (token.toLowerCase()) {
      case "commandorcontrol":
      case "cmdorctrl":
        if (mac) meta = true;
        else ctrl = true;
        break;
      case "command":
      case "cmd":
      case "meta":
      case "super":
        meta = true;
        break;
      case "control":
      case "ctrl":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      default:
        key = token.toLowerCase();
    }
  }

  if (
    event.metaKey !== meta ||
    event.ctrlKey !== ctrl ||
    event.altKey !== alt ||
    event.shiftKey !== shift
  ) {
    return false;
  }
  if (!key) return true;

  const alias: Record<string, string> = {
    enter: "enter",
    return: "enter",
    esc: "escape",
    space: " ",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
  };
  if (event.key.toLowerCase() === (alias[key] ?? key)) return true;
  // Option/Alt rewrites `event.key` on macOS (Option+R -> "®"), so a letter
  // chord that needs Alt falls back to the physical key.
  return alt && /^[a-z]$/.test(key) && event.code === `Key${key.toUpperCase()}`;
}

const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  Tab: "Tab",
  Enter: "Return",
  NumpadEnter: "Return",
  Backspace: "Backspace",
  Delete: "Delete",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** Physical key (independent of modifiers/layout) for an accelerator, or null if this key has no accelerator equivalent. */
function keyFromCode(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3); // KeyA -> A
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 -> 1
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code; // F1..F24
  return CODE_TO_KEY[code] ?? null;
}

/**
 * Builds an Electron accelerator string (e.g. "Command+Shift+Space") from a
 * keydown event, for a shortcut-recorder UI. Returns null while only
 * modifier keys are held, for a key with no accelerator equivalent, or when
 * no modifier is held at all — a global shortcut needs at least one so it
 * doesn't collide with normal typing.
 */
export function eventToAccelerator(
  event: KeyboardEvent,
  mac: boolean = isMac(),
): string | null {
  const key = keyFromCode(event.code);
  if (!key) return null;

  const modifiers: string[] = [];
  if (mac) {
    if (event.metaKey) modifiers.push("Command");
    if (event.ctrlKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Option");
  } else {
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.metaKey) modifiers.push("Super");
  }
  if (event.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) return null;

  return [...modifiers, key].join("+");
}

/**
 * Sentinel accelerator for "the Windows/Command key alone" — mirrors
 * `LONE_SUPER_HOTKEY` in `main/native/hotkeys.ts`. Electron's accelerator
 * grammar has no way to express a modifier with no key, so this literal
 * (never a real accelerator string `eventToAccelerator` would otherwise
 * produce) is what a shortcut recorder emits for a clean tap.
 */
export const LONE_SUPER_HOTKEY = "Super";

/**
 * Tracks whether a keydown is a still-live "solo tap" candidate for
 * {@link LONE_SUPER_HOTKEY}, mirroring the same state machine the native
 * Windows hook runs (`native/win/src/lib.rs`: `win_tap_candidate`) — a
 * shortcut recorder feeds it every keydown/keyup it sees; `onKeyUp` returns
 * the captured accelerator once the tap completes cleanly (Meta pressed and
 * released with no other key in between), `null` otherwise. Only Meta/Super
 * has this native-side support today — a bare Ctrl/Alt/Shift tap isn't
 * offered, so this doesn't track those.
 *
 * `supported` should be `true` only on platforms whose native hotkey engine
 * (`main/native/hotkeys.ts`) can actually register a modifier-only
 * accelerator — Windows (`@magibar/win`'s `WH_KEYBOARD_LL` hook) and mac
 * (`@magibar/mac`'s `CGEventTap`), i.e. `window.api.platform === "win32" ||
 * "darwin"`. Everywhere else (Linux, or either platform if its native addon
 * fails to load) falls back to `globalShortcut`, which has no way to
 * register a modifier-only accelerator at all — without gating this, the
 * tracker would still report {@link LONE_SUPER_HOTKEY} back to a recorder
 * there, surfacing as a confusing "already in use" error for a combo nothing
 * else is actually using.
 *
 * A caller wired to `window.api.hotkey.onCaptured` (both platforms above
 * route a `mods+key` combo through that native channel, since the OS
 * swallows it before this window's own keydown listener ever sees it) must
 * call {@link cancel} whenever that channel reports *anything* mid-hold.
 * Without it: pressing `Command+T` suppresses `T`'s keydown/keyup entirely
 * (never reaching `onKeyDown` here to clear `candidate`), but the native
 * side deliberately leaves `Command`'s own *eventual* keyup un-suppressed —
 * so this tracker sees only "Meta down … Meta up" and misreads it as a
 * clean solo tap, overwriting the just-reported `"Command+T"` with
 * {@link LONE_SUPER_HOTKEY} the instant the user lets go of Cmd.
 */
export function createLoneSuperTapTracker(supported: boolean): {
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => string | null;
  cancel: () => void;
} {
  let candidate = false;
  return {
    onKeyDown(event) {
      if (!supported || event.repeat) return;
      candidate = event.key === "Meta";
    },
    onKeyUp(event) {
      if (!supported) return null;
      const wasCandidate = candidate && event.key === "Meta";
      candidate = false;
      return wasCandidate ? LONE_SUPER_HOTKEY : null;
    },
    cancel() {
      candidate = false;
    },
  };
}

/** One display-ready token of a formatted shortcut — see {@link shortcutTokens}. */
export interface ShortcutToken {
  /** The symbol/label text this token normally renders as (`formatShortcut` joins exactly these). */
  label: string;
  /**
   * True for the Win/Super modifier specifically, and only on non-mac (mac's
   * own "⌘" glyph already looks fine as plain text) — lets a JSX renderer
   * swap in a proper Windows-key icon instead of the `label` text, since
   * there's no single Unicode glyph for it that looks as good as ⌘ does.
   */
  isWinKey: boolean;
}

function isWinKeyToken(token: string): boolean {
  const key = token.toLowerCase();
  return (
    key === "super" || key === "meta" || key === "command" || key === "cmd"
  );
}

/** Splits `accelerator` into display-ready tokens, in order — the shared
 *  step behind both {@link formatShortcut} (joins them into plain text) and
 *  `ShortcutLabel` (renders them as JSX, swapping the Win-key token for an
 *  icon). */
export function shortcutTokens(
  accelerator: string,
  mac: boolean = isMac(),
): ShortcutToken[] {
  const map = mac ? MAC_SYMBOLS : OTHER_LABELS;
  return accelerator
    .split("+")
    .filter(Boolean)
    .map((token) => ({
      label: map[token.toLowerCase()] ?? token.toUpperCase(),
      isWinKey: !mac && isWinKeyToken(token),
    }));
}

export function formatShortcut(
  accelerator: string,
  mac: boolean = isMac(),
): string {
  const tokens = shortcutTokens(accelerator, mac).map((t) => t.label);

  if (!mac) return tokens.join("+");

  // On mac, modifier symbols are conventionally run together with no
  // separator, e.g. "⌘⇧K", but a word like "Space" still needs a gap.
  return tokens.reduce((out, token, i) => {
    if (i === 0) return token;
    const needsSpace = token.length > 1;
    return out + (needsSpace ? " " : "") + token;
  }, "");
}
