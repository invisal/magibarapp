/**
 * The `ActionSource` that turns every installed plugin's commands into
 * launcher rows — one entry in `main/actions.ts`'s `sources` array covering
 * *every* installed plugin, not one entry per plugin.
 *
 * Implements `ActionSource` directly rather than extending `Extension`
 * (`@core/base`): `Extension` wires exactly one `this.storage`, namespaced by
 * one `id` — built for "one first-party extension, one id." This is a
 * registry of N independently-installed plugins, each needing its own
 * isolated storage root (`plugins/<pluginId>/storage.json`), which would
 * fight that constructor. It still reaches for `navigate` (`@main/navigate`)
 * directly for the one capability it needs from `Extension`'s `ctx`.
 *
 * Launching goes through one gate (`launch`): a command whose required
 * preferences aren't set yet opens the preferences screen first, and one
 * with required arguments opens the argument form — both then come back
 * here (`launchFromRenderer`) to actually run.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { nativeImage, nativeTheme, Notification, type IpcMain } from "electron";
import { ExtensionStorage } from "@core/storage";
import { navigate } from "@main/navigate";
import { getLauncherWindow, hideLauncher, showLauncher } from "@main/window";
import { HOTKEY_CHANNELS } from "@extensions/hotkey/shared/types";
import type { ActionSource } from "@main/sources/base";
import type { ActionDefinition } from "@main/types";
import {
  PluginRegistry,
  reinstallSource,
  type PluginRegistryEntry,
} from "../registry.ts";
import {
  pluginAssetsDir,
  pluginBundlePath,
  pluginCacheFilePath,
  pluginDistDir,
  pluginsRootDir,
  pluginStorageFilePath,
  pluginSupportDir,
  registryFilePath,
} from "../paths.ts";
import {
  missingRequiredPreferences,
  resolvePreferenceValues,
} from "../preferences.ts";
import {
  installPlugin,
  sweepStaging,
  type InstallOptions,
  type InstallResult,
} from "../install/install.ts";
import { applyHostEffect, handleHostRequest } from "./main-rpc.ts";
import { runNoViewCommand } from "./no-view-runner.ts";
import { listHostManager } from "./list-host-manager.ts";
import { registerPluginEngineIpc } from "./ipc.ts";
import type {
  HostEffect,
  InstallSourceInput,
  PluginArgumentField,
  PluginHostMessage,
  PluginInboundEvent,
} from "./protocol.ts";
import type { CommandRunInput } from "./list-host-messages.ts";

export const INSTALL_ACTION_ID = "plugin:install";
export const MANAGE_ACTION_ID = "plugin:manage";

interface ResolvedCommand {
  entry: PluginRegistryEntry;
  commandName: string;
}

/** `LaunchProps` beyond what the manifest fixes. */
export interface LaunchOptions {
  arguments?: Record<string, unknown>;
  launchContext?: unknown;
  fallbackText?: string;
}

/** What the renderer should do after asking main to launch something. */
export interface LaunchOutcome {
  navigate?: { name: string; payload?: unknown };
  error?: string;
}

type Navigator = (name: string, payload?: unknown) => void;

export function commandActionId(pluginId: string, commandName: string): string {
  return `plugin:${pluginId}:${commandName}`;
}

/** Pushes a route onto the launcher from outside an `execute()` call (a
 *  running plugin's `launchCommand`/`openExtensionPreferences`) — the same
 *  channel hotkey-bound actions use to land on a screen. */
const pushRouteFromMain: Navigator = (name, payload) => {
  const win = getLauncherWindow();
  if (!win) return;
  if (!win.isVisible()) showLauncher();
  win.webContents.send(HOTKEY_CHANNELS.triggerNavigate, { name, payload });
};

const ICON_SIZE = 64;

/** How many old-format installs `migrateLegacyInstalls` rebuilds at once. */
const MIGRATION_CONCURRENCY = 3;

export class PluginHostSource implements ActionSource {
  readonly id = "plugin";
  readonly pluginsRoot: string;
  readonly registry: PluginRegistry;

  private commands = new Map<string, ResolvedCommand>();
  /** `LaunchOptions` for a view instance, from navigate until it attaches. */
  private readonly pendingLaunches = new Map<string, LaunchOptions>();
  private readonly iconCache = new Map<string, string | null>();
  /** Plugins `migrateLegacyInstalls` is rebuilding right now. */
  private readonly migrating = new Set<string>();

  constructor(userDataDir: string) {
    this.pluginsRoot = pluginsRootDir(userDataDir);
    this.registry = new PluginRegistry(
      new ExtensionStorage(
        registryFilePath(this.pluginsRoot),
        "plugin-engine:registry",
      ),
    );
  }

