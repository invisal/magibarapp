/**
 * The wire protocol between a running plugin process (the `utilityProcess`
 * hosting a `List` command's reconciler — see `api-shim/src/reconciler.ts`)
 * and the main process, and between main and the renderer's
 * `PluginListScreen`. Plain data only, no Electron types, so it's shared
 * between the node-side host and the renderer's `map-tree.ts` unchanged.
 *
 * Filtering happens *inside* the shim's `List` component (mirroring real
 * Raycast behavior: a plugin can opt out with `filtering={false}`), so every
 * tree that reaches main is already the correct, final set — nothing here
 * ever needs to be re-filtered downstream.
 */

export interface PluginActionNode {
  id: string;
  title: string;
  icon?: string;
  shortcut?: string;
  style?: "default" | "destructive";
  /** A hint for a default icon only — the shim resolves real behavior, main
   *  never special-cases it. `"submit-form"` is also how
   *  `renderer/PluginFormScreen.tsx` knows to send a `form-submit` event
   *  instead of the ordinary `action-invoked` one when this action fires. */
  kind?:
    | "copy-to-clipboard"
    | "open-in-browser"
    | "open"
    | "generic"
    | "submit-form"
    | "push"
    | "paste"
    | "show-in-finder"
    | "trash";
}

export interface PluginActionPanelNode {
  sections: { title?: string; actions: PluginActionNode[] }[];
}

export interface PluginAccessory {
  text?: string;
  icon?: string;
  tag?: { value: string; color?: string };
}

export interface PluginDetailMetadataLabel {
  kind: "label";
  title: string;
  text?: string;
  icon?: string;
}

export interface PluginDetailMetadataTagListItem {
  text: string;
  color?: string;
}

export interface PluginDetailMetadataTagList {
  kind: "tag-list";
  title: string;
  items: PluginDetailMetadataTagListItem[];
}

export interface PluginDetailMetadataLink {
  kind: "link";
  title: string;
  target: string;
  text: string;
}

export interface PluginDetailMetadataSeparator {
  kind: "separator";
}

export type PluginDetailMetadataItem =
  | PluginDetailMetadataLabel
  | PluginDetailMetadataTagList
  | PluginDetailMetadataLink
  | PluginDetailMetadataSeparator;

export interface PluginDetailBody {
  markdown?: string;
  isLoading?: boolean;
  metadata?: PluginDetailMetadataItem[];
}

export interface PluginListItemNode {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  accessories?: PluginAccessory[];
  actionPanel?: PluginActionPanelNode;
  detail?: PluginDetailBody;
}

export interface PluginListSection {
  id: string;
  title?: string;
  items: PluginListItemNode[];
}

/** `List.Dropdown.Item`. */
export interface PluginDropdownItemNode {
  value: string;
  title: string;
  icon?: string;
}

/** `List.Dropdown.Section`. */
export interface PluginDropdownSection {
  title?: string;
  items: PluginDropdownItemNode[];
}

/** `List`'s `searchBarAccessory` — v1 only supports a `List.Dropdown` there
 *  (real Raycast allows other accessories too, but a dropdown is the only
 *  one the extensions this engine has been validated against actually use). */
export interface PluginDropdownNode {
  tooltip?: string;
  placeholder?: string;
  /** The currently selected item's value — controlled by the plugin's own
   *  `value`/`onChange`, same as real Raycast. */
  value?: string;
  isLoading?: boolean;
  sections: PluginDropdownSection[];
}

/** `List`/`Grid` selection and paging — the callbacks stay in the plugin
 *  process; the renderer answers with `selection-changed` / `load-more`. */
export interface PluginSelectionAndPaging {
  /** Highlight this item (controlled selection). */
  selectedItemId?: string;
  /** `pagination.hasMore` — the renderer asks for more near the end. */
  hasMore?: boolean;
  /** Debounce `search-text-changed` before sending it. */
  throttle?: boolean;
}

