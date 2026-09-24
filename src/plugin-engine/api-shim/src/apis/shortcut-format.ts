/**
 * Converts a real Raycast `Keyboard.Shortcut` (`{modifiers, key}`, using
 * Raycast's own token vocabulary — `"opt"` not `"alt"`, `"arrowUp"` not
 * `"up"`, …) into the accelerator string format this app's own
 * `ShortcutLabel`/`matchesShortcut` understand (`@renderer/lib/shortcut`:
 * lowercase tokens joined by `"+"`, e.g. `"cmd+shift+k"`).
 *
 * `reconciler.ts`'s `buildAction` is the only caller — an `Action`'s
 * `shortcut` prop is passed straight through as plain host-node data (see
 * `components/Action.ts`), converted to the wire format at commit time.
 */

export interface KeyboardShortcut {
  modifiers?: string[];
  key: string;
}

export type ShortcutInput = string | KeyboardShortcut;

const MODIFIER_TOKENS: Record<string, string> = {
  cmd: "cmd",
  ctrl: "ctrl",
  opt: "alt",
  shift: "shift",
};

const KEY_TOKENS: Record<string, string> = {
  arrowUp: "up",
  arrowDown: "down",
  arrowLeft: "left",
  arrowRight: "right",
  return: "return",
  delete: "delete",
  deleteForward: "delete",
  escape: "escape",
  tab: "tab",
  space: "space",
};

function isKeyboardShortcut(value: unknown): value is KeyboardShortcut {
  return !!value && typeof value === "object" && "key" in value;
}

/** `undefined` for anything that isn't a usable shortcut — a missing/absent
 *  `shortcut` prop stays absent on the wire rather than becoming a stray
 *  empty string. */
export function toAccelerator(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isKeyboardShortcut(value) || !value.key) return undefined;
  const modifiers = (value.modifiers ?? []).map(
    (modifier) => MODIFIER_TOKENS[modifier] ?? modifier,
  );
  const key = KEY_TOKENS[value.key] ?? value.key;
  return [...modifiers, key].join("+");
}
