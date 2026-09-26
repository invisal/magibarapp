/**
 * The crux of real `@raycast/api` compatibility: a `react-reconciler` host
 * config whose "DOM" is a tiny in-memory tree of plain nodes (`HostNode`),
 * built from the intrinsic element types the components in `components/*.tsx`
 * create (`"list"`, `"list-item"`, `"action"`, …). A plugin's actual JSX —
 * hooks, state, conditional rendering — runs unmodified against this; only
 * the "DOM" it renders into is ours.
 *
 * Mutation mode (`supportsMutation: true`), the same mode react-dom uses: the
 * host config mutates `HostNode.children` in place as React commits changes,
 * and `resetAfterCommit` — called once per commit, after mutations settle —
 * is where the committed tree gets serialized into a `PluginListTree` and
 * handed to `host-bridge.ts`'s `HostTransport`.
 *
 * Many `HostConfig` fields below are required by the type but irrelevant to
 * this renderer (Suspense commit-timing, `<form>` actions, transitions,
 * hydration, React DevTools instance lookups) — this renderer never exercises
 * those React features, so they're inert stubs, grouped and short rather than
 * commented one by one.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import { Component, createContext, createElement, type ReactNode } from "react";
import type {
  PluginAccessory,
  PluginActionNode,
  PluginActionPanelNode,
  PluginDetailBody,
  PluginDetailMetadataItem,
  PluginDetailTree,
  PluginDropdownItemNode,
  PluginDropdownNode,
  PluginDropdownSection,
  PluginFormItemNode,
  PluginFormPickerItemNode,
  PluginFormTree,
  PluginGridItemNode,
  PluginGridSection,
  PluginGridTree,
  PluginListItemNode,
  PluginListSection,
  PluginListTree,
  PluginViewTree,
} from "../../host/protocol";
import {
  actionRegistry,
  dropdownChangeStore,
  formFieldChangeStore,
  formSubmitStore,
  getHostTransport,
  listCallbackStore,
  searchTextStore,
  type Pagination,
} from "./host-bridge.ts";
import { getPluginContext } from "./context.ts";
import { NavigationRoot } from "./navigation.ts";
import { filterHostChildren } from "./components/searchFilter.ts";
import { iconGlyph, isRaycastIconName } from "./icon-glyphs.ts";
import { toAccelerator } from "./apis/shortcut-format.ts";
import { Cache } from "./apis/cache.ts";

interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostNode[];
}

interface RootContainer {
  children: HostNode[];
}

function createNode(type: string, props: Record<string, unknown>): HostNode {
  return { type, props, children: [] };
}

function insertChild(
  children: HostNode[],
  child: HostNode,
  before: HostNode | null,
): void {
  const index = before ? children.indexOf(before) : -1;
  if (index === -1) children.push(child);
  else children.splice(index, 0, child);
}

function removeChild(children: HostNode[], child: HostNode): void {
  const index = children.indexOf(child);
  if (index !== -1) children.splice(index, 1);
}

/* ------------------------------ host config ------------------------------ */

const hostConfig: ReactReconciler.HostConfig<
  string,
  Record<string, unknown>,
  RootContainer,
  HostNode,
  HostNode,
  never,
  never,
  never,
  HostNode,
  Record<string, never>,
  never,
  ReturnType<typeof setTimeout>,
  number,
  null
> = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  createInstance: (type, props) => createNode(type, props),
  // No host element treats its React children as literal text (title/subtitle
  // are plain props, never JSX text nodes) — a stray text child is inert.
  createTextInstance: (text) => createNode("text", { text }),
  appendInitialChild: (parent, child) => parent.children.push(child),
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  // A plain placeholder, not `null` — React's DEV-mode host-context stack
  // treats `null` as "nothing pushed" and warns ("Expected host context to
  // exist"); host context itself is otherwise unused, since nothing here
  // needs to know where it sits in the tree.
  getRootHostContext: () => ({}),
  getChildHostContext: (parent) => parent,
  getPublicInstance: (instance) => instance,
  preparePortalMount: () => {},
  prepareForCommit: () => null,

  resetAfterCommit: (container) => {
    try {
      actionRegistry.reset();
      dropdownChangeStore.reset();
      formFieldChangeStore.reset();
      formSubmitStore.reset();
      listCallbackStore.reset();
      const tree = serializeContainer(container);
      if (tree) getHostTransport().sendRenderTree(tree);
    } catch (error) {
      getHostTransport().sendRenderError(
        error instanceof Error ? error.message : String(error),
      );
    }
  },

  appendChild: (parent, child) => parent.children.push(child),
  appendChildToContainer: (container, child) => container.children.push(child),
  insertBefore: (parent, child, before) =>
    insertChild(parent.children, child, before as HostNode),
  insertInContainerBefore: (container, child, before) =>
    insertChild(container.children, child, before as HostNode),
  removeChild: (parent, child) =>
    removeChild(parent.children, child as HostNode),
  removeChildFromContainer: (container, child) =>
    removeChild(container.children, child as HostNode),
  commitUpdate: (instance, _type, _prevProps, nextProps) => {
    instance.props = nextProps;
  },
  commitTextUpdate: (textInstance, _oldText, newText) => {
    textInstance.props.text = newText;
  },
  clearContainer: (container) => {
    container.children = [];
  },

  scheduleTimeout: (fn, delay) => setTimeout(fn, delay),
  cancelTimeout: (id) => clearTimeout(id),
  noTimeout: -1,

  // Suspense / scope / devtools hooks this renderer never uses.
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,

  // Transitions / <form> actions: unused, since plugin commands never render
  // a real `<form>` and this renderer predates any transition-aware API.
  NotPendingTransition: null,
  // React's public `Context<T>` and react-reconciler's internal `ReactContext<T>`
  // describe the same real object differently (the latter exposes React's own
  // internal fields) — the object `createContext` returns satisfies both at
  // runtime, so this cast is safe.
  HostTransitionContext: createContext<null>(
    null,
  ) as unknown as ReactReconciler.ReactContext<null>,
  resetFormInstance: () => {},
  requestPostPaintCallback: (cb) => cb(0),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  setCurrentUpdatePriority: (priority) => {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () => currentUpdatePriority || DefaultEventPriority,
};

let currentUpdatePriority: ReactReconciler.EventPriority = DefaultEventPriority;

const Reconciler = ReactReconciler(hostConfig);

function onUncaughtError(error: unknown): void {
  console.error("[plugin-engine] uncaught render error:", error);
}
function onCaughtError(error: unknown): void {
  console.error("[plugin-engine] render error (caught by boundary):", error);
}
function onRecoverableError(error: unknown): void {
  console.error("[plugin-engine] recoverable render error:", error);
}

/** Catches a top-level unsupported view (`Detail`/`Form`/`Grid` throw as soon
 *  as React tries to render them — see `unsupported.ts`) and reports it
 *  through the transport instead of leaving the tree in a half-rendered
 *  state. Renders `null` once tripped: `resetAfterCommit` then sees an empty
 *  container and — correctly — sends nothing further, since the error was
 *  already reported here. */
class RootBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    getHostTransport().sendRenderError(
      error instanceof Error ? error.message : String(error),
    );
  }

  render(): ReactNode {
    return this.state.hasError ? null : this.props.children;
  }
}

export interface PluginRoot {
  render(element: ReactNode): void;
  dispose(): void;
}

/**
 * Forces `fn` (a `render()` call, or an inbound event like a search-text
 * change or an action's `onAction` state update) to commit synchronously
 * before returning, rather than leaving it to the scheduler's own timing.
 * `list-host-process.ts` wraps every inbound event dispatch in this so a
 * commit — and the `PluginListTree` push it triggers — has definitely
 * happened by the time the event is considered handled.
 */
export function flushSync(fn: () => void): void {
  // `flushSyncFromReconciler`, not `flushSync` — this package version's
  // runtime only actually exports the former, despite its `.d.ts` listing
  // both (confirmed by grepping the installed `cjs/react-reconciler
  // .development.js`: `flushSync` isn't assigned anywhere in it).
  Reconciler.flushSyncFromReconciler(fn);
}

/** One root per running command instance. */
export function createPluginRoot(): PluginRoot {
  const container: RootContainer = { children: [] };
  const root = Reconciler.createContainer(
    container,
    1 /* ConcurrentRoot */,
    null,
    false,
    null,
    "magibar-",
    onUncaughtError,
    onCaughtError,
    onRecoverableError,
    () => {},
  );

  return {
    render(element) {
      flushSync(() =>
        Reconciler.updateContainer(
          createElement(
            RootBoundary,
            null,
            createElement(NavigationRoot, { root: element }),
          ),
          root,
          null,
          null,
        ),
      );
    },
    /** Synchronous, like `render` — `list-host-process.ts` exits right
     *  after, and the unmount (the command's effect cleanups) must have
     *  run by then. */
    dispose() {
      flushSync(() => Reconciler.updateContainer(null, root, null, null));
    },
  };
}

