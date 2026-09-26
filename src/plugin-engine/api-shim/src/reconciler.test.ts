/**
 * Exercises the reconciler end to end in plain Node — no Electron, no
 * process spawn: render fixture "plugin" components through
 * `createPluginRoot()` and assert on the `PluginListTree` a fake
 * `HostTransport` receives. This is the highest-value test in the plugin
 * engine, since it's the one place that proves unmodified `@raycast/api`-style
 * JSX (hooks, state, conditional rendering) actually produces a correct tree.
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, useEffect, useState } from "react";
import {
  createPluginRoot,
  flushSync,
  normalizeSvgDataUri,
  type PluginRoot,
} from "./reconciler.ts";
import {
  actionRegistry,
  configureHostTransport,
  dropdownChangeStore,
  formFieldChangeStore,
  formSubmitStore,
  searchTextStore,
  type HostEffect,
  type HostRequest,
  type HostTransport,
} from "./host-bridge.ts";
import { List } from "./components/List.ts";
import { ActionPanel } from "./components/ActionPanel.ts";
import { Action } from "./components/Action.ts";
import { Detail } from "./components/Detail.ts";
import { Grid } from "./components/Grid.ts";
import { Form } from "./components/Form.ts";
import { unsupportedComponent } from "./unsupported.ts";
import { configurePluginContext } from "./context.ts";
import type {
  PluginDetailTree,
  PluginFormTree,
  PluginGridTree,
  PluginListTree,
  PluginViewTree,
} from "../../host/protocol.ts";

class FakeTransport implements HostTransport {
  trees: PluginViewTree[] = [];
  errors: string[] = [];
  effects: HostEffect[] = [];

  sendRenderTree(tree: PluginViewTree): void {
    this.trees.push(tree);
  }
  sendRenderError(message: string): void {
    this.errors.push(message);
  }
  sendEffect(effect: HostEffect): void {
    this.effects.push(effect);
  }
  async request(request: HostRequest): Promise<unknown> {
    if (request.method === "confirm-alert") return true;
    if (request.method === "clipboard-read") return "";
    return undefined;
  }
  poppedToRoot = false;
  clearedSearchBar = false;
  popToRoot(): void {
    this.poppedToRoot = true;
  }
  clearSearchBar(): void {
    this.clearedSearchBar = true;
  }

  /** Most tests render a `List`, so this narrows for their convenience;
   *  `lastViewTree` below is the untyped-by-view-kind escape hatch for a
   *  `Detail` (or, once they land, `Grid`/`Form`) test. */
  get lastTree(): PluginListTree | undefined {
    const tree = this.trees.at(-1);
    return tree?.type === "list" ? tree : undefined;
  }

  get lastViewTree(): PluginViewTree | undefined {
    return this.trees.at(-1);
  }
}

let transport: FakeTransport;
let root: PluginRoot | undefined;

beforeEach(() => {
  transport = new FakeTransport();
  configureHostTransport(transport);
  searchTextStore.setText("");
});

afterEach(() => {
  root?.dispose();
  root = undefined;
});

