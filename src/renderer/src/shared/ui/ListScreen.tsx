import {
  cloneElement,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { cn } from "cnfast";
import { formatShortcut } from "@renderer/lib/shortcut";
import { iconSrc } from "@renderer/lib/icon";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { Footer, type FooterMenuItem } from "./Footer";
import { ListScrollRootContext } from "./useOnceVisible";

/**
 * A full-screen, launcher-style list: a frameless search header, a scrolling
 * body of rows, and a footer with an optional ⌘K / right-click actions menu.
 *
 * Unlike the old purely-visual `List.*` parts, `ListScreen` owns the behaviour
 * every list screen used to re-wire by hand — the Base UI `Autocomplete`
 * incantation, the query state, highlight tracking, the render-prop bridge, the
 * Escape ladder, and the `Footer.Menu` plumbing. A screen only says what its
 * data is and how to draw a row:
 *
 *   <ListScreen
 *     data={items}
 *     getId={(x) => x.id}
 *     renderItem={(x, { highlighted }) => (
 *       <ListScreen.Item highlighted={highlighted} title={x.name} />
 *     )}
 *     menu={(x) => [{ label: "Edit", onSelect: () => edit(x!.id) }]}
 *   />
 *
 * `highlighted` is the keyboard cursor only — the row Enter, the ⌘K menu and
 * `onInputKeyDown` act on. The mouse never moves it; a hovered row gets a
 * plain CSS `:hover` background instead (give `ListScreen.Item` one — it
 * already has `hover:bg-item-hover`).
 *
 * Plain DOM, not virtualized — fine for the few hundred rows a launcher list
 * holds. Rows carry `content-visibility: auto` so the browser skips
 * layout/paint for off-screen ones; a row that does expensive work on mount
 * (a Widget fetching its subtitle) should gate it on `useOnceVisible`. Pass
 * `serverFiltered` when `data` is already filtered and ranked upstream (e.g. a
 * main-process query), so `ListScreen` renders it as-is instead of
 * re-filtering it against the query text.
 *
 * Pass `getGroup` to section the list under Base UI `Autocomplete.Group`
 * headings. Rows stay a flat `data` array; groups form in first-seen order. A
 * list that ends up with a single group renders flat, with no header.
 */

/* --------------------------------- item -------------------------------- */

/** Fixed row height, in px. */
export const LIST_SCREEN_ITEM_HEIGHT = 40;

/** Back-navigation chevron for the header's back button. */
function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 3.5L4.5 8l5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Magibar's mark: a sparkle wand. Shown at the head of the root screen (the
 * launcher itself, `stack.length === 1`) in the same slot the back button
 * occupies on a pushed screen — purely decorative, so it carries no
 * `no-drag` override and sits inside the header's drag region.
 *
 * Two animation layers (both defined in `index.css`, and how they avoid
 * fighting each other is explained there): `.magic-intro` on the wrapping
 * `<g>` is a one-shot bouncy pop as the icon mounts, and `.magic-float` on
 * each star keeps a slow, staggered hover drift going afterwards — replaced
 * a blink/twinkle loop that read as flat rather than "magic".
 */
function MagicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g className="magic-intro">
        <path
          className="magic-float"
          d="M9 2l1 2.5L12.5 5.5 10 6.5 9 9 8 6.5 5.5 5.5 8 4.5 9 2z"
          fill="currentColor"
        />
        <path
          className="magic-float magic-float--b"
          d="M4.5 9l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L2.5 11l1.4-.6.6-1.4z"
          fill="currentColor"
        />
        <path
          className="magic-float magic-float--c"
          d="M12 10.8l.3.7.7.3-.7.3-.3.7-.3-.7L11 11.8l.7-.3.3-.7z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

function ItemIcon({ icon }: { icon?: ReactNode }) {
  const src = typeof icon === "string" ? iconSrc(icon) : undefined;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-lg">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-5 w-5 object-contain"
        />
      ) : (
        (icon ?? <span className="text-foreground-subtle">?</span>)
      )}
    </span>
  );
}

