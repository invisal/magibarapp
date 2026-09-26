/**
 * "Manage Extensions" — every installed plugin, master/detail like Search
 * Raycast Store: the list on the left, the selected extension on the right
 * (`InstalledDetailPane`) with its settings edited in place, its commands,
 * and Update / Uninstall. Clicking a row only selects it; Enter jumps into
 * its settings. Registered as the `"plugin-manage"` core route in
 * `router/Outlet.tsx`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ListScreen } from "@renderer/shared/ui/ListScreen";
import type { FooterMenuItem } from "@renderer/shared/ui/Footer";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import type { InstalledPluginSummary } from "@plugin-engine/host/protocol";
import { InstalledDetailPane } from "./InstalledDetailPane";

type Status =
  | { state: "idle" }
  | { state: "busy"; id: string; message: string }
  | { state: "done"; message: string }
  | { state: "error"; message: string };

export function PluginManageScreen(): ReactNode {
  const { push, pop } = useRouteStack();
  const [plugins, setPlugins] = useState<InstalledPluginSummary[] | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [query, setQuery] = useState("");
  // The extension shown in the pane — tracked here, not read from
  // `ListScreen`'s highlight, which a plain click can momentarily clear
  // (same approach as Clipboard History).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.api.pluginEngine.listInstalled().then(setPlugins);
  }, []);
  useEffect(refresh, [refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = plugins ?? [];
    if (!q) return all;
    return all.filter((plugin) =>
      `${plugin.title} ${plugin.description ?? ""}`.toLowerCase().includes(q),
    );
  }, [plugins, query]);

  const selected =
    visible.find((plugin) => plugin.id === selectedId) ?? visible[0] ?? null;

  function configure(plugin: InstalledPluginSummary): void {
    push({ name: "plugin-preferences", payload: { pluginId: plugin.id } });
  }

  async function uninstall(plugin: InstalledPluginSummary): Promise<void> {
    setStatus({
      state: "busy",
      id: plugin.id,
      message: `Uninstalling ${plugin.title}…`,
    });
    const result = await window.api.pluginEngine.uninstall(plugin.id);
    setStatus(
      result.ok
        ? { state: "done", message: `Uninstalled ${plugin.title}` }
        : { state: "error", message: result.error ?? "Uninstall failed" },
    );
    refresh();
  }

  async function update(plugin: InstalledPluginSummary): Promise<void> {
    const requestId = crypto.randomUUID();
    setStatus({
      state: "busy",
      id: plugin.id,
      message: `Updating ${plugin.title}…`,
    });
    const unsubscribe = window.api.pluginEngine.onInstallProgress(
      (progress) => {
        if (progress.requestId === requestId) {
          setStatus({
            state: "busy",
            id: plugin.id,
            message: progress.message,
          });
        }
      },
    );
    try {
      const result = await window.api.pluginEngine.reinstall(
        plugin.id,
        requestId,
      );
      setStatus(
        result.ok
          ? { state: "done", message: `Updated ${plugin.title}` }
          : { state: "error", message: result.error },
      );
      refresh();
    } finally {
      unsubscribe();
    }
  }

  function menu(plugin: InstalledPluginSummary | null): FooterMenuItem[] {
    if (!plugin) return [];
    const items: FooterMenuItem[] = [];
    if (plugin.hasPreferences) {
      items.push({
        label: "Configure Extension",
        icon: "⚙️",
        onSelect: () => configure(plugin),
      });
    }
    items.push({
      label:
        plugin.source === "store" ? "Update from Raycast Store" : "Reinstall",
      icon: "⬇️",
      onSelect: () => void update(plugin),
    });
    if (plugin.source === "store") {
      if (plugin.author) {
        items.push({
          label: "Open in Raycast Store",
          icon: "🌐",
          onSelect: () =>
            void window.api.pluginEngine.openStorePage(
              plugin.author!,
              storeName(plugin),
            ),
        });
      }
    }
    items.push({
      label: "Uninstall",
      icon: "🗑️",
      danger: true,
      separator: items.length > 0,
      confirmLabel: `Uninstall ${plugin.title}?`,
      onSelect: () => void uninstall(plugin),
    });
    return items;
  }

  const footerLabel =
    status.state === "busy"
      ? status.message
      : status.state === "done"
        ? status.message
        : status.state === "error"
          ? `⚠︎ ${status.message}`
          : (count: number) => `${count} extension${count === 1 ? "" : "s"}`;

  return (
    <ListScreen<InstalledPluginSummary>
      data={plugins}
      getId={(plugin) => plugin.id}
      serverFiltered
      inputValue={query}
      onInputChange={setQuery}
      placeholder="Search installed extensions…"
      renderItem={(plugin) => (
        <ListScreen.Item
          highlighted={plugin.id === selected?.id}
          icon={
            plugin.iconDataUri ? (
              <img
                src={plugin.iconDataUri}
                alt=""
                className="h-6 w-6 rounded object-contain"
              />
            ) : (
              <span className="grid h-6 w-6 place-items-center text-base">
                🧩
              </span>
            )
          }
          title={plugin.title}
          badge={
            plugin.missingRequiredPreferences ? (
              <span className="text-xs text-amber-500">Needs setup</span>
            ) : undefined
          }
        />
      )}
      // A click only selects (Base UI also turns Enter into a synthetic
      // click, so this stays inert); Enter moves into the settings form.
      onActivate={(plugin) => setSelectedId(plugin.id)}
      // Only a user's own move counts: Base UI re-highlights the first row
      // on its own (reason "none") whenever the search box takes focus.
      onHighlightChange={(plugin, reason) => {
        if (plugin && reason !== "none") setSelectedId(plugin.id);
      }}
      // …and a click moves Base UI's highlight onto the clicked row, so
      // arrow keys carry on from there.
      highlightId={selected?.id}
      onInputKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        const field = document.querySelector<HTMLElement>(
          "[data-plugin-settings] input, [data-plugin-settings] select, [data-plugin-settings] button",
        );
        if (!field) return;
        e.preventDefault();
        field.focus();
      }}
      detail={() => (
        <InstalledDetailPane
          plugin={selected}
          busy={status.state === "busy"}
          onUpdate={(plugin) => void update(plugin)}
          onUninstall={(plugin) => void uninstall(plugin)}
          onSettingsSaved={refresh}
        />
      )}
      menu={() => menu(selected)}
      onExit={pop}
      footerLabel={footerLabel}
      loadingLabel="Loading…"
      emptyLabel="No extensions installed yet — use “Search Raycast Store” to add one."
    />
  );
}

function storeName(plugin: InstalledPluginSummary): string {
  return plugin.storeName ?? plugin.id;
}
