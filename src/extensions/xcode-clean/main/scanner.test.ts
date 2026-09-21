import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cleanItems } from "./cleaner.ts";
import { XcodeScanner } from "./scanner.ts";
import type { ScanSnapshot } from "../shared/types.ts";

let home: string;
let xcode: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xcode-clean-"));
  xcode = join(home, "Library", "Developer", "Xcode");
  mkdirSync(join(xcode, "DerivedData", "App-abc"), { recursive: true });
  mkdirSync(join(xcode, "DerivedData", "Big-def"), { recursive: true });
  mkdirSync(join(xcode, "iOS DeviceSupport", "iPhone 27.0"), {
    recursive: true,
  });
  mkdirSync(join(xcode, "DerivedData", "Empty-000"), { recursive: true });
  writeFileSync(join(xcode, "DerivedData", "App-abc", "f"), "x");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function scanner(onChange: (s: ScanSnapshot) => void = () => {}) {
  return new XcodeScanner({
    home,
    measure: async (paths) =>
      paths.map((path) => ({
        path,
        bytes: path.endsWith("Big-def")
          ? 900
          : path.endsWith("Empty-000")
            ? 0
            : 100,
        fileCount: 1,
        modifiedMs: 5,
      })),
    workspacePath: async () => undefined,
    xcodeRunning: async () => false,
    onChange,
  });
}

test("scan() lists existing folders first, then fills sizes in largest-first", async () => {
  const s = scanner();
  const { initial, done } = await s.scan();
  assert.deepEqual(initial.categories.map((c) => c.id).sort(), [
    "derived-data",
    "device-support",
  ]);
  assert.ok(initial.categories.every((c) => c.pending));

  await done;
  const [first] = s.snapshot().categories;
  assert.equal(first.id, "derived-data");
  assert.equal(first.bytes, 1000);
  assert.deepEqual(
    first.items.map((i) => i.title),
    ["Big", "App"],
  );
});

test("a rescan keeps previously known sizes while re-measuring", async () => {
  const s = scanner();
  await (
    await s.scan()
  ).done;
  const { initial } = await s.scan();
  assert.equal(
    initial.categories.find((c) => c.id === "derived-data")?.bytes,
    1000,
  );
});

test("cleanItems() deletes known folders and reports the freed bytes", async () => {
  const s = scanner();
  await (
    await s.scan()
  ).done;
  const removed: string[] = [];
  const result = await cleanItems(
    ["derived-data:Library/Developer/Xcode/DerivedData/Big-def"],
    (id) => s.lookup(id),
    async (p) => void removed.push(p),
  );
  assert.equal(result.freedBytes, 900);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(removed, [join(xcode, "DerivedData", "Big-def")]);
});

test("cleanItems() refuses unknown ids and folders swapped for a symlink parent", async () => {
  const s = scanner();
  await (
    await s.scan()
  ).done;
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    const entry = s.lookup(
      "derived-data:Library/Developer/Xcode/DerivedData/App-abc",
    )!;
    rmSync(join(xcode, "DerivedData"), { recursive: true });
    symlinkSync(outside, join(xcode, "DerivedData"));
    // Root now resolves to `outside`, but the item's dirname is that same
    // symlink — swap the recorded root to simulate a stale/forged entry.
    const forged = { ...entry, root: join(xcode, "iOS DeviceSupport") };
    const removed: string[] = [];
    const result = await cleanItems(
      ["nope", "forged"],
      (id) => (id === "forged" ? forged : undefined),
      async (p) => void removed.push(p),
    );
    assert.equal(result.failed.length, 2);
    assert.deepEqual(removed, []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("folders that measure 0 B are dropped from the list and the lookup", async () => {
  const s = scanner();
  await (
    await s.scan()
  ).done;
  const derived = s.snapshot().categories.find((c) => c.id === "derived-data");
  assert.deepEqual(
    derived?.items.map((i) => i.title),
    ["Big", "App"],
  );
  assert.equal(
    s.lookup("derived-data:Library/Developer/Xcode/DerivedData/Empty-000"),
    undefined,
  );
});
