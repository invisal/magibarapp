/**
 * `Grid` / `Grid.Item` / `Grid.Section` / `Grid.Dropdown` / `Grid.EmptyView`.
 * Mirrors `List.ts` closely (same launcher-search-driven filtering via
 * `searchFilter.ts`, same dropdown/empty-view shapes) — a `Grid` is a `List`
 * with image-forward items and a tile layout instead of rows.
 */
import {
  createElement,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { searchTextStore } from "../host-bridge.ts";
import { FrameContext } from "../navigation.ts";
import { List } from "./List.ts";

export interface GridItemProps {
  id?: string;
  title?: string;
  subtitle?: string;
  keywords?: string[];
  /** An icon name, or a `data:`/`file:`/`https:` image URL, or `{ color }` —
   *  real Raycast's `content` accepts an `Image.ImageLike`; v1 passes
   *  through whatever string/color the plugin gave and lets the renderer's
   *  existing icon resolution (`iconSrc()`) sort it out, same as every
   *  other icon prop in this shim. */
  content: string;
  actions?: ReactNode;
}

function GridItem({
  id,
  title,
  subtitle,
  keywords,
  content,
  actions,
}: GridItemProps) {
  return createElement(
    "grid-item",
    { id, title, subtitle, keywords, content },
    actions,
  );
}

export interface GridSectionProps {
  title?: string;
  /** Accepted for signature compatibility, not enforced — v1 only honors
   *  the top-level `Grid`'s layout values, matching this codebase's
   *  "accept but don't enforce" treatment of other decorative options. */
  columns?: number;
  aspectRatio?: string;
  fit?: string;
  inset?: string;
  children?: ReactNode;
}

function GridSection({ title, children }: GridSectionProps) {
  return createElement("grid-section", { title }, children);
}

export interface GridEmptyViewProps {
  title: string;
  description?: string;
  icon?: string;
}

function GridEmptyView(props: GridEmptyViewProps) {
  return createElement("grid-empty-view", props);
}

export interface GridProps {
  isLoading?: boolean;
  searchBarPlaceholder?: string;
  searchBarAccessory?: ReactNode;
  columns?: number;
  /** Deprecated in real Raycast in favor of `columns`, still widely used. */
  itemSize?: "small" | "medium" | "large";
  aspectRatio?: "1" | "3/2" | "2/3" | "4/3" | "3/4" | "16/9" | "9/16";
  fit?: "contain" | "fill";
  inset?: "none" | "small" | "medium" | "large";
  onSearchTextChange?: (text: string) => void;
  filtering?: boolean | { keepSectionOrder?: boolean };
  children?: ReactNode;
}

/** The deprecated `itemSize` prop, as a column count. */
const ITEM_SIZE_COLUMNS: Record<string, number> = {
  small: 8,
  medium: 5,
  large: 3,
};

function GridRoot({
  itemSize,
  isLoading = false,
  searchBarPlaceholder,
  searchBarAccessory,
  columns,
  aspectRatio,
  fit,
  inset,
  onSearchTextChange,
  filtering,
  children,
}: GridProps) {
  const frameId = useContext(FrameContext);
  const searchText = useSyncExternalStore(searchTextStore.subscribe, () =>
    searchTextStore.getText(frameId),
  );

  useEffect(() => {
    onSearchTextChange?.(searchText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  // Real Raycast: filtering defaults to off when the extension handles
  // search itself via `onSearchTextChange`, on otherwise. Applied to the
  // committed host tree by `reconciler.ts` (see `searchFilter.ts`).
  const filterEnabled =
    filtering === undefined ? !onSearchTextChange : filtering !== false;

  return createElement(
    "grid",
    {
      isLoading,
      searchBarPlaceholder,
      columns: columns ?? (itemSize ? ITEM_SIZE_COLUMNS[itemSize] : undefined),
      aspectRatio,
      fit,
      inset,
      filterQuery: filterEnabled ? searchText : "",
    },
    searchBarAccessory,
    children,
  );
}

export const Grid = Object.assign(GridRoot, {
  Item: GridItem,
  Section: GridSection,
  EmptyView: GridEmptyView,
  // Identical shape to `List.Dropdown` (real Raycast shares the type too) —
  // re-exported rather than reimplemented, so `reconciler.ts`'s existing
  // `buildDropdown` needs no Grid-specific counterpart.
  Dropdown: List.Dropdown,
  // Enum namespaces extensions read at render time (`Grid.Inset.Small`).
  Inset: { Zero: "zero", Small: "small", Medium: "medium", Large: "large" },
  ItemSize: { Small: "small", Medium: "medium", Large: "large" },
  Fit: { Contain: "contain", Fill: "fill" },
});