interface ItemProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Electron accelerator shown as a kbd pill while the row is highlighted. */
  shortcut?: string;
  /** Trailing tag — a type label, an "Exposed" marker, etc. */
  badge?: ReactNode;
  highlighted?: boolean;
}

/**
 * One row: icon, title, subtitle, an optional trailing badge. Fixed height
 * (`LIST_SCREEN_ITEM_HEIGHT`). `ListScreen` clones the base-ui `Autocomplete.Item`
 * props onto this element, so a screen never spreads them itself.
 */
const Item = forwardRef<HTMLDivElement, ItemProps>(function Item(
  { icon, title, subtitle, shortcut, badge, highlighted, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={cn(
        "flex h-10 cursor-default items-center gap-2 rounded px-1 py-1",
        highlighted
          ? "bg-item-selected text-foreground"
          : "hover:bg-item-hover",
        className,
      )}
    >
      <ItemIcon icon={icon} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {/* Shrinkable, not `shrink-0`: in a narrow column (the master/detail
            layout) a long title has to truncate rather than push the row wide
            and give the list a horizontal scrollbar. */}
        <span className="min-w-0 truncate">{title}</span>
        {shortcut && highlighted ? (
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-xs text-foreground-subtle">
            {formatShortcut(shortcut)}
          </kbd>
        ) : subtitle ? (
          <span className="min-w-0 truncate font-medium text-foreground-subtle">
            {subtitle}
          </span>
        ) : null}
      </div>
      {badge != null && (
        <span className="shrink-0 rounded px-1.5 py-0.5 text-foreground-subtle">
          {badge}
        </span>
      )}
    </div>
  );
});

/* --------------------------------- root -------------------------------- */

const INPUT_CLASS =
  "w-full bg-transparent px-2 py-2 text-lg outline-none " +
  "placeholder:text-foreground-subtle [-webkit-app-region:no-drag]";

interface ListScreenBaseProps<T> {
  /** Full row data, in display order. `null` / `undefined` = loading. */
  data: T[] | null | undefined;
  /** Stable key per row. */
  getId: (item: T) => string;
  /** Draw one row — return a single element, normally `<ListScreen.Item>`. */
  renderItem: (item: T, state: { highlighted: boolean }) => ReactElement;
  /** Section key per row. Rows sharing a key form one group, headed by
   *  `renderGroupLabel`; with fewer than two groups no header is shown. */
  getGroup?: (item: T) => string;
  /** Group heading content. Default: the group key. */
  renderGroupLabel?: (group: string, items: T[]) => ReactNode;

  /** ⌘K + right-click menu, rebuilt from the current highlighted row.
   *  Renders via the built-in `Footer.Menu` (a flat, searchable list —
   *  sections, icons, danger + confirm rows, but no nesting) in
   *  `Footer.Right`. */
  menu?: (highlighted: T | null) => FooterMenuItem[];
  /** Click / Enter on a row; `e.detail === 0` means Enter, not the mouse. */
  onActivate?: (item: T, e: MouseEvent<HTMLElement>) => void;
  /**
   * Opt into a master/detail layout: the list narrows to a column on the left
   * and this renders a scrolling pane beside it for the highlighted row (the
   * same target `menu` gets, so the two always describe the same thing). Omit
   * for the usual full-width list.
   */
  detail?: (highlighted: T | null) => ReactNode;
  /** Escape with an empty query (a non-empty query is cleared first).
   *  Defaults to popping this screen off the launcher's route stack — every
   *  `ListScreen` is pushed there, so a caller only needs this to override
   *  the default (e.g. to do something else before leaving). */
  onExit?: () => void;

