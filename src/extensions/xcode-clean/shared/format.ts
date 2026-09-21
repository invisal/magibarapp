import type { CleanCategory, CleanItem } from "./types";

/** One slice of the storage bar. */
export interface BarSegment {
  id: string;
  title: string;
  bytes: number;
  /** 0–100, of the whole bar. */
  percent: number;
}

/** Categories that hold anything, as proportional bar segments (largest first, as given). */
export function barSegments(categories: CleanCategory[]): BarSegment[] {
  const total = categories.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= 0) return [];
  return categories
    .filter((c) => c.bytes > 0)
    .map((c) => ({
      id: c.id,
      title: c.title,
      bytes: c.bytes,
      percent: (c.bytes / total) * 100,
    }));
}

/** Bytes across `ids` — an item still being sized counts as 0. */
export function selectedBytes(
  categories: CleanCategory[],
  ids: ReadonlySet<string>,
): number {
  let total = 0;
  for (const category of categories) {
    for (const item of category.items) {
      if (ids.has(item.id)) total += item.bytes ?? 0;
    }
  }
  return total;
}

/** Ids of every item in categories marked `safe`. */
export function safeItemIds(categories: CleanCategory[]): string[] {
  return categories
    .filter((c) => c.safety === "safe")
    .flatMap((c) => c.items.map((i) => i.id));
}

export function findItem(
  categories: CleanCategory[],
  id: string,
): CleanItem | null {
  for (const category of categories) {
    const item = category.items.find((i) => i.id === id);
    if (item) return item;
  }
  return null;
}

/** Drops ids no longer in `categories` (deleted, or gone after a rescan). */
export function pruneSelection(
  categories: CleanCategory[],
  ids: ReadonlySet<string>,
): Set<string> {
  const live = new Set(categories.flatMap((c) => c.items.map((i) => i.id)));
  return new Set([...ids].filter((id) => live.has(id)));
}
