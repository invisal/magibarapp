import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionStorage } from "../core/storage.ts";
import { PluginRegistry, type PluginRegistryEntry } from "./registry.ts";

function entry(id: string): PluginRegistryEntry {
  return {
    id,
    title: id,
    sourceRef: { kind: "local", path: "/tmp/x" },
    installedAt: Date.now(),
    commands: [{ name: "run", title: "Run", mode: "no-view" }],
    preferenceValues: {},
  };
}

describe("PluginRegistry", () => {
  let dir: string;
  let registry: PluginRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugin-registry-"));
    registry = new PluginRegistry(
      new ExtensionStorage(join(dir, "registry.json"), "test"),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    assert.deepEqual(registry.list(), []);
  });

  it("round-trips an upsert", () => {
    registry.upsert(entry("a"));
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("a")?.title, "a");
  });

  it("upsert replaces an existing entry with the same id", () => {
    registry.upsert(entry("a"));
    const updated = { ...entry("a"), title: "A v2" };
    registry.upsert(updated);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("a")?.title, "A v2");
  });

  it("removes an entry", () => {
    registry.upsert(entry("a"));
    registry.upsert(entry("b"));
    registry.remove("a");
    assert.deepEqual(
      registry.list().map((e) => e.id),
      ["b"],
    );
  });

  it("persists across instances backed by the same file", () => {
    registry.upsert(entry("a"));
    const reopened = new PluginRegistry(
      new ExtensionStorage(join(dir, "registry.json"), "test"),
    );
    assert.equal(reopened.list().length, 1);
  });

  it("setPreferenceValues replaces the stored values", () => {
    registry.upsert(entry("a"));
    registry.setPreferenceValues("a", { token: "x" });
    assert.deepEqual(registry.get("a")?.preferenceValues, { token: "x" });
  });

  it("setCommandSubtitle sets and clears a command's subtitle override", () => {
    registry.upsert(entry("a"));
    registry.setCommandSubtitle("a", "run", "3 unread");
    assert.equal(registry.get("a")?.commands[0].subtitleOverride, "3 unread");
    registry.setCommandSubtitle("a", "run", null);
    assert.equal(registry.get("a")?.commands[0].subtitleOverride, undefined);
  });
});
