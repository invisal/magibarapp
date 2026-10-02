import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLinuxShimDir,
  LINUX_SHIMS,
  withLinuxShimPath,
} from "./linux-shims.ts";

test("ensureLinuxShimDir writes every shim as an executable", () => {
  const dir = ensureLinuxShimDir(
    join(mkdtempSync(join(tmpdir(), "shim-")), "b"),
  );
  for (const name of Object.keys(LINUX_SHIMS)) {
    assert.ok(statSync(join(dir, name)).mode & 0o100, `${name} is executable`);
  }
  assert.match(readFileSync(join(dir, "osascript"), "utf8"), /Linux/);
});

test("withLinuxShimPath appends so real tools win", () => {
  assert.equal(withLinuxShimPath("/usr/bin", "/s"), "/usr/bin:/s");
  assert.equal(withLinuxShimPath(undefined, "/s"), "/s");
});
