import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMissingApiNames,
  runNoView,
  startView,
  type ViewTransport,
} from "./runtime.ts";
import type { CommandRunInput } from "./list-host-messages.ts";
import type {
  HostEffect,
  HostRequest,
  PluginDetailTree,
  PluginListTree,
  PluginViewTree,
} from "./protocol.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/prebuilt/${name}`, import.meta.url));

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "magibar-runtime-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function input(
  bundle: string,
  overrides: Partial<CommandRunInput> = {},
): CommandRunInput {
  return {
    bundlePath: fixture(bundle),
    pluginId: "fixture",
    pluginTitle: "Fixture",
    extensionName: "fixture",
    commandName: "cmd",
    commandMode: "no-view",
    appearance: "dark",
    storageFilePath: join(dir, "storage.json"),
    cacheFilePath: join(dir, "cache.json"),
    supportPath: join(dir, "support"),
    assetsPath: join(dir, "assets"),
    preferenceValues: {},
    ...overrides,
  };
}

describe("runNoView", () => {
  it("runs a prebuilt bundle against the shim with LaunchProps and live requests", async () => {
    const effects: HostEffect[] = [];
    const requests: HostRequest[] = [];
    await runNoView(
      input("no-view.js", {
        preferenceValues: { greeting: "Hello" },
        launchArguments: { name: "Ada" },
      }),
      {
        sendEffect: (effect) => effects.push(effect),
        request: async (request) => {
          requests.push(request);
          return "clipped";
        },
      },
    );
    assert.deepEqual(requests, [{ method: "clipboard-read" }]);
    assert.deepEqual(effects, [
      {
        op: "hud",
        title: "Hello Ada from cmd (userInitiated) clip=clipped",
      },
    ]);
  });

  it("reports an unimplemented @raycast/api export by name", async () => {
    await assert.rejects(
      runNoView(input("missing-api.js"), {
        sendEffect() {},
        request: async () => undefined,
      }),
      /someBrandNewApi\.doThing/,
    );
    assert.ok(getMissingApiNames().includes("someBrandNewApi"));
  });
});

describe("startView", () => {
  function mount(): {
    trees: PluginViewTree[];
    errors: string[];
    view: ReturnType<typeof startView>;
  } {
    const trees: PluginViewTree[] = [];
    const errors: string[] = [];
    const transport: ViewTransport = {
      sendRenderTree: (tree) => trees.push(tree),
      sendRenderError: (message) => errors.push(message),
      sendEffect() {},
      request: async () => undefined,
      popToRoot() {},
      clearSearchBar() {},
    };
    const view = startView(
      input("view.js", { commandMode: "view", launchArguments: {} }),
      transport,
    );
    return { trees, errors, view };
  }

  it("renders the root List with normalized icons and accessories", () => {
    const { trees, errors, view } = mount();
    assert.deepEqual(errors, []);
    const tree = trees.at(-1) as PluginListTree;
    assert.equal(tree.type, "list");
    assert.equal(tree.navigationDepth, 0);
    const items = tree.sections.flatMap((s) => s.items);
    assert.deepEqual(
      items.map((i) => i.title),
      ["Alpha", "Beta"],
    );
    assert.equal(items[0].icon, "⭐");
    assert.deepEqual(items[0].accessories, [
      { text: "acc" },
      { tag: { value: "t" } },
    ]);
    view.dispose();
  });

  it("filters items rendered through the extension's own components", () => {
    const { trees, view } = mount();
    view.handleSearchTextChanged("bet");
    const tree = trees.at(-1) as PluginListTree;
    assert.deepEqual(
      tree.sections.flatMap((s) => s.items.map((i) => i.title)),
      ["Beta"],
    );
    view.dispose();
  });

  it("pushes and pops views, keeping search text per frame", () => {
    const { trees, view } = mount();
    view.handleSearchTextChanged("alp");
    const list = trees.at(-1) as PluginListTree;
    const pushId =
      list.sections[0].items[0].actionPanel!.sections[0].actions[0].id;

    view.handleActionInvoked(pushId);
    const detail = trees.at(-1) as PluginDetailTree;
    assert.equal(detail.type, "detail");
    assert.equal(detail.markdown, "# Alpha");
    assert.equal(detail.navigationDepth, 1);
    assert.equal(detail.searchText, "");

    view.handlePop();
    const back = trees.at(-1) as PluginListTree;
    assert.equal(back.type, "list");
    assert.equal(back.navigationDepth, 0);
    assert.equal(back.searchText, "alp");
    view.dispose();
  });

  it("pops via useNavigation().pop() from inside the pushed view", async () => {
    const { trees, view } = mount();
    const list = trees.at(-1) as PluginListTree;
    view.handleActionInvoked(
      list.sections[0].items[1].actionPanel!.sections[0].actions[0].id,
    );
    const detail = trees.at(-1) as PluginDetailTree;
    view.handleActionInvoked(detail.actionPanel!.sections[0].actions[0].id);
    assert.equal(trees.at(-1)!.type, "list");
    view.dispose();
  });
});
