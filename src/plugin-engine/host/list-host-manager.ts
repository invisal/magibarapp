/**
 * Owns every running view command instance: forks `list-host-process.ts`
 * via `utilityProcess.fork()`, relays messages to/from it, and hands its
 * effects and requests to the caller's handlers (`PluginHostSource`, which
 * knows which plugin an instance belongs to). One instance per open plugin
 * screen — killed on detach, no cross-session caching.
 *
 * An instance lives exactly as long as its screen: until the screen
 * unmounts (`detach`) or the renderer that owns it goes away
 * (`detachOwner` — a reload or crash, which never unmounts anything). There
 * is deliberately no idle timeout: a plugin screen stays mounted while the
 * launcher is hidden, and must still work when the user comes back to it.
 *
 * Not unit-testable (`utilityProcess` only exists inside real Electron) —
 * see `list-host-process.ts`'s doc comment.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { hostEnv } from "./host-env.ts";
import { join } from "node:path";
import type {
  ListHostChildMessage,
  ListHostParentMessage,
  ListStartInput,
} from "./list-host-messages.ts";
import type {
  HostEffect,
  HostRequest,
  PluginHostMessage,
  PluginInboundEvent,
} from "./protocol.ts";

export interface ListHostHandlers {
  /** Messages for the instance's own renderer screen. */
  onMessage(message: PluginHostMessage): void;
  /** Every non-toast effect (toasts go to the screen via `onMessage`). */
  onEffect(effect: HostEffect): void | Promise<void>;
  onRequest(request: HostRequest): Promise<unknown>;
}

interface Instance {
  pluginId: string;
  /** `webContents.id` of the renderer showing it. */
  ownerId: number;
  process: UtilityProcess;
  handlers: ListHostHandlers;
}

class ListHostManager {
  private readonly instances = new Map<string, Instance>();

  spawn(
    instanceId: string,
    ownerId: number,
    input: ListStartInput,
    handlers: ListHostHandlers,
  ): void {
    if (this.instances.has(instanceId)) return;

    const child = utilityProcess.fork(
      join(import.meta.dirname, "plugin-list-host.js"),
      [],
      {
        serviceName: `plugin-list-host:${input.pluginId}:${input.commandName}`,
        stdio: "pipe",
        env: hostEnv(),
      },
    );

    // `stdio: "pipe"` means nothing sees a running command's own
    // console.log/error (or an uncaught exception's stack) unless something
    // reads these streams — surface them here rather than losing them
    // silently, the only way to debug a command that misbehaves without
    // throwing (e.g. swallows its own fetch error into an empty state).
    const logPrefix = `[plugin-engine:${input.pluginId}/${input.commandName}]`;
    child.stdout?.on("data", (chunk: Buffer) =>
      console.log(logPrefix, chunk.toString().trimEnd()),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      console.error(logPrefix, chunk.toString().trimEnd()),
    );

    this.instances.set(instanceId, {
      pluginId: input.pluginId,
      ownerId,
      process: child,
      handlers,
    });

    child.on("message", (message: ListHostChildMessage) => {
      void this.handleChildMessage(instanceId, message);
    });
    child.once("exit", (code) => {
      const instance = this.instances.get(instanceId);
      // Exiting on its own (not via `detach`) means the command crashed.
      if (instance && code !== 0) {
        instance.handlers.onMessage({
          type: "error",
          instanceId,
          message: `the command's process exited unexpectedly (code ${code})`,
        });
      }
      this.cleanup(instanceId);
    });

    this.post(instanceId, { type: "start", input });
  }

  sendEvent(instanceId: string, event: PluginInboundEvent): void {
    if (event.type === "dispose") {
      this.detach(instanceId);
      return;
    }
    this.post(instanceId, event);
  }

  /** Ask the instance to unmount, then force-kill it shortly after — called
   *  when the renderer's plugin screen unmounts (screen popped/closed). */
  detach(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    this.post(instanceId, { type: "dispose" });
    setTimeout(() => instance.process.kill(), 500);
    this.cleanup(instanceId);
  }

  /** Every running instance of one plugin — before it's reinstalled or
   *  uninstalled (so nothing holds its files open), or after its
   *  preferences change (it was started with the old values). `reason` is
   *  what its screen shows instead. */
  detachPlugin(
    pluginId: string,
    reason = "This extension was updated or removed — reopen the command.",
  ): void {
    for (const [instanceId, instance] of this.instances) {
      if (instance.pluginId === pluginId) {
        instance.handlers.onMessage({
          type: "error",
          instanceId,
          message: reason,
        });
        this.detach(instanceId);
      }
    }
  }

  /** Every instance a renderer owns — when it reloads, crashes or is
   *  destroyed, its screens are gone without ever unmounting. */
  detachOwner(ownerId: number): void {
    for (const [instanceId, instance] of this.instances) {
      if (instance.ownerId === ownerId) this.detach(instanceId);
    }
  }

  private async handleChildMessage(
    instanceId: string,
    message: ListHostChildMessage,
  ): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    switch (message.type) {
      case "render":
        instance.handlers.onMessage({
          type: "render",
          instanceId,
          tree: message.tree,
        });
        return;
      case "error":
        instance.handlers.onMessage({
          type: "error",
          instanceId,
          message: message.message,
        });
        return;
      case "effect": {
        const { effect } = message;
        if (effect.op === "toast") {
          instance.handlers.onMessage({
            type: "toast",
            instanceId,
            toast: {
              title: effect.title,
              message: effect.message,
              style: effect.style,
            },
          });
          return;
        }
        if (effect.op === "hide-toast") {
          instance.handlers.onMessage({
            type: "toast",
            instanceId,
            toast: null,
          });
          return;
        }
        await instance.handlers.onEffect(effect);
        return;
      }
      case "request": {
        try {
          const result = await instance.handlers.onRequest(message.request);
          this.post(instanceId, {
            type: "response",
            requestId: message.requestId,
            ok: true,
            result,
          });
        } catch (error) {
          this.post(instanceId, {
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "pop-to-root":
        instance.handlers.onMessage({ type: "pop-to-root", instanceId });
        return;
      case "clear-search-bar":
        instance.handlers.onMessage({ type: "clear-search-bar", instanceId });
        return;
    }
  }

  private post(instanceId: string, message: ListHostParentMessage): void {
    this.instances.get(instanceId)?.process.postMessage(message);
  }

  /** Kill every running instance — called from `app.on("will-quit")`, same
   *  as the Clipboard History / Activity Monitor pollers' own cleanup. */
  disposeAll(): void {
    for (const instanceId of [...this.instances.keys()])
      this.detach(instanceId);
  }

  private cleanup(instanceId: string): void {
    this.instances.delete(instanceId);
  }
}

export const listHostManager = new ListHostManager();
