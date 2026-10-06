import { test } from "node:test";
import { execFileSync } from "node:child_process";
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

test("the sqlite3 shim speaks the CLI's --json and list modes", () => {
  const dir = ensureLinuxShimDir(
    join(mkdtempSync(join(tmpdir(), "shim-")), "b"),
  );
  const env = { ...process.env, MAGIBAR_NODE: process.execPath };
  const db = join(dir, "t.db");
  const run = (...args: string[]) =>
    execFileSync(join(dir, "sqlite3"), args, { env, encoding: "utf8" });
  run(
    db,
    "create table t(a integer, b text); insert into t values (9007199254740993, 'x;y'), (2, null)",
  );
  assert.equal(
    run("--json", "--readonly", "--vfs", "unix-none", db, "select * from t"),
    '[{"a":9007199254740993,"b":"x;y"},\n{"a":2,"b":null}]\n',
  );
  assert.equal(
    run(
      "-header",
      "-separator",
      "\t",
      `file:${db}?immutable=1`,
      "select a, b from t",
    ),
    "a\tb\n9007199254740993\tx;y\n2\t\n",
  );
  assert.equal(run(db, "select 1 where 0"), "");
});
