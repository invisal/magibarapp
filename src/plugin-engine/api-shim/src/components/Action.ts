/**
 * `Action` and its variants. Each renders an intrinsic `"action"` host node
 * carrying an `onAction` handler — `reconciler.ts`'s serializer pulls that
 * handler out into `host-bridge.ts`'s action registry (never sent over the
 * wire, since main/renderer only ever forward an id) and emits the `kind`
 * hint so the renderer can pick a sensible default icon.
 *
 * `Push` is real navigation (see `navigation.ts`). `SubmitForm` is real too:
 * its `onSubmit` registers into `host-bridge.ts`'s `formSubmitStore`, and its
 * `kind: "submit-form"` is how `renderer/PluginFormScreen.tsx` knows to send
 * the values snapshot instead of an ordinary `action-invoked`.
 * `CreateQuicklink`/`CreateSnippet` target Raycast's own built-in commands,
 * which don't exist here — they soft-fail with a toast instead of crashing.
 */
import { createElement, type ReactNode } from "react";
import { getHostTransport } from "../host-bridge.ts";
import { useNavigation } from "../navigation.ts";
import { Clipboard, open } from "../apis/clipboard.ts";
import { showInFinder, trash } from "../apis/system.ts";
import type { ShortcutInput } from "../apis/shortcut-format.ts";

export type { ShortcutInput };

export type ActionStyle = "default" | "destructive";

const ActionStyleValues = {
  Default: "default",
  Regular: "default",
  Destructive: "destructive",
} as const;

type Icon = unknown;
type ClipboardContent =
  string | number | { text?: string; file?: string; html?: string };

export interface ActionProps {
  title: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  style?: ActionStyle;
  autoFocus?: boolean;
  onAction?: () => void | Promise<void>;
}

function ActionRoot({ title, icon, shortcut, style, onAction }: ActionProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    style,
    kind: "generic",
    onAction,
  });
}

export interface CopyToClipboardProps {
  title?: string;
  content: ClipboardContent;
  icon?: Icon;
  shortcut?: ShortcutInput;
  style?: ActionStyle;
  concealed?: boolean;
  onCopy?: (content: ClipboardContent) => void;
}

function CopyToClipboard({
  title = "Copy to Clipboard",
  content,
  icon,
  shortcut,
  style,
  onCopy,
}: CopyToClipboardProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    style,
    kind: "copy-to-clipboard",
    onAction: async () => {
      await Clipboard.copy(content);
      onCopy?.(content);
    },
  });
}

export interface PasteProps {
  title?: string;
  content: ClipboardContent;
  icon?: Icon;
  shortcut?: ShortcutInput;
  onPaste?: (content: ClipboardContent) => void;
}

function Paste({
  title = "Paste",
  content,
  icon,
  shortcut,
  onPaste,
}: PasteProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "paste",
    onAction: async () => {
      await Clipboard.paste(content);
      onPaste?.(content);
    },
  });
}

export interface OpenInBrowserProps {
  title?: string;
  url: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  onOpen?: (url: string) => void;
}

function OpenInBrowser({
  title = "Open in Browser",
  url,
  icon,
  shortcut,
  onOpen,
}: OpenInBrowserProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "open-in-browser",
    onAction: async () => {
      await open(url);
      onOpen?.(url);
    },
  });
}

export interface OpenProps {
  title: string;
  target: string;
  application?: string | { path?: string; name?: string; bundleId?: string };
  icon?: Icon;
  shortcut?: ShortcutInput;
  onOpen?: (target: string) => void;
}

function Open({
  title,
  target,
  application,
  icon,
  shortcut,
  onOpen,
}: OpenProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "open",
    onAction: async () => {
      await open(target, application);
      onOpen?.(target);
    },
  });
}

export interface OpenWithProps {
  title?: string;
  path: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  onOpen?: (path: string) => void;
}

/** No app picker yet — opens with the default application instead. */
function OpenWith({
  title = "Open With",
  path,
  icon,
  shortcut,
  onOpen,
}: OpenWithProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "open",
    onAction: async () => {
      await open(path);
      onOpen?.(path);
    },
  });
}

export interface ShowInFinderProps {
  title?: string;
  path: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  onShow?: (path: string) => void;
}