/* ------------------------------ serializing ------------------------------ */

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A text prop real Raycast also accepts as `{ value, tooltip }` (list item
 *  `title`/`subtitle`, accessory `text`, …). */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "value" in value) {
    return text((value as { value: unknown }).value);
  }
  return undefined;
}

/** A path main must turn into an image (`app.getFileIcon`) — see
 *  `host/file-icons.ts`, which rewrites these before a tree reaches the
 *  renderer. */
export const FILE_ICON_PREFIX = "fileicon:";

/**
 * `Image.ImageLike` -> the plain string the renderer's `iconSrc()` resolves:
 * an `Icon.X` name, an asset file name, a URL, or an emoji. Real Raycast
 * also accepts `{ source, tintColor, mask }`, `{ source: { light, dark } }`,
 * `{ fileIcon: path }`, `{ color }` (Grid) and `{ value, tooltip }`. A tint
 * applies to glyph icons (drawn as a colored SVG); image sources and `mask`
 * are shown as-is.
 */
function icon(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (isRaycastIconName(value)) return iconGlyph(value);
    const asset = assetIcon(value);
    if (asset) return asset;
    // An app bundle, `.icns`, or any other file: its Finder icon.
    if (isAbsolute(value)) return FILE_ICON_PREFIX + value;
    return normalizeSvgDataUri(value) || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if ("source" in v) {
    const source = v.source;
    const resolved =
      source && typeof source === "object" ? themedIcon(source) : icon(source);
    const tint = color(v.tintColor);
    return resolved && tint && isTintableGlyph(resolved)
      ? glyphSvg(resolved, tint)
      : resolved;
  }
  if ("fileIcon" in v) {
    return typeof v.fileIcon === "string"
      ? FILE_ICON_PREFIX + v.fileIcon
      : undefined;
  }
  if ("color" in v) {
    const swatch = color(v.color);
    return swatch ? swatchSvg(swatch) : undefined;
  }
  if ("value" in v) return icon(v.value);
  if ("light" in v || "dark" in v) return themedIcon(v);
  return undefined;
}

/** A monochrome glyph a tint can recolor (`●`, `⊗`) — not an image to
 *  load (the renderer's `isGlyphIcon` test), and not a color emoji, which
 *  ignores `fill`. */
function isTintableGlyph(value: string): boolean {
  return !/[a-zA-Z]/.test(value) && !/\p{Extended_Pictographic}/u.test(value);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
  );
}

/** A tinted glyph — Raycast's `{ source: Icon.X, tintColor }`. */
function glyphSvg(glyph: string, fill: string): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="17" font-size="26" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(fill)}" font-family="-apple-system, system-ui, sans-serif">${escapeXml(glyph)}</text></svg>`,
  );
}

/** A solid color tile — Grid's `content: { color }`. */
function swatchSvg(fill: string): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="${escapeXml(fill)}"/></svg>`,
  );
}

function isDarkAppearance(): boolean {
  try {
    return getPluginContext().appearance === "dark";
  } catch {
    return false;
  }
}

/** `{ light, dark }` — the variant for the current appearance. */
function themedIcon(value: object): string | undefined {
  const { light, dark } = value as { light?: unknown; dark?: unknown };
  const isDark = isDarkAppearance();
  return icon(isDark ? (dark ?? light) : (light ?? dark));
}

/**
 * Extensions build `data:image/svg+xml,<svg …>` icons by hand (Hacker News
 * draws its score badges that way). Raycast renders them, but Chromium only
 * does with an `xmlns` on the root element and the markup URI-encoded — a
 * raw `#fff` would otherwise end the URL at the `#`. Anything else passes
 * through unchanged.
 */
