import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListScreen, Footer } from "@renderer/shared/ui";
import type { FooterMenuItem } from "@renderer/shared/ui";
import { formatBytes } from "@extensions/clipboard-history/shared/format";
import {
  barSegments,
  findItem,
  pruneSelection,
  safeItemIds,
  selectedBytes,
} from "../shared/format";
import type { CleanCategory, CleanItem, ScanSnapshot } from "../shared/types";

/** How long the footer's "press again to delete" stays armed. */
const CONFIRM_MS = 4000;

/** One colour per category in the storage bar, keyed by category id. */
const SEGMENT_COLORS: Record<string, string> = {
  "derived-data": "#4c9bff",
  "device-support": "#a78bfa",
  archives: "#f5a25d",
  "documentation-cache": "#52c7a5",
  "old-logs": "#e6c15a",
  "other-caches": "#e2708f",
};

function segmentColor(id: string): string {
  return SEGMENT_COLORS[id] ?? "#8a8582";
}

function sizeLabel(bytes: number | null): string {
  return bytes == null ? "…" : formatBytes(bytes);
}

/** Items matching `query`, in category order so each category's run is contiguous for grouping. */
function matchingItems(
  categories: CleanCategory[],
  query: string,
): CleanItem[] {
  const q = query.trim().toLowerCase();
  return categories.flatMap((category) =>
    q
      ? category.items.filter((i) =>
          `${i.title} ${i.subtitle ?? ""} ${i.path}`.toLowerCase().includes(q),
        )
      : category.items,
  );
}

function Checkbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={
        "grid h-4 w-4 place-items-center rounded border transition-colors " +
        (checked
          ? "border-transparent bg-[#4c9bff] text-white"
          : "border-foreground-subtle/60 hover:border-foreground")
      }
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path
            d="M2 5.2 4.2 7.4 8 2.8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

