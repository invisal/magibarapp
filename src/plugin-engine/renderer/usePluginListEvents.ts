/**
 * The `ListScreen` callbacks a plugin `List`/`Grid` answers with inbound
 * events: search text (debounced when the tree asks for `throttle`),
 * `selection-changed` (for `onSelectionChange`) and `load-more` (for
 * `pagination`).
 */
import { useEffect, useRef } from "react";
import type {
  PluginGridTree,
  PluginInboundEvent,
  PluginListTree,
} from "@plugin-engine/host/protocol";

/** Raycast's `throttle` delay for `onSearchTextChange`, near enough. */
const THROTTLE_MS = 150;

export interface PluginListEvents {
  onInputChange(value: string): void;
  onHighlightChange(row: { id: string } | null): void;
  /** `undefined` unless the tree has more to load. */
  onEndReached: (() => void) | undefined;
}

export function usePluginListEvents(
  tree: PluginListTree | PluginGridTree | null,
  sendEvent: (event: PluginInboundEvent) => void,
  onQueryChange: (value: string) => void,
): PluginListEvents {
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // `ListScreen` re-reports the highlight after every tree; the plugin only
  // needs to hear about a different row.
  const lastSelection = useRef<string | undefined>(undefined);
  // One `load-more` per tree: the answer is a new tree (a loading one, then
  // the next page), and only that may ask again.
  const loadRequestedFor = useRef<PluginListTree | PluginGridTree | null>(null);

  return {
    onInputChange(value) {
      onQueryChange(value);
      const send = (): void =>
        sendEvent({ type: "search-text-changed", text: value });
      clearTimeout(searchTimer.current);
      if (tree?.throttle) searchTimer.current = setTimeout(send, THROTTLE_MS);
      else send();
    },
    onHighlightChange(row) {
      // `null` is `ListScreen`'s transient click artefact (see its doc).
      if (!row || row.id === lastSelection.current) return;
      lastSelection.current = row.id;
      sendEvent({ type: "selection-changed", itemId: row.id });
    },
    onEndReached:
      tree?.hasMore && !tree.isLoading
        ? () => {
            if (loadRequestedFor.current === tree) return;
            loadRequestedFor.current = tree;
            sendEvent({ type: "load-more" });
          }
        : undefined,
  };
}
