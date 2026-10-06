import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rewriteLibraryPaths,
  setHomeForTests,
  toLinuxPath,
  wrapFsModule,
} from "./linux-paths.ts";

const home = mkdtempSync(join(tmpdir(), "linux-paths-"));
setHomeForTests(home);
mkdirSync(join(home, ".config", "obsidian"), { recursive: true });

test("maps ~/Library folders onto their XDG counterparts", () => {
  const lib = join(home, "Library");
  assert.equal(
    toLinuxPath(`${lib}/Application Support/Code/User/globalStorage`),
    `${home}/.config/Code/User/globalStorage`,
  );
  assert.equal(
    toLinuxPath(`${lib}/Application Support/Google/Chrome/Default/History`),
    `${home}/.config/google-chrome/Default/History`,
  );
  assert.equal(
    toLinuxPath(`${lib}/Application Support/Firefox/Profiles/x.default`),
    `${home}/.mozilla/firefox/x.default`,
  );
  assert.equal(toLinuxPath(`${lib}/Caches/foo`), `${home}/.cache/foo`);
  assert.equal(
    toLinuxPath(`${lib}/Application Support/Obsidian/obsidian.json`),
    `${home}/.config/obsidian/obsidian.json`,
    "matches the folder case-insensitively",
  );
  assert.equal(toLinuxPath(`${lib}/Containers/x`), `${lib}/Containers/x`);
  assert.equal(toLinuxPath("/etc/hosts"), "/etc/hosts");
});

test("rewrites ~/Library paths inside shell strings", () => {
  assert.equal(
    rewriteLibraryPaths(
      `cat "${home}/Library/Application Support/Code/x" ${home}/Library/Application\\ Support/Slack/y`,
    ),
    `cat "${home}/.config/Code/x" ${home}/.config/Slack/y`,
  );
});

test("the wrapped fs reads through mapped paths", async () => {
  writeFileSync(join(home, ".config", "obsidian", "a.json"), "{}");
  const wrapped = wrapFsModule(fs);
  const mac = join(
    home,
    "Library",
    "Application Support",
    "obsidian",
    "a.json",
  );
  assert.equal(wrapped.existsSync(mac), true);
  assert.equal(wrapped.readFileSync(mac, "utf8"), "{}");
  assert.equal(await wrapped.promises.readFile(mac, "utf8"), "{}");
  assert.equal(wrapped.readFileSync, wrapped.readFileSync, "stable identity");
  assert.equal(wrapped.constants, fs.constants);
});
