import { useCallback, useEffect, useMemo, useState } from "react";
import { ListScreen } from "@renderer/shared/ui";
import type { FooterMenuItem } from "@renderer/shared/ui";
import {
  absoluteTime,
  dataUrlByteSize,
  formatBytes,
  groupLabel,
  textByteSize,
} from "../shared/format";
import type { ClipboardEntry } from "../shared/types";

/**
 * The section an entry sits under: "Pinned", else its calendar day. The
 * store's order (pinned first, then newest first) already keeps each
 * section contiguous.
 */
function sectionOf(entry: ClipboardEntry, now: number): string {
  return entry.pinned ? "Pinned" : groupLabel(entry.createdAt, now);
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6 py-0.5 text-xs">
      <span className="text-foreground-subtle">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

/** Like `InfoRow`, but the value is an app name with its icon in front. */
function SourceAppRow({ name, icon }: { name: string; icon?: string }) {
  return (
    <div className="flex justify-between gap-6 py-0.5 text-xs">
      <span className="text-foreground-subtle">Source</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {icon && (
          <img src={icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
        )}
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}

/** The right-hand preview pane: full content up top, metadata below. */
function DetailPane({ entry }: { entry: ClipboardEntry | null }) {
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground-subtle">
        No item selected
      </div>
    );
  }

  // Prefer the byte size of what was actually captured (the source file, or
  // the raw clipboard bytes) over the size of our downsized/re-encoded copy
  // — falls back to measuring the stored copy for entries recorded before
  // `originalBytes` existed.
  const size =
    entry.contentType === "image"
      ? (entry.originalBytes ??
        (entry.imageDataUrl ? dataUrlByteSize(entry.imageDataUrl) : 0))
      : textByteSize(entry.text ?? "");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        {entry.contentType === "image" ? (
          <img
            src={entry.imageDataUrl}
            alt=""
            className="max-h-full max-w-full rounded object-contain"
          />
        ) : (
          <pre className="max-h-full w-full overflow-auto whitespace-pre-wrap wrap-break-word text-sm">
            {entry.text}
          </pre>
        )}
      </div>
      <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border p-3">
        <div className="mb-1 text-xs font-medium">Information</div>
        {entry.sourceApp && (
          <SourceAppRow
            name={entry.sourceApp.name}
            icon={entry.sourceApp.icon}
          />
        )}
        <InfoRow
          label="Type"
          value={entry.contentType === "image" ? "Image" : "Text"}
        />
        {entry.contentType === "image" && entry.imageSize && (
          <InfoRow
            label="Dimensions"
            value={`${entry.imageSize.width}×${entry.imageSize.height}`}
          />
        )}
        <InfoRow label="Size" value={formatBytes(size)} />
        {entry.contentType === "image" && entry.sourcePath && (
          <InfoRow label="Path" value={entry.sourcePath} />
        )}
        <InfoRow label="Copied" value={absoluteTime(entry.createdAt)} />
      </div>
    </div>
  );
}

/**
 * The Clipboard History list, as a screen pushed onto the launcher's
 * navigation stack. Built on the shared `ListScreen` (search, highlight,
 * Escape, ⌘K menu), Raycast-style: a grouped list on the left
 * (`detail`'s left column) and a full-content preview + metadata pane on the
 * right, synced to the highlighted row.
 *
 * The query is controlled here (rather than left to `ListScreen`'s default
 * internal state) so the empty message can tell "no history" from "no
 * match"; `ListScreen` drops a section heading once none of its rows match.
 *
 * Knows nothing about the router; `../screen.tsx` mounts it.
 */