export function normalizeSvgDataUri(value: string): string {
  const match = /^data:image\/svg\+xml(;[^,]*)?,/i.exec(value);
  if (!match || /;base64/i.test(match[1] ?? "")) return value;
  let svg = value.slice(match[0].length);
  if (!svg.includes("<")) {
    try {
      svg = decodeURIComponent(svg);
    } catch {
      return value;
    }
  }
  if (!/<svg[^>]*\sxmlns=/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const ASSET_ICON_MAX_BYTES = 512 * 1024;
const assetIconCache = new Map<string, string | null>();

/**
 * Real Raycast resolves an icon string naming an image file against the
 * extension's `assets/` folder (`icon: "command-icon.png"`), or takes an
 * absolute path as-is. The renderer can't load `file:` images (its CSP),
 * so the file is inlined here, where the filesystem is reachable. Anything
 * that isn't an image file name passes through untouched.
 */
function assetIcon(value: string): string | undefined {
  const mime = IMAGE_MIME[extname(value).toLowerCase()];
  if (!mime || /^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  if (assetIconCache.has(value)) return assetIconCache.get(value) ?? undefined;
  let result: string | null = null;
  try {
    const path = isAbsolute(value)
      ? value
      : join(getPluginContext().assetsPath, value);
    if (statSync(path).size <= ASSET_ICON_MAX_BYTES) {
      result = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    }
  } catch {
    result = null;
  }
  assetIconCache.set(value, result);
  return result ?? undefined;
}

/** Raycast's named `Color`s (`Color.Red` is the string `"Red"` here, see
 *  `index.ts`) as CSS colors, close to Raycast's own palette. */
const RAYCAST_COLORS: Record<string, string> = {
  Red: "#ff6363",
  Orange: "#ff9f43",
  Yellow: "#ffc531",
  Green: "#59d499",
  Blue: "#56c2ff",
  Purple: "#cf71ff",
  Magenta: "#ff63c3",
  PrimaryText: "currentColor",
  SecondaryText: "#8e8e93",
};

/**
 * Markdown images that name a file — `![](wheel.png)` resolved against the
 * extension's `assets/`, or an absolute path — inlined as `data:` URIs, as
 * Raycast shows them. URLs are left alone.
 */
export function markdownWithAssets(
  markdown: string | undefined,
): string | undefined {
  if (!markdown) return markdown;
  const inline = (src: string): string => {
    const [path, query] = src.split("?", 2);
    const data = assetIcon(decodeURI(path));
    return data ? (query ? `${data}?${query}` : data) : src;
  };
  return markdown
    .replace(
      /(!\[[^\]]*\]\()\s*<?([^\s)>]+)>?/g,
      (_m, head: string, src: string) => head + inline(src),
    )
    .replace(
      /(<img\b[^>]*\bsrc=")([^"]+)"/gi,
      (_m, head: string, src: string) => `${head}${inline(src)}"`,
    );
}

/** A `Color`/`Color.Dynamic`/raw CSS color -> a CSS color string. */
function color(value: unknown): string | undefined {
  if (typeof value === "string") return RAYCAST_COLORS[value] ?? value;
  if (value && typeof value === "object") {
    const { light, dark } = value as { light?: unknown; dark?: unknown };
    const isDark = isDarkAppearance();
    return color(isDark ? (dark ?? light) : (light ?? dark));
  }
  return undefined;
}

function formatDate(value: Date): string {
  const diffMs = value.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  return value.toLocaleDateString();
}

/** `List.Item.Accessory[]` -> the wire shape. Real Raycast accessories can
 *  carry `text` (string or `{ value, color }`), `date`, `tag` (string, Date,
 *  or `{ value, color }`) and `icon` — plus the legacy `{ text }`-only form. */
function accessories(value: unknown): PluginAccessory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: PluginAccessory[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const out: PluginAccessory = {};
    const t = a.date instanceof Date ? formatDate(a.date) : text(a.text);
    if (t) out.text = t;
    const i = icon(a.icon);
    if (i) out.icon = i;
    if (a.tag !== undefined && a.tag !== null) {
      const tag = a.tag as unknown;
      if (tag instanceof Date) out.tag = { value: formatDate(tag) };
      else if (typeof tag === "object") {
        const tv = (tag as { value?: unknown }).value;
        const value = tv instanceof Date ? formatDate(tv) : text(tv);
        if (value)
          out.tag = { value, color: color((tag as { color?: unknown }).color) };
      } else {
        const value = text(tag);
        if (value) out.tag = { value };
      }
    }
    if (out.text || out.icon || out.tag) result.push(out);
  }
  return result;
}

function serializeContainer(container: RootContainer): PluginViewTree | null {
  const topLevel = container.children.filter((node) => node.type !== "text");
  // Nothing rendered yet, or `RootBoundary` swallowed a caught error to
  // `null` — that error was already reported via `componentDidCatch` above.
  if (topLevel.length === 0) return null;

  // `NavigationRoot` (see `navigation.ts`) renders one `"nav-frame"` per
  // stacked view — only the top one is what the user sees. Anything rendered
  // without a `NavigationRoot` is treated as a lone root frame.
  const frames = topLevel.every((node) => node.type === "nav-frame")
    ? topLevel
    : [{ type: "nav-frame", props: {}, children: topLevel }];
  const top = frames[frames.length - 1];
  const [root, ...rest] = top.children.filter((node) => node.type !== "text");
  // A pushed view that renders `null` (e.g. while it loads) — keep showing
  // whatever was last sent rather than blanking the screen.
  if (!root) return null;
  if (rest.length > 0) {
    throw new Error(
      "a command's default export must render exactly one top-level view",
    );
  }
  const tree = buildViewTree(root);
  tree.navigationDepth = frames.length - 1;
  tree.searchText = searchTextStore.getSnapshot();
  return tree;
}

