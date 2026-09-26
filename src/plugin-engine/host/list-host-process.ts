/**
 * Hosts one running view command instance (List/Detail/Grid/Form), forked by
 * `list-host-manager.ts` via Electron's `utilityProcess.fork()` — the
 * persistent counterpart to `no-view-worker.ts`'s one-shot run, needed here
 * because a view is interactive (search-as-you-type, action clicks) rather
 * than run-once.
 *
 * The forked script only has `process.parentPort` (a `MessagePortMain`) for
 * talking to main — no other Electron APIs — hence every clipboard read,
 * alert, or application lookup is a `request` round trip to main.
 *
 * Bundled as its own `electron.vite` main entry (key `plugin-list-host` — see
 * `electron.vite.config.ts`); `list-host-manager.ts` forks it. The command
 * itself runs through `runtime.ts`.
 *
 * Not unit-testable: `utilityProcess`/`process.parentPort` only exist inside
 * a real Electron `utilityProcess`, not under plain `node --test` —
 * `runtime.test.ts` covers everything this file delegates to.
 */
import { startView, type RunningView } from "./runtime.ts";
import { createRequestClient } from "./request-client.ts";
import type {
  ListHostChildMessage,
  ListHostParentMessage,
  ListStartInput,
} from "./list-host-messages.ts";

const port = process.parentPort;
if (!port) {
  throw new Error(
    "plugin-list-host must be run as an Electron utilityProcess (no parentPort found)",
  );
}

function send(message: ListHostChildMessage): void {
  port.postMessage(message);
}

// Extensions routinely fire-and-forget promises (a fetch in a `useEffect`
// with no `.catch`) — Node's default is to crash the whole process on one,
// which would take the user's screen down with it. Log instead, like a
// browser would.
process.on("unhandledRejection", (reason) => {
  console.error("[plugin-engine] unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[plugin-engine] uncaught exception:", error);
});

const requests = createRequestClient(send);

let instance: RunningView | null = null;

function start(input: ListStartInput): void {
  try {
    instance = startView(input, {
      sendRenderTree: (tree) => send({ type: "render", tree }),
      sendRenderError: (message) => send({ type: "error", message }),
      sendEffect: (effect) => send({ type: "effect", effect }),
      request: requests.request,
      popToRoot: () => send({ type: "pop-to-root" }),
      clearSearchBar: () => send({ type: "clear-search-bar" }),
    });
  } catch (error) {
    console.error("[plugin-engine] failed to start command:", error);
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

port.on("message", (event: { data: ListHostParentMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      start(message.input);
      return;
    case "search-text-changed":
      instance?.handleSearchTextChanged(message.text);
      return;
    case "action-invoked":
      instance?.handleActionInvoked(message.actionId);
      return;
    case "dropdown-value-changed":
      instance?.handleDropdownValueChanged(message.value);
      return;
    case "form-value-changed":
      instance?.handleFormValueChanged(message.fieldId, message.value);
      return;
    case "form-submit":
      instance?.handleFormSubmit(message.values);
      return;
    case "pop":
      instance?.handlePop();
      return;
    case "selection-changed":
      instance?.handleSelectionChanged(message.itemId);
      return;
    case "load-more":
      instance?.handleLoadMore();
      return;
    case "response":
      requests.handleResponse(message);
      return;
    case "dispose":
      instance?.dispose();
      process.exit(0);
  }
});
