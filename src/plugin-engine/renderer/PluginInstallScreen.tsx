/**
 * "Search Raycast Store" — search-as-you-type against the Raycast Store
 * (see `install/store.ts`), Enter to install. Every Store extension ships
 * prebuilt, so an install is a download + extract, usually a few seconds.
 *
 * Also the entry point for the source-build fallback: typing a GitHub
 * folder URL (`github.com/<owner>/<repo>/tree/<ref>/<path>` or
 * `owner/repo/path`) or an absolute folder path offers an "Install from…"
 * row instead of Store results. (A raycast/extensions link still installs
 * from the Store — see `install.ts`'s `normalizeSource`.)
 *
 * Master/detail, like Clipboard History: results on the left, the
 * selected extension's details on the right (`StoreDetailPane`). Clicking
 * a row only selects it; installing is the pane's Install button, or Enter.
 *
 * Registered as a core route (`"plugin-install"`) in `router/Outlet.tsx`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListScreen } from "@renderer/shared/ui/ListScreen";
import { Detail } from "@renderer/shared/ui/Detail";
import {
  formatCount,
  InstallButton,
  StoreDetailPane,
  type InstallAction,
} from "./StoreDetailPane";
import type { FooterMenuItem } from "@renderer/shared/ui/Footer";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import type {
  InstallSourceInput,
  StoreExtensionSearchResult,
} from "@plugin-engine/host/protocol";

const SEARCH_DEBOUNCE_MS = 300;

type Row =
  | { kind: "store"; id: string; result: StoreExtensionSearchResult }
  | { kind: "source"; id: string; source: InstallSourceInput; label: string };

type Status =
  | { state: "idle" }
  | { state: "installing"; rowId: string; message: string }
  | { state: "error"; rowId: string; message: string }
  | { state: "installed"; rowId: string; title: string };

type TypedSource = Extract<InstallSourceInput, { kind: "github" | "local" }>;

/** A typed GitHub link / folder path, if the query is one. */
export function sourceFromQuery(query: string): TypedSource | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (/^(\/|~\/|[a-zA-Z]:\\)/.test(trimmed))
    return { kind: "local", path: trimmed };
  if (/github\.com\//i.test(trimmed)) return { kind: "github", url: trimmed };
  if (/^[\w.-]+\/[\w.-]+\/[^\s]+$/.test(trimmed) && !trimmed.includes(" ")) {
    return { kind: "github", url: trimmed };
  }
  return null;
}

/** Whether Magibar can run any of its commands — a menu-bar-only
 *  extension can't. A listing without commands gets the benefit of the
 *  doubt (the install itself checks). */
function hasRunnableCommand(result: StoreExtensionSearchResult): boolean {
  return (
    result.commands.length === 0 || result.commands.some((c) => c.supported)
  );
}

function RowIcon({ src }: { src: string | null }): ReactNode {
  return src ? (
    <img src={src} alt="" className="h-6 w-6 rounded object-contain" />
  ) : (
    <span className="grid h-6 w-6 place-items-center text-base">🧩</span>
  );
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn";
}) {
  const color =
    tone === "ok"
      ? "text-green-500"
      : tone === "warn"
        ? "text-amber-500"
        : "text-foreground-subtle";
  return <span className={`text-xs ${color}`}>{children}</span>;
}