function buildViewTree(root: HostNode): PluginViewTree {
  switch (root.type) {
    case "list":
      return buildListTree(root);
    case "detail":
      return buildDetailTree(root);
    case "grid":
      return buildGridTree(root);
    case "form":
      return buildFormTree(root);
    default:
      throw new Error(
        `this command renders "${root.type}", which Magibar doesn't support yet — only List, Detail, Grid, Form, and no-view commands are implemented`,
      );
  }
}

function buildGridTree(gridNode: HostNode): PluginGridTree {
  const sections: PluginGridSection[] = [];
  let implicitItems: PluginGridItemNode[] = [];
  let emptyView: PluginGridTree["emptyView"];
  let searchBarAccessory: PluginDropdownNode | undefined;
  let sectionIndex = 0;

  const flushImplicit = (): void => {
    if (implicitItems.length === 0) return;
    sections.push({ id: `section-${sectionIndex++}`, items: implicitItems });
    implicitItems = [];
  };

  const query = str(gridNode.props.filterQuery)?.trim() ?? "";
  const children = query
    ? filterHostChildren(gridNode.children, query, "grid-item", "grid-section")
    : gridNode.children;

  for (const child of children) {
    if (child.type === "grid-section") {
      flushImplicit();
      const id = `section-${sectionIndex++}`;
      sections.push({
        id,
        title: str(child.props.title),
        items: child.children
          .filter((c) => c.type === "grid-item")
          .map((item, i) => buildGridItemNode(item, `${id}-item-${i}`)),
      });
    } else if (child.type === "grid-item") {
      implicitItems.push(
        buildGridItemNode(child, `item-${implicitItems.length}`),
      );
    } else if (child.type === "grid-empty-view") {
      emptyView = {
        title: (str(child.props.title) ?? "") as string,
        description: str(child.props.description),
        icon: icon(child.props.icon),
      };
    } else if (child.type === "list-dropdown") {
      searchBarAccessory = buildDropdown(child);
    }
  }
  flushImplicit();

  return {
    ...selectionAndPaging(gridNode),
    type: "grid",
    isLoading: Boolean(gridNode.props.isLoading),
    navigationTitle: str(gridNode.props.navigationTitle),
    searchBarPlaceholder: str(gridNode.props.searchBarPlaceholder),
    searchBarAccessory,
    columns: gridNode.props.columns as number | undefined,
    aspectRatio: gridNode.props.aspectRatio as PluginGridTree["aspectRatio"],
    fit: gridNode.props.fit as PluginGridTree["fit"],
    inset: gridNode.props.inset as PluginGridTree["inset"],
    sections,
    emptyView,
  };
}

function buildGridItemNode(
  node: HostNode,
  fallbackId: string,
): PluginGridItemNode {
  const id = itemId(node, fallbackId);
  const actionPanel = node.children.find((c) => c.type === "action-panel");
  return {
    id,
    title: text(node.props.title),
    subtitle: text(node.props.subtitle),
    content: icon(node.props.content) ?? "",
    actionPanel: actionPanel ? buildActionPanel(actionPanel, id) : undefined,
  };
}

function buildDetailTree(node: HostNode): PluginDetailTree {
  const metadataNode = node.children.find((c) => c.type === "detail-metadata");
  const actionPanel = node.children.find((c) => c.type === "action-panel");
  return {
    type: "detail",
    isLoading: Boolean(node.props.isLoading),
    navigationTitle: str(node.props.navigationTitle),
    markdown: markdownWithAssets(str(node.props.markdown)),
    metadata: metadataNode ? buildMetadataItems(metadataNode) : undefined,
    actionPanel: actionPanel
      ? buildActionPanel(actionPanel, "detail")
      : undefined,
  };
}