function ShowInFinder({
  title = process.platform === "win32" ? "Show in Explorer" : "Show in Finder",
  path,
  icon,
  shortcut,
  onShow,
}: ShowInFinderProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "show-in-finder",
    onAction: async () => {
      await showInFinder(path);
      onShow?.(path);
    },
  });
}

export interface TrashProps {
  title?: string;
  paths: string | string[];
  icon?: Icon;
  shortcut?: ShortcutInput;
  onTrash?: (paths: string | string[]) => void;
}

function Trash({
  title = "Move to Trash",
  paths,
  icon,
  shortcut,
  onTrash,
}: TrashProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    style: "destructive",
    kind: "trash",
    onAction: async () => {
      await trash(paths);
      onTrash?.(paths);
    },
  });
}

export interface PushProps {
  title: string;
  target: ReactNode;
  icon?: Icon;
  shortcut?: ShortcutInput;
  style?: ActionStyle;
  onPush?: () => void;
  onPop?: () => void;
}

function Push({
  title,
  target,
  icon,
  shortcut,
  style,
  onPush,
  onPop,
}: PushProps) {
  const { push } = useNavigation();
  return createElement("action", {
    title,
    icon,
    shortcut,
    style,
    kind: "push",
    onAction: () => {
      push(target, onPop);
      onPush?.();
    },
  });
}

export interface SubmitFormProps<T = Record<string, unknown>> {
  title?: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  style?: ActionStyle;
  onSubmit?: (values: T) => void | boolean | Promise<void | boolean>;
}

function SubmitForm({
  title = "Submit",
  icon,
  shortcut,
  style,
  onSubmit,
}: SubmitFormProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    style,
    kind: "submit-form",
    // Kept as a plain prop, not registered into `formSubmitStore` here —
    // registration has to happen in `reconciler.ts`'s `buildAction`
    // (post-commit, from the already-built host node), the same as every
    // other action's `onAction`. Registering during this component's own
    // render call would run *before* `resetAfterCommit`'s
    // `formSubmitStore.reset()`, which would immediately wipe it out.
    onSubmit,
    // `PluginFormScreen` dispatches `form-submit` (carrying the values
    // snapshot) directly on this action's id rather than the ordinary
    // `action-invoked` path, so this never actually runs — a harmless no-op
    // rather than leaving it unregistered, in case anything ever does
    // invoke it the ordinary way.
    onAction: () => {},
  });
}

export interface PickDateProps {
  title: string;
  icon?: Icon;
  shortcut?: ShortcutInput;
  onChange: (date: Date | null) => void;
}

/** No inline date picker in the action panel yet — picks "now", which is
 *  what most "Set Due Date…" style actions offer as their first choice. */
function PickDate({ title, icon, shortcut, onChange }: PickDateProps) {
  return createElement("action", {
    title,
    icon,
    shortcut,
    kind: "generic",
    onAction: () => onChange(new Date()),
  });
}

function unsupportedBuiltIn(name: string, defaultTitle: string) {
  return function UnsupportedBuiltIn({
    title = defaultTitle,
    icon,
    shortcut,
  }: {
    title?: string;
    icon?: Icon;
    shortcut?: ShortcutInput;
  }) {
    return createElement("action", {
      title,
      icon,
      shortcut,
      kind: "generic",
      onAction: () =>
        getHostTransport().sendEffect({
          op: "toast",
          title: "Not supported",
          message: `${name} needs a Raycast built-in command Magibar doesn't have.`,
          style: "failure",
        }),
    });
  };
}

/** Quick Look / sidebar toggles have no counterpart in Magibar's UI —
 *  rendering nothing keeps them out of the action panel entirely. */
function Nothing(): null {
  return null;
}

export const Action = Object.assign(ActionRoot, {
  CopyToClipboard,
  Paste,
  OpenInBrowser,
  Open,
  OpenWith,
  ShowInFinder,
  Trash,
  Push,
  SubmitForm,
  PickDate: Object.assign(PickDate, {
    Type: { DateTime: "datetime", Date: "date" },
  }),
  CreateQuicklink: unsupportedBuiltIn(
    "Action.CreateQuicklink",
    "Create Quicklink",
  ),
  CreateSnippet: unsupportedBuiltIn("Action.CreateSnippet", "Create Snippet"),
  ToggleQuickLook: Nothing,
  ToggleSidebar: Nothing,
  Style: ActionStyleValues,
});