  /** Opt-in controlled query. Omit to let `ListScreen` hold it internally. */
  inputValue?: string;
  onInputChange?: (value: string) => void;
  placeholder?: string;
  /** Select-all in the search input whenever the window regains focus (e.g.
   *  the launcher reappearing with its last query still in the box). The
   *  input is refocused on every window focus regardless; default false
   *  only skips the select-all. */
  autoRefocus?: boolean;
  /** Text automatic filtering matches against. Default: `getId(item)`. */
  getSearchText?: (item: T) => string;
  /** Full opt-in override of the built-in substring filter. Ignored when
   *  `serverFiltered` is set. */
  filter?: (item: T, query: string) => boolean;
  /** `data` is already filtered/ranked upstream (e.g. a main-process query)
   *  — skip the built-in substring filter and render `data` as-is. */
  serverFiltered?: boolean;
  /** Extra key handling on the search input, run before the built-in
   *  Escape ladder (clear query, else `onExit`). The second arg is the
   *  currently highlighted row (falling back to the first, like `menu`'s) —
   *  so a screen needing it for a shortcut doesn't have to mirror the
   *  highlight in its own state. Call `preventDefault` to suppress the
   *  built-in handling for a key you own instead. */
  onInputKeyDown?: (
    e: KeyboardEvent<HTMLInputElement>,
    highlighted: T | null,
  ) => void;

  footerLabel?: ReactNode | ((visibleCount: number) => ReactNode);
  /** Escape hatch replacing `Footer.Left` entirely (a count label plus a
   *  Pin toggle, say) — takes over from `footerLabel` when set. As a function
   *  it also receives the search input's ref, which a second `Footer.Menu` in
   *  the footer (a filter, say) wants as its `finalFocus` so closing it puts
   *  the cursor back in the search box rather than on its own trigger. */
  customFooter?:
    | ReactNode
    | ((ctx: { inputRef: RefObject<HTMLInputElement | null> }) => ReactNode);
  loadingLabel?: ReactNode;
  emptyLabel?: ReactNode;
  noMatchLabel?: ReactNode;

  /** Rendered inside the search header, before the input — the launcher's
   *  argument chip sits here, so what you type reads as the chip's value. */
  inputPrefix?: ReactNode;
  /** Rendered inside the search header, after the input — a segmented
   *  filter/sort control (e.g. Activity Monitor's CPU/Memory toggle), the
   *  header counterpart to a `Footer.Menu` filter. */
  inputSuffix?: ReactNode;
  /** Row is inert — keyboard nav skips it and click/Enter/⌘K ignore it.
   *  For a non-interactive row inlined into `data`, e.g. a section heading
   *  (see `ClipboardHistoryListScreen` for the pattern). */
  isDisabled?: (item: T) => boolean;
  /** Fires whenever the highlighted row changes — keyboard navigation,
   *  right-click (which highlights the row it opens the menu for), and
   *  Base UI's own auto-highlight on mount/filter. A caller driving its own
   *  state off this (e.g. a `detail` pane) should ignore the occasional
   *  `null` a plain click can still emit as a side effect of `Autocomplete`'s
   *  built-in "commit and close" handling — `onActivate` already fires with
   *  the clicked row itself, synchronously, so nothing is lost by ignoring
   *  it here. */
  onHighlightChange?: (
    item: T | null,
    reason: "keyboard" | "pointer" | "none",
  ) => void;
  /** Fires when the ⌘K / right-click menu opens or closes — for a live list
   *  that should hold still while a row's action menu is up. */
  onMenuOpenChange?: (open: boolean) => void;
}

type ListScreenProps<T> = ListScreenBaseProps<T>;

interface Group<T> {
  value: string;
  items: T[];
}

