/**
 * The attach/detach/message-listener plumbing every plugin view screen
 * needs, extracted out of what used to be `PluginListScreen`'s own
 * `useEffect` so `PluginViewScreen` can route to whichever screen body fits
 * the tree's `type` once the first render message arrives — routing can't
 * happen any earlier than that, since a command's manifest entry doesn't say
 * which view it renders (see `PluginViewScreen.tsx`'s doc comment).
 */
import { useEffect, useRef, useState } from "react";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import type {
  PluginHostMessage,
  PluginInboundEvent,
  PluginViewTree,
} from "@plugin-engine/host/protocol";

export interface PluginToast {
  title: string;
  message?: string;
  style?: string;
}

export interface PluginViewInstance {
  tree: PluginViewTree | null;
  errorMessage: string | null;
  /** The command's current `showToast()`, if any (`null` once hidden). */
  toast: PluginToast | null;
  invokeAction(actionId: string): void;
  sendEvent(event: PluginInboundEvent): void;
}

export function usePluginViewInstance(
  instanceId: string,
  actionId: string,
  handlers?: { onClearSearchBar?: () => void },
): PluginViewInstance {
  const { reset } = useRouteStack();
  const [tree, setTree] = useState<PluginViewTree | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<PluginToast | null>(null);

  // Read via a ref inside the effect below rather than adding `handlers` to
  // its dependency array — callers typically pass a fresh object/closure
  // every render, and this effect must only re-attach (killing and
  // restarting the actual plugin process) when `instanceId`/`actionId`
  // genuinely change.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    setTree(null);
    setErrorMessage(null);
    setToast(null);
    window.api.pluginList.attach(instanceId, actionId);
    const unsubscribe = window.api.pluginList.onMessage(
      (message: PluginHostMessage) => {
        if (message.instanceId !== instanceId) return;
        switch (message.type) {
          case "render":
            setTree(message.tree);
            setErrorMessage(null);
            return;
          case "error":
            setErrorMessage(message.message);
            return;
          case "pop-to-root":
            reset();
            return;
          case "clear-search-bar":
            handlersRef.current?.onClearSearchBar?.();
            return;
          case "toast":
            setToast(message.toast);
            return;
        }
      },
    );
    return () => {
      unsubscribe();
      window.api.pluginList.detach(instanceId);
    };
  }, [instanceId, actionId, reset]);

  return {
    tree,
    errorMessage,
    toast,
    invokeAction(id: string): void {
      window.api.pluginList.sendEvent(instanceId, {
        type: "action-invoked",
        actionId: id,
      });
    },
    sendEvent(event: PluginInboundEvent): void {
      window.api.pluginList.sendEvent(instanceId, event);
    },
  };
}
