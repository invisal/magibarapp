/**
 * The `List`-command screen body — one component for every installed
 * plugin's every `List` command. Driven by props from `PluginViewScreen`
 * (which owns the IPC attach/detach lifecycle via `usePluginViewInstance`
 * and decides, once the first render message arrives, that this is the
 * screen to show) rather than owning that lifecycle itself.
 *
 * Built directly on `shared/ui/ListScreen.tsx`; the mapping from the wire
 * protocol to its props lives in `map-tree.ts`.
 */
import type { ReactNode } from "react";
import { ListScreen } from "@renderer/shared/ui/ListScreen";
import { Detail } from "@renderer/shared/ui/Detail";
import { iconSrc, isGlyphIcon } from "@renderer/lib/icon";
import type {
  PluginDropdownNode,
  PluginInboundEvent,
  PluginListTree,
} from "@plugin-engine/host/protocol";
import {
  accessoriesBadge,
  actionPanelToMenuItems,
  defaultAction,
  flattenTree,
  type PluginListRow,
} from "./map-tree";
import { renderDetailMarkdown, renderDetailMetadata } from "./map-detail-tree";

export interface PluginListScreenProps {
  tree: PluginListTree | null;
  title: string;
  query: string;
  onQueryChange: (value: string) => void;
  invokeAction: (actionId: string) => void;
  sendEvent: (event: PluginInboundEvent) => void;
  /** Escape with an empty query — see `PluginDetailScreen`'s `onBack`. */
  onBack?: () => void;
}

export function PluginListScreen({
  tree,
  title,
  query,
  onQueryChange,
  invokeAction,
  sendEvent,
  onBack,
}: PluginListScreenProps): ReactNode {
  const rows = flattenTree(tree);
  // Only opt into the master/detail layout when at least one row actually
  // uses `List.Item.Detail` — checked once per tree, not per row, so a plain
  // List renders exactly as before (full width, no detail pane).
  const hasDetail = rows?.some((row) => row.detail !== undefined) ?? false;

  return (
    <ListScreen<PluginListRow>
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
      placeholder={tree?.searchBarPlaceholder ?? title}
      inputSuffix={
        tree?.searchBarAccessory ? (
          <SearchBarDropdown
            dropdown={tree.searchBarAccessory}
            onChange={(value) =>
              sendEvent({ type: "dropdown-value-changed", value })
            }
          />
        ) : undefined
      }
      renderItem={(row, { highlighted }) => (
        <ListScreen.Item
          highlighted={highlighted}
          icon={displayIcon(row.icon)}
          title={row.title}
          subtitle={row.subtitle}
          badge={accessoriesBadge(row.accessories)}
        />
      )}
      onActivate={(row) => {
        const action = defaultAction(row.actionPanel);
        if (action) invokeAction(action.id);
      }}
      menu={(row) =>
        row ? actionPanelToMenuItems(row.actionPanel, invokeAction) : []
      }
      detail={
        hasDetail
          ? (row) => (
              <Detail>
                <Detail.Preview align="start">
                  {renderDetailMarkdown(
                    row?.detail?.markdown,
                    row?.detail?.isLoading,
                  )}
                </Detail.Preview>
                {row?.detail?.metadata && (
                  <Detail.Info title={null}>
                    {renderDetailMetadata(row.detail.metadata)}
                  </Detail.Info>
                )}
              </Detail>
            )
          : undefined
      }
      loadingLabel="Loading…"
      emptyLabel={tree?.emptyView?.title ?? "No results."}
    />
  );
}

/** An icon the row can actually draw — an image URL or a glyph — else an
 *  empty slot, as Raycast shows for no icon, rather than `ListScreen`'s "?"
 *  placeholder (e.g. a `{ fileIcon }` path, which has no image here). */
function displayIcon(icon: string | undefined): ReactNode {
  return icon && (iconSrc(icon) || isGlyphIcon(icon)) ? icon : <span />;
}

/** `List`'s (and `Grid`'s — same dropdown shape, see `PluginGridScreen`)
 *  `searchBarAccessory`. A native `<select>` renders every real Raycast use
 *  case (a flat or sectioned list of named options) without building a
 *  custom menu component; `ListScreen`'s `inputSuffix` slot is exactly "a
 *  segmented filter/sort control after the input", built for this. An
 *  implicit (section-less) group of items renders as plain `<option>`s
 *  rather than an unlabelled `<optgroup>`. */
export function SearchBarDropdown({
  dropdown,
  onChange,
}: {
  dropdown: PluginDropdownNode;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <select
      value={dropdown.value ?? ""}
      title={dropdown.tooltip}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-border bg-input px-1.5 py-1 text-xs text-foreground-subtle outline-none [-webkit-app-region:no-drag]"
    >
      {dropdown.sections.map((section, index) =>
        section.title ? (
          <optgroup key={index} label={section.title}>
            {section.items.map((item) => (
              <option key={item.value} value={item.value}>
                {item.title}
              </option>
            ))}
          </optgroup>
        ) : (
          section.items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.title}
            </option>
          ))
        ),
      )}
    </select>
  );
}
