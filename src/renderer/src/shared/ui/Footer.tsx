import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { cn } from "cnfast";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { iconSrc } from "@renderer/lib/icon";
import { ShortcutLabel } from "./ShortcutLabel";

/** A key-combo pill (e.g. ⌘⏎ / Ctrl+Enter). Decorative — hidden from a11y. */
function Kbd({
  accelerator,
  className,
}: {
  accelerator: string;
  className?: string;
}) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-sans text-xs text-foreground-subtle",
        className,
      )}
    >
      <ShortcutLabel accelerator={accelerator} />
    </kbd>
  );
}

/**
 * The bar pinned to the bottom of a window — as `Layout.Footer` below a
 * scrolling `Content`, or on its own as the last flex child (the launcher).
 *
 *   <Layout.Footer>
 *     <Layout.Footer.Left>
 *       <Layout.Footer.Button onClick={cancel}>Cancel</Layout.Footer.Button>
 *     </Layout.Footer.Left>
 *     <Layout.Footer.Right>
 *       <Layout.Footer.Label>Unsaved changes</Layout.Footer.Label>
 *       <Layout.Footer.Button
 *         variant="primary"
 *         shortcut="CommandOrControl+Enter"
 *         onClick={save}
 *       >
 *         Save
 *       </Layout.Footer.Button>
 *     </Layout.Footer.Right>
 *   </Layout.Footer>
 *
 * `Left` / `Right` are optional flex groups that stick to their side (either one
 * works alone). Raw children are still fine — the footer is a plain flex row.
 * `Button` is the slim ghost action; `Label` is passive text (a status readout,
 * hint, or count) sharing the footer's type scale. `Menu` is a searchable
 * actions dropdown; see its own doc below.
 *
 * The bar itself is a window drag region (all our windows are frameless), so the
 * empty space and any `Label` text drag the window. `Button` and the `Menu`
 * trigger opt back out — a raw `<button>` you drop in yourself needs its own
 * `[-webkit-app-region:no-drag]`.
 *
 * `Button`'s `shortcut` is only a visual hint — bind the actual key with
 * `useShortcut` in the screen. `Menu` owns its own open/close (and the ⌘K
 * toggle) unless you pass `open` / `onOpenChange` to drive it.
 */
function FooterRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-border px-2 py-1 [-webkit-app-region:drag]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Left-aligned group. `mr-auto` pushes anything after it to the right. */
function Left({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mr-auto flex min-w-0 items-center gap-3", className)}>
      {children}
    </div>
  );
}

/** Right-aligned group. */
function Right({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("ml-auto flex min-w-0 items-center gap-3", className)}>
      {children}
    </div>
  );
}

/* ----------------------------- action button ---------------------------- */

/** Every footer button is the same ghost shape — a slim, borderless target
 *  that grows a faint background on hover. `primary` only differs by carrying
 *  full-strength text; `default` sits back in the subtle colour. */
type Variant = "primary" | "default";

const VARIANT: Record<Variant, string> = {
  primary: "text-foreground",
  default: "text-foreground-subtle",
};

const ACTION_BASE =
  "flex items-center gap-2 rounded px-2 py-1 text-xs font-medium transition-colors " +
  "[-webkit-app-region:no-drag] " +
  "hover:bg-item-hover hover:text-foreground " +
  "disabled:opacity-40 disabled:hover:bg-transparent";

export interface ButtonProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children"
> {
  children: ReactNode;
  /** `primary` for the confirming action (full-strength text), `default` for
   *  the rest (subtle text). Both are the same slim ghost shape. */
  variant?: Variant;
  /** Electron accelerator (e.g. "CommandOrControl+Enter") shown as a trailing
   *  kbd hint. This is display only — bind the key with `useShortcut`. */
  shortcut?: string;
  /** Plain trailing text shown where `shortcut` would sit, for a hint that
   *  isn't a real accelerator to format (e.g. literal "Esc" instead of the
   *  Mac ⎋ symbol `shortcut="Escape"` renders). If both are set, `shortcut`
   *  wins. */
  shortcutLabel?: string;
  /** Disables the button and swaps in `loadingLabel`. */
  loading?: boolean;
  loadingLabel?: ReactNode;
  /** Renders a persistent "on" state (filled background) for a toggle, e.g. a
   *  pin. Also reflected as `aria-pressed`. */
  active?: boolean;
}