  init(): void {
    this.reloadRegistry();
    void sweepStaging(this.pluginsRoot)
      .catch((error) =>
        console.error("[plugin-engine] sweeping staging dirs failed:", error),
      )
      .then(() => this.migrateLegacyInstalls());
  }

  /** Installs (or reinstalls) a plugin and registers it, keeping whatever
   *  preferences the user already set for it. */
  async installAndRegister(
    source: InstallSourceInput,
    opts: InstallOptions = {},
  ): Promise<InstallResult> {
    const result = await installPlugin(this.pluginsRoot, source, opts);
    if (!result.ok) return result;
    const previous = this.registry.get(result.entry.id);
    const entry = {
      ...result.entry,
      preferenceValues: previous?.preferenceValues ?? {},
    };
    listHostManager.detachPlugin(entry.id);
    this.registry.upsert(entry);
    this.reloadRegistry();
    return { ok: true, entry };
  }

  /**
   * An install made before the current runtime: every build since writes a
   * `dist/package.json` (see `install/bundle.ts`'s `writeDistPackageJson`),
   * and the old pipeline's bundles export a harness (`start`/`run`) instead
   * of the command itself, so they can't run as-is.
   */
  isLegacyInstall(entry: PluginRegistryEntry): boolean {
    return !existsSync(
      join(pluginDistDir(this.pluginsRoot, entry.id), "package.json"),
    );
  }

