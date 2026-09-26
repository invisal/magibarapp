import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePlugin, findEntryFile } from "./bundle.ts";
import { pluginBundlePath, pluginDistDir } from "../paths.ts";
import { parseManifest } from "../manifest.ts";
import { runNoView } from "../host/runtime.ts";
import type { HostEffect } from "../host/protocol.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("./fixtures/sample-plugin", import.meta.url),
);

function fixtureCommands() {
  const parsed = parseManifest(
    readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest.commands;
}

describe("bundlePlugin", () => {
  let pluginsRoot: string;

  beforeEach(() => {
    pluginsRoot = mkdtempSync(join(tmpdir(), "plugin-bundle-"));
  });

  afterEach(() => {
    rmSync(pluginsRoot, { recursive: true, force: true });
  });

  it("bundles every command ray-build style: @raycast/api and React stay external", async () => {
    const result = await bundlePlugin(
      pluginsRoot,
      "sample-plugin",
      FIXTURE_DIR,
      fixtureCommands(),
    );
    assert.deepEqual(result, { ok: true });

    const browse = readFileSync(
      pluginBundlePath(pluginsRoot, "sample-plugin", "browse"),
      "utf8",
    );
    assert.match(browse, /require\(["']@raycast\/api["']\)/);
    assert.match(browse, /require\(["']react\/jsx-runtime["']\)/);
    // Nothing of the shim itself got inlined — `host/runtime.ts` supplies it.
    assert.doesNotMatch(browse, /unsupportedComponent/);

    // The dist folder is pinned to CommonJS regardless of ancestors.
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(pluginDistDir(pluginsRoot, "sample-plugin"), "package.json"),
          "utf8",
        ),
      ),
      { type: "commonjs" },
    );
  });

  it("the built bundle runs through the shared runtime", async () => {
    await bundlePlugin(
      pluginsRoot,
      "sample-plugin",
      FIXTURE_DIR,
      fixtureCommands(),
    );
    const effects: HostEffect[] = [];
    await runNoView(
      {
        bundlePath: pluginBundlePath(pluginsRoot, "sample-plugin", "greet"),
        pluginId: "sample-plugin",
        pluginTitle: "Sample Plugin",
        extensionName: "sample-plugin",
        commandName: "greet",
        commandMode: "no-view",
        appearance: "dark",
        storageFilePath: join(pluginsRoot, "sample-plugin", "storage.json"),
        cacheFilePath: join(pluginsRoot, "sample-plugin", "cache.json"),
        supportPath: join(pluginsRoot, "sample-plugin", "support"),
        assetsPath: join(pluginsRoot, "sample-plugin", "assets"),
        preferenceValues: {},
      },
      { sendEffect: (e) => effects.push(e), request: async () => undefined },
    );
    assert.deepEqual(effects, [
      { op: "hud", title: "Hello from the fixture plugin" },
    ]);
    const cacheFile = readFileSync(
      join(pluginsRoot, "sample-plugin", "cache.json"),
      "utf8",
    );
    assert.match(cacheFile, /"cache::greeted-at":\s*"fixture-run"/);
  });

  it("reports a clear error when a command's entry file is missing", async () => {
    const result = await bundlePlugin(
      pluginsRoot,
      "sample-plugin",
      FIXTURE_DIR,
      [{ name: "does-not-exist", title: "Nope", mode: "no-view" }],
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /does-not-exist/);
  });
});

describe("findEntryFile", () => {
  it("finds src/<name>/index.tsx as well as src/<name>.tsx", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-entry-"));
    try {
      mkdirSync(join(dir, "src", "nested"), { recursive: true });
      writeFileSync(join(dir, "src", "flat.tsx"), "");
      writeFileSync(join(dir, "src", "nested", "index.ts"), "");
      assert.equal(findEntryFile(dir, "flat"), join(dir, "src", "flat.tsx"));
      assert.equal(
        findEntryFile(dir, "nested"),
        join(dir, "src", "nested", "index.ts"),
      );
      assert.equal(findEntryFile(dir, "missing"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