/** A slim ghost button with a hover background, a built-in loading state, an
 *  optional (display-only) shortcut hint, and an optional `active` toggle
 *  state. */
function Button({
  children,
  variant = "default",
  shortcut,
  shortcutLabel,
  loading = false,
  loadingLabel,
  active = false,
  disabled,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={Boolean(disabled) || loading}
      aria-keyshortcuts={shortcut}
      aria-pressed={active || undefined}
      className={cn(
        ACTION_BASE,
        VARIANT[variant],
        active && "bg-item-selected text-foreground hover:bg-item-selected",
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 truncate">
        {loading && loadingLabel ? loadingLabel : children}
      </span>
      {shortcut ? (
        <Kbd accelerator={shortcut} />
      ) : shortcutLabel ? (
        <kbd
          aria-hidden
          className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-sans text-xs text-foreground-subtle"
        >
          {shortcutLabel}
        </kbd>
      ) : null}
    </button>
  );
}

/* -------------------------------- label -------------------------------- */

/** Passive footer text — a status readout, hint, or count sitting next to the
 *  buttons. Shares the footer's type scale (slim, subtle) and truncates rather
 *  than pushing the row wide; pass `className` to recolour (e.g. a warning). */
function Label({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "min-w-0 truncate text-xs font-medium text-foreground-subtle",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/* -------------------------------- menu --------------------------------- */

interface FooterMenuItemBase {
  /** Stable key for the row; falls back to `label`. Also the submenu path
   *  segment for a row that carries `items`, so give those an explicit `id`. */
  id?: string;
  label: string;
  /** Display hint shown on the row. Bind the key itself with `useShortcut`. */
  shortcut?: string;
  /**
   * Plain trailing text shown where `shortcut` would sit, for a value that
   * isn't a keyboard accelerator (so shouldn't be piped through `Kbd`'s
   * symbol formatting) — e.g. the current alias for a "Change Alias" row.
   * If both are set, `shortcut` wins.
   */
  hint?: string;
  disabled?: boolean;
  /** Emoji or image URL shown before the label. */
  icon?: string;
  /** Render the row in a warning colour (a Delete action). */
  danger?: boolean;
  /**
   * Group heading. Drawn once above the first item of each contiguous run of
   * items sharing a `section`; items with no `section` get no heading. Keep
   * items of one section next to each other in the array.
   */
  section?: string;
  /**
   * Draw a plain divider line above this item instead of a `section` text
   * heading — for a row that just needs visual separation from what's above
   * it without a label (e.g. one lone row tacked onto the end of the menu).
   * Ignored where a `section` heading already draws one, and at index 0.
   */
  separator?: boolean;
}

/** A row that runs something when picked. */
interface FooterMenuLeaf extends FooterMenuItemBase {
  /**
   * Guards a destructive action with a second activation: the first select
   * swaps the label to this text and arms the row (auto-disarms after a few
   * seconds, or when the query changes); a second select runs `onSelect`.
   */
  confirmLabel?: string;
  onSelect: () => void;
  items?: never;
  panel?: never;
  /**
   * Keep the popup open after this row runs, instead of the usual
   * select-and-close — for a row whose `onSelect` starts something the popup
   * needs to keep showing the live state of (e.g. "press a key to record a
   * hotkey"). Default false.
   */
  keepOpen?: boolean;
}

/**
 * A row that opens a list of its own instead of running: picking it replaces
 * the menu's contents with `items` (and its search box filters those); Escape
 * returns to the list it came from. For a long, self-contained group like
 * quicklinks' "Open With", which contributes a row per installed app and
 * would otherwise bury the rest of the menu under it.
 */
interface FooterMenuSubmenu extends FooterMenuItemBase {
  items: FooterMenuItem[];
  panel?: never;
  confirmLabel?: never;
  onSelect?: never;
  keepOpen?: never;
}

/**
 * A form the native Actions menu can show in place of a `panel` — see
 * `FooterMenuPanel.native`. Mirrors the native `ActionsFormSpec`, plus the save
 * handler, which stays here in the renderer.
 */
export interface NativeMenuForm {
  /** `text`: a text field. `keys`: records the next key combo (an accelerator). */
  kind: "text" | "keys";
  title: string;
  /** An action icon (emoji, or a `data:` image URL); other kinds are left out. */
  icon?: string;
  initialValue?: string;
  placeholder?: string;
  /** `text`: drop whitespace as it's typed. */
  stripWhitespace?: boolean;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Default "Save". */
  submitLabel?: string;
  /**
   * Runs on save with the text or accelerator. Resolve `null` when it worked
   * (the form closes), or a message to show while keeping the form open.
   */
  onSubmit: (value: string) => Promise<string | null>;
}

/**
 * A row that opens arbitrary content of its own instead of a list: picking it
 * replaces the popup's search box and list with whatever `panel` renders —
 * for a group that isn't a set of choices, like an alias to type rather than
 * pick. `onClose` returns to the list this row came from, landing the
 * highlight back on it, the same as Escape (or the popup's back button) does
 * for an `items` submenu — call it once the panel's own work is done (a save,
 * a cancel), not on every keystroke.
 */
interface FooterMenuPanel extends FooterMenuItemBase {
  panel: (ctx: { onClose: () => void }) => ReactNode;
  /**
   * What to show instead of `panel` in the native (macOS) menu, which can't
   * host React: a small form with a text field or a key-combo recorder. A
   * `panel` row without one keeps the DOM popup even there.
   */
  native?: NativeMenuForm;
  items?: never;
  confirmLabel?: never;
  onSelect?: never;
  keepOpen?: never;
}

export type FooterMenuItem =
  FooterMenuLeaf | FooterMenuSubmenu | FooterMenuPanel;

export interface FooterMenuProps {
  /** Trigger label. Default "Actions". */
  label?: ReactNode;
  /** Toggles the menu, and the hint shown on the trigger. Default
   *  "CommandOrControl+K". */
  shortcut?: string;
  /** Search-box placeholder. Default "Search actions…". */
  placeholder?: string;
  items: FooterMenuItem[];
  /** Controlled open state. Omit both to let the menu own its visibility; pass
   *  them when the screen needs to coordinate it (e.g. the launcher rebuilds
   *  `items` from the highlighted row and shares the ⌘K toggle). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus lands when the popup closes. Defaults to the trigger. */
  finalFocus?: RefObject<HTMLElement | null>;
  /**
   * Position the popup against this instead of its own trigger, and skip
   * rendering that trigger (and its ⌘K binding) altogether — for a menu
   * opened programmatically by something else (a row in another menu), which
   * owns `open`/`onOpenChange` itself and has no on-screen trigger of its own
   * for this popup to sit next to. Accepts anything Base UI's
   * `Autocomplete.Positioner` `anchor` does: an element, a ref, a getter, or
   * a virtual `{ getBoundingClientRect }` point.
   */
  anchor?: ComponentPropsWithoutRef<typeof Autocomplete.Positioner>["anchor"];
}

/**
 * Whether the experimental native Actions panel is available (macOS build with
 * the addon). On by default while it's an experiment; opt out with
 * `localStorage.nativeActionsPanel = "0"`.
 */
function useNativeActionsPanel(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let enabled = true;
    try {
      enabled = localStorage.getItem("nativeActionsPanel") !== "0";
    } catch {
      /* storage unavailable — keep the default */
    }
    if (!enabled) return;
    void window.api.actionsPanel.supported().then(setOn);
  }, []);
  return on;
}

/**
 * A searchable actions menu for the footer, opened by its trigger or the ⌘K
 * shortcut. Uncontrolled by default (owns its open/close and binds ⌘K); pass
 * `open` / `onOpenChange` to drive it. An item's `shortcut` is a display hint
 * on the row; bind the key itself with `useShortcut` in the screen. Items can
 * carry an `icon`, a `section` heading, `danger` styling, and a `confirmLabel`
 * (arm-then-confirm) — see `FooterMenuItem`.
 *
 * Mostly one flat list: related rows are a `section`, not a submenu. The one
 * exception is a row carrying `items` (a `FooterMenuSubmenu`), which opens
 * that list in place of the current one — for a group too long to sit inline,
 * like quicklinks' "Open With" and its row per installed app. Escape (or the
 * popup's back button) returns to the list it came from, and only closes the
 * menu from the top level.
 *
 *   const format = () => editor.current?.format();
 *   useShortcut({ "CommandOrControl+S": format });
 *
 *   <Layout.Footer.Menu
 *     items={[
 *       { label: "Run Test", onSelect: runTest },
 *       { label: "Format", shortcut: "CommandOrControl+S", onSelect: format },
 *     ]}
 *   />
 */
function Menu({
  label = "Actions",
  shortcut = "CommandOrControl+K",
  placeholder = "Search actions…",
  items,
  open: openProp,
  onOpenChange,
  finalFocus,
  anchor,
}: FooterMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const [search, setSearch] = useState("");
  // Key of the `confirmLabel` item awaiting its second activation, if any.
  const [armedId, setArmedId] = useState<string | null>(null);
  // Path into the open submenu, as row keys (`id ?? label`) rather than the
  // item objects themselves: a screen rebuilds `items` on every render (the
  // launcher rebuilds it from the highlighted row), so holding onto an item
  // would pin the submenu — and the closures in its `onSelect`s — to whatever
  // the menu looked like when it was opened.
  const [trail, setTrail] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Row key `goBack()` wants the *real* (not just visual) highlight to land
  // on once the popped-back-to list renders — see the effect below.
  const pendingHighlightKeyRef = useRef<string | null>(null);
  // The popup is portalled into this element rather than `document.body`, so it
  // stays inside the owning screen's subtree. When an `onSelect` navigates and
  // React parks that screen in a hidden `<Activity>`, the `display:none` covers
  // the popup too — otherwise Base UI defers its unmount to a closing
  // transition that never fires offscreen, and it lingers over the new screen.
  const portalRef = useRef<HTMLDivElement>(null);

  const nativePanel = useNativeActionsPanel();

  const openDom = () => {
    if (openProp === undefined) setUncontrolledOpen(true);
    onOpenChange?.(true);
  };

  // The latest `items`, for re-showing the list after a form (the closure that
  // opened the form is from before whatever the form changed).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Shows `form` and serves its saves until it closes: each `submit` runs
  // `onSubmit`, which either finishes it or hands back a message to show.
  //
  // Resolves how it ended: `saved`, `back` (the user chose to leave), or
  // `dismissed` (focus moved away — the caller must not put anything back up).
  const runNativeForm = async (
    form: NativeMenuForm,
  ): Promise<"saved" | "back" | "dismissed"> => {
    const api = window.api.actionsPanel;
    const src = iconSrc(form.icon);
    const opened = await api.formOpen({
      kind: form.kind,
      title: form.title,
      iconText: form.icon && !src ? form.icon : undefined,
      iconDataUrl: src?.startsWith("data:") ? src : undefined,
      initialValue: form.initialValue,
      placeholder: form.placeholder,
      stripWhitespace: form.stripWhitespace,
      cancelLabel: form.cancelLabel,
      submitLabel: form.submitLabel,
    });
    if (!opened) return "dismissed";

    for (;;) {
      const event = await api.formNext();
      if (event.kind !== "submit") {
        return event.value === "dismissed" ? "dismissed" : "back";
      }
      let error: string | null;
      try {
        error = await form.onSubmit(event.value ?? "");
      } catch {
        error = "Couldn't save. Try again.";
      }
      if (error === null) {
        await api.formClose();
        return "saved";
      }
      await api.formFail(error);
    }
  };

  // Experimental: on macOS with the flag on, the menu opens as a native
  // NSPanel instead of the DOM popup. A row with `items` re-shows the panel
  // with that list, and a `confirmLabel` row asks again in a small panel. Rows
  // with a `native` form show it natively; those that need React or a popup
  // that stays open showing live state (`panel` without one, `keepOpen`) keep
  // the DOM popup — at the step that holds them.
  const showNativePanel = async (
    list: FooterMenuItem[],
    title: string,
    path: string[],
  ): Promise<void> => {
    const rows = list.filter((item) => !item.disabled);
    const picked = await window.api.actionsPanel.show(
      title,
      rows.map((item, index) => ({
        id: String(index),
        title: item.label,
        section: item.section,
        shortcut: item.shortcut
          ? item.shortcut.split("+").map((key) => formatShortcut(key))
          : undefined,
        danger: item.danger,
        hint: item.hint,
        accessorySfSymbol:
          item.items || item.panel ? "chevron.right" : undefined,
      })),
    );
    const item = picked === null ? undefined : rows[Number(picked)];
    if (!item) return;

    if (item.panel) {
      if (item.native) {
        const outcome = await runNativeForm(item.native);
        // Clicking away isn't "back": leave the launcher alone, or the list
        // would reappear over whatever the user moved on to.
        if (outcome === "dismissed") return;
        // Back to the list, as the DOM panel's `onClose` does. Give the save's
        // state updates a moment so the rebuilt rows (e.g. "Change Alias") show.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return showNativePanel(
          path.length ? list : itemsRef.current,
          title,
          path,
        );
      }
      // React content with no native form: the DOM popup, at that step.
      setTrail([...path, item.id ?? item.label]);
      openDom();
      return;
    }
    if (item.items) {
      const next = [...path, item.id ?? item.label];
      if (item.items.some((child) => child.keepOpen)) {
        setTrail(next);
        openDom();
        return;
      }
      return showNativePanel(item.items, item.label, next);
    }
    if (item.confirmLabel) {
      const answer = await window.api.actionsPanel.show(item.label, [
        { id: "confirm", title: item.confirmLabel, danger: item.danger },
        { id: "cancel", title: "Cancel" },
      ]);
      if (answer !== "confirm") return;
    }
    item.onSelect();
  };

  const openNativePanel = (): boolean => {
    if (!nativePanel || anchor || trail.length > 0) return false;
    if (items.some((item) => item.keepOpen)) return false;
    void showNativePanel(
      items,
      typeof label === "string" ? label : "Actions",
      [],
    );
    return true;
  };

  const setOpen = (next: boolean) => {
    if (next && openNativePanel()) return;
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // Clear the query and disarm any pending confirm on every close path
  // (select / Escape / outside click / ⌘K).
  useEffect(() => {
    if (!open) {
      setSearch("");
      setArmedId(null);
      setTrail([]);
    }
  }, [open]);

  // A pending confirm disarms when the user filters away from it, and a few
  // seconds after arming if it's never confirmed.
  useEffect(() => {
    setArmedId(null);
  }, [search]);
  useEffect(() => {
    if (!armedId) return;
    const timer = setTimeout(() => setArmedId(null), 4000);
    return () => clearTimeout(timer);
  }, [armedId]);

  // Walk `trail` down the *current* `items` to the list being shown, and the
  // row it hangs off (the popup's header). A segment that no longer resolves —
  // the highlighted row changed under an open submenu — stops the walk there,
  // so the menu falls back to the deepest list that still exists. A `panel`
  // row is a terminal step (nothing to descend into): the walk stops there
  // and `activeItems` stays whatever list it was found in, unused while the
  // panel is shown.
  const { activeItems, parent, activePanel } = useMemo(() => {
    let list = items;
    let openedBy: FooterMenuItem | null = null;
    let panel: FooterMenuPanel | null = null;
    for (const key of trail) {
      const next = list.find((item) => (item.id ?? item.label) === key);
      if (!next) break;
      if (next.panel) {
        openedBy = next;
        panel = next as FooterMenuPanel;
        break;
      }
      if (!next.items) break;
      list = next.items;
      openedBy = next;
    }
    return { activeItems: list, parent: openedBy, activePanel: panel };
  }, [items, trail]);

  // Heading rows: the key of the first item of each contiguous `section` run.
  const sectionFirstKeys = useMemo(() => {
    const keys = new Set<string>();
    let prev: string | undefined;
    for (const item of activeItems) {
      const key = item.id ?? item.label;
      if (item.section && item.section !== prev) keys.add(key);
      prev = item.section;
    }
    return keys;
  }, [activeItems]);

  /**
   * Leave the open submenu for the list it came from — landing the *real*
   * highlight back on the row that opened it, not whatever Autocomplete
   * defaults to.
   *
   * There's no public API to set Autocomplete's highlighted item directly,
   * and forcing it by reordering `items` or remounting the popup both crash
   * its internals (verified against the library). What does work, without
   * touching any internal state: drive it with the same synthetic key
   * events a real Home-then-ArrowDown press would send — see the effect
   * below, keyed off `pendingHighlightKeyRef`.
   */
  const goBack = () => {
    pendingHighlightKeyRef.current = parent
      ? (parent.id ?? parent.label)
      : null;
    setTrail((path) => path.slice(0, -1));
    setSearch("");
    setArmedId(null);
  };

  // Consumes `pendingHighlightKeyRef` once the list `goBack()` returned to
  // has actually rendered: finds that row's index in it, then dispatches a
  // Home press (reliably lands on index 0) followed by that many ArrowDowns
  // — real keydown events on the popup's own input, so Autocomplete moves
  // its highlight through its normal navigation path instead of anything
  // reaching into its state. Two animation frames give its own
  // layout-effect-driven highlight bookkeeping a turn to settle first.
  useEffect(() => {
    const targetKey = pendingHighlightKeyRef.current;
    if (!targetKey) return;

    const targetIndex = activeItems.findIndex(
      (item) => (item.id ?? item.label) === targetKey,
    );

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        // Only cleared once the work below actually runs — not up front.
        // An incidental re-render (e.g. `refreshActionHotkeys`'s IPC round
        // trip resolving) between this effect scheduling its rAFs and them
        // firing tears this effect down early (the cleanup below cancels
        // them); clearing the ref up front would then lose the highlight
        // request entirely instead of the rerun picking it back up.
        pendingHighlightKeyRef.current = null;
        const input = inputRef.current;
        if (!input) return;
        // A `panel` step unmounts this input while it's shown (see
        // `activePanel` below), so returning from one leaves real keyboard
        // focus on whatever the browser fell back to — nothing reaches
        // Autocomplete's own arrow/Enter handling until it's back here.
        // Unconditional even when the target row below isn't found, so
        // keyboard nav still recovers in that edge case too.
        input.focus();
        if (targetIndex < 0) return;
        const dispatch = (key: string) =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
        dispatch("Home");
        for (let i = 0; i < targetIndex; i++) dispatch("ArrowDown");
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // `trail`, not just `activeItems`: leaving a `panel` step pops `trail`
    // back to a list that was already the current `activeItems` (a panel
    // never descends into a list of its own, so it never changes what
    // `activeItems` points to) — without `trail` here too, that transition
    // wouldn't re-run this effect at all, and `pendingHighlightKeyRef` would
    // sit unconsumed forever.
  }, [activeItems, trail]);

  /** `"armed"` when the hit only armed a `confirmLabel` item, `"opened"` when
   *  it descended into a submenu — neither ran anything. */
  const choose = (
    item: FooterMenuItem,
  ): "armed" | "opened" | "ran" | "ignored" => {
    if (item.disabled) return "ignored";
    const key = item.id ?? item.label;
    // A submenu or panel row swaps the popup's content out and keeps the
    // menu open; the search box starts empty again so it filters the list
    // now on screen (irrelevant while a panel is showing, but harmless).
    if (item.items || item.panel) {
      setTrail((path) => [...path, key]);
      setSearch("");
      setArmedId(null);
      return "opened";
    }
    // First hit on a guarded item just arms it — keep the menu open so the
    // swapped-in `confirmLabel` is visible for the confirming second hit.
    if (item.confirmLabel && armedId !== key) {
      setArmedId(key);
      return "armed";
    }
    setArmedId(null);
    if (!item.keepOpen) setOpen(false);
    item.onSelect();
    return "ran";
  };

  // The menu owns the ⌘K toggle whether controlled or not (setOpen routes to
  // the right place). Item shortcuts stay the screen's to bind via useShortcut.
  // An anchored menu has no trigger of its own to toggle — the caller owns
  // showing/hiding it — so it doesn't bind the shortcut at all.
  useShortcut({ [shortcut]: anchor ? undefined : () => setOpen(!open) });

  return (
    <Autocomplete.Root
      items={activeItems}
      open={open}
      onOpenChange={setOpen}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(item) => item.label}
      autoHighlight="always"
      // Without this, the pointer leaving the list clears the highlight and
      // `autoHighlight="always"` snaps it to the first row.
      keepHighlight
    >
      {!anchor && (
        <Autocomplete.Trigger
          ref={triggerRef}
          className={cn(
            ACTION_BASE,
            open ? "bg-item-hover text-foreground" : "text-foreground-subtle",
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <Kbd accelerator={shortcut} />
        </Autocomplete.Trigger>
      )}
      {/* Zero-size, out-of-flow host for the portal (see `portalRef`), pinned
          to the viewport origin. The positioner inside it is absolutely
          positioned, so this host is its containing block and its origin: left
          at `auto` the host sits at its static position in the footer row, and
          every popup coordinate — already computed against the viewport —
          picks up that offset on top, landing the popup outside the window. */}
      <div ref={portalRef} className="fixed left-0 top-0" />
      <Autocomplete.Portal container={portalRef}>
        <Autocomplete.Positioner
          anchor={anchor}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          // Above the list it overlaps: the portal host sits in the footer,
          // which paints below the scrolling body it hangs over. Same `z-50`
          // the "Open With" picker's positioner carries in `AppPicker`.
          className="z-50"
        >
          {/* The popup is capped at the space the window actually has
              (`--available-height`, from the positioner) and the list scrolls
              inside it. Without the cap a long list — quicklinks' "Open With"
              submenu, a row per installed app — lays itself out at its full
              height, and since the side axis flips rather than shifts, most of
              it ends up off the top of the 640×420 launcher: search box and
              first rows outside the window, unclickable. Same treatment as the
              "Open With" picker in `AppPicker`. */}
          <Autocomplete.Popup
            finalFocus={finalFocus ?? triggerRef}
            // Inside a submenu, Escape steps back out instead of dismissing.
            // Base UI's own Escape handling is a bubble-phase listener on the
            // document, so claiming the key here (capture, before the event
            // reaches the input at all) is what keeps the popup open.
            onKeyDownCapture={(event) => {
              if (event.key !== "Escape" || !parent) return;
              event.preventDefault();
              event.stopPropagation();
              goBack();
            }}
            className="flex max-h-[min(24rem,var(--available-height))] w-60 flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-lg outline-none [-webkit-app-region:no-drag]"
          >
            {activePanel ? (
              activePanel.panel({ onClose: goBack })
            ) : (
              <>
                <div className="shrink-0 border-b border-border p-1">
                  <Autocomplete.Input
                    ref={inputRef}
                    placeholder={
                      parent ? `Search ${parent.label}…` : placeholder
                    }
                    className="w-full bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-foreground-subtle"
                  />
                </div>
                <Autocomplete.List className="min-h-0 overflow-y-auto overscroll-contain scroll-py-1 p-1">
                  {(item: FooterMenuItem, index: number) => {
                    const key = item.id ?? item.label;
                    const armed = armedId === key;
                    return (
                      <Fragment key={key}>
                        {sectionFirstKeys.has(key) ? (
                          <div
                            aria-hidden
                            className={cn(
                              "px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle",
                              index === 0 ? "pt-1" : "pt-3",
                            )}
                          >
                            {item.section}
                          </div>
                        ) : (
                          item.separator &&
                          index !== 0 && (
                            <div
                              aria-hidden
                              className="my-1 border-t border-border"
                            />
                          )
                        )}
                        <Autocomplete.Item
                          value={item}
                          disabled={item.disabled}
                          onClick={(event) => {
                            // Only a hit that actually ran the action, and wants
                            // the popup closed, may go on to Base UI's own item
                            // press: it selects the item — closing the popup and
                            // writing the label into the search box — which would
                            // disarm a confirm before its second hit, close the
                            // menu on a disabled row, or close a `keepOpen` row
                            // before its own `onSelect` has anything to show. (↵
                            // on a highlighted row arrives here as a click too.)
                            const result = choose(item);
                            if (result !== "ran" || item.keepOpen)
                              event.preventBaseUIHandler();
                          }}
                          className={cn(
                            "flex w-full cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 text-sm outline-none",
                            armed
                              ? "bg-red-500/25 text-red-300 ring-1 ring-inset ring-red-500/40"
                              : item.danger
                                ? "text-red-400/90 data-highlighted:bg-red-500/15 data-highlighted:text-red-300"
                                : "data-highlighted:bg-item-selected data-highlighted:text-foreground",
                            item.disabled && "opacity-40",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {item.icon &&
                              (iconSrc(item.icon) ? (
                                <img
                                  src={iconSrc(item.icon)}
                                  alt=""
                                  className="h-4 w-4 shrink-0 object-contain"
                                />
                              ) : (
                                <span className="w-4 shrink-0 text-center text-[13px]">
                                  {item.icon}
                                </span>
                              ))}
                            <span className="truncate">
                              {armed && item.confirmLabel
                                ? item.confirmLabel
                                : item.label}
                            </span>
                          </span>
                          {item.shortcut ? (
                            <Kbd
                              accelerator={item.shortcut}
                              className="border-border"
                            />
                          ) : (
                            item.hint && (
                              <span className="shrink-0 truncate text-xs text-foreground-subtle">
                                {item.hint}
                              </span>
                            )
                          )}
                        </Autocomplete.Item>
                      </Fragment>
                    );
                  }}
                </Autocomplete.List>
                <Autocomplete.Empty className="shrink-0 px-2 py-1.5 text-xs text-foreground-subtle">
                  No actions found
                </Autocomplete.Empty>
              </>
            )}
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}

export const Footer = Object.assign(FooterRoot, {
  Left,
  Right,
  Button,
  Label,
  Menu,
});
