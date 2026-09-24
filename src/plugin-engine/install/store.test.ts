import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  extractPackage,
  isPlatformSupported,
  mapListing,
  resolveStoreExtension,
  safeRelativePath,
  searchStore,
} from "./store.ts";

function jsonFetch(body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return Response.json(body);
  }) as typeof fetch;
}

describe("mapListing", () => {
  it("maps the Store's listing shape to a search hit", () => {
    assert.deepEqual(
      mapListing({
        name: "spotify-player",
        title: "Spotify Player",
        description: "Control Spotify",
        author: { handle: "mattisssa", name: "Artem" },
        icons: { light: "https://files.raycast.com/icon", dark: null },
        platforms: ["macOS", "Windows"],
        download_count: 42,
        commands: [{}, {}],
      }),
      {
        name: "spotify-player",
        author: "mattisssa",
        authorName: "Artem",
        title: "Spotify Player",
        description: "Control Spotify",
        iconUrl: "https://files.raycast.com/icon",
        platforms: ["macOS", "Windows"],
        downloadCount: 42,
        commandCount: 2,
      },
    );
  });
});

describe("isPlatformSupported", () => {
  it("treats a missing platforms list as macOS-only", () => {
    assert.equal(isPlatformSupported(null, "darwin"), true);
    assert.equal(isPlatformSupported(null, "win32"), false);
    assert.equal(isPlatformSupported(["macOS"], "win32"), false);
    assert.equal(isPlatformSupported(["Windows"], "darwin"), false);
    assert.equal(isPlatformSupported(["macOS", "Windows"], "win32"), true);
    assert.equal(isPlatformSupported(null, "linux"), true);
  });
});

describe("searchStore", () => {
  it("queries the search endpoint and drops kill-listed listings", async () => {
    const seen: string[] = [];
    const hits = await searchStore("unique-query-for-cache-test", {
      fetch: jsonFetch(
        {
          data: [
            { name: "a", title: "A" },
            { name: "b", title: "B", kill_listed_at: 1700000000 },
          ],
        },
        seen,
      ),
    });
    assert.deepEqual(
      hits.map((h) => h.name),
      ["a"],
    );
    assert.match(seen[0], /extensions\/search\?q=unique-query-for-cache-test/);
  });

  it("returns nothing for a blank query without fetching", async () => {
    const seen: string[] = [];
    assert.deepEqual(
      await searchStore("   ", { fetch: jsonFetch({}, seen) }),
      [],
    );
    assert.equal(seen.length, 0);
  });
});

describe("resolveStoreExtension", () => {
  const data = [
    {
      name: "todo",
      title: "Todo",
      author: { handle: "alice" },
      download_url: "https://a",
    },
    {
      name: "todo",
      title: "Todo",
      author: { handle: "bob" },
      download_url: "https://b",
    },
    { name: "todo-list", title: "Todo List", download_url: "https://c" },
  ];

  it("requires an exact name match, disambiguated by author", async () => {
    const result = await resolveStoreExtension(
      { name: "todo", author: "bob" },
      { fetch: jsonFetch({ data }) },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.listing.download_url, "https://b");
  });

  it("fails clearly when nothing matches", async () => {
    const result = await resolveStoreExtension(
      { name: "nope" },
      { fetch: jsonFetch({ data }) },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /couldn't find "nope"/);
  });
});

describe("safeRelativePath", () => {
  it("rejects anything that could escape the destination", () => {
    assert.equal(safeRelativePath("../evil.js"), null);
    assert.equal(safeRelativePath("a/../../evil.js"), null);
    assert.equal(safeRelativePath("/etc/passwd"), null);
    assert.equal(safeRelativePath("C:\\Windows\\x"), null);
    assert.equal(safeRelativePath(""), null);
    assert.equal(
      safeRelativePath("./assets//icon.png"),
      join("assets", "icon.png"),
    );
  });
});

describe("extractPackage", () => {
  it("strips the top-level folder and skips source maps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-extract-"));
    try {
      const written = await extractPackage(
        zipSync({
          "ext/package.json": strToU8("{}"),
          "ext/cmd.js": strToU8("x"),
          "ext/cmd.js.map": strToU8("{}"),
          "ext/assets/icon.png": new Uint8Array([1]),
        }),
        dir,
      );
      assert.deepEqual(
        written.sort(),
        ["assets/icon.png", "cmd.js", "package.json"]
          .map((p) => join(...p.split("/")))
          .sort(),
      );
      assert.equal(readFileSync(join(dir, "cmd.js"), "utf8"), "x");
      assert.ok(!existsSync(join(dir, "cmd.js.map")));
      assert.ok(!readdirSync(dir).includes("ext"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a zip entry that tries to escape the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-extract-"));
    try {
      await assert.rejects(
        extractPackage(zipSync({ "../evil.js": strToU8("x") }), dir),
        /unsafe path/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bytes that aren't a zip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-extract-"));
    try {
      await assert.rejects(
        extractPackage(new Uint8Array([1, 2, 3, 4]), dir),
        /isn't a valid zip/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
