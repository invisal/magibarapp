import { app } from "electron";
import type { IpcMain } from "electron";
import { join } from "node:path";
import {
  ACTION_GROUP_ORDER,
  defaultActionGroup,
  type ActionGroup,
  type CalculatorSettings,
  type ExecuteResult,
  type QueryResult,
  type RequestSubtitleOptions,
} from "../shared/types";
import { evaluate } from "./calculator";
import { matchAction } from "@shared/search";
import { takePendingNavigate } from "./navigate";
import { SettingsStore } from "./settings/store";
import type { ActionSource } from "./sources/base";
import { InstalledAppSource } from "./sources/apps/source";
import { BuiltinCommandSource } from "./sources/builtin/source";
import { QuicklinkSource } from "@extensions/quicklink";
import { ExchangeRateSource } from "./sources/calculator/exchange-rate/source.ts";
import { CryptoPriceSource } from "./sources/calculator/crypto-price/source.ts";
import { setCryptoEnabled } from "./sources/calculator/crypto-price/store.ts";
import {
  numberLocaleTag,
  setNumberLocale,
} from "./calculator/common/locale.ts";
import { WidgetSource } from "@extensions/widget";
import { WindowExtension } from "@extensions/window";
import { Usage } from "./usage/store";
import { configureActionResolver, configureExtensions } from "@core/base";
import { GroupExtension } from "@extensions/group";
import type { ActionDefinition } from "./types";
import { QuitProcessExtension } from "@extensions/quit-process";
import { XcodeCleanExtension } from "@extensions/xcode-clean";
import { CalculatorHistoryExtension } from "@extensions/calculator-history";
import { ClipboardHistoryExtension } from "@extensions/clipboard-history";
import { ExtensionStorage } from "@core/storage";
import { HotkeyBindingStore } from "@extensions/hotkey/main/store";
import { AliasStore } from "@extensions/alias/main/store";
import { PluginHostSource } from "@plugin-engine/host/PluginHostSource";

// Point extensions at `<userData>/extensions/` before any is constructed below.
configureExtensions(app.getPath("userData"));

/** Persisted user settings (today: the custom-layout gap size). Also read directly by `index.ts` to wire the custom-layout manager's IPC. */
export const settings = new SettingsStore({ dir: app.getPath("userData") });

/**
 * The Widget extension. It owns its `ExtensionStorage`
 * (`<userData>/extensions/widget.json`, `store`/`runner` keyed `widgets`/
 * `values`) and wires the manager window's IPC to them itself, via
 * `registerIpc()`.
 */
const widgetSource = new WidgetSource();

/**
 * The window-management extension. It owns its `ExtensionStorage`
 * (`<userData>/extensions/window.json`, `store` keyed `layouts`) and wires
 * the manager screens' IPC to it itself, via `registerIpc()`.
 */
const windowExtension = new WindowExtension(settings);

/**
 * The Calculator History extension. It owns its `ExtensionStorage`
 * (`<userData>/extensions/calculator-history.json`) and wires the
 * record/list/pin IPC to it itself, via `registerIpc()`. Pinned entries
 * re-run through `evaluate` for their live value.
 */
const calculatorHistory = new CalculatorHistoryExtension(evaluate);

/**
 * The Clipboard History extension. It owns its `ExtensionStorage`
 * (`<userData>/extensions/clipboard-history.json`) and a background poller
 * watching Electron's `clipboard` module (no native change event exists),
 * wiring the list/pin/delete/copy-again IPC to the same instance via
 * `registerIpc()`. Exposed so `index.ts` can stop the poller at `will-quit`.
 */
export const clipboardHistory = new ClipboardHistoryExtension();

/**
 * The Activity Monitor extension ("Quit Processes"). Its background
 * poller only runs while its list screen is open (started/stopped via its
 * own `start`/`stop` IPC, not `init()`), wiring the list/kill IPC to the
 * same instance via `registerIpc()`. Exposed so `index.ts` can stop the
 * poller at `will-quit` and forward its live refreshes to the launcher
 * window.
 */
export const quitProcess = new QuitProcessExtension();

/**
 * The Clean Xcode extension (macOS only). Scans nothing until its screen
 * asks; wires its scan/clean IPC via `registerIpc()`. Exposed so `index.ts`
 * can forward its per-category size updates to the launcher window.
 */
