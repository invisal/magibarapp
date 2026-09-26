/**
 * Turns a `PluginGridTree` (from `host/protocol.ts`) into what
 * `shared/ui/ListScreen.tsx`'s `layout="grid"` mode wants — mirrors
 * `map-tree.ts`'s `flattenTree` for `List`, reusing its action-menu helpers
 * rather than duplicating them (a `Grid` item's `actionPanel` is the exact
 * same shape as a `List.Item`'s).
 */
import type {
  PluginGridItemNode,
  PluginGridTree,
} from "@plugin-engine/host/protocol";

export interface PluginGridRow extends PluginGridItemNode {
  sectionTitle: string;
}

export function flattenGridTree(
  tree: PluginGridTree | null,
): PluginGridRow[] | null {
  if (!tree) return null;
  const rows: PluginGridRow[] = [];
  for (const section of tree.sections) {
    for (const item of section.items) {
      rows.push({ ...item, sectionTitle: section.title ?? "" });
    }
  }
  return rows;
}
