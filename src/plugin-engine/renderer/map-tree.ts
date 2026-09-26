/**
 * Turns a `PluginListTree` (from `host/protocol.ts`) into what
 * `shared/ui/ListScreen.tsx` and `shared/ui/Footer`'s `Footer.Menu` actually
 * want — no changes needed to either, their shapes line up closely enough
 * that this is just plumbing.
 */
import type {
  PluginAccessory,
  PluginActionNode,
  PluginActionPanelNode,
  PluginListItemNode,
  PluginListTree,
} from "@plugin-engine/host/protocol";
import type { FooterMenuItem } from "@renderer/shared/ui/Footer";

/** One row, flattened out of its section for `ListScreen`'s flat `data`
 *  array — `getGroup` re-sections it by `sectionTitle`. */
export interface PluginListRow extends PluginListItemNode {
  sectionTitle: string;
}

export function flattenTree(
  tree: PluginListTree | null,
): PluginListRow[] | null {
  if (!tree) return null;
  const rows: PluginListRow[] = [];
  for (const section of tree.sections) {
    for (const item of section.items) {
      rows.push({ ...item, sectionTitle: section.title ?? "" });
    }
  }
  return rows;
}

/** A trailing badge summarizing `accessories` — just the text/tag values;
 *  `ListScreen.Item`'s `badge` slot is a single trailing node, not a row of
 *  chips, so multiple accessories join with a middle dot. */
export function accessoriesBadge(
  accessories: PluginAccessory[] | undefined,
): string | undefined {
  if (!accessories || accessories.length === 0) return undefined;
  const parts = accessories
    .map((a) => a.tag?.value ?? a.text)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const KIND_ICON: Record<NonNullable<PluginActionNode["kind"]>, string> = {
  "copy-to-clipboard": "📋",
  "open-in-browser": "🌐",
  open: "↗️",
  generic: "▸",
  "submit-form": "⏎",
  push: "›",
  paste: "📋",
  "show-in-finder": "📁",
  trash: "🗑️",
};

function actionMenuItem(
  action: PluginActionNode,
  sectionTitle: string | undefined,
  onInvoke: (actionId: string) => void,
  shortcuts: ActionShortcut[] | undefined,
): FooterMenuItem {
  return {
    id: action.id,
    label: action.title,
    icon: action.icon ?? KIND_ICON[action.kind ?? "generic"],
    shortcut: shortcuts
      ? shortcuts.find((s) => s.actionId === action.id)?.accelerator
      : action.shortcut,
    danger: action.style === "destructive",
    section: sectionTitle,
    onSelect: () => onInvoke(action.id),
  };
}

/** `null` when the row has no `ActionPanel` — `ListScreen`'s `menu` prop
 *  itself handles a `null` target as "nothing highlighted", not "no items",
 *  so an empty array reads correctly either way. */
export function actionPanelToMenuItems(
  actionPanel: PluginActionPanelNode | undefined,
  onInvoke: (actionId: string) => void,
  /** From `actionShortcuts` — the hints then show the chords that really
   *  fire (↵/⌘↵ included) instead of only the declared ones. */
  shortcuts?: ActionShortcut[],
): FooterMenuItem[] {
  if (!actionPanel) return [];
  return actionPanel.sections.flatMap((section) =>
    section.actions.map((action) =>
      actionMenuItem(action, section.title, onInvoke, shortcuts),
    ),
  );
}

/** The row's default action — what Enter/click runs. Real Raycast semantics:
 *  the first action in the first section. */
export function defaultAction(
  actionPanel: PluginActionPanelNode | undefined,
): PluginActionNode | undefined {
  return actionPanel?.sections[0]?.actions[0];
}

/** A key chord bound to one action of the current action panel. */
export interface ActionShortcut {
  accelerator: string;
  actionId: string;
}

/** Where the panel is showing — decides the implicit chords, as in Raycast:
 *  ↵ / ⌘↵ run the first two actions, except in a form, where plain ↵
 *  belongs to the focused field and ⌘↵ / ⌘⇧↵ take over. */
export type ActionPanelContext = "list" | "detail" | "form";

const IMPLICIT_CHORDS: Record<ActionPanelContext, [string, string]> = {
  list: ["Enter", "CommandOrControl+Enter"],
  detail: ["Enter", "CommandOrControl+Enter"],
  form: ["CommandOrControl+Enter", "CommandOrControl+Shift+Enter"],
};

/** An accelerator as a comparable set of tokens, `CommandOrControl`
 *  resolved for the platform. */
function chordKey(accelerator: string, mac: boolean): string {
  return accelerator
    .split("+")
    .filter(Boolean)
    .map((token) => {
      const t = token.toLowerCase();
      if (t === "commandorcontrol" || t === "cmdorctrl")
        return mac ? "cmd" : "ctrl";
      if (t === "command" || t === "meta") return "cmd";
      if (t === "control") return "ctrl";
      if (t === "option") return "alt";
      if (t === "return") return "enter";
      return t;
    })
    .sort()
    .join("+");
}

/** Only a chord with a real modifier (⌘/⌃/⌥) — a bare or Shift-only key
 *  would steal typing from the search box or a form field. */
function isBindable(accelerator: string, mac: boolean): boolean {
  return chordKey(accelerator, mac)
    .split("+")
    .some((token) => token === "cmd" || token === "ctrl" || token === "alt");
}

/** ⌘K always opens the actions menu. */
const RESERVED_CHORDS = ["CommandOrControl+K"];

/**
 * Every chord that should run an action of `actionPanel`: the implicit
 * primary/secondary chords first, then each action's own `shortcut`. A chord
 * already taken (by an earlier entry or `RESERVED_CHORDS`) is skipped, so
 * the first claimant wins — as in Raycast, where the implicit ones do.
 */
export function actionShortcuts(
  actionPanel: PluginActionPanelNode | undefined,
  context: ActionPanelContext,
  mac: boolean,
): ActionShortcut[] {
  const actions = actionPanel?.sections.flatMap((s) => s.actions) ?? [];
  const taken = new Set(RESERVED_CHORDS.map((a) => chordKey(a, mac)));
  const result: ActionShortcut[] = [];
  const claim = (accelerator: string, actionId: string): void => {
    const key = chordKey(accelerator, mac);
    if (taken.has(key)) return;
    taken.add(key);
    result.push({ accelerator, actionId });
  };
  const [primaryChord, secondaryChord] = IMPLICIT_CHORDS[context];
  if (actions[0]) claim(primaryChord, actions[0].id);
  if (actions[1]) claim(secondaryChord, actions[1].id);
  for (const action of actions) {
    if (action.shortcut && isBindable(action.shortcut, mac)) {
      claim(action.shortcut, action.id);
    }
  }
  return result;
}

/** ⌘A/C/V/X/Z edit the search text while some of it is selected — a
 *  plugin action bound to one of those shouldn't hijack that. */
export function isTextEditingChord(accelerator: string, mac: boolean): boolean {
  const mod = mac ? "cmd" : "ctrl";
  return ["a", "c", "v", "x", "z"].some(
    (key) => chordKey(accelerator, mac) === chordKey(`${mod}+${key}`, mac),
  );
}
