import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barSegments,
  pruneSelection,
  safeItemIds,
  selectedBytes,
} from "./format.ts";
import type { CleanCategory, CleanItem } from "./types.ts";

function item(id: string, bytes: number | null): CleanItem {
  return {
    id,
    categoryId: "c",
    title: id,
    path: `/x/${id}`,
    bytes,
    fileCount: 0,
    modifiedAt: 0,
  };
}

function category(
  id: string,
  safety: "safe" | "caution",
  items: CleanItem[],
): CleanCategory {
  return {
    id,
    title: id,
    glyph: "",
    safety,
    consequence: "",
    bytes: items.reduce((s, i) => s + (i.bytes ?? 0), 0),
    pending: items.some((i) => i.bytes === null),
    items,
  };
}

const categories = [
  category("a", "safe", [item("a1", 300), item("a2", 100)]),
  category("b", "caution", [item("b1", 600), item("b2", null)]),
  category("empty", "safe", []),
];

test("barSegments() is proportional and skips empty categories", () => {
  const segments = barSegments(categories);
  assert.deepEqual(
    segments.map((s) => [s.id, s.percent]),
    [
      ["a", 40],
      ["b", 60],
    ],
  );
  assert.deepEqual(barSegments([]), []);
});

test("selectedBytes() sums selected items and ignores unsized ones", () => {
  assert.equal(selectedBytes(categories, new Set(["a1", "b1", "b2"])), 900);
});

test("safeItemIds() only takes safe categories", () => {
  assert.deepEqual(safeItemIds(categories), ["a1", "a2"]);
});

test("pruneSelection() drops ids that no longer exist", () => {
  assert.deepEqual(
    [...pruneSelection(categories, new Set(["a1", "gone"]))],
    ["a1"],
  );
});