function buildListTree(listNode: HostNode): PluginListTree {
  const sections: PluginListSection[] = [];
  let implicitItems: PluginListItemNode[] = [];
  let emptyView: PluginListTree["emptyView"];
  let searchBarAccessory: PluginDropdownNode | undefined;
  let sectionIndex = 0;

  const flushImplicit = (): void => {
    if (implicitItems.length === 0) return;
    sections.push({ id: `section-${sectionIndex++}`, items: implicitItems });
    implicitItems = [];
  };

  const query = str(listNode.props.filterQuery)?.trim() ?? "";
  const children = query
    ? filterHostChildren(listNode.children, query, "list-item", "list-section")
    : listNode.children;

  for (const child of children) {
    if (child.type === "list-section") {
      flushImplicit();
      const id = `section-${sectionIndex++}`;
      sections.push({
        id,
        title: str(child.props.title),
        items: child.children
          .filter((c) => c.type === "list-item")
          .map((item, i) => buildItemNode(item, `${id}-item-${i}`)),
      });
    } else if (child.type === "list-item") {
      implicitItems.push(buildItemNode(child, `item-${implicitItems.length}`));
    } else if (child.type === "list-empty-view") {
      emptyView = {
        title: (str(child.props.title) ?? "") as string,
        description: str(child.props.description),
        icon: icon(child.props.icon),
      };
    } else if (child.type === "list-dropdown") {
      searchBarAccessory = buildDropdown(child);
    }
  }
  flushImplicit();

  return {
    type: "list",
    isLoading: Boolean(listNode.props.isLoading),
    navigationTitle: str(listNode.props.navigationTitle),
    searchBarPlaceholder: str(listNode.props.searchBarPlaceholder),
    searchBarAccessory,
    sections,
    emptyView,
    isShowingDetail: listNode.props.isShowingDetail === true,
    ...selectionAndPaging(listNode),
  };
}

/** Dropdowns whose initial value `onChange` has already been told. */
const announcedDropdowns = new WeakSet<HostNode>();

/** What the user last picked in each mounted dropdown — kept across commits
 *  (unlike the registered handler, rebuilt every commit) so an
 *  *uncontrolled* dropdown (`defaultValue` only) keeps echoing the pick on
 *  the wire instead of reverting to `defaultValue` on every re-render. Per
 *  node, so a pushed view's own dropdown starts fresh. */
const pickedValues = new WeakMap<HostNode, string>();

let storedValues: Cache | null = null;

/** Where a `storeValue` dropdown's last pick lives — the plugin's own cache
 *  file, in a namespace of ours, per command. */
function storedValueKey(node: HostNode): {
  cache: Cache;
  key: string;
} {
  storedValues ??= new Cache({ namespace: "magibar-stored-values" });
  const { commandName } = getPluginContext();
  return {
    cache: storedValues,
    key: `${commandName}:dropdown:${str(node.props.id) ?? ""}`,
  };
}

function buildDropdown(node: HostNode): PluginDropdownNode {
  const onChange = node.props.onChange as ((value: string) => void) | undefined;
  const storeValue = node.props.storeValue === true;
  dropdownChangeStore.register((value) => {
    pickedValues.set(node, value);
    if (storeValue) {
      const { cache, key } = storedValueKey(node);
      cache.set(key, value);
    }
    onChange?.(value);
  });

  const sections: PluginDropdownSection[] = [];
  let implicitItems: PluginDropdownItemNode[] = [];

  const flushImplicit = (): void => {
    if (implicitItems.length === 0) return;
    sections.push({ items: implicitItems });
    implicitItems = [];
  };

  for (const child of node.children) {
    if (child.type === "list-dropdown-section") {
      flushImplicit();
      sections.push({
        title: str(child.props.title),
        items: child.children
          .filter((c) => c.type === "list-dropdown-item")
          .map(buildDropdownItem),
      });
    } else if (child.type === "list-dropdown-item") {
      implicitItems.push(buildDropdownItem(child));
    }
  }
  flushImplicit();

  // A genuinely controlled dropdown (an explicit `value` every render) always
  // wins. Otherwise this is uncontrolled (`defaultValue` only) — once the
  // user has picked something, keep echoing that back rather than the
  // node's `defaultValue`, which never changes and would otherwise make the
  // wire value (and so the rendered `<select>`) revert on every re-render
  // the extension's own `onChange`-driven state update triggers.
  const items = sections.flatMap((section) => section.items);
  const stored = storeValue ? storedValueKey(node) : null;
  const storedValue = stored?.cache.get(stored.key);
  const value =
    str(node.props.value) ??
    pickedValues.get(node) ??
    (items.some((item) => item.value === storedValue)
      ? storedValue
      : undefined) ??
    str(node.props.defaultValue) ??
    items[0]?.value;

  // Raycast tells `onChange` the initial selection on mount — extensions
  // commonly load their data from it (Hacker News fetches the picked feed
  // only there), so without this they'd sit empty until the user picked.
  // After the commit, so the handler registered above is the live one.
  if (onChange && value !== undefined && !announcedDropdowns.has(node)) {
    announcedDropdowns.add(node);
    queueMicrotask(() => flushSync(() => dropdownChangeStore.invoke(value)));
  }

  return {
    tooltip: str(node.props.tooltip),
    placeholder: str(node.props.placeholder),
    value,
    isLoading: Boolean(node.props.isLoading),
    sections,
  };
}

