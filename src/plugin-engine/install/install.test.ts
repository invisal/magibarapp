import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import {
  installPlugin,
  normalizeSource,
  raycastExtensionsFolder,
} from "./install.ts";
import {
  pluginBundlePath,
  pluginSourceDir,
  pluginStorageFilePath,
} from "../paths.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("./fixtures/sample-plugin", import.meta.url),
);

const STORE_MANIFEST = {
  name: "store-ext",
  title: "Store Ext",
  platforms: ["macOS", "Windows"],
  preferences: [
    { name: "token", type: "password", required: true, title: "Token" },
  ],
  commands: [
    { name: "run", title: "Run", mode: "no-view" },
    { name: "tray", title: "Tray", mode: "menu-bar" },
    { name: "ghost", title: "Ghost", mode: "view" },
  ],
};

function storeZip(manifest: object = STORE_MANIFEST): Uint8Array {
  return zipSync({
    "store-ext/package.json": strToU8(JSON.stringify(manifest)),
    "store-ext/run.js": strToU8('"use strict";exports.default=async()=>{};'),
    "store-ext/run.js.map": strToU8("{}"),
    "store-ext/assets/icon.png": new Uint8Array([1, 2, 3]),
  });
}

/** A fake `fetch` answering the Store search endpoint and the S3 download. */
function storeFetch(
  zip: Uint8Array,
  listing: Record<string, unknown> = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (
      url.startsWith("https://www.raycast.com/frontend_api/extensions/search")
    ) {
      return Response.json({
        data: [
          {
            name: "store-ext",
            title: "Store Ext",
            author: { handle: "someone" },
            platforms: ["macOS", "Windows"],
            download_url: "https://s3.example/store-ext.zip",
            commit_sha: "abc123",
            updated_at: 1700000000,
            ...listing,
          },
        ],
      });
    }
    if (url === "https://s3.example/store-ext.zip") {
      return new Response(zip, {
        headers: { "content-length": String(zip.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("installPlugin — Raycast Store", () => {
  let pluginsRoot: string;

  beforeEach(() => {
    pluginsRoot = mkdtempSync(join(tmpdir(), "plugin-install-"));
  });

  afterEach(() => {
    rmSync(pluginsRoot, { recursive: true, force: true });
  });

  it("downloads the prebuilt package and lays it out as source/ + dist/", async () => {
    const stages: string[] = [];
    const result = await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext", author: "someone" },
      {
        fetch: storeFetch(storeZip()),
        platform: "darwin",
        onProgress: (stage) => stages.push(stage),
      },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;

    assert.equal(result.entry.id, "store-ext");
    assert.equal(result.entry.name, "store-ext");
    // menu-bar is skipped by the manifest parser; "ghost" has no bundle.
    assert.deepEqual(
      result.entry.commands.map((c) => c.name),
      ["run"],
    );
    assert.deepEqual(result.entry.sourceRef, {
      kind: "store",
      name: "store-ext",
      author: "someone",
      commitSha: "abc123",
      updatedAt: 1700000000,
    });
    assert.equal(result.entry.preferences?.[0].name, "token");

    assert.ok(existsSync(pluginBundlePath(pluginsRoot, "store-ext", "run")));
    const source = pluginSourceDir(pluginsRoot, "store-ext");
    assert.ok(existsSync(join(source, "package.json")));
    assert.ok(existsSync(join(source, "assets", "icon.png")));
    assert.ok(!existsSync(join(source, "run.js.map")));
    assert.ok(stages.includes("downloading") && stages.includes("extracting"));
    // No staging leftovers.
    assert.deepEqual(
      readdirSync(pluginsRoot).filter((n) => n.startsWith(".staging-")),
      [],
    );
  });

  it("refuses a listing that doesn't support this platform", async () => {
    const result = await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext" },
      {
        fetch: storeFetch(storeZip(), { platforms: null }),
        platform: "win32",
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /only supports macOS/);
  });

  it("a failed reinstall leaves the working install (and its data) intact", async () => {
    const first = await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext" },
      { fetch: storeFetch(storeZip()), platform: "darwin" },
    );
    assert.equal(first.ok, true);
    writeFileSync(
      pluginStorageFilePath(pluginsRoot, "store-ext"),
      '{"kept":1}',
    );

    const broken = zipSync({ "store-ext/package.json": strToU8("{nope") });
    const second = await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext" },
      { fetch: storeFetch(broken), platform: "darwin" },
    );
    assert.equal(second.ok, false);
    assert.ok(existsSync(pluginBundlePath(pluginsRoot, "store-ext", "run")));
    assert.equal(
      readFileSync(pluginStorageFilePath(pluginsRoot, "store-ext"), "utf8"),
      '{"kept":1}',
    );
  });

  it("a successful reinstall carries the plugin's own data over", async () => {
    const opts = { fetch: storeFetch(storeZip()), platform: "darwin" as const };
    await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext" },
      opts,
    );
    writeFileSync(
      pluginStorageFilePath(pluginsRoot, "store-ext"),
      '{"kept":2}',
    );
    const again = await installPlugin(
      pluginsRoot,
      { kind: "store", name: "store-ext" },
      opts,
    );
    assert.equal(again.ok, true);
    assert.equal(
      readFileSync(pluginStorageFilePath(pluginsRoot, "store-ext"), "utf8"),
      '{"kept":2}',
    );
  });

  it("routes a raycast/extensions GitHub link to the Store", async () => {
    const result = await installPlugin(
      pluginsRoot,
      {
        kind: "github",
        url: "https://github.com/raycast/extensions/tree/main/extensions/store-ext",
      },
      { fetch: storeFetch(storeZip()), platform: "darwin" },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.entry.sourceRef.kind, "store");
  });
});

describe("installPlugin — raycast/extensions folder whose name differs", () => {
  it("reads the folder's manifest to find the real Store name", async () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), "plugin-install-"));
    try {
      const base = storeFetch(storeZip());
      const seen: string[] = [];
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input);
        seen.push(url);
        if (
          url.startsWith(
            "https://raw.githubusercontent.com/raycast/extensions/main/extensions/renamed-folder/",
          )
        ) {
          return Response.json({
            name: "store-ext",
            author: "someone",
            title: "Store Ext",
          });
        }
        return base(input, init);
      }) as typeof fetch;
      const result = await installPlugin(
        pluginsRoot,
        { kind: "github", url: "raycast/extensions/extensions/renamed-folder" },
        { fetch: fetchImpl, platform: "darwin" },
      );
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      assert.ok(seen.some((u) => u.includes("search?q=store-ext")));
    } finally {
      rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });
});

