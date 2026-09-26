import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toAccelerator } from "./shortcut-format.ts";

describe("toAccelerator", () => {
  it("maps Raycast's modifier and key tokens", () => {
    assert.equal(
      toAccelerator({ modifiers: ["cmd", "opt"], key: "arrowUp" }, "darwin"),
      "cmd+alt+up",
    );
  });

  it("reads Raycast's delete as backspace, deleteForward as delete", () => {
    assert.equal(
      toAccelerator({ modifiers: ["ctrl"], key: "delete" }, "darwin"),
      "ctrl+backspace",
    );
    assert.equal(
      toAccelerator({ modifiers: ["ctrl"], key: "deleteForward" }, "darwin"),
      "ctrl+delete",
    );
  });

  it("turns cmd into ctrl off macOS", () => {
    assert.equal(
      toAccelerator({ modifiers: ["cmd", "shift"], key: "c" }, "win32"),
      "ctrl+shift+c",
    );
  });

  it("picks the current platform's half of a per-platform shortcut", () => {
    const shortcut = {
      macOS: { modifiers: ["cmd"], key: "e" },
      Windows: { modifiers: ["ctrl", "shift"], key: "e" },
    };
    assert.equal(toAccelerator(shortcut, "darwin"), "cmd+e");
    assert.equal(toAccelerator(shortcut, "win32"), "ctrl+shift+e");
    assert.equal(toAccelerator({ macOS: shortcut.macOS }, "linux"), undefined);
  });

  it("drops anything that isn't a shortcut", () => {
    assert.equal(toAccelerator(undefined), undefined);
    assert.equal(toAccelerator({ key: "" }), undefined);
  });
});
