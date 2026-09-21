/**
 * Clean Xcode's wire contract — the DTOs and IPC channel names shared by the
 * extension's main handlers (`../ipc/handlers.ts`), its preload fragment
 * (`../ipc/preload.ts`) and its renderer screen (`../renderer/`).
 */

/** How comfortable deleting something is. `safe` regenerates on its own and
 *  cheaply; `caution` costs a slow rebuild/re-download, or can't come back. */
export type Safety = "safe" | "caution";

/** One deletable folder, e.g. a single project's DerivedData. */
export interface CleanItem {
  id: string;
  categoryId: string;
  title: string;
  /** Muted second line: the workspace a DerivedData folder belongs to, the
   *  platform of a Device Support folder, etc. */
  subtitle?: string;
  /** Absolute path, for display only — the renderer never sends paths back. */
  path: string;
  /** On-disk bytes; `null` until the native sizer has reported. */
  bytes: number | null;
  fileCount: number;
  /** Epoch ms of the folder's newest direct entry (0 when unknown). */
  modifiedAt: number;
}

export interface CleanCategory {
  id: string;
  title: string;
  /** Emoji shown in the category header. */
  glyph: string;
  safety: Safety;
  /** What deleting anything in this category costs the user. */
  consequence: string;
  /** Sum of the items sized so far. */
  bytes: number;
  /** Some item in this category hasn't been sized yet. */
  pending: boolean;
  /** Largest first. */
  items: CleanItem[];
}

export interface ScanSnapshot {
  categories: CleanCategory[];
  /** Xcode is running right now — DerivedData/caches may be in use. */
  xcodeRunning: boolean;
}

export interface CleanResult {
  freedBytes: number;
  failed: { id: string; error: string }[];
}

/** Route name of the screen (`../screen.tsx`). */
export const XCODE_CLEAN_ROUTE = "xcode-clean";

export const XCODE_CLEAN_CHANNELS = {
  /** Starts a (re)scan; resolves with the item list straight away, sizes
   *  (kept from the previous scan where known) still filling in. */
  scan: "xcode-clean:scan",
  /** Delete the items with these ids. Resolves a `CleanResult`. */
  clean: "xcode-clean:clean",
  /** Show the item in Finder. */
  reveal: "xcode-clean:reveal",
  /** Main → renderer push: a category finished sizing. Carries the whole snapshot. */
  updated: "xcode-clean:updated",
} as const;
