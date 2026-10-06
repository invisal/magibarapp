import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMacOnlyUsage } from "./linux-compat.ts";

describe("findMacOnlyUsage", () => {
  it("flags AppleScript and ~/Library paths", () => {
    assert.deepEqual(
      findMacOnlyUsage(`execFile("osascript"); join(home, "~/Library/x")`),
      ["AppleScript", "macOS ~/Library paths"],
    );
  });
  it("is empty for portable code", () => {
    assert.deepEqual(findMacOnlyUsage(`fetch("https://example.com")`), []);
  });
});