export const xcodeClean = new XcodeCleanExtension();

/** Live crypto prices for the calculator — a data feed like `ExchangeRateSource`, gated by a setting. */
const cryptoPriceSource = new CryptoPriceSource();

/**
 * Per-action global hotkey bindings (Ctrl+K menu's "Set Hotkey…" — see
 * `@extensions/hotkey`). Not an `Extension`/`ActionSource` itself — it
 * doesn't contribute search rows, just attaches an optional `globalShortcut`
 * to any existing action — so it isn't in `sources` below; `index.ts` wires
 * its `globalShortcut` registration and IPC directly, the same way it wires
 * Quicklink's launcher-window-dependent IPC by hand.
 */
export const actionHotkeys = new HotkeyBindingStore(
  new ExtensionStorage(
    join(app.getPath("userData"), "extensions", "hotkey.json"),
    "ext:hotkey",
  ),
);

/**
 * Per-action aliases (Ctrl+K menu's "Alias" row — see `@extensions/alias`).
 * Same shape as `actionHotkeys`: not in `sources`, doesn't contribute rows,
 * just fills in `keyword` on any action's `LauncherAction` inside `query()`
 * below. The one place any action's alias lives, quicklinks included — see
 * `QuicklinkSource.useAliases`, wired up in `index.ts`.
 */
export const actionAliases = new AliasStore(
  new ExtensionStorage(
    join(app.getPath("userData"), "extensions", "alias.json"),
    "ext:alias",
  ),
);

/**
 * Push the calculator settings into the calculator's module-level state: the
 * crypto feed's on/off switch and the number format. Called at startup and
 * whenever Settings changes them.
 */
function applyCalculatorSettings(value: CalculatorSettings): void {
  setCryptoEnabled(value.cryptoEnabled);
  setNumberLocale(numberLocaleTag(value.numberFormat, app.getLocale()));
}

export function getCalculatorSettings(): CalculatorSettings {
  return settings.getCalculatorSettings();
}

/** Persist a Settings change and apply it right away. */
export function updateCalculatorSettings(
  patch: Partial<CalculatorSettings>,
): CalculatorSettings {
  const wasEnabled = settings.getCalculatorSettings().cryptoEnabled;
  const next = settings.setCalculatorSettings(patch);
  applyCalculatorSettings(next);
  if (next.cryptoEnabled && !wasEnabled) void cryptoPriceSource.refreshNow();
  return next;
}

/**
 * The Quicklinks extension. Exposed so `index.ts` can wire the Create/Edit
 * form's and the Ctrl+K menu's IPC to the same instance.
 */
export const quicklinkSource = new QuicklinkSource();

/**
 * The plugin engine (`src/plugin-engine`) — every installed
 * Raycast-extension-compatible plugin's commands, as one source covering all
 * of them (not one entry per plugin; see `PluginHostSource`'s doc comment).
 * Owns `<userData>/plugins/`, entirely separate from `configureExtensions`'s
 * `<userData>/extensions/` root above.
 */
const pluginHostSource = new PluginHostSource(app.getPath("userData"));

/**
 * Registry of action sources. Order matters: `query` keeps it, and the
 * stable sort below preserves it among equally-scored results (so built-in
 * commands rank ahead of applications on a tie).
 */
const sources: ActionSource[] = [
  new BuiltinCommandSource(),
  windowExtension,
  widgetSource,
  calculatorHistory,
  clipboardHistory,
  quitProcess,
  xcodeClean,
  quicklinkSource,
  pluginHostSource,
  new InstalledAppSource(),
  new ExchangeRateSource(),
  cryptoPriceSource,
  // Group is still an in-progress testing command — keep it out of packaged builds.
  ...(app.isPackaged ? [] : [new GroupExtension()]),
];

/**
 * Cross-source lookup by id, e.g. for a group resolving its members' current
 * title/icon/subtitle. Each id is checked against `owns()` in registry order
 * and resolved by whichever source claims it, via `provideByIds` where a
 * source implements it, else `provide("")` filtered down to the ids it owns.
 */