export function PluginInstallScreen(): ReactNode {
  const { pop, replace } = useRouteStack();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StoreExtensionSearchResult[] | null>(
    [],
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  // The row shown in the pane — tracked here rather than read from
  // `ListScreen`'s highlight, which a plain click can momentarily clear
  // (same approach as Clipboard History).
  const [selected, setSelected] = useState<Row | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Memoized: `rows` (and the selection effect keyed on it) must only
  // change with the query — a fresh object every render re-selected the
  // typed-source row forever ("Maximum update depth exceeded").
  const typedSource = useMemo(() => sourceFromQuery(query), [query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || typedSource) {
      setResults([]);
      setSearchError(null);
      return;
    }
    let live = true;
    setResults(null);
    const timer = setTimeout(() => {
      void window.api.pluginEngine.searchStore(trimmed).then((response) => {
        if (!live) return;
        if (response.ok) {
          setResults(response.results);
          setSearchError(null);
        } else {
          setResults([]);
          setSearchError(response.error);
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `typedSource` is derived from `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const rows = useMemo<Row[] | null>(() => {
    if (typedSource) {
      const label =
        typedSource.kind === "local"
          ? `Install from folder: ${typedSource.path}`
          : `Install from GitHub: ${typedSource.url}`;
      return [
        { kind: "source", id: "typed-source", source: typedSource, label },
      ];
    }
    if (results === null) return null;
    return results.map((result) => ({
      kind: "store",
      id: `${result.author}/${result.name}`,
      result,
    }));
  }, [typedSource, results]);

  // Keep `selected` pointing at a row that exists, and at its current
  // object (an install flips `installed`).
  useEffect(() => {
    const list = rows ?? [];
    const current = selected
      ? (list.find((r) => r.id === selected.id) ?? null)
      : null;
    // Falls back to the first row — also when nothing was selected yet
    // (Base UI's own auto-highlight is ignored, see `onHighlightChange`).
    const next = current ?? list[0] ?? null;
    if (next !== selected) setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function install(row: Row): Promise<void> {
    if (status.state === "installing") return;
    if (row.kind === "store" && !row.result.supported) {
      setStatus({
        state: "error",
        rowId: row.id,
        message: "Not available for this platform.",
      });
      return;
    }
    if (row.kind === "store" && !hasRunnableCommand(row.result)) {
      setStatus({
        state: "error",
        rowId: row.id,
        message: "None of its commands can run in Magibar (menu bar only).",
      });
      return;
    }
    const source: InstallSourceInput =
      row.kind === "store"
        ? { kind: "store", name: row.result.name, author: row.result.author }
        : row.source;
    const requestId = crypto.randomUUID();
    setStatus({ state: "installing", rowId: row.id, message: "Starting…" });
    const unsubscribe = window.api.pluginEngine.onInstallProgress(
      (progress) => {
        if (progress.requestId !== requestId) return;
        setStatus({
          state: "installing",
          rowId: row.id,
          message: progress.message,
        });
      },
    );
    try {
      const result = await window.api.pluginEngine.install(source, requestId);
      if (!result.ok) {
        setStatus({ state: "error", rowId: row.id, message: result.error });
        return;
      }
      if (result.needsPreferences) {
        replace({
          name: "plugin-preferences",
          payload: { pluginId: result.pluginId, justInstalled: true },
        });
        return;
      }
      setStatus({ state: "installed", rowId: row.id, title: result.title });
      if (row.kind === "store") {
        setResults(
          (current) =>
            current?.map((r) =>
              r.name === row.result.name && r.author === row.result.author
                ? { ...r, installed: true }
                : r,
            ) ?? current,
        );
      }
    } finally {
      unsubscribe();
    }
  }

  function statusFor(row: Row): ReactNode {
    if (status.state !== "idle" && status.rowId === row.id) {
      if (status.state === "installing") return <Badge>{status.message}</Badge>;
      if (status.state === "error") return <Badge tone="warn">Failed</Badge>;
      if (status.state === "installed")
        return <Badge tone="ok">Installed ✓</Badge>;
    }
    if (row.kind === "source") return null;
    const { result } = row;
    if (result.installed) return <Badge tone="ok">Installed</Badge>;
    if (!result.supported) {
      return (
        <Badge tone="warn">
          {result.platforms?.join(", ") ?? "macOS"} only
        </Badge>
      );
    }
    if (!hasRunnableCommand(result)) {
      return <Badge tone="warn">Not supported</Badge>;
    }
    return <Badge>↓ {formatCount(result.downloadCount)}</Badge>;
  }

  /** The pane's Status line: what's happening to this row, else whether
   *  it's installed. */
  function paneStatus(row: Row): ReactNode {
    if (status.state !== "idle" && status.rowId === row.id) {
      if (status.state === "installing") return status.message;
      if (status.state === "error") {
        return <span className="text-amber-500">{status.message}</span>;
      }
      return <span className="text-green-500">Installed</span>;
    }
    if (row.kind === "store" && row.result.installed) {
      return <span className="text-green-500">Installed</span>;
    }
    if (row.kind === "store" && !hasRunnableCommand(row.result)) {
      return (
        <span className="text-amber-500">
          Not supported — menu bar commands only
        </span>
      );
    }
    return undefined;
  }

  /** The pane's button for `row`: what Enter would do, or why it can't. */
  function installAction(row: Row): InstallAction {
    if (status.state === "installing") {
      return status.rowId === row.id
        ? { label: status.message, disabled: true }
        : { label: "Install", disabled: true };
    }
    if (row.kind === "store") {
      if (!row.result.supported || !hasRunnableCommand(row.result)) {
        return { label: "Not Supported", disabled: true };
      }
      if (row.result.installed) {
        return {
          label: "Reinstall",
          secondary: true,
          onClick: () => void install(row),
        };
      }
    }
    return { label: "Install", onClick: () => void install(row) };
  }

  const installActionRef = useRef(installAction);
  installActionRef.current = installAction;

  function detailPane(row: Row | null): ReactNode {
    if (row?.kind === "source") {
      return (
        <div className="h-full overflow-y-auto p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center text-3xl">
              📦
            </span>
            <div className="min-w-0 flex-1 text-xs">
              <div className="text-sm font-semibold break-all">
                {row.source.kind === "local" ? row.source.path : row.label}
              </div>
              <p className="mt-1.5 text-foreground-subtle">
                Built from source on install — needs Node.js/npm if it has
                dependencies.
              </p>
            </div>
            <InstallButton action={installAction(row)} />
          </div>
          <div className="mt-4">
            <Detail.Row label="Status" value={paneStatus(row)} />
            <Detail.Row
              label="Source"
              value={row.source.kind === "local" ? "Local folder" : "GitHub"}
            />
          </div>
        </div>
      );
    }
    return (
      <StoreDetailPane
        result={row?.result ?? null}
        status={row ? paneStatus(row) : undefined}
        action={row ? installAction(row) : { label: "Install", disabled: true }}
      />
    );
  }

  function menu(row: Row | null): FooterMenuItem[] {
    if (!row) return [];
    const items: FooterMenuItem[] = [
      {
        label:
          row.kind === "store" && row.result.installed
            ? "Reinstall / Update"
            : "Install",
        icon: "⬇️",
        onSelect: () => void install(row),
      },
    ];
    if (row.kind === "store") {
      items.push({
        label: "Open in Store",
        icon: "🌐",
        onSelect: () =>
          void window.api.pluginEngine.openStorePage(
            row.result.author,
            row.result.name,
          ),
      });
    }
    return items;
  }

  const footerLabel =
    status.state === "error"
      ? `⚠︎ ${status.message}`
      : status.state === "installing"
        ? status.message
        : status.state === "installed"
          ? `Installed ${status.title} — find its commands in the launcher`
          : searchError
            ? `⚠︎ ${searchError}`
            : "Store";

  return (
    <ListScreen<Row>
      data={rows}
      getId={(row) => row.id}
      serverFiltered
      inputValue={query}
      onInputChange={(value) => {
        setQuery(value);
        if (status.state === "error" || status.state === "installed") {
          setStatus({ state: "idle" });
        }
      }}
      placeholder="Search extensions, or paste a GitHub URL / folder path…"
      renderItem={(row) =>
        row.kind === "store" ? (
          <ListScreen.Item
            highlighted={row.id === selected?.id}
            icon={<RowIcon src={row.result.iconDataUri} />}
            title={row.result.title}
            badge={statusFor(row)}
          />
        ) : (
          <ListScreen.Item
            highlighted={row.id === selected?.id}
            icon={
              <span className="grid h-6 w-6 place-items-center text-base">
                📦
              </span>
            }
            title={row.label}
            badge={statusFor(row)}
          />
        )
      }
      // A click only selects the row (Base UI also turns Enter into a
      // synthetic click, so this must stay inert); Enter installs, in
      // `onInputKeyDown`, as does the pane's Install button.
      onActivate={(row) => setSelected(row)}
      // Only a user's own move counts: Base UI re-highlights the first row
      // on its own (reason "none") whenever the search box takes focus.
      onHighlightChange={(row, reason) => {
        if (row && reason !== "none") setSelected(row);
      }}
      // …and a click moves Base UI's highlight onto the clicked row, so
      // arrow keys carry on from there.
      highlightId={selected?.id}
      onInputKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        // Through a ref: Base UI keeps the first `onKeyDown` it was given,
        // so `selected` here would be the first render's (null).
        const row = selectedRef.current;
        if (row) installActionRef.current(row).onClick?.();
      }}
      detail={() => detailPane(selected)}
      menu={() => menu(selected)}
      onExit={pop}
      footerLabel={footerLabel}
      loadingLabel="Searching extensions…"
      emptyLabel={
        query.trim()
          ? searchError
            ? "Couldn't reach the Store."
            : "No extensions found."
          : "Type to search thousands of extensions."
      }
    />
  );
}
