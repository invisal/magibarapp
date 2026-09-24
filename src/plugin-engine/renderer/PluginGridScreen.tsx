/**
 * The `Grid`-command screen body — the `layout="grid"` counterpart to
 * `PluginListScreen`, driven by the same kind of props from
 * `PluginViewScreen`. Real Raycast has no `Grid.Item.Detail`, so unlike
 * `PluginListScreen` there's no master/detail pane here.
 */
import type { ReactNode } from "react";
import { ListScreen } from "@renderer/shared/ui/ListScreen";
import type {
  PluginGridTree,
  PluginInboundEvent,
} from "@plugin-engine/host/protocol";
import { actionPanelToMenuItems, defaultAction } from "./map-tree";
import { flattenGridTree, type PluginGridRow } from "./map-grid-tree";
import { SearchBarDropdown } from "./PluginListScreen";

export interface PluginGridScreenProps {
  tree: PluginGridTree;
  title: string;
  query: string;
  onQueryChange: (value: string) => void;
  invokeAction: (actionId: string) => void;
  sendEvent: (event: PluginInboundEvent) => void;
  /** Escape with an empty query — see `PluginDetailScreen`'s `onBack`. */
  onBack?: () => void;
}

export function PluginGridScreen({
  tree,
  title,
  query,
  onQueryChange,
  invokeAction,
  sendEvent,
  onBack,
}: PluginGridScreenProps): ReactNode {
  const rows = flattenGridTree(tree);

  return (
    <ListScreen<PluginGridRow>
      layout="grid"
      columns={tree.columns}
      data={rows}
      getId={(row) => row.id}
      onExit={onBack}
      getGroup={(row) => row.sectionTitle}
      serverFiltered
      inputValue={query}
      onInputChange={(value) => {
        onQueryChange(value);
        sendEvent({ type: "search-text-changed", text: value });
      }}
      placeholder={tree.searchBarPlaceholder ?? title}
      inputSuffix={
        tree.searchBarAccessory ? (
          <SearchBarDropdown
            dropdown={tree.searchBarAccessory}
            onChange={(value) =>
              sendEvent({ type: "dropdown-value-changed", value })
            }
          />
        ) : undefined
      }
      renderItem={(row, { highlighted }) => (
        <ListScreen.GridItem
          highlighted={highlighted}
          content={row.content}
          title={row.title}
          subtitle={row.subtitle}
        />
      )}
      onActivate={(row) => {
        const action = defaultAction(row.actionPanel);
        if (action) invokeAction(action.id);
      }}
      menu={(row) =>
        row ? actionPanelToMenuItems(row.actionPanel, invokeAction) : []
      }
      loadingLabel="Loading…"
      emptyLabel={tree.emptyView?.title ?? "No results."}
    />
  );
}
