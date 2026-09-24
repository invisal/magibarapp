/**
 * Turns a `PluginFormTree` (from `host/protocol.ts`) into the initial React
 * state `PluginFormScreen` seeds its controlled inputs from.
 */
import type { PluginFormItemNode } from "@plugin-engine/host/protocol";

export function initialFormValues(
  items: PluginFormItemNode[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const item of items) {
    if (item.kind === "separator" || item.kind === "description") continue;
    if ("value" in item && item.value !== undefined)
      values[item.id] = item.value;
  }
  return values;
}
