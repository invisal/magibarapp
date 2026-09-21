import { relative } from "node:path";
import type {
  CleanCategory,
  CleanItem,
  ScanSnapshot,
} from "../shared/types.ts";
import {
  categorySpecs,
  discover,
  type Candidate,
  type CategorySpec,
} from "./locations.ts";
import type { Measured } from "./dir-size-mac.ts";

/** What the cleaner needs to know about an item to delete it safely. */
export interface ScanEntry {
  item: CleanItem;
  root: string;
  mode: Candidate["mode"];
}

export interface ScannerDeps {
  home: string;
  measure: (paths: string[]) => Promise<Measured[]>;
  /** Only asked of DerivedData folders. */
  workspacePath: (dir: string) => Promise<string | undefined>;
  xcodeRunning: () => Promise<boolean>;
  /** A category finished sizing (or was re-listed) — carries the whole snapshot. */
  onChange: (snapshot: ScanSnapshot) => void;
}

/**
 * Lists Xcode's cache folders and sizes them. `scan()` resolves as soon as the
 * folders are *listed* (sizes still `null`, or carried over from the previous
 * scan so a rescan doesn't blank the list), then sizes each category on its own
 * and reports through `onChange` as they finish — so the screen opens instantly
 * even while 20 GB of DerivedData is being walked.
 */
export class XcodeScanner {
  private categories: CleanCategory[] = [];
  private entries = new Map<string, ScanEntry>();
  private xcodeRunning = false;
  /** Bumped per scan; a stale scan's late results are dropped. */
  private generation = 0;

  private readonly deps: ScannerDeps;

  constructor(deps: ScannerDeps) {
    this.deps = deps;
  }

  snapshot(): ScanSnapshot {
    return { categories: this.categories, xcodeRunning: this.xcodeRunning };
  }

  lookup(id: string): ScanEntry | undefined {
    return this.entries.get(id);
  }

  async scan(): Promise<{ initial: ScanSnapshot; done: Promise<void> }> {
    const generation = ++this.generation;
    const previous = new Map(
      this.categories.flatMap((c) => c.items.map((i) => [i.id, i] as const)),
    );
    const specs = categorySpecs(this.deps.home);

    const [listed, xcodeRunning] = await Promise.all([
      Promise.all(specs.map((spec) => this.list(spec, previous))),
      this.deps.xcodeRunning(),
    ]);
    if (generation !== this.generation)
      return { initial: this.snapshot(), done: Promise.resolve() };

    this.xcodeRunning = xcodeRunning;
    this.entries = new Map(listed.flatMap((l) => l.entries));
    this.categories = listed
      .filter((l) => l.category.items.length > 0)
      .map((l) => l.category);
    const initial = this.snapshot();

    const done = Promise.all(
      this.categories.map((category) => this.size(category, generation)),
    ).then(() => undefined);
    return { initial, done };
  }

  private async list(
    spec: CategorySpec,
    previous: Map<string, CleanItem>,
  ): Promise<{ category: CleanCategory; entries: [string, ScanEntry][] }> {
    const candidates = await discover(spec);
    const entries: [string, ScanEntry][] = [];
    const items: CleanItem[] = await Promise.all(
      candidates.map(async (c) => {
        const id = `${spec.id}:${relative(this.deps.home, c.path)}`;
        const old = previous.get(id);
        let subtitle = c.subtitle;
        if (spec.id === "derived-data") {
          subtitle = (await this.deps.workspacePath(c.path)) ?? c.subtitle;
        }
        const item: CleanItem = {
          id,
          categoryId: spec.id,
          title: c.title,
          subtitle,
          path: c.path,
          bytes: old?.bytes ?? null,
          fileCount: old?.fileCount ?? 0,
          modifiedAt: old?.modifiedAt ?? 0,
        };
        entries.push([id, { item, root: c.root, mode: c.mode }]);
        return item;
      }),
    );
    return { category: this.build(spec, items), entries };
  }

  private build(spec: CategorySpec, items: CleanItem[]): CleanCategory {
    const sorted = [...items].sort(
      (a, b) =>
        (b.bytes ?? -1) - (a.bytes ?? -1) || a.title.localeCompare(b.title),
    );
    return {
      id: spec.id,
      title: spec.title,
      glyph: spec.glyph,
      safety: spec.safety,
      consequence: spec.consequence,
      bytes: sorted.reduce((sum, i) => sum + (i.bytes ?? 0), 0),
      pending: sorted.some((i) => i.bytes === null),
      items: sorted,
    };
  }

  private async size(
    category: CleanCategory,
    generation: number,
  ): Promise<void> {
    const results = await this.deps.measure(category.items.map((i) => i.path));
    if (generation !== this.generation) return;

    const byPath = new Map(results.map((r) => [r.path, r]));
    const items: CleanItem[] = [];
    for (const item of category.items) {
      const measured = byPath.get(item.path);
      if (!measured) {
        items.push(item);
        continue;
      }
      // Xcode leaves empty `Name-<hash>` folders behind when a project is
      // reopened from a different state; nothing to reclaim, so don't list them.
      if (measured.bytes === 0) {
        this.entries.delete(item.id);
        continue;
      }
      const sized = {
        ...item,
        bytes: measured.bytes,
        fileCount: measured.fileCount,
        modifiedAt: measured.modifiedMs,
      };
      const entry = this.entries.get(item.id);
      if (entry) entry.item = sized;
      items.push(sized);
    }

    const spec = categorySpecs(this.deps.home).find(
      (s) => s.id === category.id,
    );
    if (!spec) return;
    const rebuilt = this.build(spec, items);
    this.categories = this.categories
      .map((c) => (c.id === rebuilt.id ? rebuilt : c))
      .filter((c) => c.items.length > 0)
      // Biggest category first once sizes are known.
      .sort((a, b) => b.bytes - a.bytes);
    this.deps.onChange(this.snapshot());
  }
}
