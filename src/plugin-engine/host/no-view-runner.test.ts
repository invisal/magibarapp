import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runNoViewCommand,
  type NoViewHandlers,
  type NoViewRunInput,
} from "./no-view-runner.ts";
import type { NoViewOutput } from "./protocol.ts";

const input: NoViewRunInput = {
  bundlePath: "/dev/null",
  pluginId: "p",
  pluginTitle: "P",
  extensionName: "p",
  commandName: "c",
  commandMode: "no-view",
  appearance: "dark",
  storageFilePath: "/dev/null",
  cacheFilePath: "/dev/null",
  supportPath: "/dev/null",
  assetsPath: "/dev/null",
  preferenceValues: {},
};

const handlers: NoViewHandlers = {
  onEffect() {},
  async onRequest() {
    return undefined;
  },
};

describe("runNoViewCommand", () => {
  it("resolves with whatever the worker returns", async () => {
    const expected: NoViewOutput = { ok: true };
    const result = await runNoViewCommand(input, handlers, {
      runWorker: async () => expected,
    });
    assert.deepEqual(result, expected);
  });

  it("passes the input, handlers and timeout through to the worker", async () => {
    let seenInput: NoViewRunInput | undefined;
    let seenHandlers: NoViewHandlers | undefined;
    let seenTimeout: number | undefined;
    await runNoViewCommand(input, handlers, {
      timeoutMs: 1234,
      runWorker: async (i, h, t) => {
        seenInput = i;
        seenHandlers = h;
        seenTimeout = t;
        return { ok: true };
      },
    });
    assert.deepEqual(seenInput, input);
    assert.equal(seenHandlers, handlers);
    assert.equal(seenTimeout, 1234);
  });

  it("surfaces a worker failure as ok: false", async () => {
    const result = await runNoViewCommand(input, handlers, {
      runWorker: async () => ({ ok: false, error: "boom" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "boom");
  });
});
