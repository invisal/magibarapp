/**
 * "Manage Extensions" — every installed plugin, with Configure (its
 * preferences), Update (re-download from the Store; source installs rebuild
 * from where they came from) and Uninstall in the ⌘K menu. Registered as the
 * `"plugin-manage"` core route in `router/Outlet.tsx`.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ListScreen } from "@renderer/shared/ui/ListScreen";
import type { FooterMenuItem } from "@renderer/shared/ui/Footer";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import type { InstalledPluginSummary } from "@plugin-engine/host/protocol";

type Status =
  | { state: "idle" }
  | { state: "busy"; id: string; message: string }
  | { state: "done"; message: string }
  | { state: "error"; message: string };

const SOURCE_LABEL: Record<InstalledPluginSummary["source"], string> = {
  store: "Raycast Store",
  github: "GitHub",
  local: "Local folder",
};

export function PluginManageScreen(): ReactNode {
  const { push, pop } = useRouteStack();
  const [plugins, setPlugins] = useState<InstalledPluginSummary[] | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  const refresh = useCallback(() => {
    void window.api.pluginEngine.listInstalled().then(setPlugins);
  }, []);
  useEffect(refresh, [refresh]);

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
      getSearchText={(plugin) => `${plugin.title} ${plugin.description ?? ""}`}
      placeholder="Search installed extensions…"
      renderItem={(plugin, { highlighted }) => (
        <ListScreen.Item
          highlighted={highlighted}
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
          subtitle={[
            `${plugin.commandCount} command${plugin.commandCount === 1 ? "" : "s"}`,
            SOURCE_LABEL[plugin.source],
            plugin.author,
          ]
            .filter(Boolean)
            .join(" · ")}
          badge={
            plugin.missingRequiredPreferences ? (
              <span className="text-xs text-amber-500">Needs setup</span>
            ) : undefined
          }
        />
      )}
      onActivate={(plugin) => {
        if (plugin.hasPreferences) configure(plugin);
      }}
      menu={menu}
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
