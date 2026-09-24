import type { IpcMain } from "electron";
import { Extension } from "@core/base";
import type { ActionDefinition } from "@main/types";
import { relativeAge } from "@shared/format";
import {
  DRAFT_CHANNELS,
  DRAFT_ROUTES,
  type DraftDef,
  type DraftInput,
} from "./shared/types";
import { DraftStore } from "./main/store";

/**
 * Drafts: the forms you started and backed out of.
 *
 * A form (today only Create Quicklink) saves its half-filled state here when
 * the user leaves without saving, and this contributes one launcher row per
 * draft in the "Drafts" section at the top of the root list. Running a row
 * navigates back into the form that wrote it, which reads its own `values`
 * back out and clears the draft once it finally saves.
 *
 * As the `Extension` this is also the composition root for its store — it
 * persists through `this.storage` (`<userData>/extensions/draft.json`, keyed
 * `drafts`) and exposes it as `store` so the forms' IPC (`registerIpc()`) wires
 * to the same instance.
 */
export class DraftExtension extends Extension {
  readonly store: DraftStore;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    super("draft");
    this.store = new DraftStore(this.storage, opts);
    this.now = opts?.now ?? Date.now;
  }

  init(): void {
    this.store.init();
  }

  /** Small enough to wire the forms' CRUD straight to the store, like Group's. */
  registerIpc(ipc: IpcMain): void {
    ipc.handle(DRAFT_CHANNELS.list, () => this.store.list());
    ipc.handle(
      DRAFT_CHANNELS.get,
      (_event, id: string) => this.store.get(id) ?? null,
    );
    ipc.handle(DRAFT_CHANNELS.save, (_event, input: DraftInput) =>
      this.store.save(input),
    );
    ipc.handle(DRAFT_CHANNELS.delete, (_event, id: string) => {
      this.store.remove(id);
    });
  }

  /**
   * Reopen the form this draft came from, handing it the draft id. The form
   * loads the values itself (via `window.api.draft.get`) rather than receiving
   * them through the navigate payload, so it stays the only thing that knows
   * what shape they are.
   */
  execute(actionId: string): void {
    const draft = this.store.get(this.draftIdOf(actionId));
    if (!draft) return;
    this.ctx.navigate(DRAFT_ROUTES[draft.kind], { draftId: draft.id });
  }

  /** One row per draft, all in the "Drafts" section. */
  provide(): ActionDefinition[] {
    const now = this.now();
    return this.store.list().map((draft) => ({
      action: {
        id: `${this.id}:${draft.id}`,
        title: draft.title,
        subtitle: this.subtitleOf(draft, now),
        // The source picks the group here; `applySections` leaves it alone, so
        // a draft is never demoted into a type section or lifted into
        // Suggestions however often it's opened.
        group: "Drafts" as const,
        type: "command" as const,
        icon: draft.icon ?? "📝",
      },
      run: () => {},
    }));
  }

  /** What was typed so far, and when — "https://x.dev · 5m ago". */
  private subtitleOf(draft: DraftDef, now: number): string {
    const age = relativeAge(draft.updatedAt, now);
    return draft.subtitle ? `${draft.subtitle} · ${age}` : age;
  }

  /** `draft:d1` → `d1`. */
  private draftIdOf(actionId: string): string {
    return actionId.slice(`${this.id}:`.length);
  }
}
