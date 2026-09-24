import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ExtensionStorage } from "../../../core/storage.ts";
import { DraftStore } from "./store.ts";

let dir: string;
/** Drives `updatedAt` so ordering/eviction are deterministic. */
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-"));
  clock = 1_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = (): string => join(dir, "draft.json");
const makeStore = (): DraftStore =>
  new DraftStore(new ExtensionStorage(file(), "ext:draft"), {
    now: () => (clock += 1_000),
  });

const input = (title: string, values: Record<string, unknown> = {}) => ({
  kind: "quicklink" as const,
  title,
  values,
});

test("save() generates an id and returns the stored draft", () => {
  const store = makeStore();
  const saved = store.save(input("Docs", { link: "https://x.dev" }));

  assert.equal(saved.id, "d1");
  assert.equal(saved.kind, "quicklink");
  assert.deepEqual(saved.values, { link: "https://x.dev" });
  assert.deepEqual(store.list(), [saved]);
});

test("save() with an existing id updates in place rather than adding", () => {
  const store = makeStore();
  const first = store.save(input("Docs", { link: "https://x.dev" }));
  const second = store.save({
    ...input("Docs Renamed", { link: "https://y.dev" }),
    id: first.id,
  });

  assert.equal(second.id, first.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(first.id)?.title, "Docs Renamed");
  assert.ok(second.updatedAt > first.updatedAt);
});

test("save() with an unknown id creates a new draft instead of resurrecting it", () => {
  const store = makeStore();
  const saved = store.save({ ...input("Ghost"), id: "gone" });

  assert.equal(saved.id, "d1");
  assert.deepEqual(
    store.list().map((d) => d.id),
    ["d1"],
  );
});

test("list() is newest first", () => {
  const store = makeStore();
  store.save(input("first"));
  store.save(input("second"));
  store.save(input("third"));

  assert.deepEqual(
    store.list().map((d) => d.title),
    ["third", "second", "first"],
  );
});

test("remove() drops just that draft", () => {
  const store = makeStore();
  const a = store.save(input("a"));
  store.save(input("b"));
  store.remove(a.id);

  assert.deepEqual(
    store.list().map((d) => d.title),
    ["b"],
  );
});

test("remove() of an unknown id is a no-op", () => {
  const store = makeStore();
  store.save(input("a"));
  store.remove("nope");

  assert.equal(store.list().length, 1);
});

test("ids are reused once freed, so they stay short", () => {
  const store = makeStore();
  const a = store.save(input("a"));
  store.save(input("b"));
  store.remove(a.id);

  assert.equal(store.save(input("c")).id, "d1");
});

test("the list is capped, evicting the oldest draft", () => {
  const store = makeStore();
  for (let n = 0; n < 25; n++) store.save(input(`draft ${n}`));

  const list = store.list();
  assert.equal(list.length, 20);
  assert.equal(list[0].title, "draft 24");
  assert.equal(list.at(-1)?.title, "draft 5");
});

test("mutating a returned draft does not reach into the store", () => {
  const store = makeStore();
  const saved = store.save(input("a", { link: "x" }));
  saved.title = "mutated";
  saved.values.link = "mutated";

  assert.equal(store.get(saved.id)?.title, "a");
  assert.deepEqual(store.get(saved.id)?.values, { link: "x" });
});

test("drafts survive a reload through storage", () => {
  const first = makeStore();
  first.save(input("Docs", { link: "https://x.dev" }));

  assert.deepEqual(
    makeStore()
      .list()
      .map((d) => d.title),
    ["Docs"],
  );
});

test("a malformed entry is dropped without losing the good ones", () => {
  writeFileSync(
    file(),
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      data: {
        drafts: [
          {
            id: "d1",
            kind: "quicklink",
            title: "good",
            values: {},
            updatedAt: 1,
          },
          {
            id: "d2",
            kind: "nonsense",
            title: "bad",
            values: {},
            updatedAt: 2,
          },
          "not even an object",
        ],
      },
    }),
  );

  assert.deepEqual(
    makeStore()
      .list()
      .map((d) => d.title),
    ["good"],
  );
});
