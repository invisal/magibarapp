import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installDependencies } from "./npm-install.ts";
import type { RaycastManifest } from "../manifest.ts";

function manifest(dependencies?: Record<string, string>): RaycastManifest {
  return {
    name: "x",
    title: "X",
    commands: [],
    dependencies,
  };
}

describe("installDependencies", () => {
  // Only the "nothing to do" path is unit-testable without a live npm
  // registry — real installs are manual-only, same as `fetch-github.ts`'s
  // network path.
  it("skips npm entirely when the manifest has no dependencies", async () => {
    const result = await installDependencies("/nonexistent", manifest());
    assert.deepEqual(result, { ok: true });
  });

  it("skips npm entirely when dependencies is an empty object", async () => {
    const result = await installDependencies("/nonexistent", manifest({}));
    assert.deepEqual(result, { ok: true });
  });
});