/** Fields every top-level view tree carries, whatever its `type`. */
export interface PluginViewTreeBase {
  /** How many views `useNavigation().push()`/`Action.Push` have stacked on
   *  top of the command's root view — `0` for the root itself. The renderer
   *  sends a `pop` event instead of leaving the screen while this is > 0. */
  navigationDepth?: number;
  /** The search text this frame last saw — restored into the renderer's
   *  search input when a pushed view pops back to this one. */
  searchText?: string;
}

export interface PluginListTree
  extends PluginViewTreeBase, PluginSelectionAndPaging {
  type: "list";
  isLoading: boolean;
  searchBarPlaceholder?: string;
  searchBarAccessory?: PluginDropdownNode;
  sections: PluginListSection[];
  emptyView?: { title: string; description?: string; icon?: string };
  /** Show the highlighted item's `detail` pane beside the list. */
  isShowingDetail?: boolean;
}

export interface PluginDetailTree extends PluginViewTreeBase {
  type: "detail";
  isLoading: boolean;
  navigationTitle?: string;
  markdown?: string;
  metadata?: PluginDetailMetadataItem[];
  actionPanel?: PluginActionPanelNode;
}

export interface PluginGridItemNode {
  id: string;
  title?: string;
  subtitle?: string;
  /** An icon name, or a `data:`/`file:`/`https:` image URL — same
   *  resolution the renderer's `iconSrc()` already does for other icons. */
  content: string;
  actionPanel?: PluginActionPanelNode;
}

export interface PluginGridSection {
  id: string;
  title?: string;
  items: PluginGridItemNode[];
}

export type PluginGridAspectRatio =
  "1" | "3/2" | "2/3" | "4/3" | "3/4" | "16/9" | "9/16";
export type PluginGridFit = "contain" | "fill";
export type PluginGridInset = "none" | "small" | "medium" | "large";

export interface PluginGridTree
  extends PluginViewTreeBase, PluginSelectionAndPaging {
  type: "grid";
  isLoading: boolean;
  searchBarPlaceholder?: string;
  searchBarAccessory?: PluginDropdownNode;
  columns?: number;
  aspectRatio?: PluginGridAspectRatio;
  fit?: PluginGridFit;
  inset?: PluginGridInset;
  sections: PluginGridSection[];
  emptyView?: { title: string; description?: string; icon?: string };
}

export interface PluginFormFieldBase {
  id: string;
  title?: string;
  info?: string;
  error?: string;
  /** Accepted for signature compatibility, not enforced in v1 — real
   *  Raycast persists a field's value across command launches when set. */
  storeValue?: boolean;
}

export interface PluginFormTextFieldNode extends PluginFormFieldBase {
  kind: "text-field" | "password-field" | "text-area";
  placeholder?: string;
  value?: string;
}

export interface PluginFormCheckboxNode extends PluginFormFieldBase {
  kind: "checkbox";
  label?: string;
  value?: boolean;
}

export interface PluginFormPickerItemNode {
  value: string;
  title: string;
  icon?: string;
}

export interface PluginFormDropdownNode extends PluginFormFieldBase {
  kind: "dropdown";
  value?: string;
  items: PluginFormPickerItemNode[];
}

export interface PluginFormTagPickerNode extends PluginFormFieldBase {
  kind: "tag-picker";
  value?: string[];
  items: PluginFormPickerItemNode[];
}

export interface PluginFormDatePickerNode extends PluginFormFieldBase {
  kind: "date-picker";
  value?: string;
  type?: "date" | "datetime";
}

export interface PluginFormFilePickerNode extends PluginFormFieldBase {
  kind: "file-picker";
  value?: string[];
  allowMultiple?: boolean;
  canChooseDirectories?: boolean;
}

export interface PluginFormSeparatorNode {
  kind: "separator";
}