async function resolveActionsByIds(ids: string[]): Promise<ActionDefinition[]> {
  const remaining = new Set(ids);
  const found: ActionDefinition[] = [];
  for (const source of sources) {
    const owned = ids.filter((id) => remaining.has(id) && source.owns(id));
    if (owned.length === 0) continue;
    const definitions = source.provideByIds
      ? await source.provideByIds(owned)
      : (await source.provide("")).filter((definition) =>
          remaining.has(definition.action.id),
        );
    for (const definition of definitions) {
      found.push(definition);
      remaining.delete(definition.action.id);
    }
  }
  return found;
}
configureActionResolver(resolveActionsByIds);

/** Open the quicklink `id` now with a specific app ("" = the system default). */
export async function openQuicklinkWith(
  id: string,
  text: string,
  appPath: string,
): Promise<void> {
  await quicklinkSource.execute(id, text, undefined, appPath);
  usage.record(id, text);
}

/** Personalized ranking signal — records what the user picks, boosts it next time. */
const usage = new Usage({ dir: app.getPath("userData") });

/** How often / how recently `actionId` has been run — the "Opened" row in the quicklink manager. */
export function actionUsage(
  actionId: string,
): { count: number; lastUsedAt: number } | undefined {
  return usage.stat(actionId);
}

/** Warm every source at startup (called from app `whenReady`). */
export function initActionSources(): void {
  usage.init();
  settings.init();
  applyCalculatorSettings(settings.getCalculatorSettings());
  for (const source of sources) source.init?.();
}

/** Let every source wire its own `ipcMain` handlers (called once from app `whenReady`). */
export function registerActionSourcesIpc(ipc: IpcMain): void {
  for (const source of sources) source.registerIpc?.(ipc);
}

/** Refresh every source (called when the launcher window is shown; sources throttle). */
export function refreshActionSources(): void {
  for (const source of sources) source.refresh?.();
}

export async function query(text: string): Promise<QueryResult> {
  const lists = await Promise.all(
    sources.map((source) => source.provide(text)),
  );
  // A user-set alias fills in the action's `keyword` — no source sets one of
  // its own — applied once, up front, so it's in effect for both the root
  // list below and the `matchAction` search path.
  const definitions = lists.flat().map((definition) => {
    const alias = actionAliases.get(definition.action.id);
    if (!alias) return definition;
    return { ...definition, action: { ...definition.action, keyword: alias } };
  });

  const trimmed = text.trim();
  if (!trimmed) {
    // The root list: pinned actions first, then by how recently/often each has
    // been used; the stable sort keeps registry order among the (many) ties.
    // Actions flagged "Hide in Root Search" are dropped here but still returned
    // for an explicit query below.
    const scores = usage.scores();
    const groupRank = (group: ActionGroup) => ACTION_GROUP_ORDER.indexOf(group);
    const result = definitions
      .map(({ action }) => ({
        ...action,
        group: action.group ?? defaultActionGroup(action),
      }))
      .filter((action) => !action.hidden)
      .sort((a, b) => {
        // Sections first (Pinned, Commands, Applications), then usage within each.
        const groupDelta = groupRank(a.group) - groupRank(b.group);
        if (groupDelta) return groupDelta;
        return (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
      });
    return { result };
  }

  const result = definitions
    .map((definition) => {
      const { action } = definition;
      // Only a static subtitle is searchable; a deferred one (a widget's live
      // value) isn't resolved yet at query time.
      const match = matchAction(trimmed, {
        ...action,
        subtitle: action.isDeferredSubtitle ? undefined : action.subtitle,
      });
      const score = match.score + usage.boost(action.id, trimmed);
      return { action, matched: match.match, score };
    })
    .filter((entry) => entry.matched)
    // Best score first; `sort` is stable, so equal scores keep registry order.
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.action, group: "Results" as const }));

  const calculation = evaluate(trimmed);
  return calculation ? { result, calculation } : { result };
}

export async function executeAction(
  id: string,
  text: string,
  argument?: string,
): Promise<ExecuteResult> {
  await sources.find((source) => source.owns(id))?.execute(id, text, argument);
  // `widget:edit:*` is a UI shortcut (open the editor), not a real action to rank.
  if (!id.startsWith("widget:edit:")) usage.record(id, text);
  return { navigate: takePendingNavigate() };
}

/** A deferred-subtitle row rendered in the launcher; ask whichever source owns it for a fresh subtitle. */
export async function requestSubtitle(
  id: string,
  opts?: RequestSubtitleOptions,
): Promise<string | undefined> {
  return await sources
    .find((source) => source.owns(id))
    ?.requestSubtitle?.(id, opts);
}