function ClipboardHistoryListScreen() {
  const [entries, setEntries] = useState<ClipboardEntry[] | null>(null);
  const [pinLimitHit, setPinLimitHit] = useState(false);
  const [query, setQuery] = useState("");
  // The previewed/menu-target entry, tracked here rather than trusted from
  // `ListScreen`'s own highlight state: a plain click routes through Base
  // UI's "commit selection" handling (distinct from the keyboard-highlight
  // path), which can momentarily clear the highlight right after — see
  // `onHighlightChange` below for how this stays correct across keyboard
  // nav, click and right-click regardless.
  const [selectedEntry, setSelectedEntry] = useState<ClipboardEntry | null>(
    null,
  );

  const reload = useCallback(() => {
    void window.api.clipboardHistory.list().then(setEntries);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // The poller records new entries in the background regardless of whether
  // this screen is open — without this, a copy made while already viewing
  // the list only shows up after leaving and re-entering the screen.
  useEffect(() => {
    return window.api.clipboardHistory.onUpdated(reload);
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries ?? [];
    return (entries ?? []).filter((e) => e.preview.toLowerCase().includes(q));
  }, [entries, query]);

  // Fixed per data load, so a section label can't flip mid-list at midnight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [entries]);

  // Keeps `selectedEntry` valid whenever `filtered` changes: falls back to
  // the first entry when nothing's selected yet (belt-and-suspenders —
  // `onHighlightChange` should already set this from `ListScreen`'s own
  // auto-highlight on mount, but doesn't depend on it) or the selected one
  // was deleted, and refreshes it to the current object (e.g. after a pin
  // toggle) when it's still present. Deliberately keyed on `filtered`
  // alone — it reads `selectedEntry`'s latest value each time it *does*
  // run, but re-running on every selection change too would be redundant.
  useEffect(() => {
    const stillPresent = selectedEntry
      ? (filtered.find((e) => e.id === selectedEntry.id) ?? null)
      : null;
    if (stillPresent !== selectedEntry) {
      setSelectedEntry(stillPresent ?? filtered[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  async function copyAgain(entry: ClipboardEntry): Promise<void> {
    await window.api.clipboardHistory.copyAgain(entry.id);
  }

  async function paste(entry: ClipboardEntry): Promise<void> {
    // Main hides the launcher; the route stack is left alone so reopening
    // lands back on this screen.
    await window.api.clipboardHistory.paste(entry.id);
  }

  async function togglePin(entry: ClipboardEntry): Promise<void> {
    const ok = await window.api.clipboardHistory.setPinned(
      entry.id,
      !entry.pinned,
    );
    setPinLimitHit(!ok);
    reload();
  }

  async function remove(entry: ClipboardEntry): Promise<void> {
    await window.api.clipboardHistory.delete(entry.id);
    reload();
  }

  async function clearAll(): Promise<void> {
    await window.api.clipboardHistory.clear();
    reload();
  }

  const menu = (): FooterMenuItem[] => {
    const clearItem: FooterMenuItem = {
      id: "clear",
      label: "Clear History",
      confirmLabel: "Clear all unpinned entries? Select again",
      danger: true,
      section: "History",
      onSelect: () => void clearAll(),
    };
    const entry = selectedEntry;
    if (!entry) return filtered.length ? [clearItem] : [];
    return [
      {
        id: "copy-again",
        label: "Copy Again",
        onSelect: () => void copyAgain(entry),
      },
      {
        id: "paste",
        label: "Paste",
        shortcut: "Enter",
        onSelect: () => void paste(entry),
      },
      {
        id: "pin",
        label: entry.pinned ? "Unpin" : "Pin",
        onSelect: () => void togglePin(entry),
      },
      {
        id: "delete",
        label: "Delete Entry",
        confirmLabel: "Delete this entry? Select again",
        danger: true,
        section: "History",
        onSelect: () => void remove(entry),
      },
      clearItem,
    ];
  };

  return (
    <ListScreen
      data={entries == null ? null : filtered}
      getId={(entry) => entry.id}
      getGroup={(entry) => sectionOf(entry, now)}
      inputValue={query}
      onInputChange={setQuery}
      serverFiltered
      placeholder="Search clipboard history..."
      renderItem={(entry) => (
        <ListScreen.Item
          // Driven by `selectedEntry`, not Base UI's own per-item
          // highlight state — those two can diverge right after a click
          // (see the note on `onActivate` below), and the row that's
          // visually marked "active" should always be the exact one the
          // detail pane is previewing, never out of sync with it.
          highlighted={entry.id === selectedEntry?.id}
          icon={
            entry.contentType === "image"
              ? entry.imageDataUrl
              : entry.pinned
                ? "📌"
                : "📋"
          }
          title={entry.preview}
          onDoubleClick={() => void paste(entry)}
        />
      )}
      // Keyboard nav, right-click and Base UI's own auto-highlight all keep
      // `selectedEntry` in sync via `onHighlightChange` below. A plain click
      // only selects the row (so the preview shows); Enter (handled in
      // `onInputKeyDown`, not here — Base UI also turns it into a synthetic
      // click, which must stay inert) or a double-click (`onDoubleClick` on
      // the row) pastes it into the app underneath.
      onActivate={(entry) => setSelectedEntry(entry)}
      onInputKeyDown={(e, entry) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        if (!entry) return;
        e.preventDefault();
        void paste(entry);
      }}
      onHighlightChange={(entry) => {
        if (entry) setSelectedEntry(entry);
      }}
      menu={menu}
      detail={() => <DetailPane entry={selectedEntry} />}
      footerLabel={() =>
        pinLimitHit
          ? "Pin limit reached — unpin one first"
          : `${filtered.length} Item${filtered.length === 1 ? "" : "s"}`
      }
      // `serverFiltered` means `visible` is always exactly `data` — `ListScreen`
      // can no longer tell "no history at all" apart from "this query matched
      // nothing" on its own (both collapse to `data.length === 0`), since the
      // filtering that distinction relies on already happened above, in
      // `filtered`. Pick the right message here instead.
      emptyLabel={
        query.trim()
          ? "No matching entries"
          : "No clipboard history yet. Copy some text or an image to save it here."
      }
    />
  );
}

export default ClipboardHistoryListScreen;
