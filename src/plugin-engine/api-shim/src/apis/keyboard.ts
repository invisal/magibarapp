/**
 * `Keyboard`/`Keyboard.Shortcut.Common`. Only the `Common` presets, since
 * that's the one real extension usage seen so far (`Keyboard.Shortcut.Common.X`
 * as an `Action`'s `shortcut`) — best-effort reproductions of Raycast's own
 * presets, not guaranteed byte-identical modifier/key choices. That's fine:
 * these only ever feed `reconciler.ts`'s `toAccelerator`, which turns them
 * into a purely decorative kbd hint — never the action's actual behavior,
 * which still runs via click/Enter/⌘K regardless of what's shown.
 */
import type { KeyboardShortcut } from "./shortcut-format.ts";

const Common: Record<string, KeyboardShortcut> = {
  Copy: { modifiers: ["cmd"], key: "c" },
  CopyDeeplink: { modifiers: ["cmd", "shift"], key: "c" },
  CopyName: { modifiers: ["cmd", "shift"], key: "." },
  CopyPath: { modifiers: ["cmd", "shift"], key: "," },
  Duplicate: { modifiers: ["cmd"], key: "d" },
  Edit: { modifiers: ["cmd"], key: "e" },
  MoveDown: { modifiers: ["cmd", "shift"], key: "arrowDown" },
  MoveUp: { modifiers: ["cmd", "shift"], key: "arrowUp" },
  New: { modifiers: ["cmd"], key: "n" },
  Open: { modifiers: ["cmd"], key: "o" },
  OpenWith: { modifiers: ["cmd", "shift"], key: "o" },
  Pin: { modifiers: ["cmd", "shift"], key: "p" },
  Refresh: { modifiers: ["cmd"], key: "r" },
  Remove: { modifiers: ["ctrl"], key: "x" },
  RemoveAll: { modifiers: ["ctrl", "shift"], key: "x" },
  ToggleQuickLook: { modifiers: [], key: "space" },
};

/** A preset this table doesn't have falls back to a harmless no-modifier
 *  placeholder instead of throwing — same non-crashing spirit as `Icon`/
 *  `Color`'s proxies in `index.ts`. */
const CommonProxy = new Proxy(Common, {
  get: (target, prop) =>
    typeof prop === "string" ? (target[prop] ?? { key: "" }) : undefined,
});

export const Keyboard = {
  Shortcut: { Common: CommonProxy },
};
