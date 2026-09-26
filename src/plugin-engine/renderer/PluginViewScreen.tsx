/**
 * The mount point for every `mode: "view"` plugin command, registered as the
 * `"plugin-list"` route in `router/Outlet.tsx` (the route name predates this
 * screen — renaming it would touch `PluginHostSource` for no behavioral
 * gain, so it stays).
 *
 * Routing to the right screen body can only happen *after* the first render
 * message arrives: a command's manifest entry says `mode: "view"`, never
 * which view component it actually renders (`List`, `Detail`, `Grid`,
 * `Form`) — that's a runtime fact about the command's own default export,
 * not manifest data (see `manifest.ts`). So this screen owns the IPC
 * instance (`usePluginViewInstance`) and switches on `tree.type` once it has
 * one, rather than the instance-per-view-type screens routing there
 * themselves.
 *
 * It also owns the plugin's own navigation stack (`useNavigation`/
 * `Action.Push`, see `api-shim/src/navigation.ts`): while a pushed view is
 * showing (`navigationDepth > 0`), "back" pops the plugin's stack instead of
 * leaving this screen, and the search input takes whatever text the view
 * being returned to had.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import {
  usePluginViewInstance,
  type PluginToast,
} from "./usePluginViewInstance";
import { PluginListScreen } from "./PluginListScreen";
import { PluginGridScreen } from "./PluginGridScreen";
import { PluginFormScreen } from "./PluginFormScreen";
import { PluginDetailScreen } from "./PluginDetailScreen";
import { PluginErrorScreen } from "./PluginErrorScreen";

export interface PluginListRoutePayload {
  instanceId: string;
  actionId: string;
  title: string;
  /** The command's icon (a `data:` URI), for the footer. */
  icon?: string;
}

function isPluginListRoutePayload(
  value: unknown,
): value is PluginListRoutePayload {
  return (
    !!value && typeof (value as PluginListRoutePayload).instanceId === "string"
  );
}

export function PluginViewScreen(payload: unknown): ReactNode {
  if (!isPluginListRoutePayload(payload)) return null;
  return <PluginView {...payload} />;
}

/** How long a settled (success/failure) toast stays up. */
const TOAST_MS = 3_000;

/** `plugin:<pluginId>:<command>` -> `<pluginId>`. */
function pluginIdOf(actionId: string): string | undefined {
  return actionId.split(":")[1];
}

function PluginView({
  instanceId,
  actionId,
  title,
  icon,
}: PluginListRoutePayload) {
  const { pop, push } = useRouteStack();
  const [query, setQuery] = useState("");

  const view = usePluginViewInstance(instanceId, actionId, {
    onClearSearchBar: () => {
      setQuery("");
      window.api.pluginList.sendEvent(instanceId, {
        type: "search-text-changed",
        text: "",
      });
    },
  });

  const depth = view.tree?.navigationDepth ?? 0;
  const lastDepth = useRef(depth);
  useEffect(() => {
    if (depth === lastDepth.current) return;
    lastDepth.current = depth;
    setQuery(view.tree?.searchText ?? "");
  }, [depth, view.tree]);

  const onBack = (): void => {
    if (depth > 0) view.sendEvent({ type: "pop" });
    else pop();
  };

  let body: ReactNode;
  if (view.errorMessage) {
    const pluginId = pluginIdOf(actionId);
    body = (
      <PluginErrorScreen
        title={title}
        message={view.errorMessage}
        onConfigure={
          pluginId
            ? () => push({ name: "plugin-preferences", payload: { pluginId } })
            : undefined
        }
      />
    );
  } else if (!view.tree) {
    body = <PluginErrorScreen title={title} />;
  } else {
    switch (view.tree.type) {
      case "detail":
        body = (
          <PluginDetailScreen
            key={depth}
            tree={view.tree}
            title={title}
            commandIcon={icon}
            invokeAction={view.invokeAction}
            onBack={onBack}
          />
        );
        break;
      case "list":
        body = (
          <PluginListScreen
            key={depth}
            tree={view.tree}
            title={title}
            commandIcon={icon}
            query={query}
            onQueryChange={setQuery}
            invokeAction={view.invokeAction}
            sendEvent={view.sendEvent}
            onBack={onBack}
          />
        );
        break;
      case "grid":
        body = (
          <PluginGridScreen
            key={depth}
            tree={view.tree}
            title={title}
            commandIcon={icon}
            query={query}
            onQueryChange={setQuery}
            invokeAction={view.invokeAction}
            sendEvent={view.sendEvent}
            onBack={onBack}
          />
        );
        break;
      case "form":
        body = (
          <PluginFormScreen
            key={depth}
            tree={view.tree}
            title={title}
            commandIcon={icon}
            invokeAction={view.invokeAction}
            sendEvent={view.sendEvent}
            onBack={onBack}
          />
        );
        break;
    }
  }

  return (
    <>
      {body}
      <ToastBar toast={view.toast} />
    </>
  );
}

/** Raycast shows a command's toast inside its own window, not as an OS
 *  notification — a small bar just above the footer. An animated toast
 *  stays until the command updates or hides it; a settled one fades. */
function ToastBar({ toast }: { toast: PluginToast | null }): ReactNode {
  const [visible, setVisible] = useState<PluginToast | null>(toast);
  useEffect(() => {
    setVisible(toast);
    if (!toast || toast.style === "animated") return;
    const timer = setTimeout(() => setVisible(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!visible) return null;
  const glyph =
    visible.style === "failure"
      ? "✕"
      : visible.style === "animated"
        ? null
        : "✓";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-11 z-50 flex justify-center px-4">
      <div className="flex max-w-full items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-xs shadow-lg">
        {glyph ? (
          <span
            className={
              visible.style === "failure" ? "text-red-500" : "text-green-500"
            }
          >
            {glyph}
          </span>
        ) : (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground-subtle border-t-transparent" />
        )}
        <span className="truncate font-medium">{visible.title}</span>
        {visible.message ? (
          <span className="truncate text-foreground-subtle">
            {visible.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
