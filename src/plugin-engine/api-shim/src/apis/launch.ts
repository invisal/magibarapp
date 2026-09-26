/**
 * Command-lifecycle APIs: `LaunchType`, `launchCommand`,
 * `updateCommandMetadata`, `open{Extension,Command}Preferences`. All
 * fire-and-forget effects main resolves against the plugin that sent them
 * (see `host/PluginHostSource.ts`) — the shim never needs to know what else
 * is installed.
 */
import { getHostTransport } from "../host-bridge.ts";
import { getPluginContext } from "../context.ts";

export const LaunchType = {
  UserInitiated: "userInitiated",
  Background: "background",
} as const;

export interface LaunchOptions {
  name: string;
  type?: (typeof LaunchType)[keyof typeof LaunchType];
  arguments?: Record<string, unknown>;
  context?: unknown;
  fallbackText?: string;
  /** Another extension's command — not supported (see below). */
  extensionName?: string;
  ownerOrAuthorName?: string;
}

/** Only commands of the calling extension itself: cross-extension launches
 *  would need a stable id for another installed extension that the caller
 *  can't know how Magibar assigned. */
export async function launchCommand(options: LaunchOptions): Promise<void> {
  const ctx = getPluginContext();
  if (
    options.extensionName &&
    options.extensionName !== ctx.extensionName &&
    options.extensionName !== ctx.pluginId
  ) {
    throw new Error(
      `launchCommand: launching another extension's command ("${options.extensionName}") isn't supported in Magibar`,
    );
  }
  // A background launch is how extensions refresh a menu-bar/interval
  // command's data — there's nothing to run in the background here yet.
  if (options.type === LaunchType.Background) return;
  getHostTransport().sendEffect({
    op: "launch-command",
    name: options.name,
    arguments: options.arguments,
    context: options.context,
    fallbackText: options.fallbackText,
  });
}

export async function updateCommandMetadata(metadata: {
  subtitle?: string | null;
}): Promise<void> {
  getHostTransport().sendEffect({
    op: "update-command-metadata",
    subtitle: metadata.subtitle ?? null,
  });
}

export async function openExtensionPreferences(): Promise<void> {
  getHostTransport().sendEffect({ op: "open-preferences" });
}

export async function openCommandPreferences(): Promise<void> {
  getHostTransport().sendEffect({
    op: "open-preferences",
    commandName: getPluginContext().commandName,
  });
}
