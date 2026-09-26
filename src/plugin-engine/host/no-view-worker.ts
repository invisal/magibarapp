/**
 * Runs one no-view command out-of-process, spawned by `no-view-runner.ts` —
 * never inside Electron's browser process.
 *
 * Talks to main over Node's IPC channel (`process.send`/`"message"`), not
 * stdout: a command's own `console.log` goes to stdout like any Node
 * program's, and must never be able to corrupt the protocol. Effects stream
 * as they happen (so an animated "Working…" toast shows immediately), and
 * requests (clipboard reads, `confirmAlert`, …) are live round trips.
 *
 * Bundled as its own `electron.vite` main entry (key `plugin-noview-worker`,
 * so the output is `plugin-noview-worker.js` next to `index.js`). The
 * command itself runs through `runtime.ts`.
 */
import { runNoView } from "./runtime.ts";
import { createRequestClient } from "./request-client.ts";
import type {
  NoViewChildMessage,
  NoViewParentMessage,
} from "./list-host-messages.ts";

function send(message: NoViewChildMessage): void {
  process.send?.(message);
}

process.on("unhandledRejection", (reason) => {
  console.error("[plugin-engine] unhandled rejection:", reason);
});

const requests = createRequestClient(send);

async function start(
  input: Extract<NoViewParentMessage, { type: "start" }>["input"],
): Promise<void> {
  try {
    await runNoView(input, {
      sendEffect: (effect) => send({ type: "effect", effect }),
      request: requests.request,
    });
    send({ type: "done", ok: true });
  } catch (error) {
    console.error("[plugin-engine] command failed:", error);
    send({
      type: "done",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

process.on("message", (message: NoViewParentMessage) => {
  if (message.type === "start") void start(message.input);
  else if (message.type === "response") requests.handleResponse(message);
});
