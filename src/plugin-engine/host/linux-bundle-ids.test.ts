import { test } from "node:test";
import assert from "node:assert/strict";
import { macBundleIdFor } from "./linux-bundle-ids.ts";

test("maps deb, snap and Flatpak desktop IDs to the macOS bundle id", () => {
  assert.equal(macBundleIdFor("code"), "com.microsoft.VSCode");
  assert.equal(macBundleIdFor("google-chrome"), "com.google.Chrome");
  assert.equal(macBundleIdFor("firefox_firefox"), "org.mozilla.firefox");
  assert.equal(macBundleIdFor("com.spotify.Client"), "com.spotify.client");
  assert.equal(macBundleIdFor("gnome-calculator"), undefined);
});
