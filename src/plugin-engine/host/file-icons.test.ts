import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFileIcons } from "./file-icons.ts";
import type { PluginListTree } from "./protocol.ts";

function tree(icon: string, accessoryIcon: string): PluginListTree {
  return {
    type: "list",
    isLoading: false,
    sections: [
      {
        id: "s",
        items: [
          {
            id: "a",
            title: "fileicon: in a title stays text",
            icon,
            accessories: [{ text: "1%", icon: accessoryIcon }],
          },
        ],
      },
    ],
  };
}

describe("resolveFileIcons", () => {
  it("replaces fileicon: paths anywhere in the tree, loading each once", async () => {
    const loaded: string[] = [];
    const load = async (path: string): Promise<string | null> => {
      loaded.push(path);
      return path === "/Apps/Missing.app" ? null : `data:${path}`;
    };
    const result = (await resolveFileIcons(
      tree("fileicon:/Apps/A.app", "fileicon:/Apps/A.app"),
      load,
    )) as PluginListTree;
    const item = result.sections[0].items[0];
    assert.equal(item.icon, "data:/Apps/A.app");
    assert.equal(item.accessories![0].icon, "data:/Apps/A.app");
    assert.equal(item.title, "fileicon: in a title stays text");
    assert.deepEqual(loaded, ["/Apps/A.app"]);

    const missing = (await resolveFileIcons(
      tree("fileicon:/Apps/Missing.app", "⚙"),
      load,
    )) as PluginListTree;
    assert.equal(missing.sections[0].items[0].icon, undefined);
    assert.equal(missing.sections[0].items[0].accessories![0].icon, "⚙");
  });

  it("returns a tree without file icons untouched", async () => {
    const input = tree("⚙", "⚙");
    assert.equal(await resolveFileIcons(input, async () => null), input);
  });
});