function buildDropdownItem(node: HostNode): PluginDropdownItemNode {
  return {
    value: (str(node.props.value) ?? "") as string,
    title: (str(node.props.title) ?? "") as string,
    icon: icon(node.props.icon),
  };
}

/** The `List`/`Grid` props that are callbacks or hints rather than content:
 *  registers the callbacks (see `listCallbackStore`) and returns the tree's
 *  share of them. */
function selectionAndPaging(node: HostNode): {
  selectedItemId?: string;
  hasMore?: boolean;
  throttle?: boolean;
} {
  const pagination = node.props.pagination as Pagination | undefined;
  listCallbackStore.register({
    onSelectionChange: node.props.onSelectionChange as
      ((id: string | null) => void) | undefined,
    onLoadMore: pagination?.onLoadMore,
  });
  return {
    selectedItemId: str(node.props.selectedItemId),
    hasMore: pagination ? Boolean(pagination.hasMore) : undefined,
    throttle: node.props.throttle === true || undefined,
  };
}

/** An item's wire id: the extension's own `id` (registered, so a selection
 *  of it is reported back), else `fallbackId`. */
function itemId(node: HostNode, fallbackId: string): string {
  const own = str(node.props.id);
  if (own === undefined) return fallbackId;
  listCallbackStore.registerItemId(own);
  return own;
}

function buildItemNode(node: HostNode, fallbackId: string): PluginListItemNode {
  const id = itemId(node, fallbackId);
  const actionPanel = node.children.find((c) => c.type === "action-panel");
  const detail = node.children.find((c) => c.type === "list-item-detail");
  return {
    id,
    title: text(node.props.title) ?? "",
    subtitle: text(node.props.subtitle),
    icon: icon(node.props.icon),
    accessories: accessories(node.props.accessories),
    actionPanel: actionPanel ? buildActionPanel(actionPanel, id) : undefined,
    detail: detail ? buildDetailBody(detail) : undefined,
  };
}

function buildDetailBody(node: HostNode): PluginDetailBody {
  const metadataNode = node.children.find((c) => c.type === "detail-metadata");
  return {
    markdown: markdownWithAssets(str(node.props.markdown)),
    isLoading: Boolean(node.props.isLoading),
    metadata: metadataNode ? buildMetadataItems(metadataNode) : undefined,
  };
}

function buildMetadataItems(node: HostNode): PluginDetailMetadataItem[] {
  return node.children
    .map((child): PluginDetailMetadataItem | null => {
      switch (child.type) {
        case "detail-metadata-label": {
          // `text: { value, color }`
          const labelColor = color(
            (child.props.text as { color?: unknown } | undefined)?.color,
          );
          return {
            kind: "label",
            title: (str(child.props.title) ?? "") as string,
            text: text(child.props.text),
            ...(labelColor && { color: labelColor }),
            icon: icon(child.props.icon),
          };
        }
        case "detail-metadata-taglist":
          return {
            kind: "tag-list",
            title: (str(child.props.title) ?? "") as string,
            items: child.children
              .filter((c) => c.type === "detail-metadata-taglist-item")
              .map((c) => {
                const tagIcon = icon(c.props.icon);
                return {
                  text: text(c.props.text) ?? "",
                  color: color(c.props.color),
                  ...(tagIcon && { icon: tagIcon }),
                };
              }),
          };
        case "detail-metadata-link":
          return {
            kind: "link",
            title: (str(child.props.title) ?? "") as string,
            target: (str(child.props.target) ?? "") as string,
            text: (str(child.props.text) ?? "") as string,
          };
        case "detail-metadata-separator":
          return { kind: "separator" };
        default:
          return null;
      }
    })
    .filter((item): item is PluginDetailMetadataItem => item !== null);
}

