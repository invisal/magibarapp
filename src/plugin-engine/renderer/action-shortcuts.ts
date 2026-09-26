/**
 * Binds a plugin action panel's key chords (see `map-tree.ts`'s
 * `actionShortcuts`) — `Footer.Menu` only *shows* an item's shortcut, so
 * without this ⌘⇧C and friends would be decoration.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isMac, matchesShortcut } from "@renderer/lib/shortcut";
import { useShortcut, type ShortcutMap } from "@renderer/lib/use-shortcut";
import type { PluginActionPanelNode } from "@plugin-engine/host/protocol";
import {
  actionShortcuts,
  isTextEditingChord,
  type ActionPanelContext,
} from "./map-tree";

/** `ListScreen`'s `onInputKeyDown` for a List/Grid: runs the highlighted
 *  row's action whose chord this is. Plain ↵ is left to `ListScreen`'s own
 *  `onActivate`. */
export function handleRowShortcut(
  e: ReactKeyboardEvent<HTMLInputElement>,
  actionPanel: PluginActionPanelNode | undefined,
  invoke: (actionId: string) => void,
): void {
  if (e.nativeEvent.isComposing) return;
  const mac = isMac();
  const input = e.currentTarget;
  const hasSelection = input.selectionStart !== input.selectionEnd;
  for (const { accelerator, actionId } of actionShortcuts(
    actionPanel,
    "list",
    mac,
  )) {
    if (accelerator === "Enter") continue;
    if (hasSelection && isTextEditingChord(accelerator, mac)) continue;
    if (!matchesShortcut(accelerator, e.nativeEvent, mac)) continue;
    e.preventDefault();
    invoke(actionId);
    return;
  }
}

/** Window-level chords for a screen with one action panel (Detail, Form).
 *  Pass `enabled: false` while its actions menu is open — the menu owns the
 *  keyboard then. */
export function usePanelShortcuts(
  actionPanel: PluginActionPanelNode | undefined,
  context: ActionPanelContext,
  invoke: (actionId: string) => void,
  enabled: boolean,
): void {
  const map: ShortcutMap = {};
  if (enabled) {
    for (const { accelerator, actionId } of actionShortcuts(
      actionPanel,
      context,
      isMac(),
    )) {
      map[accelerator] = () => invoke(actionId);
    }
  }
  useShortcut(map);
}
