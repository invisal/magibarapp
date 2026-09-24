import assert from "node:assert/strict";
import { test } from "node:test";

import { withExtensionEnabled } from "./gnome-extension.ts";

const UUID = "'magibar@magibar.app'";

test("an empty list is written back as [] rather than GSettings' @as []", () => {
  // `gsettings get` prints an empty `as` as "@as []", which `gsettings set`
  // refuses as input — writing it back verbatim is a silent no-op install.
  assert.equal(withExtensionEnabled("@as []"), `[${UUID}]`);
  assert.equal(withExtensionEnabled("[]"), `[${UUID}]`);
  assert.equal(withExtensionEnabled(null), `[${UUID}]`);
});

test("appending keeps every extension the user already had enabled", () => {
  assert.equal(
    withExtensionEnabled("['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']\n"),
    `['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com', ${UUID}]`,
  );
});

test("an already-enabled extension needs no write at all", () => {
  assert.equal(withExtensionEnabled(`['ding@rastersoft.com', ${UUID}]`), null);
  assert.equal(withExtensionEnabled(`[${UUID}]`), null);
});

test("trailing newline from gsettings doesn't corrupt the appended list", () => {
  // `gsettings get` always ends with a newline; splicing before the closing
  // bracket without trimming would put the entry after it.
  const result = withExtensionEnabled("['a@b.c']\n");
  assert.equal(result, `['a@b.c', ${UUID}]`);
  assert.ok(result!.endsWith("]"));
});
