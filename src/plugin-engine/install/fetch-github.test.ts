import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGithubFolderUrl, splitFolderPath } from "./fetch-github.ts";

describe("parseGithubFolderUrl", () => {
  it("parses a full github.com tree URL", () => {
    const result = parseGithubFolderUrl(
      "https://github.com/raycast/extensions/tree/main/extensions/lorem-ipsum",
    );
    assert.deepEqual(result, {
      owner: "raycast",
      repo: "extensions",
      ref: "main",
      path: "extensions/lorem-ipsum",
    });
  });

  it("parses a URL without a protocol", () => {
    const result = parseGithubFolderUrl(
      "github.com/raycast/extensions/tree/main/extensions/lorem-ipsum",
    );
    assert.deepEqual(result, {
      owner: "raycast",
      repo: "extensions",
      ref: "main",
      path: "extensions/lorem-ipsum",
    });
  });

  it("trims a trailing slash off the path", () => {
    const result = parseGithubFolderUrl(
      "https://github.com/raycast/extensions/tree/main/extensions/lorem-ipsum/",
    );
    assert.equal(result?.path, "extensions/lorem-ipsum");
  });

  it("parses a bare owner/repo/path form with no explicit ref", () => {
    const result = parseGithubFolderUrl(
      "raycast/extensions/extensions/lorem-ipsum",
    );
    assert.deepEqual(result, {
      owner: "raycast",
      repo: "extensions",
      ref: null,
      path: "extensions/lorem-ipsum",
    });
  });

  it("rejects a bare form with fewer than 3 segments", () => {
    assert.equal(parseGithubFolderUrl("raycast/extensions"), null);
  });

  it("rejects an unrelated URL", () => {
    assert.equal(parseGithubFolderUrl("https://example.com/foo/bar"), null);
  });

  it("rejects an empty string", () => {
    assert.equal(parseGithubFolderUrl(""), null);
  });
});

describe("splitFolderPath", () => {
  it("splits a multi-segment path", () => {
    assert.deepEqual(splitFolderPath("extensions/speedtest"), [
      "extensions",
      "speedtest",
    ]);
  });

  it("drops a trailing slash", () => {
    assert.deepEqual(splitFolderPath("extensions/speedtest/"), [
      "extensions",
      "speedtest",
    ]);
  });

  it("handles a single segment", () => {
    assert.deepEqual(splitFolderPath("extensions"), ["extensions"]);
  });

  it("returns an empty array for an empty path", () => {
    assert.deepEqual(splitFolderPath(""), []);
  });
});
