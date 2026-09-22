import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { VersionStatus } from "./components/VersionStatus";
import type { OpenWithApp } from "@extensions/quicklink/shared/types";
import type { ActionHotkeyBinding } from "@extensions/hotkey/shared/types";
import type { Calculation, LauncherAction } from "../../../../shared/types";
import { Footer, ListScreen } from "@renderer/shared/ui";
import {
  clipboardText,
  type CopyKind,
} from "@extensions/calculator-history/shared/format";
import type { FooterMenuItem } from "@renderer/shared/ui";
import SearchItem from "./components/SearchItem";
import CalculatorPanel from "./components/CalculatorPanel";
import { buildContextMenu } from "./context-menu/registry";
import type { ContextMenuContext } from "./context-menu/types";
import { useLauncherHost } from "./host";
import { useRouteStack } from "./router/context";

type Row =
  | { key: string; kind: "calc"; calculation: Calculation }
  | { key: string; kind: "action"; action: LauncherAction };

/**
 * The launcher's search screen: the query input, the ranked result list, the
 * inline calculator panel and the Ctrl+K actions menu (the shared
 * `Footer.Menu`, built from `buildMenuActions`). It's the root entry of the
 * navigation stack (see `router/`), so its Effects — the focus trap, and the
 * ⌘K binding `Footer.Menu` owns — are torn down and re-mounted by `<Activity>`
 * whenever a screen is pushed over it or popped back off, with no manual
 * guarding here.
 */
