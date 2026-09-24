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
): FooterMenuItem {
  return {
    id: action.id,
    label: action.title,
    icon: action.icon ?? KIND_ICON[action.kind ?? "generic"],
    shortcut: action.shortcut,
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
): FooterMenuItem[] {
  if (!actionPanel) return [];
  return actionPanel.sections.flatMap((section) =>
    section.actions.map((action) =>
      actionMenuItem(action, section.title, onInvoke),
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
