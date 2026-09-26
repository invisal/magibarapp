/**
 * Wires `PluginHostSource`'s own `ipcMain` handlers — called once at startup
 * via `ActionSource.registerIpc()` (see `PluginHostSource.registerIpc`),
 * matching every other source's own-IPC convention. The preload side is
 * `ipc-preload.ts`.
 */
import { rm } from "node:fs/promises";
import { nativeImage, shell, type IpcMain, type WebContents } from "electron";
import {
  fetchHitIcons,
  isPlatformSupported,
  searchStore,
} from "../install/store.ts";
import { encodeAsIs, type IconEncoder } from "../install/icon.ts";
import { pluginDir, pluginIdFromName } from "../paths.ts";
import {
  missingRequiredPreferences,
  preferencesPayload,
} from "../preferences.ts";
import { listHostManager } from "./list-host-manager.ts";
import {
  PLUGIN_ENGINE_CHANNELS,
  type InstallProgress,
  type InstallRequest,
  type InstallResponse,
  type InstallStage,
  type InstalledPluginSummary,
  type PluginInboundEvent,
  type PluginPreferencesPayload,
  type SearchStoreResponse,
} from "./protocol.ts";
import { reinstallSource } from "../registry.ts";
import type {
  LaunchOptions,
  LaunchOutcome,
  PluginHostSource,
} from "./PluginHostSource.ts";

/** Store icons are full-size PNGs — downscale before they cross IPC. */
const downscaleIcon: IconEncoder = (bytes, mime) => {
  if (mime === "image/svg+xml") return encodeAsIs(bytes, mime);
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  return image.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
};

/** Relays install progress to the renderer that asked for the install. */
function progressTo(
  sender: WebContents,
  requestId: string,
): (stage: InstallStage, message: string) => void {
  return (stage, message) => {
    const progress: InstallProgress = { requestId, stage, message };
    if (!sender.isDestroyed()) {
      sender.send(PLUGIN_ENGINE_CHANNELS.installProgress, progress);
    }
  };
}

/** Renderers whose teardown already detaches their plugin instances. */
const watchedOwners = new WeakSet<WebContents>();

/** A reload, crash or destroyed window drops every plugin screen without
 *  unmounting it — kill the instances that were showing there. */
function watchOwner(sender: WebContents): void {
  if (watchedOwners.has(sender)) return;
  watchedOwners.add(sender);
  const id = sender.id;
  const release = (): void => listHostManager.detachOwner(id);
  sender.on("render-process-gone", release);
  sender.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  });
  sender.once("destroyed", release);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerPluginEngineIpc(
  ipc: IpcMain,
  source: PluginHostSource,
): void {
  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.install,
    async (event, request: InstallRequest): Promise<InstallResponse> => {
      const result = await source.installAndRegister(request.source, {
        onProgress: progressTo(event.sender, request.requestId),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        pluginId: result.entry.id,
        title: result.entry.title,
        needsPreferences: missingRequiredPreferences(result.entry).length > 0,
      };
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.reinstall,
    async (
      event,
      pluginId: string,
      requestId: string,
    ): Promise<InstallResponse> => {
      const entry = source.registry.get(pluginId);
      if (!entry) return { ok: false, error: "not installed" };
      const result = await source.installAndRegister(reinstallSource(entry), {
        onProgress: progressTo(event.sender, requestId),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        pluginId: result.entry.id,
        title: result.entry.title,
        needsPreferences: missingRequiredPreferences(result.entry).length > 0,
      };
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.searchStore,
    async (_event, query: string): Promise<SearchStoreResponse> => {
      try {
        const hits = await searchStore(query);
        const icons = await fetchHitIcons(hits, { encode: downscaleIcon });
        const installed = new Set(source.registry.list().map((e) => e.id));
        return {
          ok: true,
          results: hits.map((hit, i) => ({
            name: hit.name,
            author: hit.author,
            authorName: hit.authorName,
            title: hit.title,
            description: hit.description,
            iconDataUri: icons[i],
            platforms: hit.platforms,
            downloadCount: hit.downloadCount,
            commandCount: hit.commandCount,
            supported: isPlatformSupported(hit.platforms),
            installed: installed.has(pluginIdFromName(hit.name)),
          })),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.listInstalled,
    (): InstalledPluginSummary[] =>
      source.registry
        .list()
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          description: entry.description,
          version: entry.version,
          author:
            entry.sourceRef.kind === "store"
              ? entry.sourceRef.author
              : entry.author,
          source: entry.sourceRef.kind,
          storeName:
            entry.sourceRef.kind === "store" ? entry.sourceRef.name : undefined,
          commandCount: entry.commands.length,
          hasPreferences:
            (entry.preferences?.length ?? 0) > 0 ||
            entry.commands.some((c) => (c.preferences?.length ?? 0) > 0),
          missingRequiredPreferences:
            missingRequiredPreferences(entry).length > 0,
          iconDataUri: source.iconFor(entry),
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.getPreferences,
    (_event, pluginId: string): PluginPreferencesPayload | null => {
      const entry = source.registry.get(pluginId);
      return entry ? preferencesPayload(entry) : null;
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.setPreferences,
    (_event, pluginId: string, values: Record<string, unknown>): boolean => {
      if (!source.registry.get(pluginId)) return false;
      source.registry.setPreferenceValues(pluginId, values);
      source.reloadRegistry();
      // Running instances were started with the old values.
      listHostManager.detachPlugin(
        pluginId,
        "The extension's preferences changed — reopen the command.",
      );
      return true;
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.uninstall,
    async (
      _event,
      pluginId: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!source.registry.get(pluginId))
        return { ok: false, error: "not installed" };
      listHostManager.detachPlugin(pluginId);
      source.registry.remove(pluginId);
      source.reloadRegistry();
      try {
        await rm(pluginDir(source.pluginsRoot, pluginId), {
          recursive: true,
          force: true,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.launch,
    (_event, actionId: string, options: LaunchOptions): LaunchOutcome =>
      source.launchFromRenderer(actionId, options ?? {}),
  );

  ipc.handle(
    PLUGIN_ENGINE_CHANNELS.openStorePage,
    async (_event, author: string, name: string): Promise<void> => {
      const segment = /^[\w.-]+$/;
      if (!segment.test(author) || !segment.test(name)) return;
      await shell.openExternal(`https://www.raycast.com/${author}/${name}`);
    },
  );

  ipc.on(
    PLUGIN_ENGINE_CHANNELS.listAttach,
    (event, instanceId: string, actionId: string) => {
      watchOwner(event.sender);
      source.attachListInstance(
        instanceId,
        actionId,
        event.sender.id,
        (message) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(PLUGIN_ENGINE_CHANNELS.listMessage, message);
          }
        },
      );
    },
  );

  ipc.on(PLUGIN_ENGINE_CHANNELS.listDetach, (_event, instanceId: string) => {
    source.sendListEvent(instanceId, { type: "dispose" });
  });

  ipc.on(
    PLUGIN_ENGINE_CHANNELS.listSendEvent,
    (_event, instanceId: string, pluginEvent: PluginInboundEvent) => {
      source.sendListEvent(instanceId, pluginEvent);
    },
  );
}
