/**
 * Spawns `no-view-worker.ts` (bundled as `plugin-noview-worker.js`, an
 * `electron.vite` main entry — see `electron.vite.config.ts`) to run one
 * no-view command out-of-process, via `ELECTRON_RUN_AS_NODE` — the same
 * spawn shape `widget/main/runner.ts`'s `spawnWorker` and `native/apps.ts`'s
 * `runAppsWorker` use, for the same reason: a slow or runaway command can't
 * freeze the Electron main process's window paint / IPC.
 *
 * Unlike those, the worker gets a Node IPC channel (`stdio[3] = "ipc"`):
 * effects stream back as they happen and requests are answered live, via
 * the caller's `handlers` (see `PluginHostSource.runNoView`).
 *
 * `runWorker` is injectable so this is testable without a real build (see
 * `no-view-runner.test.ts`).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { hostEnv } from "./host-env.ts";
import type { HostEffect, HostRequest, NoViewOutput } from "./protocol.ts";
import type {
  CommandRunInput,
  NoViewChildMessage,
  NoViewParentMessage,
} from "./list-host-messages.ts";

export type NoViewRunInput = CommandRunInput;

export interface NoViewHandlers {
  onEffect(effect: HostEffect): void | Promise<void>;
  onRequest(request: HostRequest): Promise<unknown>;
}

/** Long enough for a command that does real work (a network round trip or
 *  two, a shell-out) — a runaway one is still killed eventually. */
export const DEFAULT_TIMEOUT_MS = 60_000;

type RunWorker = (
  input: NoViewRunInput,
  handlers: NoViewHandlers,
  timeoutMs: number,
) => Promise<NoViewOutput>;

export async function runNoViewCommand(
  input: NoViewRunInput,
  handlers: NoViewHandlers,
  opts?: { runWorker?: RunWorker; timeoutMs?: number },
): Promise<NoViewOutput> {
  const runWorker = opts?.runWorker ?? spawnNoViewWorker;
  return runWorker(input, handlers, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

function spawnNoViewWorker(
  input: NoViewRunInput,
  handlers: NoViewHandlers,
  timeoutMs: number,
): Promise<NoViewOutput> {
  return new Promise((resolve) => {
    const workerPath = join(import.meta.dirname, "plugin-noview-worker.js");
    const child = spawn(process.execPath, [workerPath], {
      env: { ...hostEnv(), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });

    const logPrefix = `[plugin-engine:${input.pluginId}/${input.commandName}]`;
    let stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) =>
      console.log(logPrefix, chunk.toString().trimEnd()),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      console.error(logPrefix, text.trimEnd());
    });

    let settled = false;
    const finish = (result: NoViewOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // A command can leave timers or sockets open after it resolves —
      // the worker has nothing more to do either way.
      if (child.exitCode === null) child.kill();
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      finish({
        ok: false,
        error: `command timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    const post = (message: NoViewParentMessage): void => {
      if (child.connected) child.send(message);
    };

    child.on("message", (message: NoViewChildMessage) => {
      switch (message.type) {
        case "effect":
          void handlers.onEffect(message.effect);
          return;
        case "request":
          handlers.onRequest(message.request).then(
            (result) =>
              post({
                type: "response",
                requestId: message.requestId,
                ok: true,
                result,
              }),
            (error: unknown) =>
              post({
                type: "response",
                requestId: message.requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
          return;
        case "done":
          finish(
            message.ok ? { ok: true } : { ok: false, error: message.error },
          );
          return;
      }
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("exit", () =>
      finish({
        ok: false,
        error:
          stderrTail.trim().split("\n").slice(-5).join("\n") ||
          "the command's worker exited without finishing",
      }),
    );

    post({ type: "start", input });
  });
}
