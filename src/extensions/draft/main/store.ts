/**
 * Persisted list of unsaved form drafts. Persistence goes through the Draft
 * extension's `ExtensionStorage` (injected by `DraftExtension`), under the
 * `drafts` key of `<userData>/extensions/draft.json`.
 *
 * Same shape as `@extensions/group`'s store — domain logic only, Electron-free
 * so the `node --test` suite can drive it directly. Ids are counter-based
 * rather than slugged from the title: a draft's title changes as the user keeps
 * typing, and its id has to survive that.
 */
import type { ExtensionStorage } from "@core/storage";
import type { DraftDef, DraftInput, DraftKind } from "../shared/types";

/** Storage key holding the `DraftDef[]`. */
const KEY = "drafts";

/**
 * Ceiling on the list. Drafts are a safety net, not a filing system — an
 * unbounded pile of them would crowd out the top of the root list, which is
 * exactly the space the feature is trying to make useful. Oldest goes first.
 */
const MAX_DRAFTS = 20;

const KINDS: readonly DraftKind[] = ["quicklink"];

function isDraftDef(value: unknown): value is DraftDef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DraftDef>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.updatedAt === "number" &&
    KINDS.includes(candidate.kind as DraftKind) &&
    !!candidate.values &&
    typeof candidate.values === "object"
  );
}

const clone = (draft: DraftDef): DraftDef => ({
  ...draft,
  values: { ...draft.values },
});

export class DraftStore {
  private readonly storage: ExtensionStorage;
  private readonly now: () => number;

  private items: DraftDef[] = [];
  private loaded = false;

  constructor(storage: ExtensionStorage, opts?: { now?: () => number }) {
    this.storage = storage;
    this.now = opts?.now ?? Date.now;
  }

  /** Load the stored list into memory. Missing / malformed → empty list. */
  init(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = this.storage.get<unknown>(KEY);
    if (Array.isArray(raw)) {
      // Unlike Group's all-or-nothing check, drop only the bad entries: losing
      // every draft because one is malformed is the worst possible failure for
      // a feature whose whole job is not losing work.
      this.items = raw.filter(isDraftDef);
    }
  }

  /** Newest first — the order the launcher's "Drafts" section lists them in. */
  list(): DraftDef[] {
    this.init();
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt).map(clone);
  }

  get(id: string): DraftDef | undefined {
    this.init();
    const found = this.items.find((item) => item.id === id);
    return found ? clone(found) : undefined;
  }

  /**
   * Create (no `id`) or update (`id` present) a draft and persist. Returns the
   * saved definition, including the generated id on create.
   */
  save(input: DraftInput): DraftDef {
    this.init();

    const existing = input.id
      ? this.items.find((item) => item.id === input.id)
      : undefined;

    const def: DraftDef = {
      id: existing?.id ?? this.nextId(),
      kind: input.kind,
      title: input.title,
      subtitle: input.subtitle,
      icon: input.icon,
      values: { ...input.values },
      updatedAt: this.now(),
    };

    if (existing) {
      this.items[this.items.indexOf(existing)] = def;
    } else {
      this.items.push(def);
      this.evictOldest();
    }

    this.persist();
    return clone(def);
  }

  remove(id: string): void {
    this.init();
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
  }

  /** Drop the oldest drafts until the list is back within `MAX_DRAFTS`. */
  private evictOldest(): void {
    if (this.items.length <= MAX_DRAFTS) return;
    this.items = [...this.items]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DRAFTS);
  }

  /** `d1`, `d2`, … — the lowest number not already taken. */
  private nextId(): string {
    const taken = new Set(this.items.map((item) => item.id));
    for (let n = 1; ; n++) {
      const candidate = `d${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private persist(): void {
    this.storage.set(KEY, this.items);
  }
}