describe("normalizeSource", () => {
  it("recognizes raycast/extensions folder links in both URL forms", () => {
    assert.deepEqual(
      raycastExtensionsFolder(
        "https://github.com/raycast/extensions/tree/8490f28/extensions/spotify-player/",
      ),
      { name: "spotify-player", ref: "8490f28" },
    );
    assert.deepEqual(
      raycastExtensionsFolder("raycast/extensions/extensions/emoji"),
      { name: "emoji", ref: null },
    );
    assert.equal(
      raycastExtensionsFolder(
        "https://github.com/someone/else/tree/main/extensions/x",
      ),
      null,
    );
    assert.equal(
      raycastExtensionsFolder("raycast/extensions/extensions/emoji/src"),
      null,
    );
  });

  it("leaves local and other GitHub sources alone", () => {
    const local = { kind: "local" as const, path: "/x" };
    assert.equal(normalizeSource(local), local);
    const other = { kind: "github" as const, url: "someone/repo/ext" };
    assert.equal(normalizeSource(other), other);
  });
});

describe("installPlugin — local source build", () => {
  let pluginsRoot: string;

  beforeEach(() => {
    pluginsRoot = mkdtempSync(join(tmpdir(), "plugin-install-"));
  });

  afterEach(() => {
    rmSync(pluginsRoot, { recursive: true, force: true });
  });

  it("installs a local folder end to end: stages, bundles, and returns a registry entry", async () => {
    const result = await installPlugin(pluginsRoot, {
      kind: "local",
      path: FIXTURE_DIR,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;

    assert.equal(result.entry.id, "sample-plugin");
    assert.equal(result.entry.title, "Sample Plugin");
    assert.equal(result.entry.commands.length, 2);
    assert.deepEqual(result.entry.sourceRef, {
      kind: "local",
      path: FIXTURE_DIR,
    });

    const copiedManifest = readFileSync(
      join(pluginSourceDir(pluginsRoot, "sample-plugin"), "package.json"),
      "utf8",
    );
    assert.match(copiedManifest, /"sample-plugin"/);
    for (const command of ["greet", "browse"]) {
      assert.ok(
        readFileSync(
          pluginBundlePath(pluginsRoot, "sample-plugin", command),
          "utf8",
        ).length > 0,
      );
    }
  });

  it("fails clearly when the folder has no package.json", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "plugin-install-empty-"));
    try {
      const result = await installPlugin(pluginsRoot, {
        kind: "local",
        path: emptyDir,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /package\.json/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