  /** Rebuilds every old-format install from where it came from, in the
   *  background — raycast/extensions links go through the Store. One that
   *  fails keeps its registry entry; opening it explains how to reinstall. */
  private async migrateLegacyInstalls(): Promise<void> {
    const queue = this.registry.list().filter((e) => this.isLegacyInstall(e));
    if (queue.length === 0) return;
    console.log(
      `[plugin-engine] rebuilding ${queue.length} extension(s) installed by an older version`,
    );
    for (const entry of queue) this.migrating.add(entry.id);
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const result = await this.installAndRegister(reinstallSource(entry));
        this.migrating.delete(entry.id);
        if (result.ok) {
          console.log(`[plugin-engine] rebuilt "${entry.id}"`);
        } else {
          console.error(
            `[plugin-engine] couldn't rebuild "${entry.id}": ${result.error}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: MIGRATION_CONCURRENCY }, () => worker()),
    );
  }

  /** Why `entry` can't run right now, if it's an unmigrated old install. */
  private legacyBlocker(entry: PluginRegistryEntry): string | null {
    if (this.migrating.has(entry.id)) {
      return `${entry.title} is being updated for this version of Magibar — try again in a few seconds.`;
    }
    if (this.isLegacyInstall(entry)) {
      return `${entry.title} was installed by an older version of Magibar and couldn't be updated automatically. Reinstall it from Manage Extensions (⌘K → Reinstall).`;
    }
    return null;
  }

  /** Re-reads the registry and rebuilds the in-memory command list — called
   *  once at startup and again after every install/uninstall/metadata
   *  change, so the launcher reflects it immediately, no restart needed. */
  reloadRegistry(): void {
    const next = new Map<string, ResolvedCommand>();
    for (const entry of this.registry.list()) {
      for (const command of entry.commands) {
        next.set(commandActionId(entry.id, command.name), {
          entry,
          commandName: command.name,
        });
      }
    }
    this.commands = next;
    this.iconCache.clear();
  }

  owns(actionId: string): boolean {
    return actionId.startsWith("plugin:");
  }

  /** A plugin asset (`icon: "extension-icon.png"`) as a small `data:` URI —
   *  the launcher's CSP doesn't allow `file:` images. */
  iconFor(entry: PluginRegistryEntry, iconName?: string): string | null {
    const name = iconName ?? entry.icon;
    if (!name) return null;
    const key = `${entry.id}/${name}`;
    const cached = this.iconCache.get(key);
    if (cached !== undefined) return cached;
    let uri: string | null = null;
    try {
      const path = join(pluginAssetsDir(this.pluginsRoot, entry.id), name);
      if (extname(name).toLowerCase() === ".svg") {
        uri = `data:image/svg+xml;base64,${readFileSync(path).toString("base64")}`;
      } else {
        const image = nativeImage.createFromPath(path);
        uri = image.isEmpty()
          ? null
          : image.resize({ width: ICON_SIZE, height: ICON_SIZE }).toDataURL();
      }
    } catch {
      uri = null;
    }
    this.iconCache.set(key, uri);
    return uri;
  }

  provide(): ActionDefinition[] {
    const definitions: ActionDefinition[] = [
      {
        action: {
          id: INSTALL_ACTION_ID,
          title: "Search Raycast Store",
          subtitle: "Install Raycast extensions",
          icon: "🧩",
          type: "command",
          altNames: [
            "Install Extension",
            "Install Plugin",
            "Raycast Extensions",
          ],
        },
        run: () => {},
      },
      {
        action: {
          id: MANAGE_ACTION_ID,
          title: "Manage Extensions",
          subtitle: "Configure or uninstall Raycast extensions",
          icon: "🧩",
          type: "command",
          altNames: ["Uninstall Extension", "Extension Preferences"],
        },
        run: () => {},
      },
    ];
    for (const [actionId, { entry, commandName }] of this.commands) {
      const command = entry.commands.find((c) => c.name === commandName);
      if (!command) continue;
      const args = command.arguments ?? [];
      definitions.push({
        action: {
          id: actionId,
          title: command.title,
          subtitle: command.subtitleOverride ?? command.subtitle ?? entry.title,
          icon:
            this.iconFor(entry, command.icon) ?? this.iconFor(entry) ?? "🧩",
          type: "plugin",
          altNames: [entry.title],
          // One text argument maps onto the launcher's own Tab-to-type chip,
          // Raycast's inline-argument experience; more go through a form.
          takesArgument: args.length > 0 && args[0].type !== "dropdown",
        },
        run: () => {},
      });
    }
    return definitions;
  }

  async execute(
    actionId: string,
    _query: string,
    argument?: string,
  ): Promise<void> {
    if (actionId === INSTALL_ACTION_ID) {
      navigate("plugin-install");
      return;
    }
    if (actionId === MANAGE_ACTION_ID) {
      navigate("plugin-manage");
      return;
    }
    const resolved = this.commands.get(actionId);
    if (!resolved) return;
    const command = resolved.entry.commands.find(
      (c) => c.name === resolved.commandName,
    );
    const first = command?.arguments?.[0];
    const args = argument && first ? { [first.name]: argument } : undefined;
    this.launch(
      resolved.entry.id,
      resolved.commandName,
      { arguments: args },
      navigate,
    );
  }

  /**
   * The one launch path. Routes to the preferences screen or argument form
   * when something required is missing; otherwise runs a no-view command
   * (fire-and-forget, so the launcher can hide right away) or navigates to
   * the view screen.
   */
  launch(
    pluginId: string,
    commandName: string,
    options: LaunchOptions,
    nav: Navigator,
  ):
    | { ok: true; ran: "no-view" | "view" | "gated" }
    | { ok: false; error: string } {
    const entry = this.registry.get(pluginId);
    const command = entry?.commands.find((c) => c.name === commandName);
    if (!entry || !command) {
      return {
        ok: false,
        error: `unknown command "${pluginId}/${commandName}"`,
      };
    }
    const actionId = commandActionId(pluginId, commandName);

    if (missingRequiredPreferences(entry, commandName).length > 0) {
      nav("plugin-preferences", {
        pluginId,
        continueWith: { actionId, options },
      });
      return { ok: true, ran: "gated" };
    }

    // Raycast always offers a command's argument fields before it runs;
    // here that's the argument form — unless arguments already came in
    // (the launcher's inline chip, a `launchCommand`, or the form itself)
    // and none of the required ones are blank.
    const args = command.arguments ?? [];
    const provided = options.arguments ?? {};
    const missingArg = args.some(
      (a) =>
        a.required &&
        (provided[a.name] === undefined || provided[a.name] === ""),
    );
    const noneProvided = args.length > 0 && Object.keys(provided).length === 0;
    if (missingArg || noneProvided) {
      const fields: PluginArgumentField[] = args.map((a) => ({
        name: a.name,
        type: a.type,
        placeholder: a.placeholder,
        required: a.required,
        data: a.data,
      }));
      nav("plugin-arguments", {
        actionId,
        title: command.title,
        pluginTitle: entry.title,
        fields,
        values: provided,
        options,
      });
      return { ok: true, ran: "gated" };
    }

    if (command.mode === "no-view") {
      void this.runNoView(entry, commandName, options);
      return { ok: true, ran: "no-view" };
    }

    const instanceId = randomUUID();
    this.pendingLaunches.set(instanceId, options);
    nav("plugin-list", { instanceId, actionId, title: command.title });
    return { ok: true, ran: "view" };
  }

  /** The renderer's side door into `launch` — after the preferences screen
   *  or argument form finishes. */
  launchFromRenderer(actionId: string, options: LaunchOptions): LaunchOutcome {
    const resolved = this.commands.get(actionId);
    if (!resolved) return { error: `unknown command "${actionId}"` };
    let route: LaunchOutcome["navigate"];
    const result = this.launch(
      resolved.entry.id,
      resolved.commandName,
      options,
      (name, payload) => (route = { name, payload }),
    );
    if (!result.ok) return { error: result.error };
    if (result.ran === "no-view") hideLauncher();
    return { navigate: route };
  }

  private runInput(
    entry: PluginRegistryEntry,
    commandName: string,
    options: LaunchOptions,
  ): CommandRunInput {
    const command = entry.commands.find((c) => c.name === commandName);
    return {
      bundlePath: pluginBundlePath(this.pluginsRoot, entry.id, commandName),
      pluginId: entry.id,
      pluginTitle: entry.title,
      extensionName: entry.name ?? entry.id,
      ownerOrAuthorName:
        entry.owner ??
        entry.author ??
        (entry.sourceRef.kind === "store" ? entry.sourceRef.author : undefined),
      commandName,
      commandMode: command?.mode ?? "view",
      appearance: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      storageFilePath: pluginStorageFilePath(this.pluginsRoot, entry.id),
      cacheFilePath: pluginCacheFilePath(this.pluginsRoot, entry.id),
      supportPath: pluginSupportDir(this.pluginsRoot, entry.id),
      assetsPath: pluginAssetsDir(this.pluginsRoot, entry.id),
      preferenceValues: resolvePreferenceValues(entry, commandName),
      launchArguments: options.arguments ?? {},
      launchContext: options.launchContext,
      fallbackText: options.fallbackText,
    };
  }

  /** Effects that need to know which plugin sent them; the rest go to
   *  `main-rpc.ts`. */
  private async handleEffect(
    entry: PluginRegistryEntry,
    commandName: string,
    effect: HostEffect,
  ): Promise<void> {
    switch (effect.op) {
      case "launch-command": {
        const result = this.launch(
          entry.id,
          effect.name,
          {
            arguments: effect.arguments,
            launchContext: effect.context,
            fallbackText: effect.fallbackText,
          },
          pushRouteFromMain,
        );
        if (!result.ok)
          console.error("[plugin-engine] launchCommand:", result.error);
        return;
      }
      case "open-preferences":
        pushRouteFromMain("plugin-preferences", {
          pluginId: entry.id,
          focusCommand: effect.commandName,
        });
        return;
      case "update-command-metadata":
        this.registry.setCommandSubtitle(
          entry.id,
          commandName,
          effect.subtitle,
        );
        this.reloadRegistry();
        return;
      default:
        await applyHostEffect(effect);
    }
  }

  private async runNoView(
    entry: PluginRegistryEntry,
    commandName: string,
    options: LaunchOptions,
  ): Promise<void> {
    const blocker = this.legacyBlocker(entry);
    if (blocker) {
      new Notification({ title: entry.title, body: blocker }).show();
      return;
    }
    const result = await runNoViewCommand(
      this.runInput(entry, commandName, options),
      {
        onEffect: (effect) => this.handleEffect(entry, commandName, effect),
        onRequest: handleHostRequest,
      },
    );
    if (!result.ok) {
      console.error(
        `[plugin-engine] "${entry.id}/${commandName}" failed:`,
        result.error,
      );
      const title =
        entry.commands.find((c) => c.name === commandName)?.title ??
        commandName;
      new Notification({
        title: `${title} failed`,
        body: result.error.slice(0, 300),
      }).show();
    }
  }

  registerIpc(ipc: IpcMain): void {
    registerPluginEngineIpc(ipc, this);
  }

  /** Called by `ipc.ts` when a plugin view screen mounts for `instanceId`. */
  attachListInstance(
    instanceId: string,
    actionId: string,
    ownerId: number,
    onMessage: (message: PluginHostMessage) => void,
  ): void {
    const resolved = this.commands.get(actionId);
    if (!resolved) {
      onMessage({
        type: "error",
        instanceId,
        message: `unknown command "${actionId}"`,
      });
      return;
    }
    const options = this.pendingLaunches.get(instanceId) ?? {};
    this.pendingLaunches.delete(instanceId);
    const { entry, commandName } = resolved;
    const blocker = this.legacyBlocker(entry);
    if (blocker) {
      onMessage({ type: "error", instanceId, message: blocker });
      return;
    }
    listHostManager.spawn(
      instanceId,
      ownerId,
      this.runInput(entry, commandName, options),
      {
        onMessage,
        onEffect: (effect) => this.handleEffect(entry, commandName, effect),
        onRequest: handleHostRequest,
      },
    );
  }

  sendListEvent(instanceId: string, event: PluginInboundEvent): void {
    listHostManager.sendEvent(instanceId, event);
  }
}
