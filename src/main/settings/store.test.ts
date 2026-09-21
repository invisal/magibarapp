import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { SettingsStore } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("getGapSize defaults to 8px unset", () => {
  const settings = new SettingsStore({ dir });
  assert.equal(settings.getGapSize(), 8);
});

test("setGapSize overrides the default, and persists across instances", () => {
  const first = new SettingsStore({ dir });
  first.setGapSize(16);

  const second = new SettingsStore({ dir });
  assert.equal(second.getGapSize(), 16);
});

test("setGapSize clamps a negative value to zero", () => {
  const settings = new SettingsStore({ dir });
  settings.setGapSize(-5);
  assert.equal(settings.getGapSize(), 0);
});

test("missing, corrupt, and wrong-version files all yield the default without throwing", () => {
  // Missing: fresh dir.
  assert.equal(new SettingsStore({ dir }).getGapSize(), 8);

  // Corrupt JSON.
  writeFileSync(join(dir, "settings.json"), "{ not json");
  assert.equal(new SettingsStore({ dir }).getGapSize(), 8);

  // Wrong version.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ version: 999, savedAt: 0, gapPx: 20 }),
  );
  assert.equal(new SettingsStore({ dir }).getGapSize(), 8);
});

test("calculator settings default to crypto on / system number format", () => {
  assert.deepEqual(new SettingsStore({ dir }).getCalculatorSettings(), {
    cryptoEnabled: true,
    numberFormat: "system",
  });
});

test("setCalculatorSettings merges a patch, persists, and keeps the gap size", () => {
  const first = new SettingsStore({ dir });
  first.setGapSize(12);
  assert.deepEqual(first.setCalculatorSettings({ cryptoEnabled: false }), {
    cryptoEnabled: false,
    numberFormat: "system",
  });
  first.setCalculatorSettings({ numberFormat: "comma" });

  const second = new SettingsStore({ dir });
  assert.deepEqual(second.getCalculatorSettings(), {
    cryptoEnabled: false,
    numberFormat: "comma",
  });
  assert.equal(second.getGapSize(), 12);
});

test("setCalculatorSettings ignores invalid values", () => {
  const settings = new SettingsStore({ dir });
  settings.setCalculatorSettings({
    numberFormat: "roman" as never,
    cryptoEnabled: "yes" as never,
  });
  assert.deepEqual(settings.getCalculatorSettings(), {
    cryptoEnabled: true,
    numberFormat: "system",
  });
});

test("getWindowBounds is undefined until a position is saved, then persists across instances", () => {
  const first = new SettingsStore({ dir });
  assert.equal(first.getWindowBounds("settings"), undefined);

  first.setWindowBounds("settings", { x: 10, y: 20, width: 720, height: 560 });
  assert.deepEqual(first.getWindowBounds("settings"), {
    x: 10,
    y: 20,
    width: 720,
    height: 560,
  });
  assert.equal(first.getWindowBounds("widget"), undefined);

  const second = new SettingsStore({ dir });
  assert.deepEqual(second.getWindowBounds("settings"), {
    x: 10,
    y: 20,
    width: 720,
    height: 560,
  });
});

test("a settings file with an invalid windowBounds field falls back to defaults", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 1,
      savedAt: 0,
      windowBounds: { settings: { x: 10, y: "nope" } },
    }),
  );
  assert.equal(
    new SettingsStore({ dir }).getWindowBounds("settings"),
    undefined,
  );
});

test("getHotkey defaults to the platform default unset", () => {
  const settings = new SettingsStore({ dir });
  const expected =
    process.platform === "darwin" ? "Command+Shift+Space" : "Alt+Space";
  assert.equal(settings.getHotkey(), expected);
});

test("setHotkey overrides the default, and persists across instances", () => {
  const first = new SettingsStore({ dir });
  first.setHotkey("Control+Alt+Space");

  const second = new SettingsStore({ dir });
  assert.equal(second.getHotkey(), "Control+Alt+Space");
});

test("a settings file with an invalid hotkey field falls back to the default", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ version: 1, savedAt: 0, hotkey: "" }),
  );
  const expected =
    process.platform === "darwin" ? "Command+Shift+Space" : "Alt+Space";
  assert.equal(new SettingsStore({ dir }).getHotkey(), expected);
});

test("a settings file with an invalid calculator field falls back to defaults", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 1,
      savedAt: 0,
      gapPx: 20,
      numberFormat: "roman",
    }),
  );
  assert.equal(new SettingsStore({ dir }).getGapSize(), 8);
});

test("onboarding is not completed by default, and completion persists across instances", () => {
  const first = new SettingsStore({ dir });
  assert.equal(first.isOnboardingCompleted(), false);
  first.setOnboardingCompleted(true);

  assert.equal(new SettingsStore({ dir }).isOnboardingCompleted(), true);
});

test("a settings file saved before onboarding existed reads as not completed", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ version: 1, savedAt: 0, gapPx: 12 }),
  );
  const settings = new SettingsStore({ dir });
  assert.equal(settings.isOnboardingCompleted(), false);
  assert.equal(settings.getGapSize(), 12);
});
