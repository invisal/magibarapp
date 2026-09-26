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
import {
  actionPanelToMenuItems,
  actionShortcuts,
  defaultAction,
} from "./map-tree";
import { handleRowShortcut } from "./action-shortcuts";
import { CommandBadge, PrimaryActionButton } from "./PluginChrome";
import { usePluginListEvents } from "./usePluginListEvents";
import { isMac } from "@renderer/lib/shortcut";
import { flattenGridTree, type PluginGridRow } from "./map-grid-tree";
import { SearchBarDropdown } from "./PluginListScreen";

export interface PluginGridScreenProps {
  tree: PluginGridTree;
  title: string;
  /** The command's icon, for the footer badge. */
  commandIcon?: string;
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
  commandIcon,
  query,
  onQueryChange,
  invokeAction,
  sendEvent,
  onBack,
}: PluginGridScreenProps): ReactNode {
  const rows = flattenGridTree(tree);
  const events = usePluginListEvents(tree, sendEvent, onQueryChange);

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
      onInputChange={events.onInputChange}
      onHighlightChange={events.onHighlightChange}
      onEndReached={events.onEndReached}
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
      onInputKeyDown={(e, row) =>
        handleRowShortcut(e, row?.actionPanel, invokeAction)
      }
      customFooter={
        <CommandBadge
          icon={commandIcon}
          title={tree.navigationTitle ?? title}
        />
      }
      footerActions={(row) => (
        <PrimaryActionButton
          action={defaultAction(row?.actionPanel)}
          shortcut="Enter"
          onInvoke={invokeAction}
        />
      )}
      menu={(row) =>
        row
          ? actionPanelToMenuItems(
              row.actionPanel,
              invokeAction,
              actionShortcuts(row.actionPanel, "list", isMac()),
            )
          : []
      }
      loadingLabel="Loading…"
      emptyLabel={tree.emptyView?.title ?? "No results."}
    />
  );
}
