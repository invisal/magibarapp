/**
 * `List` / `List.Item` / `List.Section` / `List.EmptyView`. `List` is the one
 * component with real logic: it drives its children off the launcher's own
 * search box (`host-bridge.ts`'s `searchTextStore`) and filters them itself
 * before anything reaches the host tree — mirroring real Raycast behavior
 * (filtering is the `List`'s job, opt out with `filtering={false}`), so
 * `PluginListScreen` on the renderer side always gets an already-filtered,
 * final tree (`serverFiltered`).
 *
 * v1 simplification: there's no plugin-controlled `searchText` prop, only the
 * launcher-driven one — a plugin can still read it via `onSearchTextChange`
 * (e.g. to fetch), it just can't override what the user typed.
 */
import {
  createElement,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { searchTextStore, type Pagination } from "../host-bridge.ts";
import { FrameContext } from "../navigation.ts";
import { Metadata } from "./DetailMetadata.ts";

export interface ListItemAccessory {
  text?: string;
  icon?: string;
  tag?: { value: string; color?: string };
}

export interface ListItemProps {
  id?: string;
  title: string;
  subtitle?: string;
  icon?: string;
  keywords?: string[];
  accessories?: ListItemAccessory[];
  /** A `<ActionPanel>` element — passed through as this node's child, not a
   *  prop, so the reconciler recurses into it like any other subtree. */
  actions?: ReactNode;
  /** A `<List.Item.Detail>` element — renders in `ListScreen`'s master/detail
   *  pane when this row is highlighted. */
  detail?: ReactNode;
}

function ListItem({
  id,
  title,
  subtitle,
  icon,
  keywords,
  accessories,
  actions,
  detail,
}: ListItemProps) {
  return createElement(
    "list-item",
    { id, title, subtitle, icon, keywords, accessories },
    actions,
    detail,
  );
}

export interface ListItemDetailProps {
  isLoading?: boolean;
  markdown?: string;
  metadata?: ReactNode;
}

function ListItemDetail({
  isLoading,
  markdown,
  metadata,
}: ListItemDetailProps) {
  return createElement("list-item-detail", { isLoading, markdown }, metadata);
}

export interface ListSectionProps {
  title?: string;
  children?: ReactNode;
}

function ListSection({ title, children }: ListSectionProps) {
  return createElement("list-section", { title }, children);
}

export interface ListEmptyViewProps {
  title: string;
  description?: string;
  icon?: string;
}

function ListEmptyView(props: ListEmptyViewProps) {
  return createElement("list-empty-view", props);
}

export interface ListDropdownItemProps {
  value: string;
  title: string;
  icon?: string;
  keywords?: string[];
}

function ListDropdownItem(props: ListDropdownItemProps) {
  return createElement("list-dropdown-item", props);
}

export interface ListDropdownSectionProps {
  title?: string;
  children?: ReactNode;
}

function ListDropdownSection({ title, children }: ListDropdownSectionProps) {
  return createElement("list-dropdown-section", { title }, children);
}

export interface ListDropdownProps {
  id?: string;
  tooltip?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  isLoading?: boolean;
  /** Remember the last pick across launches of the command. */
  storeValue?: boolean;
  onChange?: (value: string) => void;
  children?: ReactNode;
}

/** `onChange`/`value` pass straight through as plain host-node props (never
 *  serialized to the wire) — `reconciler.ts`'s `buildDropdown` pulls
 *  `onChange` out at commit time and registers it with `host-bridge.ts`'s
 *  `dropdownChangeStore`, the same way `Action`'s `onAction` is handled.
 *
 *  `value` and `defaultValue` are kept as *separate* props here, not merged
 *  into one — most real extensions (kill-process among them) leave this
 *  uncontrolled (`defaultValue` only, tracking the pick in their own state
 *  via `onChange`), and `buildDropdown` needs to tell that case apart from a
 *  genuinely controlled `value` to know whether to keep echoing the wire
 *  value back to whatever the user last picked once it diverges from the
 *  original default. */
function ListDropdown({
  id,
  tooltip,
  placeholder,
  value,
  defaultValue,
  isLoading,
  storeValue,
  onChange,
  children,
}: ListDropdownProps) {
  return createElement(
    "list-dropdown",
    {
      id,
      tooltip,
      placeholder,
      value,
      defaultValue,
      isLoading,
      storeValue,
      onChange,
    },
    children,
  );
}

export interface ListProps {
  isLoading?: boolean;
  navigationTitle?: string;
  searchBarPlaceholder?: string;
  /** v1 only understands a `List.Dropdown` here — see
   *  `host/protocol.ts`'s `PluginDropdownNode` doc comment. */
  searchBarAccessory?: ReactNode;
  onSearchTextChange?: (text: string) => void;
  filtering?: boolean | { keepSectionOrder?: boolean };
  /** Show the highlighted item's `List.Item.Detail` beside the list. */
  isShowingDetail?: boolean;
  selectedItemId?: string;
  onSelectionChange?: (id: string | null) => void;
  pagination?: Pagination;
  /** Debounce `onSearchTextChange` — applied by the renderer. */
  throttle?: boolean;
  children?: ReactNode;
}

function ListRoot({
  navigationTitle,
  isLoading = false,
  searchBarPlaceholder,
  searchBarAccessory,
  onSearchTextChange,
  filtering,
  isShowingDetail,
  selectedItemId,
  onSelectionChange,
  pagination,
  throttle,
  children,
}: ListProps) {
  const frameId = useContext(FrameContext);
  const searchText = useSyncExternalStore(searchTextStore.subscribe, () =>
    searchTextStore.getText(frameId),
  );

  useEffect(() => {
    onSearchTextChange?.(searchText);
    // Only the text itself should re-fire this — `onSearchTextChange` is
    // typically a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  // Real Raycast: filtering defaults to off when the extension handles
  // search itself via `onSearchTextChange`, on otherwise. Applied to the
  // committed host tree by `reconciler.ts` (see `searchFilter.ts`).
  const filterEnabled =
    filtering === undefined ? !onSearchTextChange : filtering !== false;

  // `searchBarAccessory` is a second, independent child alongside the visible
  // items — not a prop passed straight into the "list" host node's `props`,
  // since it's itself an element (a `List.Dropdown`) that needs its own
  // subtree reconciled, not just a plain data value.
  return createElement(
    "list",
    {
      isLoading,
      searchBarPlaceholder,
      filterQuery: filterEnabled ? searchText : "",
      navigationTitle,
      isShowingDetail,
      selectedItemId,
      onSelectionChange,
      pagination,
      throttle,
    },
    searchBarAccessory,
    children,
  );
}

export const List = Object.assign(ListRoot, {
  Item: Object.assign(ListItem, {
    Detail: Object.assign(ListItemDetail, { Metadata }),
  }),
  Section: ListSection,
  EmptyView: ListEmptyView,
  Dropdown: Object.assign(ListDropdown, {
    Item: ListDropdownItem,
    Section: ListDropdownSection,
  }),
});