function ListScreenRoot<T>({
  data,
  getId,
  renderItem,
  getGroup,
  renderGroupLabel,
  menu,
  onActivate,
  detail,
  onExit,
  inputValue,
  onInputChange,
  placeholder = "Search…",
  getSearchText,
  filter,
  serverFiltered = false,
  onInputKeyDown: onExtraInputKeyDown,
  footerLabel,
  customFooter,
  loadingLabel = "Loading…",
  emptyLabel,
  noMatchLabel = "No matches.",
  inputPrefix,
  inputSuffix,
  autoRefocus = false,
  isDisabled,
  onHighlightChange,
  onMenuOpenChange,
}: ListScreenProps<T>) {
  const { stack, pop } = useRouteStack();
  const controlled = inputValue !== undefined;
  const [innerQuery, setInnerQuery] = useState("");
  const query = controlled ? inputValue : innerQuery;
  const setQuery = (value: string) => {
    if (!controlled) setInnerQuery(value);
    onInputChange?.(value);
  };

  const [highlighted, setHighlighted] = useState<T | null>(null);
  const [menuOpen, setMenuOpenState] = useState(false);
  const setMenuOpen = (open: boolean) => {
    setMenuOpenState(open);
    onMenuOpenChange?.(open);
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function focusAndSelect(): void {
      inputRef.current?.focus();
      if (autoRefocus) inputRef.current?.select();
    }
    focusAndSelect();
    // Always refocus the input when the window is reshown — the screen stays
    // mounted across hide/show, so `autoFocus` alone would leave focus on
    // the first tabbable element (the back button).
    window.addEventListener("focus", focusAndSelect);
    return () => window.removeEventListener("focus", focusAndSelect);
  }, [autoRefocus]);

  const loading = data == null;

  const visible = useMemo(() => {
    const list = data ?? [];
    if (serverFiltered) return list;
    const q = query.trim().toLowerCase();
    if (!q) return list;
    if (filter) return list.filter((item) => filter(item, query));
    return list.filter((item) =>
      (getSearchText ? getSearchText(item) : getId(item))
        .toLowerCase()
        .includes(q),
    );
  }, [data, query, filter, getSearchText, getId, serverFiltered]);

  // Sections, in first-seen order. Fewer than two of them and the list is
  // rendered flat — a lone header would just be noise.
  const groups = useMemo<Group<T>[] | null>(() => {
    if (!getGroup) return null;
    const byKey = new Map<string, T[]>();
    for (const item of visible) {
      const key = getGroup(item);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(item);
      else byKey.set(key, [item]);
    }
    return byKey.size > 1
      ? [...byKey].map(([value, items]) => ({ value, items }))
      : null;
  }, [visible, getGroup]);

  // Display order — what Base UI walks for keyboard navigation.
  const ordered = useMemo(
    () => (groups ? groups.flatMap((g) => g.items) : visible),
    [groups, visible],
  );

  // The highlighted row, falling back to the first *selectable* one — the
  // target both the `menu` builder and `onInputKeyDown`'s second arg
  // receive. Skips a disabled row (e.g. a section heading inlined into
  // `data`) rather than landing on it before anything's been highlighted.
  const menuTarget =
    highlighted ?? ordered.find((item) => !isDisabled?.(item)) ?? null;

  // Whether this screen is pushed on top of something — i.e. whether "back"
  // is a real place to go, as opposed to the launcher root's `onExit`, which
  // hides the window rather than navigating anywhere. Drives the header's
  // back button; `onExit` (root's custom hide, or a pushed screen's override
  // of the default pop) is still whatever Escape runs either way.
  const canGoBack = stack.length > 1;
  function exit(): void {
    if (onExit) onExit();
    else if (stack.length > 1) pop();
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    onExtraInputKeyDown?.(e, menuTarget);
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else exit();
    }
  }

  const emptyMessage = loading
    ? loadingLabel
    : (data ?? []).length === 0
      ? (emptyLabel ?? noMatchLabel)
      : noMatchLabel;

  const label =
    typeof footerLabel === "function"
      ? footerLabel(visible.length)
      : footerLabel;

  const footer =
    typeof customFooter === "function"
      ? customFooter({ inputRef })
      : customFooter;

  const renderRow = (item: T) => {
    const disabled = isDisabled?.(item) ?? false;
    return (
      <Autocomplete.Item
        key={getId(item)}
        value={item}
        disabled={disabled}
        onClick={(e) => !disabled && onActivate?.(item, e)}
        onContextMenu={(e) => {
          if (disabled) return;
          e.preventDefault();
          setHighlighted(item);
          onHighlightChange?.(item, "pointer");
          setMenuOpen(true);
        }}
        // Off-screen rows skip layout and paint; `auto` remembers a row's
        // real height once rendered, so a tall row (the calculator panel)
        // isn't pinned to the 40px estimate.
        style={{
          contentVisibility: "auto",
          containIntrinsicSize: `auto ${LIST_SCREEN_ITEM_HEIGHT}px`,
        }}
        render={(props, state) =>
          cloneElement(
            renderItem(item, { highlighted: state.highlighted }),
            props,
          )
        }
      />
    );
  };

  return (
    <Autocomplete.Root
      // Base UI reads a `{ items }[]` array as grouped and a plain array as
      // flat; its overloads can't express the runtime union, hence the cast.
      items={(groups ?? visible) as T[]}
      value={query}
      onValueChange={setQuery}
      mode="none"
      inline
      open
      loopFocus={false}
      autoHighlight="always"
      // The highlighted row is the keyboard cursor only — Enter, ⌘K's menu
      // target and `onInputKeyDown`'s second arg all key off it, so hovering
      // the mouse must not move it. A hovered row instead gets its own plain
      // CSS `:hover` background (`hover:bg-item-hover` on the row), distinct
      // from the cursor's `bg-item-selected`.
      highlightItemOnHover={false}
      onItemHighlighted={(item, { reason }) => {
        const value = (item as T | undefined) ?? null;
        setHighlighted(value);
        onHighlightChange?.(value, reason);
      }}
    >
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <div className="flex items-center gap-1 border-b border-border px-2 p-1 [-webkit-app-region:drag]">
          {canGoBack ? (
            <button
              type="button"
              aria-label="Back"
              onClick={exit}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-item-hover hover:text-foreground [-webkit-app-region:no-drag]"
            >
              <BackIcon />
            </button>
          ) : (
            // Root of the stack — the launcher itself. No back button here,
            // so the slot instead carries Magibar's mark; purely decorative
            // and left inside the drag region (no `no-drag`) so it's part of
            // the window's drag handle rather than competing with it.
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center text-foreground-subtle"
            >
              <MagicIcon />
            </span>
          )}
          {inputPrefix}
          <Autocomplete.Input
            ref={inputRef}
            onKeyDown={onInputKeyDown}
            placeholder={placeholder}
            autoFocus
            className={INPUT_CLASS}
          />
          {inputSuffix}
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            ref={scrollContainerRef}
            className={cn(
              "min-h-0 overflow-y-auto p-2",
              detail ? "w-[38%] shrink-0 border-r border-border" : "flex-1",
            )}
          >
            <ListScrollRootContext.Provider value={scrollContainerRef}>
              <Autocomplete.List className="relative w-full">
                {groups
                  ? (group: Group<T>) => (
                      <Autocomplete.Group key={group.value} items={group.items}>
                        <Autocomplete.GroupLabel className="px-1.5 pt-2 pb-1 text-xs font-medium text-foreground-subtle">
                          {renderGroupLabel
                            ? renderGroupLabel(group.value, group.items)
                            : group.value}
                        </Autocomplete.GroupLabel>
                        <Autocomplete.Collection>
                          {renderRow}
                        </Autocomplete.Collection>
                      </Autocomplete.Group>
                    )
                  : renderRow}
              </Autocomplete.List>
            </ListScrollRootContext.Provider>

            {visible.length === 0 && (
              <div className="px-3 py-2 text-sm text-foreground-subtle">
                {emptyMessage}
              </div>
            )}
          </div>
          {detail && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {detail(menuTarget)}
            </div>
          )}
        </div>

        <Footer>
          {(footer != null || label != null) && (
            <Footer.Left>
              {footer ?? <Footer.Label>{label}</Footer.Label>}
            </Footer.Left>
          )}
          {menu && (
            <Footer.Right>
              <Footer.Menu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={menu(menuTarget)}
                finalFocus={inputRef}
              />
            </Footer.Right>
          )}
        </Footer>
      </div>
    </Autocomplete.Root>
  );
}

export const ListScreen = Object.assign(ListScreenRoot, { Item });
