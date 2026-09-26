import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "./manifest.ts";

function pkg(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseManifest", () => {
  it("parses a minimal valid manifest", () => {
    const result = parseManifest(
      pkg({
        name: "lorem-ipsum",
        title: "Lorem Ipsum",
        commands: [{ name: "generate", title: "Generate", mode: "no-view" }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.commands.length, 1);
    assert.equal(result.manifest.commands[0].mode, "no-view");
  });

  it("rejects invalid JSON", () => {
    const result = parseManifest("{not json");
    assert.equal(result.ok, false);
  });

  it("rejects a manifest with no commands", () => {
    const result = parseManifest(pkg({ name: "x", title: "X", commands: [] }));
    assert.equal(result.ok, false);
  });

  it("skips commands with an unsupported mode instead of failing", () => {
    const result = parseManifest(
      pkg({
        name: "x",
        title: "X",
        commands: [
          { name: "bar", title: "Bar", mode: "menu-bar" },
          { name: "list", title: "List", mode: "view" },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.commands.length, 1);
    assert.equal(result.manifest.commands[0].name, "list");
  });

  it("keeps appPicker/file/directory preferences, even when required", () => {
    const result = parseManifest(
      pkg({
        name: "x",
        title: "X",
        commands: [{ name: "a", title: "A", mode: "no-view" }],
        preferences: [
          { name: "app", type: "appPicker", required: true },
          { name: "dir", type: "directory", required: false },
          { name: "file", type: "file" },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.manifest.preferences?.map((p) => [p.name, p.type, p.required]),
      [
        ["app", "appPicker", true],
        ["dir", "directory", false],
        ["file", "file", false],
      ],
    );
  });

  it("treats an unknown preference type as a text field instead of failing", () => {
    const result = parseManifest(
      pkg({
        name: "x",
        title: "X",
        commands: [{ name: "a", title: "A", mode: "no-view" }],
        preferences: [{ name: "token", type: "somethingNew", required: true }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.preferences?.[0].type, "textfield");
  });

  it("parses command arguments and platforms", () => {
    const result = parseManifest(
      pkg({
        name: "x",
        title: "X",
        platforms: ["macOS", "Windows"],
        commands: [
          {
            name: "a",
            title: "A",
            mode: "view",
            arguments: [
              {
                name: "query",
                type: "text",
                placeholder: "Query",
                required: true,
              },
              {
                name: "kind",
                type: "dropdown",
                placeholder: "Kind",
                data: [{ title: "One", value: "1" }],
              },
              { type: "text" },
            ],
          },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest.platforms, ["macOS", "Windows"]);
    assert.deepEqual(result.manifest.commands[0].arguments, [
      {
        name: "query",
        type: "text",
        placeholder: "Query",
        required: true,
        data: undefined,
      },
      {
        name: "kind",
        type: "dropdown",
        placeholder: "Kind",
        required: false,
        data: [{ title: "One", value: "1" }],
      },
    ]);
  });

  it("keeps supported preference types", () => {
    const result = parseManifest(
      pkg({
        name: "x",
        title: "X",
        commands: [
          {
            name: "a",
            title: "A",
            mode: "view",
            preferences: [
              { name: "apiKey", type: "password", required: true },
              {
                name: "unit",
                type: "dropdown",
                data: [{ title: "C", value: "c" }],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.commands[0].preferences?.length, 2);
  });
});