describe("reconciler", () => {
  it("renders a simple List into a PluginListTree", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, { searchBarPlaceholder: "Search…" }, [
        createElement(List.Item, {
          key: "a",
          title: "Alpha",
          subtitle: "First",
        }),
        createElement(List.Item, { key: "b", title: "Beta" }),
      ]),
    );

    assert.equal(transport.errors.length, 0);
    const tree = transport.lastTree;
    assert.ok(tree);
    assert.equal(tree.type, "list");
    assert.equal(tree.searchBarPlaceholder, "Search…");
    assert.equal(tree.sections.length, 1);
    assert.deepEqual(
      tree.sections[0].items.map((i) => i.title),
      ["Alpha", "Beta"],
    );
    assert.equal(tree.sections[0].items[0].subtitle, "First");
  });

  it("serializes a List.Item's Detail (markdown + metadata) onto its PluginListItemNode", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.Item, {
          key: "a",
          title: "Alpha",
          detail: createElement(List.Item.Detail, {
            markdown: "# Hi",
            metadata: createElement(List.Item.Detail.Metadata, null, [
              createElement(List.Item.Detail.Metadata.Label, {
                key: "l",
                title: "Size",
                text: "2 MB",
              }),
              createElement(List.Item.Detail.Metadata.Separator, { key: "s" }),
              createElement(
                List.Item.Detail.Metadata.TagList,
                {
                  key: "t",
                  title: "Tags",
                },
                [
                  createElement(List.Item.Detail.Metadata.TagList.Item, {
                    key: "t1",
                    text: "urgent",
                    color: "#ff0000",
                  }),
                ],
              ),
              createElement(List.Item.Detail.Metadata.Link, {
                key: "lk",
                title: "Docs",
                target: "https://example.com",
                text: "example.com",
              }),
            ]),
          }),
        }),
      ]),
    );

    assert.equal(transport.errors.length, 0);
    const item = transport.lastTree?.sections[0].items[0];
    assert.equal(item?.detail?.markdown, "# Hi");
    assert.deepEqual(item?.detail?.metadata, [
      { kind: "label", title: "Size", text: "2 MB", icon: undefined },
      { kind: "separator" },
      {
        kind: "tag-list",
        title: "Tags",
        items: [{ text: "urgent", color: "#ff0000" }],
      },
      {
        kind: "link",
        title: "Docs",
        target: "https://example.com",
        text: "example.com",
      },
    ]);
  });

  it("a List.Item with no Detail has an undefined detail field", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.Item, { key: "a", title: "Alpha" }),
      ]),
    );
    assert.equal(transport.lastTree?.sections[0].items[0].detail, undefined);
  });

  it("renders a top-level Detail into a PluginDetailTree", () => {
    root = createPluginRoot();
    root.render(
      createElement(Detail, {
        navigationTitle: "Info",
        markdown: "# Hi",
        actions: createElement(ActionPanel, null, [
          createElement(Action, {
            key: "a",
            title: "Do it",
            onAction: () => {},
          }),
        ]),
      }),
    );

    assert.equal(transport.errors.length, 0);
    const tree = transport.lastViewTree as PluginDetailTree;
    assert.equal(tree.type, "detail");
    assert.equal(tree.navigationTitle, "Info");
    assert.equal(tree.markdown, "# Hi");
    assert.equal(tree.actionPanel?.sections[0].actions[0].title, "Do it");
  });

  it("a top-level Detail's actions register into the actionRegistry same as a List.Item's", async () => {
    root = createPluginRoot();
    let invoked = false;
    root.render(
      createElement(Detail, {
        markdown: "hi",
        actions: createElement(ActionPanel, null, [
          createElement(Action, {
            key: "a",
            title: "Do it",
            onAction: () => {
              invoked = true;
            },
          }),
        ]),
      }),
    );
    const tree = transport.lastViewTree as PluginDetailTree;
    const actionId = tree.actionPanel!.sections[0].actions[0].id;
    await actionRegistry.invoke(actionId);
    assert.equal(invoked, true);
  });

  it("renders a Grid into a PluginGridTree with columns/aspectRatio carried through", () => {
    root = createPluginRoot();
    root.render(
      createElement(Grid, { columns: 4, aspectRatio: "1" }, [
        createElement(Grid.Item, {
          key: "a",
          content: "icon.png",
          title: "Alpha",
        }),
      ]),
    );

    assert.equal(transport.errors.length, 0);
    const tree = transport.lastViewTree as PluginGridTree;
    assert.equal(tree.type, "grid");
    assert.equal(tree.columns, 4);
    assert.equal(tree.aspectRatio, "1");
    assert.equal(tree.sections[0].items[0].content, "icon.png");
    assert.equal(tree.sections[0].items[0].title, "Alpha");
  });

  it("Grid filters items via the launcher search text same as List", () => {
    root = createPluginRoot();
    root.render(
      createElement(Grid, null, [
        createElement(Grid.Item, {
          key: "a",
          content: "a.png",
          title: "Alpha",
        }),
        createElement(Grid.Item, { key: "b", content: "b.png", title: "Beta" }),
      ]),
    );
    assert.equal(
      (transport.lastViewTree as PluginGridTree).sections[0].items.length,
      2,
    );

    flushSync(() => searchTextStore.setText("al"));

    const tree = transport.lastViewTree as PluginGridTree;
    assert.deepEqual(tree.sections[0]?.items.map((i) => i.title) ?? [], [
      "Alpha",
    ]);
  });

  it("renders Form fields into a PluginFormTree and forwards onChange live via formFieldChangeStore", () => {
    root = createPluginRoot();
    let seen: unknown;
    root.render(
      createElement(Form, null, [
        createElement(Form.TextField, {
          key: "name",
          id: "name",
          title: "Name",
          onChange: (v: string) => {
            seen = v;
          },
        }),
      ]),
    );

    assert.equal(transport.errors.length, 0);
    const tree = transport.lastViewTree as PluginFormTree;
    assert.equal(tree.type, "form");
    assert.equal(tree.items[0].kind, "text-field");
    assert.equal((tree.items[0] as { id: string }).id, "name");

    flushSync(() => formFieldChangeStore.invoke("name", "Ada"));
    assert.equal(seen, "Ada");
  });

  it("Action.SubmitForm is tagged kind:'submit-form' and its onSubmit receives the values payload via formSubmitStore", async () => {
    root = createPluginRoot();
    let submitted: unknown;
    root.render(
      createElement(Form, {
        actions: createElement(ActionPanel, null, [
          createElement(Action.SubmitForm, {
            key: "submit",
            onSubmit: (v: unknown) => {
              submitted = v;
            },
          }),
        ]),
      }),
    );

    const tree = transport.lastViewTree as PluginFormTree;
    const action = tree.actionPanel?.sections[0].actions[0];
    assert.equal(action?.kind, "submit-form");

    await formSubmitStore.invoke({ name: "Ada" });
    assert.deepEqual(submitted, { name: "Ada" });
  });

  it("an uncontrolled List.Dropdown (defaultValue only) keeps reporting the user's pick, not reverting to defaultValue, once the extension's own onChange-driven re-render happens", () => {
    function Command() {
      const [sortBy, setSortBy] = useState("cpu");
      return createElement(List, {
        searchBarAccessory: createElement(List.Dropdown, {
          defaultValue: "cpu",
          onChange: (value: string) => setSortBy(value),
          children: [
            createElement(List.Dropdown.Item, {
              key: "cpu",
              title: "CPU",
              value: "cpu",
            }),
            createElement(List.Dropdown.Item, {
              key: "mem",
              title: "Memory",
              value: "memory",
            }),
          ],
        }),
        children: [createElement(List.Item, { key: "a", title: sortBy })],
      });
    }

    root = createPluginRoot();
    root.render(createElement(Command));
    assert.equal(transport.lastTree?.searchBarAccessory?.value, "cpu");

    // The renderer dispatches this on the user's selection — same event
    // `list-host-process.ts`'s `handleDropdownValueChanged` forwards into
    // `dropdownChangeStore.invoke`.
    flushSync(() => dropdownChangeStore.invoke("memory"));

    const tree = transport.lastTree;
    assert.equal(tree?.searchBarAccessory?.value, "memory");
    assert.equal(tree?.sections[0].items[0].title, "memory");
  });

  it("groups items under explicit List.Section titles", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.Section, { key: "s1", title: "Fruits" }, [
          createElement(List.Item, { key: "a", title: "Apple" }),
        ]),
        createElement(List.Section, { key: "s2", title: "Veggies" }, [
          createElement(List.Item, { key: "b", title: "Carrot" }),
        ]),
      ]),
    );

    const tree = transport.lastTree;
    assert.ok(tree);
    assert.deepEqual(
      tree.sections.map((s) => s.title),
      ["Fruits", "Veggies"],
    );
  });

  it("shows the empty view when nothing matches", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.EmptyView, { key: "empty", title: "Nothing here" }),
      ]),
    );

    const tree = transport.lastTree;
    assert.ok(tree);
    assert.equal(tree.sections.length, 0);
    assert.equal(tree.emptyView?.title, "Nothing here");
  });

  it("the launcher's search text filters items and drops empty sections", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.Item, { key: "a", title: "Alpha" }),
        createElement(List.Item, { key: "b", title: "Beta" }),
      ]),
    );
    assert.equal(transport.lastTree?.sections[0].items.length, 2);

    flushSync(() => searchTextStore.setText("al"));

    const tree = transport.lastTree;
    assert.deepEqual(tree?.sections[0]?.items.map((i) => i.title) ?? [], [
      "Alpha",
    ]);
  });

  it("passes filtering=false through unfiltered", () => {
    root = createPluginRoot();
    root.render(
      createElement(List, { filtering: false }, [
        createElement(List.Item, { key: "a", title: "Alpha" }),
        createElement(List.Item, { key: "b", title: "Beta" }),
      ]),
    );

    flushSync(() => searchTextStore.setText("zzz-no-match"));

    assert.equal(transport.lastTree?.sections[0].items.length, 2);
  });

  it("registers an item's ActionPanel actions and dispatches onAction by id", async () => {
    root = createPluginRoot();
    let clicked = 0;
    root.render(
      createElement(List, null, [
        createElement(List.Item, {
          key: "a",
          title: "Alpha",
          actions: createElement(ActionPanel, null, [
            createElement(Action, {
              key: "act",
              title: "Do it",
              onAction: () => {
                clicked++;
              },
            }),
          ]),
        }),
      ]),
    );

    const item = transport.lastTree?.sections[0].items[0];
    const action = item?.actionPanel?.sections[0]?.actions[0];
    assert.ok(action, "expected one action on the item");
    assert.equal(action.title, "Do it");
    assert.equal(action.kind, "generic");

    await actionRegistry.invoke(action.id);
    assert.equal(clicked, 1);
  });

  it("Action.CopyToClipboard sends a clipboard-copy effect when invoked", async () => {
    root = createPluginRoot();
    root.render(
      createElement(List, null, [
        createElement(List.Item, {
          key: "a",
          title: "Alpha",
          actions: createElement(ActionPanel, null, [
            createElement(Action.CopyToClipboard, {
              key: "copy",
              content: "hello",
            }),
          ]),
        }),
      ]),
    );

    const action =
      transport.lastTree?.sections[0].items[0].actionPanel?.sections[0]
        ?.actions[0];
    assert.ok(action);
    await actionRegistry.invoke(action.id);
    assert.deepEqual(transport.effects, [
      { op: "clipboard-copy", text: "hello" },
    ]);
  });

  it("state updates inside a command re-render and push a fresh tree", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement(List, null, [
        createElement(List.Item, {
          key: "a",
          title: `Count: ${count}`,
          actions: createElement(ActionPanel, null, [
            createElement(Action, {
              key: "inc",
              title: "Increment",
              onAction: () => setCount((c) => c + 1),
            }),
          ]),
        }),
      ]);
    }

    root = createPluginRoot();
    root.render(createElement(Counter, null));
    assert.equal(transport.lastTree?.sections[0].items[0].title, "Count: 0");

    const action =
      transport.lastTree?.sections[0].items[0].actionPanel?.sections[0]
        ?.actions[0];
    assert.ok(action);
    flushSync(() => {
      void actionRegistry.invoke(action.id);
    });

    assert.equal(transport.lastTree?.sections[0].items[0].title, "Count: 1");
  });

  it("an unsupported top-level view reports a render error instead of a tree", () => {
    const StillUnsupported = unsupportedComponent("Grid");
    root = createPluginRoot();
    root.render(createElement(StillUnsupported, null));

    assert.equal(transport.trees.length, 0);
    assert.equal(transport.errors.length, 1);
    assert.match(transport.errors[0], /Grid.*not supported/);
  });

  it("dispose unmounts synchronously, running the command's effect cleanups", () => {
    let cleanedUp = false;
    function Command() {
      useEffect(
        () => () => {
          cleanedUp = true;
        },
        [],
      );
      return createElement(List, null);
    }
    const disposable = createPluginRoot();
    disposable.render(createElement(Command));
    disposable.dispose();
    assert.equal(cleanedUp, true);
  });

  describe("List.Dropdown's initial value", () => {
    const dir = mkdtempSync(join(tmpdir(), "magibar-reconciler-test-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    configurePluginContext({
      pluginId: "fixture",
      pluginTitle: "Fixture",
      commandName: "cmd",
      storageFilePath: join(dir, "storage.json"),
      cacheFilePath: join(dir, "cache.json"),
      supportPath: join(dir, "support"),
      assetsPath: join(dir, "assets"),
      preferenceValues: {},
    });

    /** A List that, like Hacker News, only loads once `onChange` names a
     *  feed — its one row shows what it was told. */
    function feedList(dropdownProps: Record<string, unknown>) {
      return function Command() {
        const [feed, setFeed] = useState("(none)");
        return createElement(List, {
          searchBarAccessory: createElement(List.Dropdown, {
            ...dropdownProps,
            onChange: (value: string) => setFeed(value),
            children: ["front", "best"].map((value) =>
              createElement(List.Dropdown.Item, {
                key: value,
                title: value,
                value,
              }),
            ),
          }),
          children: [createElement(List.Item, { key: "a", title: feed })],
        });
      };
    }

    const settle = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    const shown = (): string | undefined =>
      transport.lastTree?.sections[0].items[0].title;

    it("tells onChange the defaultValue on mount", async () => {
      root = createPluginRoot();
      root.render(createElement(feedList({ defaultValue: "best" })));
      await settle();
      assert.equal(shown(), "best");
      assert.equal(transport.lastTree?.searchBarAccessory?.value, "best");
    });

    it("falls back to the first item without a defaultValue", async () => {
      root = createPluginRoot();
      root.render(createElement(feedList({})));
      await settle();
      assert.equal(shown(), "front");
    });

    it("restores a storeValue dropdown's last pick on the next launch", async () => {
      const props = { id: "feed", defaultValue: "front", storeValue: true };
      root = createPluginRoot();
      root.render(createElement(feedList(props)));
      await settle();
      flushSync(() => dropdownChangeStore.invoke("best"));
      root.dispose();

      root = createPluginRoot();
      root.render(createElement(feedList(props)));
      await settle();
      assert.equal(shown(), "best");
    });
  });
});

describe("normalizeSvgDataUri", () => {
  const decoded = (uri: string): string =>
    decodeURIComponent(uri.slice(uri.indexOf(",") + 1));

  it("adds the xmlns Chromium needs and URI-encodes the markup", () => {
    const uri = normalizeSvgDataUri(
      'data:image/svg+xml,<svg width="10"><rect fill="#f60"/></svg>',
    );
    assert.ok(!uri.includes("#"));
    assert.equal(
      decoded(uri),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10"><rect fill="#f60"/></svg>',
    );
  });

  it("keeps an existing xmlns and decodes already-encoded markup first", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const uri = normalizeSvgDataUri(
      `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    );
    assert.equal(decoded(uri), svg);
  });

  it("leaves base64 and non-SVG values alone", () => {
    for (const value of [
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:image/png;base64,AAAA",
      "https://example.com/a.svg",
    ]) {
      assert.equal(normalizeSvgDataUri(value), value);
    }
  });
});
