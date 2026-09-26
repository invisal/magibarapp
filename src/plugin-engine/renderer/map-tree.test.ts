import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actionPanelToMenuItems,
  actionShortcuts,
  isTextEditingChord,
} from "./map-tree.ts";
import type { PluginActionPanelNode } from "../host/protocol.ts";

const panel: PluginActionPanelNode = {
  sections: [
    {
      actions: [
        { id: "open", title: "Open" },
        { id: "copy", title: "Copy", shortcut: "cmd+shift+c" },
      ],
    },
    {
      title: "More",
      actions: [
        { id: "refresh", title: "Refresh", shortcut: "cmd+r" },
        { id: "look", title: "Quick Look", shortcut: "space" },
        { id: "menu", title: "Steals ⌘K", shortcut: "cmd+k" },
        { id: "dup", title: "Also ⌘R", shortcut: "cmd+r" },
      ],
    },
  ],
};

describe("actionShortcuts", () => {
  it("gives the first two actions ↵ / ⌘↵, then each declared chord", () => {
    assert.deepEqual(actionShortcuts(panel, "list", true), [
      { accelerator: "Enter", actionId: "open" },
      { accelerator: "CommandOrControl+Enter", actionId: "copy" },
      { accelerator: "cmd+shift+c", actionId: "copy" },
      { accelerator: "cmd+r", actionId: "refresh" },
    ]);
  });

  it("uses ⌘↵ / ⌘⇧↵ in a form, leaving plain ↵ to the field", () => {
    const chords = actionShortcuts(panel, "form", true).slice(0, 2);
    assert.deepEqual(chords, [
      { accelerator: "CommandOrControl+Enter", actionId: "open" },
      { accelerator: "CommandOrControl+Shift+Enter", actionId: "copy" },
    ]);
  });

  it("lets the implicit chord win over a declared duplicate", () => {
    const shortcuts = actionShortcuts(
      {
        sections: [
          {
            actions: [
              { id: "a", title: "A" },
              { id: "b", title: "B" },
              { id: "c", title: "C", shortcut: "cmd+enter" },
            ],
          },
        ],
      },
      "list",
      true,
    );
    assert.equal(
      shortcuts.some((s) => s.actionId === "c"),
      false,
    );
  });

  it("resolves CommandOrControl per platform when comparing chords", () => {
    const shortcuts = actionShortcuts(
      {
        sections: [
          {
            actions: [
              { id: "a", title: "A" },
              { id: "b", title: "B" },
              { id: "c", title: "C", shortcut: "ctrl+enter" },
            ],
          },
        ],
      },
      "list",
      false,
    );
    assert.equal(
      shortcuts.some((s) => s.actionId === "c"),
      false,
    );
  });

  it("is empty with no panel", () => {
    assert.deepEqual(actionShortcuts(undefined, "list", true), []);
  });
});

describe("actionPanelToMenuItems", () => {
  it("shows the chords that actually fire when given them", () => {
    const items = actionPanelToMenuItems(
      panel,
      () => {},
      actionShortcuts(panel, "list", true),
    );
    assert.equal(items[0].shortcut, "Enter");
    assert.equal(items[1].shortcut, "CommandOrControl+Enter");
    assert.equal(items[3].shortcut, undefined); // bare "space" isn't bound
  });
});

describe("isTextEditingChord", () => {
  it("matches ⌘C on macOS and Ctrl+C elsewhere", () => {
    assert.equal(isTextEditingChord("cmd+c", true), true);
    assert.equal(isTextEditingChord("CommandOrControl+C", false), true);
    assert.equal(isTextEditingChord("cmd+shift+c", true), false);
    assert.equal(isTextEditingChord("ctrl+c", true), false);
  });
});
