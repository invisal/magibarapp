/**
 * The message shapes between main and the two plugin host processes —
 * `list-host-process.ts` (a `utilityProcess`, over `parentPort`) and
 * `no-view-worker.ts` (a Node child, over its IPC channel). Internal to
 * those channels, unlike `protocol.ts`'s types, which also cross into the
 * renderer.
 */
import type { HostEffect, HostRequest, PluginViewTree } from "./protocol.ts";

/** Everything a host process needs to run one command — resolved by
 *  `PluginHostSource` from the registry entry at launch time. */
export interface CommandRunInput {
  bundlePath: string;
  pluginId: string;
  pluginTitle: string;
  /** The manifest `name` — `environment.extensionName`. */
  extensionName: string;
  ownerOrAuthorName?: string;
  commandName: string;
  commandMode: "view" | "no-view";
  appearance: "light" | "dark";
  storageFilePath: string;
  cacheFilePath: string;
  supportPath: string;
  assetsPath: string;
  /** Already merged with manifest defaults — see
   *  `preferences.ts`'s `resolvePreferenceValues`. */
  preferenceValues: Record<string, unknown>;
  /** `LaunchProps.arguments`. */
  launchArguments?: Record<string, unknown>;
  /** `LaunchProps.launchContext` (from another command's `launchCommand`). */
  launchContext?: unknown;
  fallbackText?: string;
}

export type ListStartInput = CommandRunInput;

/** A request's answer, relayed back to the host that asked. */
export type HostResponseMessage = {
  type: "response";
  requestId: number;
} & ({ ok: true; result: unknown } | { ok: false; error: string });

/** A host asking main something — see `protocol.ts`'s `HostRequest`. */
export interface HostRequestMessage {
  type: "request";
  requestId: number;
  request: HostRequest;
}

/** main -> List host */
export type ListHostParentMessage =
  | { type: "start"; input: ListStartInput }
  | { type: "search-text-changed"; text: string }
  | { type: "action-invoked"; actionId: string }
  | { type: "dropdown-value-changed"; value: string }
  | { type: "form-value-changed"; fieldId: string; value: unknown }
  | { type: "form-submit"; values: Record<string, unknown> }
  | { type: "pop" }
  | HostResponseMessage
  | { type: "dispose" };

/** List host -> main */
export type ListHostChildMessage =
  | { type: "render"; tree: PluginViewTree }
  | { type: "error"; message: string }
  | { type: "effect"; effect: HostEffect }
  | HostRequestMessage
  /** Both fire-and-forget: unlike `effect`, these target *this* instance's
   *  own renderer screen (route stack / search input), not a global OS
   *  action — `list-host-manager.ts` forwards them as a `PluginHostMessage`
   *  instead of routing through `main-rpc.ts`. */
  | { type: "pop-to-root" }
  | { type: "clear-search-bar" };

/** main -> no-view worker */
export type NoViewParentMessage =
  { type: "start"; input: CommandRunInput } | HostResponseMessage;

/** no-view worker -> main */
export type NoViewChildMessage =
  | { type: "effect"; effect: HostEffect }
  | HostRequestMessage
  | { type: "done"; ok: true }
  | { type: "done"; ok: false; error: string };
