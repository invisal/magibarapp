import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  missingRequiredPreferences,
  preferencesPayload,
  resolvePreferenceValues,
} from "./preferences.ts";
import type { PluginRegistryEntry } from "./registry.ts";

function entry(
  overrides: Partial<PluginRegistryEntry> = {},
): PluginRegistryEntry {
  return {
    id: "ext",
    title: "Ext",
    sourceRef: { kind: "local", path: "/x" },
    installedAt: 0,
    preferences: [
      { name: "token", type: "password", required: true },
      { name: "verbose", type: "checkbox", required: false },
      {
        name: "region",
        type: "dropdown",
        required: true,
        data: [
          { title: "EU", value: "eu" },
          { title: "US", value: "us" },
        ],
      },
      {
        name: "editor",
        type: "appPicker",
        required: false,
        default: "com.microsoft.VSCode",
      },
      { name: "folder", type: "directory", required: false },
    ],
    commands: [
      {
        name: "search",
        title: "Search",
        mode: "view",
        preferences: [
          { name: "limit", type: "textfield", required: false, default: "10" },
        ],
      },
      {
        name: "post",
        title: "Post",
        mode: "no-view",
        preferences: [{ name: "channel", type: "textfield", required: true }],
      },
    ],
    preferenceValues: {},
    ...overrides,
  };
}

describe("resolvePreferenceValues", () => {
  it("fills manifest defaults under the stored values", () => {
    const values = resolvePreferenceValues(
      entry({ preferenceValues: { token: "abc", "search.limit": "25" } }),
      "search",
    );
    assert.deepEqual(values, {
      token: "abc",
      verbose: false,
      region: "eu",
      editor: {
        name: "com.microsoft.VSCode",
        path: "com.microsoft.VSCode",
        bundleId: "com.microsoft.VSCode",
      },
      folder: "",
      limit: "25",
    });
  });

  it("only includes the launched command's own preferences", () => {
    const values = resolvePreferenceValues(entry(), "post");
    assert.equal("limit" in values, false);
    assert.equal(values.channel, "");
  });

  it("turns an appPicker path into an Application", () => {
    const values = resolvePreferenceValues(
      entry({ preferenceValues: { editor: "/Applications/Zed.app" } }),
      "search",
    );
    assert.deepEqual(values.editor, {
      name: "Zed",
      path: "/Applications/Zed.app",
    });
  });
});

describe("missingRequiredPreferences", () => {
  it("reports required values with neither a stored value nor a default", () => {
    assert.deepEqual(missingRequiredPreferences(entry(), "search"), [
      "token",
      "region",
    ]);
    assert.deepEqual(missingRequiredPreferences(entry(), "post"), [
      "token",
      "region",
      "post.channel",
    ]);
  });

  it("covers every command when no command is given", () => {
    assert.deepEqual(
      missingRequiredPreferences(
        entry({ preferenceValues: { token: "t", region: "us" } }),
      ),
      ["post.channel"],
    );
  });
});

describe("preferencesPayload", () => {
  it("keys command-level fields by <command>.<name>", () => {
    const payload = preferencesPayload(entry());
    assert.deepEqual(
      payload.fields.map((f) => [f.name, f.commandTitle ?? null]),
      [
        ["token", null],
        ["verbose", null],
        ["region", null],
        ["editor", null],
        ["folder", null],
        ["search.limit", "Search"],
        ["post.channel", "Post"],
      ],
    );
  });
});
