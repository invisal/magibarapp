import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cnfast";
import { ListScreen, type FooterMenuItem } from "@renderer/shared/ui";
import { isMac } from "@renderer/lib/shortcut";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { formatCpu, formatMemory } from "../shared/format";
import {
  arrange,
  buildItems,
  matchesPort,
  type ProcessItem,
  type SortBy,
} from "../shared/items";
import type { ProcessRow } from "../shared/types";

/** How often an unforced refresh may reorder the list. */
const RESORT_INTERVAL_MS = 10_000;

/**
 * The header segmented control: switches the list's sort order and which
 * metric each row shows on its right. Rendered via `ListScreen`'s `inputSuffix`
 * slot — "after the search input," on the right edge of the header row — a
 * pill-shaped segmented group styled after macOS Activity Monitor's own
 * CPU/Memory/Energy/Disk/Network tab bar (a rounded-full track with a
 * rounded-full "thumb" behind whichever segment is active).
 */
function SortToggle({
  sortBy,
  onChange,
}: {
  sortBy: SortBy;
  onChange: (value: SortBy) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-item-hover/60 p-0.5 [-webkit-app-region:no-drag]">
      {(
        [
          { key: "cpu", label: "CPU" },
          { key: "memory", label: "Memory" },
        ] as const
      ).map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={sortBy === key}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            sortBy === key
              ? "bg-item-selected text-foreground"
              : "text-foreground-subtle hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A row with no resolvable icon (most non-app processes — see `main/icon.ts`),
 *  styled after Activity Monitor's own dashed placeholder square rather than
 *  a filled/emoji icon that would read as "this has an icon" at a glance. */
function PlaceholderIcon() {
  return (
    <div
      aria-hidden
      className="h-5 w-5 rounded-[5px] border border-dashed border-foreground-subtle/40"
    />
  );
}

/**
 * Activity Monitor's process list, as a screen pushed onto the launcher's
 * navigation stack. Built on the shared `ListScreen` (search, highlight,
 * Escape, ⌘K menu) plus the CPU/Memory sort toggle above.
 *
 * The list is live, so three things keep the row you're acting on from
 * sliding out from under you:
 * - the selection is a stable item id (`ProcessItem.id`), not Base UI's
 *   index-based cursor, and the menu/shortcuts act on *that* item;
 * - between explicit re-sorts (the toggle, Reload, or the selection sitting
 *   on the first row) the order holds still — values update in place, see
 *   `arrange`;
 * - while the ⌘K menu is open, incoming snapshots are held back entirely.
 *
 * Hiding the launcher window leaves this screen: `hideLauncher()` never
 * touches the route stack, so without this the launcher would reopen on Quit
 * Processes instead of the main search. Electron gives a hidden
 * `BrowserWindow`'s page the same `document.visibilitychange` a backgrounded
 * browser tab gets, which is what triggers `onWindowHidden` (and stops the
 * background poller, `main/poller.ts`, which only runs while this screen is
 * open — a route that's still on the stack keeps its effects alive in a
 * hidden `<Activity>`, see `router/Outlet.tsx`, so unmounting is not
 * something to count on when only the window goes away).
 *
 * Knows nothing about the router: navigation is handed in by `../screen.tsx`.
 */
function QuitProcessListScreen({
  onWindowHidden,
}: {
  /** The launcher window was hidden — leave this screen (back to the root
   *  search), so it doesn't reopen on Quit Processes. */
  onWindowHidden: () => void;
}) {
  const onWindowHiddenRef = useRef(onWindowHidden);
  onWindowHiddenRef.current = onWindowHidden;
  const [rawRows, setRawRows] = useState<ProcessRow[] | null>(null);
  const [items, setItems] = useState<ProcessItem[] | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("cpu");
  const [groupApps, setGroupApps] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const menuOpenRef = useRef(false);
  const pendingRowsRef = useRef<ProcessRow[] | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const lastIndexRef = useRef(0);
  const lastKeyRef = useRef("");
  const lastSortAtRef = useRef(0);
  const firstLiveResortRef = useRef(false);

  /** Applies a snapshot — or, while the menu is open, holds it for when it closes. */
  const receive = useCallback((rows: ProcessRow[]) => {
    if (menuOpenRef.current) pendingRowsRef.current = rows;
    else setRawRows(rows);
  }, []);

  const reload = useCallback(() => {
    void window.api.quitProcess.list().then(receive);
  }, [receive]);

  // The poller only runs while this screen is open — started/stopped here
  // rather than at extension `init()`, unlike clipboard history's poller,
  // which has to watch continuously in the background.
  useEffect(() => {
    void window.api.quitProcess.start();
    function handleVisibilityChange(): void {
      if (!document.hidden) return;
      void window.api.quitProcess.stop();
      onWindowHiddenRef.current();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void window.api.quitProcess.stop();
    };
  }, []);

  // Open instantly, without a loading state: on the previous visit's last
  // snapshot when there is one (its order is already roughly right, and the
  // first live snapshot only updates values in place), else on a direct read
  // and one forced re-rank when the first warmed-up snapshot lands (a
  // never-primed read has no CPU% to rank by).
  useEffect(() => {
    let cancelled = false;
    void window.api.quitProcess.snapshot().then(async (cached) => {
      const rows = cached ?? (await window.api.quitProcess.list());
      if (cancelled) return;
      if (!cached) firstLiveResortRef.current = true;
      receive(rows);
    });
    const unsubscribe = window.api.quitProcess.onUpdated((rows) => {
      if (firstLiveResortRef.current) {
        firstLiveResortRef.current = false;
        setReloadNonce((n) => n + 1);
      }
      receive(rows);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [receive]);

  // Turns snapshots into the displayed order. A full re-sort only when asked
  // for (sort/group toggle, Reload) or when nothing below the top is selected
  // — otherwise `arrange` keeps every row where it was.
  useEffect(() => {
    if (!rawRows) return;
    const key = `${sortBy}|${groupApps}|${reloadNonce}`;
    const forced = key !== lastKeyRef.current;
    lastKeyRef.current = key;
    const fresh = buildItems(rawRows, groupApps);
    setItems((prev) => {
      const atTop =
        selectedIdRef.current === null ||
        prev?.[0]?.id === selectedIdRef.current;
      // Even with nothing selected, re-rank at most every RESORT_INTERVAL_MS —
      // CPU% jitters every tick, and re-sorting on each one shuffles rows.
      const due = Date.now() - lastSortAtRef.current >= RESORT_INTERVAL_MS;
      const resort = !prev || forced || (atTop && due);
      if (resort) lastSortAtRef.current = Date.now();
      return arrange(prev, fresh, sortBy, resort);
    });
  }, [rawRows, sortBy, groupApps, reloadNonce]);

  // A message (permission denied, copied) auto-clears after a few seconds,
  // same as `Footer.Menu`'s own armed-confirm timeout.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const visible = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return q
      ? items.filter(
          (i) => i.name.toLowerCase().includes(q) || matchesPort(i, q),
        )
      : items;
  }, [items, query]);

  // The item every action targets: the remembered one if it's still listed,
  // else whatever now sits where it was (a killed row hands the selection to
  // its neighbour rather than jumping to the top).
  const selected = useMemo(() => {
    if (!visible || visible.length === 0) return null;
    return (
      visible.find((i) => i.id === selectedId) ??
      visible[Math.min(lastIndexRef.current, visible.length - 1)]
    );
  }, [visible, selectedId]);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    const index = visible?.findIndex((i) => i.id === selected?.id) ?? -1;
    if (index >= 0) lastIndexRef.current = index;
  }, [selected, visible]);

  function handleMenuOpenChange(open: boolean): void {
    menuOpenRef.current = open;
    if (!open && pendingRowsRef.current) {
      setRawRows(pendingRowsRef.current);
      pendingRowsRef.current = null;
    }
  }

  async function kill(
    item: ProcessItem,
    { all, force }: { all: boolean; force: boolean },
  ): Promise<void> {
    const ok = await window.api.quitProcess.kill(
      all ? item.pids : [item.mainPid],
      force,
    );
    setMessage(
      ok
        ? null
        : `Couldn't ${force ? "force quit" : "quit"} "${item.name}" — permission denied`,
    );
    reload();
  }

  async function restart(item: ProcessItem, force: boolean): Promise<void> {
    const ok = await window.api.quitProcess.restart(
      item.mainPid,
      item.pids,
      force,
    );
    setMessage(ok ? null : `Couldn't restart "${item.name}"`);
    reload();
  }

  function copyPath(item: ProcessItem): void {
    const path = item.appPath ?? item.path;
    if (!path) return;
    void navigator.clipboard.writeText(path);
    setMessage("Copied path");
  }

  function refresh(): void {
    setReloadNonce((n) => n + 1);
    reload();
  }

  const mac = isMac();
  const KEYS = {
    forceKill: "CommandOrControl+Enter",
    restart: "Alt+CommandOrControl+R",
    forceRestart: "Alt+Shift+CommandOrControl+R",
    killAll: "Alt+Enter",
    forceKillAll: "Alt+Shift+Enter",
    copyPath: mac ? "Control+Command+C" : "Control+Shift+C",
    reload: "CommandOrControl+R",
    toggleGrouping: "Shift+Tab",
  };

  // Chords act immediately (no arm-then-confirm, unlike the menu rows) — a
  // deliberate multi-key combo is confirmation enough, same as Raycast.
  const onSelected = (act: (item: ProcessItem) => void) => (): void => {
    if (selected) act(selected);
  };
  const canRestart = !!selected?.appPath;
  const canKillAll = (selected?.pids.length ?? 0) > 1;
  const canCopyPath = !!(selected?.appPath ?? selected?.path);

  useShortcut(
    {
      [KEYS.forceKill]: onSelected(
        (i) => void kill(i, { all: false, force: true }),
      ),
      [KEYS.restart]: canRestart && onSelected((i) => void restart(i, false)),
      [KEYS.forceRestart]:
        canRestart && onSelected((i) => void restart(i, true)),
      [KEYS.killAll]:
        canKillAll &&
        onSelected((i) => void kill(i, { all: true, force: false })),
      [KEYS.forceKillAll]:
        canKillAll &&
        onSelected((i) => void kill(i, { all: true, force: true })),
      [KEYS.copyPath]: canCopyPath && onSelected(copyPath),
      [KEYS.reload]: refresh,
      [KEYS.toggleGrouping]: () => setGroupApps((on) => !on),
    },
    { capture: true },
  );

  const menu = (): FooterMenuItem[] => {
    const item = selected;
    if (!item) return [];
    const name = `"${item.name}"`;
    const entries: (FooterMenuItem | false)[] = [
      {
        id: `kill:${item.id}`,
        label: "Quit",
        icon: "⊗",
        confirmLabel: `Click again to quit ${name}`,
        danger: true,
        onSelect: () => void kill(item, { all: false, force: false }),
      },
      {
        id: `force-kill:${item.id}`,
        label: "Force Quit",
        icon: "⊗",
        shortcut: KEYS.forceKill,
        confirmLabel: `Click again to force quit ${name}`,
        danger: true,
        onSelect: () => void kill(item, { all: false, force: true }),
      },
      canRestart && {
        id: `restart:${item.id}`,
        label: "Restart",
        icon: "↻",
        shortcut: KEYS.restart,
        confirmLabel: `Click again to restart ${name}`,
        onSelect: () => void restart(item, false),
      },
      canRestart && {
        id: `force-restart:${item.id}`,
        label: "Force Restart",
        icon: "↻",
        shortcut: KEYS.forceRestart,
        confirmLabel: `Click again to force restart ${name}`,
        onSelect: () => void restart(item, true),
      },
      canKillAll && {
        id: `kill-all:${item.id}`,
        label: "Quit All",
        icon: "⊗",
        shortcut: KEYS.killAll,
        confirmLabel: `Click again to quit all ${item.pids.length} processes`,
        danger: true,
        onSelect: () => void kill(item, { all: true, force: false }),
      },
      canKillAll && {
        id: `force-kill-all:${item.id}`,
        label: "Force Quit All",
        icon: "⊗",
        shortcut: KEYS.forceKillAll,
        confirmLabel: `Click again to force quit all ${item.pids.length} processes`,
        danger: true,
        onSelect: () => void kill(item, { all: true, force: true }),
      },
      canCopyPath && {
        id: "copy-path",
        label: "Copy Path",
        icon: "⎘",
        shortcut: KEYS.copyPath,
        onSelect: () => copyPath(item),
      },
      {
        id: "reload",
        label: "Reload",
        icon: "⟳",
        shortcut: KEYS.reload,
        onSelect: refresh,
      },
      {
        id: "toggle-grouping",
        label: groupApps ? "Disable App Grouping" : "Enable App Grouping",
        icon: "▤",
        shortcut: KEYS.toggleGrouping,
        onSelect: () => setGroupApps((on) => !on),
      },
    ];
    return entries.filter((entry) => entry !== false);
  };

  return (
    <ListScreen
      data={visible}
      getId={(item) => item.id}
      serverFiltered
      inputValue={query}
      onInputChange={(value) => {
        setQuery(value);
        setSelectedId(null);
        lastIndexRef.current = 0;
      }}
      inputSuffix={<SortToggle sortBy={sortBy} onChange={setSortBy} />}
      placeholder="Search by name or port..."
      renderItem={(item) => (
        <ListScreen.Item
          highlighted={item.id === selected?.id}
          icon={item.icon ?? <PlaceholderIcon />}
          title={item.name}
          subtitle={
            item.pids.length > 1 ? `${item.pids.length} processes` : undefined
          }
          badge={
            sortBy === "cpu"
              ? formatCpu(item.cpuPercent)
              : formatMemory(item.memoryBytes)
          }
        />
      )}
      // The highlight that counts is the user's own move (keyboard, right
      // click) — Base UI also re-reports its index-based cursor whenever the
      // data changes ("none"), which would otherwise drag the selection onto
      // whatever now sits at that index.
      onHighlightChange={(item, reason) => {
        if (item && reason !== "none") setSelectedId(item.id);
      }}
      onActivate={(item) => setSelectedId(item.id)}
      onMenuOpenChange={handleMenuOpenChange}
      // Enter/click never kills — the actions live in the ⌘K / right-click
      // menu (each armed by a second press) and in their chords.
      menu={menu}
      footerLabel={() =>
        message ??
        (visible
          ? `${visible.length} Process${visible.length === 1 ? "" : "es"}`
          : undefined)
      }
      emptyLabel={query.trim() ? "No matching processes" : "No processes found"}
    />
  );
}

export default QuitProcessListScreen;