function SafetyTag({ safety }: { safety: CleanCategory["safety"] }) {
  const safe = safety === "safe";
  return (
    <span
      className={
        "rounded px-1.5 py-0.5 text-[11px] font-medium " +
        (safe
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-amber-500/15 text-amber-400")
      }
    >
      {safe ? "Safe to delete" : "Review first"}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6 py-0.5 text-xs">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className="min-w-0 break-all text-right">{value}</span>
    </div>
  );
}

/** Stacked bar of every category's share, with a legend. */
function StorageBreakdown({ categories }: { categories: CleanCategory[] }) {
  const segments = barSegments(categories);
  const total = categories.reduce((sum, c) => sum + c.bytes, 0);
  const pending = categories.some((c) => c.pending);
  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground-subtle">
          Xcode storage
        </span>
        <span className="text-lg font-semibold">
          {formatBytes(total)}
          {pending && <span className="text-foreground-subtle"> +</span>}
        </span>
      </div>
      <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-item-hover">
        {segments.map((s) => (
          <div
            key={s.id}
            title={`${s.title} · ${formatBytes(s.bytes)}`}
            style={{ width: `${s.percent}%`, background: segmentColor(s.id) }}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {categories.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: segmentColor(c.id) }}
            />
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="text-foreground-subtle">
              {sizeLabel(c.pending ? null : c.bytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemDetail({
  item,
  category,
}: {
  item: CleanItem;
  category: CleanCategory;
}) {
  return (
    <div className="border-t border-border p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {item.title}
        </span>
        <SafetyTag safety={category.safety} />
      </div>
      <p className="mb-3 text-xs leading-relaxed text-foreground-subtle">
        {category.consequence}
      </p>
      <InfoRow label="Size" value={sizeLabel(item.bytes)} />
      {item.fileCount > 0 && (
        <InfoRow label="Files" value={item.fileCount.toLocaleString()} />
      )}
      {item.modifiedAt > 0 && (
        <InfoRow
          label="Last used"
          value={new Date(item.modifiedAt).toLocaleString()}
        />
      )}
      {item.subtitle && (
        <InfoRow
          label={category.id === "derived-data" ? "Project" : "Source"}
          value={item.subtitle}
        />
      )}
      <InfoRow label="Path" value={item.path} />
    </div>
  );
}

/**
 * The Clean Xcode screen, pushed onto the launcher's stack. Same shape as
 * Clipboard History — grouped list on the left, detail pane on the
 * right — but each row is a checkbox: tick what to delete, then clean the lot
 * in one confirmed step. The detail pane pairs a storage breakdown of every
 * category with what deleting the highlighted item would cost.
 *
 * Keys: Enter ticks/unticks the highlighted row, ⌘Enter (Ctrl+Enter elsewhere)
 * cleans the ticked rows. Knows nothing about the router; `../screen.tsx`
 * mounts it.
 */
function XcodeCleanScreen() {
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  // Tracked here rather than trusted from `ListScreen`'s highlight — see the
  // same note in `ClipboardHistoryListScreen`.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categories = snapshot?.categories ?? null;

  const applySnapshot = useCallback((next: ScanSnapshot) => {
    setSnapshot(next);
    setSelected((prev) => pruneSelection(next.categories, prev));
  }, []);

  const rescan = useCallback(() => {
    void window.api.xcodeClean.scan().then(applySnapshot);
  }, [applySnapshot]);

  // Subscribe before scanning so no size update lands in the gap.
  useEffect(() => {
    const off = window.api.xcodeClean.onUpdated(applySnapshot);
    rescan();
    return off;
  }, [applySnapshot, rescan]);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const items = useMemo(
    () => (categories ? matchingItems(categories, query) : null),
    [categories, query],
  );
  const itemCount = items?.length ?? 0;

  const focused =
    (categories && focusedId && findItem(categories, focusedId)) ||
    (items?.[0] ?? null);
  const focusedCategory =
    focused && categories?.find((c) => c.id === focused.categoryId);

  const chosenBytes = categories ? selectedBytes(categories, selected) : 0;

  function toggle(id: string): void {
    setNotice(null);
    setArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function setCategory(category: CleanCategory, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of category.items) {
        if (on) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  async function clean(ids: string[]): Promise<void> {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setArmed(false);
    try {
      const result = await window.api.xcodeClean.clean(ids);
      setSelected(new Set());
      setNotice(
        result.failed.length
          ? `Freed ${formatBytes(result.freedBytes)} · ${result.failed.length} couldn't be deleted`
          : `Freed ${formatBytes(result.freedBytes)}`,
      );
      rescan();
    } finally {
      setBusy(false);
    }
  }

  /** The footer button / ⌘Enter: first press arms, second deletes. */
  function cleanSelected(): void {
    if (selected.size === 0) return;
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), CONFIRM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    void clean([...selected]);
  }

  const menu = (): FooterMenuItem[] => {
    if (!categories) return [];
    const items: FooterMenuItem[] = [];
    if (selected.size > 0) {
      items.push({
        id: "clean-selected",
        label: `Clean Selected (${formatBytes(chosenBytes)})`,
        confirmLabel: `Delete ${selected.size} item${selected.size === 1 ? "" : "s"} (${formatBytes(chosenBytes)})? Select again`,
        danger: true,
        section: "Clean",
        onSelect: () => void clean([...selected]),
      });
    }
    if (focused) {
      const item = focused;
      items.push(
        {
          id: "toggle",
          label: selected.has(item.id) ? "Deselect" : "Select",
          shortcut: "Enter",
          section: "Selection",
          onSelect: () => toggle(item.id),
        },
        ...(focusedCategory
          ? [
              {
                id: "select-category",
                label: `Select All in ${focusedCategory.title}`,
                section: "Selection",
                onSelect: () => setCategory(focusedCategory, true),
              },
            ]
          : []),
      );
    }
    items.push(
      {
        id: "select-safe",
        label: "Select All Safe Items",
        section: "Selection",
        onSelect: () => setSelected(new Set(safeItemIds(categories))),
      },
      {
        id: "deselect",
        label: "Deselect All",
        disabled: selected.size === 0,
        section: "Selection",
        onSelect: () => setSelected(new Set()),
      },
    );
    if (focused) {
      const item = focused;
      items.push({
        id: "reveal",
        label: "Reveal in Finder",
        section: "Item",
        onSelect: () => void window.api.xcodeClean.reveal(item.id),
      });
    }
    items.push({
      id: "rescan",
      label: "Rescan",
      section: "Item",
      onSelect: rescan,
    });
    return items;
  };

  const total = categories?.reduce((sum, c) => sum + c.bytes, 0) ?? 0;

  return (
    <ListScreen
      data={items}
      getId={(item) => item.id}
      getGroup={(item) => item.categoryId}
      renderGroupLabel={(id) => {
        const category = categories?.find((c) => c.id === id);
        if (!category) return id;
        return (
          <span className="flex items-center justify-between">
            <span>
              {category.glyph} {category.title}
            </span>
            <span>
              {category.pending ? "Calculating…" : formatBytes(category.bytes)}
            </span>
          </span>
        );
      }}
      inputValue={query}
      onInputChange={setQuery}
      serverFiltered
      placeholder="Search Xcode caches..."
      renderItem={(item) => (
        <ListScreen.Item
          highlighted={item.id === focused?.id}
          icon={
            <Checkbox
              checked={selected.has(item.id)}
              onToggle={() => toggle(item.id)}
            />
          }
          title={item.title}
          badge={sizeLabel(item.bytes)}
          onDoubleClick={() => toggle(item.id)}
        />
      )}
      // A plain click only focuses the row; Enter (handled in `onInputKeyDown`,
      // where Base UI's synthetic click for it stays inert) ticks it.
      onActivate={(item) => setFocusedId(item.id)}
      onInputKeyDown={(e, item) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) cleanSelected();
        else if (item) toggle(item.id);
      }}
      onHighlightChange={(item) => {
        if (item) setFocusedId(item.id);
      }}
      menu={menu}
      detail={() =>
        categories && categories.length > 0 ? (
          <div className="flex h-full flex-col">
            <StorageBreakdown categories={categories} />
            {focused && focusedCategory && (
              <ItemDetail item={focused} category={focusedCategory} />
            )}
          </div>
        ) : null
      }
      customFooter={
        categories && categories.length > 0 ? (
          <>
            <Footer.Label>
              {notice ??
                (snapshot?.xcodeRunning && selected.size > 0
                  ? "Xcode is running — quit it for a complete clean"
                  : selected.size > 0
                    ? `${selected.size} selected · ${formatBytes(chosenBytes)}`
                    : `${itemCount} Item${itemCount === 1 ? "" : "s"} · ${formatBytes(total)}`)}
            </Footer.Label>
            {selected.size > 0 && (
              <Footer.Button
                variant="primary"
                shortcut="CommandOrControl+Enter"
                loading={busy}
                loadingLabel="Cleaning…"
                onClick={cleanSelected}
                className={armed ? "text-red-400" : undefined}
              >
                {armed
                  ? `Press again to delete ${formatBytes(chosenBytes)}`
                  : `Clean ${formatBytes(chosenBytes)}`}
              </Footer.Button>
            )}
          </>
        ) : undefined
      }
      loadingLabel="Scanning Xcode folders…"
      emptyLabel={
        query.trim()
          ? "No matching folders"
          : "Nothing to clean — no Xcode caches found."
      }
    />
  );
}

export default XcodeCleanScreen;