export interface PluginFormDescriptionNode {
  kind: "description";
  title?: string;
  text: string;
}

export type PluginFormItemNode =
  | PluginFormTextFieldNode
  | PluginFormCheckboxNode
  | PluginFormDropdownNode
  | PluginFormTagPickerNode
  | PluginFormDatePickerNode
  | PluginFormFilePickerNode
  | PluginFormSeparatorNode
  | PluginFormDescriptionNode;

export interface PluginFormTree extends PluginViewTreeBase {
  type: "form";
  isLoading: boolean;
  navigationTitle?: string;
  items: PluginFormItemNode[];
  actionPanel?: PluginActionPanelNode;
}

/** Every top-level view shape a command's render tree can be. Routing to
 *  the right screen happens after this arrives (see
 *  `renderer/PluginViewScreen.tsx`), never from the manifest, since a
 *  command's `mode: "view"` entry doesn't say which of these it renders. */
export type PluginViewTree =
  PluginListTree | PluginDetailTree | PluginGridTree | PluginFormTree;

/** Sent main -> renderer for one `PluginListScreen` instance. */
export type PluginHostMessage =
  | { type: "render"; instanceId: string; tree: PluginViewTree }
  /** An unsupported top-level component (Form/Grid/MenuBarExtra/…) threw
   *  during render — see `api-shim/src/unsupported.ts`. */
  | { type: "error"; instanceId: string; message: string }
  /** `popToRoot()` — the screen collapses its own route stack back to the
   *  launcher root, mirroring real Raycast (see `host/list-host-manager.ts`). */
  | { type: "pop-to-root"; instanceId: string }
  /** `clearSearchBar()` — the screen resets its own search input. */
  | { type: "clear-search-bar"; instanceId: string }
  /** `showToast()` from a view command — shown in the screen itself (like
   *  Raycast's own toast), not as an OS notification. `null` hides it. */
  | {
      type: "toast";
      instanceId: string;
      toast: { title: string; message?: string; style?: string } | null;
    };

/** Sent renderer -> main -> the plugin process, for one instance. */
export type PluginInboundEvent =
  | { type: "search-text-changed"; text: string }
  | { type: "action-invoked"; actionId: string }
  /** The `searchBarAccessory` dropdown's selection changed — invokes the
   *  plugin's own `List.Dropdown`'s `onChange`. */
  | { type: "dropdown-value-changed"; value: string }
  /** One `Form` field's value changed — drives that field's own `onChange`
   *  live, independent of submission. */
  | { type: "form-value-changed"; fieldId: string; value: unknown }
  /** `Action.SubmitForm` fired — carries the renderer's complete current
   *  snapshot of every field's value, not just what prior
   *  `form-value-changed` events already reported (that snapshot is what
   *  the renderer holds anyway, to drive the controlled inputs). */
  | { type: "form-submit"; values: Record<string, unknown> }
  /** Escape on a pushed view — pops the plugin's own navigation stack one
   *  level (only sent while the tree's `navigationDepth` > 0). */
  | { type: "pop" }
  /** The highlighted row changed — its item id, or `null` for none. */
  | { type: "selection-changed"; itemId: string | null }
  /** The user reached the end of a list whose tree says `hasMore`. */
  | { type: "load-more" }
  | { type: "dispose" };

/**
 * A side effect a command asked for via a shim API (`showToast`,
 * `Clipboard.copy`, `open`, …) — the one type both process kinds and both
 * directions share: `api-shim/src/host-bridge.ts`'s `HostTransport.sendEffect`
 * produces these from inside a plugin bundle, `host/main-rpc.ts` turns them
 * into real OS actions.
 */