function buildActionPanel(
  node: HostNode,
  itemId: string,
): PluginActionPanelNode {
  const sections: PluginActionPanelNode["sections"] = [];
  let implicitActions: PluginActionNode[] = [];
  let actionIndex = 0;

  const flushImplicit = (): void => {
    if (implicitActions.length === 0) return;
    sections.push({ actions: implicitActions });
    implicitActions = [];
  };

  // Every `action` under `parent`, however deeply nested in sections or
  // submenus — a submenu has no dedicated UI yet, so it flattens into its
  // own titled section instead of being dropped.
  const collect = (parent: HostNode): PluginActionNode[] =>
    parent.children.flatMap((c) => {
      if (c.type === "action") {
        return [buildAction(c, `${itemId}:${actionIndex++}`)];
      }
      if (
        c.type === "action-panel-section" ||
        c.type === "action-panel-submenu"
      ) {
        return collect(c);
      }
      return [];
    });

  for (const child of node.children) {
    if (
      child.type === "action-panel-section" ||
      child.type === "action-panel-submenu"
    ) {
      flushImplicit();
      const actions = collect(child);
      if (actions.length > 0) {
        sections.push({ title: str(child.props.title), actions });
      }
    } else if (child.type === "action") {
      implicitActions.push(buildAction(child, `${itemId}:${actionIndex++}`));
    }
  }
  flushImplicit();

  return { sections };
}

function buildFormTree(node: HostNode): PluginFormTree {
  const actionPanel = node.children.find((c) => c.type === "action-panel");
  return {
    type: "form",
    isLoading: Boolean(node.props.isLoading),
    navigationTitle: str(node.props.navigationTitle),
    items: node.children
      .map(buildFormItemNode)
      .filter((item): item is PluginFormItemNode => item !== null),
    actionPanel: actionPanel
      ? buildActionPanel(actionPanel, "form")
      : undefined,
  };
}

function registerFieldChange(node: HostNode, id: string): void {
  const onChange = node.props.onChange as
    ((value: unknown) => void) | undefined;
  if (onChange) formFieldChangeStore.register(id, onChange);
}

function buildFormPickerItems(node: HostNode): PluginFormPickerItemNode[] {
  // `Form.Dropdown.Section` has no dedicated UI — its items are flattened
  // into the one list, in order.
  const items = node.children.flatMap((c) =>
    c.type === "form-dropdown-section" ? c.children : [c],
  );
  return items
    .filter(
      (c) =>
        c.type === "form-dropdown-item" || c.type === "form-tag-picker-item",
    )
    .map((c) => ({
      value: (str(c.props.value) ?? "") as string,
      title: (str(c.props.title) ?? "") as string,
      icon: icon(c.props.icon),
    }));
}

function buildFormItemNode(node: HostNode): PluginFormItemNode | null {
  const id = (str(node.props.id) ?? "") as string;
  const base = {
    id,
    title: str(node.props.title),
    info: str(node.props.info),
    error: str(node.props.error),
    storeValue: Boolean(node.props.storeValue),
  };

  switch (node.type) {
    case "form-text-field":
    case "form-password-field":
    case "form-text-area":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: node.type.slice("form-".length) as
          "text-field" | "password-field" | "text-area",
        placeholder: str(node.props.placeholder),
        value: str(node.props.value),
      };
    case "form-checkbox":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: "checkbox",
        label: str(node.props.label),
        value: Boolean(node.props.value),
      };
    case "form-dropdown":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: "dropdown",
        value: str(node.props.value),
        items: buildFormPickerItems(node),
      };
    case "form-tag-picker":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: "tag-picker",
        value: node.props.value as string[] | undefined,
        items: buildFormPickerItems(node),
      };
    case "form-date-picker":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: "date-picker",
        value: str(node.props.value),
        type: node.props.type as "date" | "datetime" | undefined,
      };
    case "form-file-picker":
      registerFieldChange(node, id);
      return {
        ...base,
        kind: "file-picker",
        value: node.props.value as string[] | undefined,
        allowMultiple: Boolean(node.props.allowMultiple),
        canChooseDirectories: Boolean(node.props.canChooseDirectories),
      };
    case "form-separator":
      return { kind: "separator" };
    case "form-description":
      return {
        kind: "description",
        title: str(node.props.title),
        text: (str(node.props.text) ?? "") as string,
      };
    default:
      return null;
  }
}

function buildAction(node: HostNode, id: string): PluginActionNode {
  const onAction = node.props.onAction as
    (() => void | Promise<void>) | undefined;
  if (onAction) actionRegistry.register(id, onAction);
  const onSubmit = node.props.onSubmit as
    | ((
        values: Record<string, unknown>,
      ) => void | boolean | Promise<void | boolean>)
    | undefined;
  if (onSubmit) formSubmitStore.register(onSubmit);
  return {
    id,
    title: (str(node.props.title) ?? "") as string,
    icon: icon(node.props.icon),
    shortcut: toAccelerator(node.props.shortcut),
    style: node.props.style as PluginActionNode["style"],
    kind: node.props.kind as PluginActionNode["kind"],
  };
}