function LauncherScreen() {
  const { query, setQuery, reloadNonce, reload } = useLauncherHost();
  const { push, reset } = useRouteStack();

  const [results, setResults] = useState<LauncherAction[]>([]);
  const [calculation, setCalculation] = useState<Calculation | null>(null);
  // One-shot "please force-refresh this row" signal for a `SearchItem` — not a
  // value store. SearchItem owns its own subtitle/loading state and fetches it
  // itself via `requestSubtitle`; this only tells the one row matching `id` to
  // re-call that (with `force: true`) after an out-of-band change like the row
  // menu's "Refresh". A fresh `token` on every trigger so re-refreshing the same
  // id still re-fires the matching SearchItem's effect.
  const [forceRefresh, setForceRefresh] = useState<{
    id: string;
    token: number;
  } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [apps, setApps] = useState<OpenWithApp[]>([]);
  /**
   * Argument mode — the Raycast-style chip. Tab on a row that `takesArgument`
   * locks it in: the search box stops being a search and becomes that action's
   * `{query}` value, so a quicklink no longer needs an alias to receive one.
   * `savedQuery` is the search text to restore when the chip is dismissed.
   */
  const [argumentMode, setArgumentMode] = useState<{
    action: LauncherAction;
    savedQuery: string;
  } | null>(null);
  /** Live "Open …" subtitle for the locked row, resolved in main. */
  const [argumentPreview, setArgumentPreview] = useState<string | null>(null);
  /** The values the locked quicklink wants, in order — the chip's prompt. */
  const [argumentNames, setArgumentNames] = useState<string[]>([]);

  const [actionHotkeys, setActionHotkeys] = useState<
    Record<string, ActionHotkeyBinding>
  >({});
  const refreshActionHotkeys = useCallback(() => {
    void window.api.actionHotkeys.list().then(setActionHotkeys);
  }, []);

  const [actionAliases, setActionAliases] = useState<Record<string, string>>(
    {},
  );
  const refreshActionAliases = useCallback(() => {
    void window.api.actionAliases.list().then(setActionAliases);
  }, []);

  async function togglePin(): Promise<void> {
    setPinned(await window.api.togglePin());
  }

  useEffect(() => {
    let live = true;
    void window.api.quicklink.openWithApps().then((list) => {
      if (live) setApps(list);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => refreshActionHotkeys(), [refreshActionHotkeys]);
  useEffect(() => refreshActionAliases(), [refreshActionAliases]);

  useEffect(() => {
    // In argument mode the box holds the argument, not a search — the list is
    // pinned to the one locked row, so there's nothing to re-rank.
    if (argumentMode) return;
    let cancelled = false;
    window.api.query(query).then((res) => {
      if (!cancelled) {
        setResults(res.result);
        setCalculation(res.calculation ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query, reloadNonce, argumentMode]);

  // Preview the URL the typed argument would open, so the row tracks the chip.
  useEffect(() => {
    if (!argumentMode) return;
    let live = true;
    void window.api.quicklink
      .preview(argumentMode.action.id, query)
      .then((subtitle) => {
        if (live) setArgumentPreview(subtitle);
      });
    return () => {
      live = false;
    };
  }, [argumentMode, query]);

  // What the chip asks for. A link can want several values ("org", "repo"),
  // and naming them is the only hint the user gets about what to type or in
  // which order — so this is fetched once per locked row, not per keystroke.
  useEffect(() => {
    if (!argumentMode) {
      setArgumentNames([]);
      return;
    }
    let live = true;
    void window.api.quicklink
      .argumentNames(argumentMode.action.id)
      .then((names) => {
        if (live) setArgumentNames(names);
      });
    return () => {
      live = false;
    };
  }, [argumentMode]);

  // The list feeds Base UI's Autocomplete (inside ListScreen): the
  // calculation, when present, is the first row, then the ranked actions.
  // Filtering/ranking stays in the main process — `serverFiltered` below.
  //
  // Deliberately depends only on `calculation`/`results`: a row's live subtitle
  // is fetched and held by its own `SearchItem` instance, not lifted up here —
  // see SearchItem.tsx. `rows` used to be rebuilt on every Widget value
  // push, which changed every row's identity; Autocomplete tracks the
  // highlighted item by identity in this `rows`/`items` array, so that churn
  // (which, since deferred rows fetch on mount, happened continuously while
  // scrolling) made it lose track and fall back to re-highlighting the first
  // row — which then yanked the list back to the top.
  const rows = useMemo<Row[]>(() => {
    if (argumentMode) {
      const { action } = argumentMode;
      return [
        {
          key: action.id,
          kind: "action",
          action: argumentPreview
            ? { ...action, subtitle: argumentPreview }
            : action,
        },
      ];
    }
    const list: Row[] = [];
    if (calculation) list.push({ key: "__calc__", kind: "calc", calculation });
    for (const action of results) {
      list.push({ key: action.id, kind: "action", action });
    }
    return list;
  }, [calculation, results, argumentMode, argumentPreview]);

  function dismiss(): void {
    setQuery("");
    setArgumentMode(null);
    setArgumentPreview(null);
    setArgumentNames([]);
    reset();
    if (!pinned) window.api.hide();
  }

  /** Tab — lock `action` in and hand the search box over to its argument. */
  function enterArgumentMode(action: LauncherAction): void {
    setArgumentMode({ action, savedQuery: query });
    setArgumentPreview(null);
    setQuery("");
  }

  /** Escape / Backspace on an empty chip — put the search query back. */
  function exitArgumentMode(mode: NonNullable<typeof argumentMode>): void {
    setQuery(mode.savedQuery);
    setArgumentMode(null);
    setArgumentPreview(null);
    setArgumentNames([]);
  }

  /**
   * Record `calc` in Calculator History. Only calculations the user *acts on*
   * (copies, feeds back in, pins) are recorded — never every keystroke.
   */
  function recordCalculation(calc: Calculation) {
    return window.api.calculatorHistory.record({
      query,
      expression: calc.expression,
      value: calc.value,
      rawValue: calc.rawValue,
    });
  }

  /** `↵` (formatted), `⌥↵` (unformatted) and `⇧⌘↵` (question & answer). */
  function copyCalculation(kind: CopyKind = "value"): void {
    if (!calculation) return;
    void navigator.clipboard.writeText(clipboardText(calculation, kind));
    void recordCalculation(calculation);
    dismiss();
  }

  /** `⌘↵` — feed the answer back into the search box to keep calculating. */
  function useCalculationAsInput(calc: Calculation): void {
    void recordCalculation(calc);
    setQuery(calc.rawValue);
  }

  async function pinCalculation(calc: Calculation): Promise<void> {
    const entry = await recordCalculation(calc);
    if (entry) await window.api.calculatorHistory.setPinned(entry.id, true);
    reload();
  }

  function runRow(row: Row): void {
    if (row.kind === "calc") {
      copyCalculation();
      return;
    }
    const { action } = row;
    if (argumentMode) {
      // The box holds the argument; `savedQuery` is what the user actually
      // searched, which is the signal usage-ranking wants.
      void window.api
        .execute(action.id, argumentMode.savedQuery, query)
        .then((result) => {
          if (result.navigate) push(result.navigate);
          else dismiss();
        });
      return;
    }
    if (action.type === "widget" || action.type === "calculation") {
      // The row is a value, not an action — Enter copies it, like the calc row.
      // Ask for the current value directly (cheap: a no-op refresh resolves
      // from cache instantly) rather than reading `row.action.subtitle`, which
      // is only a snapshot from the last query and may be behind what the row's
      // own SearchItem has since fetched.
      const id = row.action.id;
      void window.api.requestSubtitle(id).then((subtitle) => {
        if (subtitle) void navigator.clipboard.writeText(subtitle);
      });
      dismiss();
      return;
    }
    // Most actions just run in the main process and the launcher dismisses.
    // Some (e.g. the Widget/Group managers, "Create Quicklink") instead call
    // `ctx.navigate()` and resolve with a screen to push — the launcher stays
    // open showing it instead of dismissing.
    void window.api.execute(action.id, query).then((result) => {
      if (result.navigate) {
        push(result.navigate);
      } else {
        dismiss();
      }
    });
  }

  function buildMenuActions(target: Row | null): FooterMenuItem[] {
    if (!target) return [];
    if (target.kind === "calc") {
      const { calculation: calc } = target;
      return [
        {
          id: "copy-result",
          label: "Copy Result",
          shortcut: "Enter",
          onSelect: () => copyCalculation("value"),
        },
        {
          id: "copy-unformatted",
          label: "Copy Unformatted",
          shortcut: "Alt+Enter",
          onSelect: () => copyCalculation("raw"),
        },
        {
          id: "copy-question-and-answer",
          label: "Copy Question & Answer",
          shortcut: "CommandOrControl+Shift+Enter",
          onSelect: () => copyCalculation("question-and-answer"),
        },
        {
          id: "use-as-input",
          label: "Use as Input",
          shortcut: "CommandOrControl+Enter",
          onSelect: () => useCalculationAsInput(calc),
        },
        {
          id: "pin-calculation",
          label: "Pin Calculation",
          section: "Calculator History",
          onSelect: () => void pinCalculation(calc),
        },
        {
          id: "open-history",
          label: "Open Calculator History",
          section: "Calculator History",
          onSelect: () => push({ name: "calculator-history" }),
        },
      ];
    }

    // Everything a contributor might need beyond the `LauncherAction` itself —
    // renderer-only effects, plus the `window.api` calls are reached directly.
    const ctx: ContextMenuContext = {
      query,
      pinned,
      apps,
      actionHotkeys,
      refreshActionHotkeys,
      actionAliases,
      refreshActionAliases,
      setQuery,
      push,
      reload,
      dismiss,
      togglePin: () => void togglePin(),
      forceRefresh: (id) => setForceRefresh({ id, token: Date.now() }),
      runAction: (action) => runRow({ key: action.id, kind: "action", action }),
    };
    return buildContextMenu(target.action, ctx);
  }

  // Arrow keys / Enter are handled by Autocomplete inside ListScreen; Escape
  // (clear query, else hide) is its own built-in ladder — we only add the
  // launcher's extra shortcuts on top.
  function onInputKeyDown(
    e: KeyboardEvent<HTMLInputElement>,
    active: Row | null,
  ): void {
    if (argumentMode) {
      // Escape, or Backspace with nothing left to delete, gives the chip back.
      const backspaceOnEmpty = e.key === "Backspace" && !query;
      if (e.key === "Escape" || backspaceOnEmpty) {
        e.preventDefault();
        exitArgumentMode(argumentMode);
      }
      return;
    }
    if (
      e.key === "Tab" &&
      active?.kind === "action" &&
      active.action.takesArgument
    ) {
      e.preventDefault();
      enterArgumentMode(active.action);
      return;
    }
    if (e.key === "Enter" && active?.kind === "calc") {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey) {
        // ⇧⌘↵ copies "question = answer".
        e.preventDefault();
        copyCalculation("question-and-answer");
      } else if (mod) {
        // ⌘↵ feeds the answer back into the search box to keep calculating,
        // instead of copying + dismissing.
        e.preventDefault();
        useCalculationAsInput(active.calculation);
      } else if (e.altKey) {
        // ⌥↵ copies the unformatted answer (no grouping / symbol).
        e.preventDefault();
        copyCalculation("raw");
      }
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
    if (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void togglePin();
    }
  }

  return (
    <ListScreen<Row>
      data={rows}
      getId={(row) => row.key}
      // Main always sends `group`; the calc row is the renderer's own, and the
      // answer heads the list under its own heading.
      getGroup={(row) =>
        row.kind === "calc" ? "Calculator" : (row.action.group ?? "Commands")
      }
      renderItem={(row, { highlighted }) =>
        row.kind === "calc" ? (
          <CalculatorPanel
            calculation={row.calculation}
            highlighted={highlighted}
          />
        ) : (
          <SearchItem
            action={row.action}
            highlighted={highlighted}
            boundAccelerator={actionHotkeys[row.action.id]?.accelerator}
            forceRefreshToken={
              forceRefresh?.id === row.action.id
                ? forceRefresh.token
                : undefined
            }
          />
        )
      }
      serverFiltered
      inputValue={query}
      onInputChange={setQuery}
      onInputKeyDown={onInputKeyDown}
      placeholder={
        argumentMode
          ? `Enter ${argumentNames.length ? argumentNames.join(", ") : "query"}…`
          : "Search actions..."
      }
      inputPrefix={
        argumentMode ? (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded bg-item-selected px-2 py-1 text-sm [-webkit-app-region:no-drag]"
            title="Backspace to go back"
          >
            {argumentMode.action.icon &&
              (/^(https?:|data:|file:)/.test(argumentMode.action.icon) ? (
                <img
                  src={argumentMode.action.icon}
                  alt=""
                  className="h-3.5 w-3.5 shrink-0 object-contain"
                />
              ) : (
                <span className="shrink-0">{argumentMode.action.icon}</span>
              ))}
            <span className="max-w-[16ch] truncate">
              {argumentMode.action.title}
            </span>
          </span>
        ) : undefined
      }
      autoRefocus
      onActivate={runRow}
      onExit={() => window.api.hide()}
      menu={buildMenuActions}
      customFooter={
        <>
          <VersionStatus />
          <Footer.Button
            active={pinned}
            onClick={() => void togglePin()}
            title={
              pinned
                ? "Unpin (stays open) — Ctrl+P"
                : "Pin (stay open on focus loss) — Ctrl+P"
            }
          >
            📌 {pinned ? "Pinned" : "Pin"}
          </Footer.Button>
        </>
      }
      emptyLabel="No results"
      noMatchLabel="No results"
    />
  );
}

export default LauncherScreen;