export type HostEffect =
  | { op: "toast"; title: string; message?: string; style?: string }
  | { op: "hide-toast" }
  | { op: "hud"; title: string }
  | { op: "clipboard-copy"; text: string }
  | { op: "clipboard-paste"; text: string }
  | { op: "clipboard-clear" }
  | { op: "open"; target: string; application?: string }
  | { op: "show-in-finder"; path: string }
  | { op: "close-main-window" }
  /** `launchCommand()` — another command of the *same* plugin. */
  | {
      op: "launch-command";
      name: string;
      arguments?: Record<string, unknown>;
      context?: unknown;
      fallbackText?: string;
    }
  /** `openExtensionPreferences()` / `openCommandPreferences()`. */
  | { op: "open-preferences"; commandName?: string }
  /** `updateCommandMetadata({ subtitle })` — `null` clears an override. */
  | { op: "update-command-metadata"; subtitle: string | null };

/**
 * A request a plugin makes that needs an answer from main (unlike a
 * fire-and-forget `HostEffect`) — `api-shim/src/host-bridge.ts`'s
 * `HostTransport.request`, answered by `host/main-rpc.ts`'s
 * `handleHostRequest`.
 */
export type HostRequest =
  | { method: "clipboard-read" }
  | { method: "confirm-alert"; options: ConfirmAlertOptions }
  | { method: "get-applications"; path?: string }
  | { method: "get-frontmost-application" }
  | { method: "get-default-application"; path: string }
  | { method: "trash"; paths: string[] };

/** `@raycast/api`'s `Application`. */
export interface HostApplication {
  name: string;
  path: string;
  bundleId?: string;
}

/**
 * `confirmAlert()`'s options, trimmed to what a native OS dialog can actually
 * show — `Alert.ActionStyle`/icons are accepted by the shim's public API
 * (`api-shim/src/apis/alert.ts`) for signature compatibility but don't
 * survive into this wire shape, same spirit as `Toast`'s style being
 * decorative-only over a plain `Notification`.
 */
export interface ConfirmAlertOptions {
  title: string;
  message?: string;
  primaryActionTitle?: string;
  dismissActionTitle?: string;
}

/** How a no-view command's run ended — its effects were already applied
 *  live as they streamed in (see `host/no-view-runner.ts`). */
export type NoViewOutput = { ok: true } | { ok: false; error: string };

export const PLUGIN_ENGINE_CHANNELS = {
  /** Renderer -> main: fetch+bundle+register an extension. Resolves once
   *  installed (or with an error) — see `install/install.ts`. */
  install: "plugin-engine:install",
  /** Renderer -> main: a `PluginListScreen` mounted for `instanceId` and
   *  wants `actionId`'s command spawned/attached. Fire-and-forget — replies
   *  arrive on `listMessage` as they happen, not as a response here. */
  listAttach: "plugin-list:attach",
  /** Renderer -> main: the screen unmounted; kill the instance. */
  listDetach: "plugin-list:detach",
  /** Renderer -> main: a `PluginInboundEvent` for a running instance
   *  (search text changed, an action was invoked). */
  listSendEvent: "plugin-list:send-event",
  /** Main -> renderer: a `PluginHostMessage` for some instance — every
   *  `PluginListScreen` listens and filters by its own `instanceId`. */
  listMessage: "plugin-list:message",
  /** Renderer -> main: search the Raycast Store — see `install/store.ts`. */
  searchStore: "plugin-engine:search-store",
  /** Main -> renderer: install progress, one message per stage change. */
  installProgress: "plugin-engine:install-progress",
  /** Renderer -> main: every installed plugin, for "Manage Extensions". */
  listInstalled: "plugin-engine:list-installed",
  /** Renderer -> main: one installed plugin's preference schema + values. */
  getPreferences: "plugin-engine:get-preferences",
  /** Renderer -> main: persist preference values for one plugin. */
  setPreferences: "plugin-engine:set-preferences",
  /** Renderer -> main: reinstall one plugin from wherever it came from. */
  reinstall: "plugin-engine:reinstall",
  /** Renderer -> main: remove one installed plugin, files and all. */
  uninstall: "plugin-engine:uninstall",
  /** Renderer -> main: launch a command once its preferences/arguments are
   *  collected — resolves with the route to show next, if any. */
  launch: "plugin-engine:launch",
  /** Renderer -> main: open an extension's Raycast Store page in the browser. */
  openStorePage: "plugin-engine:open-store-page",
} as const;

/** One Raycast Store listing matching a search query — see `install/store.ts`. */
export interface StoreExtensionSearchResult {
  /** The extension's manifest `name` (its raycast/extensions folder name). */
  name: string;
  /** The author's Store handle — `name` alone isn't globally unique. */
  author: string;
  authorName?: string;
  title: string;
  description?: string;
  /** Already downscaled and inlined as a `data:` URI (or `null`). */
  iconDataUri: string | null;
  /** `null` means the listing predates the field: macOS only. */
  platforms: string[] | null;
  downloadCount: number;
  commandCount: number;
  /** Whether this platform can run it (see `platforms`). */
  supported: boolean;
  /** Already installed (matched by plugin id). */
  installed: boolean;
}

export type SearchStoreResponse =
  | { ok: true; results: StoreExtensionSearchResult[] }
  | { ok: false; error: string };

export type InstallSourceInput =
  | {
      kind: "store";
      name: string;
      author?: string;
      /** Set when this came from a raycast/extensions GitHub link: the
       *  folder (and ref) to read the real manifest `name`/`author` from —
       *  folder names don't always match (`google-translate` is `translate`). */
      folder?: { name: string; ref: string | null };
    }
  | { kind: "github"; url: string }
  | { kind: "local"; path: string };

export interface InstallRequest {
  source: InstallSourceInput;
  /** Echoed back on every `installProgress` message for this install. */
  requestId: string;
}

export type InstallStage =
  | "resolving"
  | "downloading"
  | "extracting"
  | "fetching"
  | "installing-dependencies"
  | "bundling"
  | "finishing";

export interface InstallProgress {
  requestId: string;
  stage: InstallStage;
  /** Human-readable, e.g. "Downloading 3.2 / 11.7 MB". */
  message: string;
}

export type InstallResponse =
  | {
      ok: true;
      pluginId: string;
      title: string;
      /** Required preferences with no value yet — the renderer routes to the
       *  preferences screen when this is non-empty. */
      needsPreferences: boolean;
    }
  | { ok: false; error: string };

/** A manifest preference, as the renderer's preferences form needs it. */
export interface PluginPreferenceField {
  name: string;
  type:
    | "textfield"
    | "password"
    | "checkbox"
    | "dropdown"
    | "appPicker"
    | "file"
    | "directory";
  title?: string;
  description?: string;
  placeholder?: string;
  /** `checkbox` only: the text beside the box. */
  label?: string;
  required: boolean;
  default?: unknown;
  data?: { title: string; value: string }[];
  /** `undefined` for an extension-level preference. */
  commandName?: string;
  commandTitle?: string;
}

/** A command argument (`LaunchProps.arguments`), as the renderer's argument
 *  form needs it. */
export interface PluginArgumentField {
  name: string;
  type: "text" | "password" | "dropdown";
  placeholder?: string;
  required: boolean;
  data?: { title: string; value: string }[];
}

export interface PluginPreferencesPayload {
  pluginId: string;
  title: string;
  fields: PluginPreferenceField[];
  /** Keyed by preference name — command-level names are prefixed
   *  `<commandName>.` so two commands' same-named preferences never clash. */
  values: Record<string, unknown>;
}

export interface InstalledPluginSummary {
  id: string;
  title: string;
  description?: string;
  version?: string;
  author?: string;
  source: "store" | "github" | "local";
  /** The Store listing name, for a Store install (updates re-resolve it). */
  storeName?: string;
  commandCount: number;
  hasPreferences: boolean;
  missingRequiredPreferences: boolean;
  iconDataUri: string | null;
}
