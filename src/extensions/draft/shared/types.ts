/**
 * Draft's wire contract — the DTOs and IPC channel names shared by the
 * extension's IPC (`../index.ts`), its preload fragment (`../ipc/preload.ts`)
 * and the forms that save drafts (today `@extensions/quicklink`'s
 * `CreateQuicklink`).
 *
 * A draft is a form the user opened, typed into, and backed out of without
 * saving. It is kept as an opaque bag of `values` plus enough display metadata
 * to draw a launcher row: the Drafts extension never interprets `values`, only
 * the form that wrote them does, on the way back in.
 */

/** Which form a draft belongs to — picks the route it resumes into. */
export type DraftKind = "quicklink";

/** The route each kind of draft reopens, with `{ draftId }` as its payload. */
export const DRAFT_ROUTES: Record<DraftKind, string> = {
  quicklink: "quicklink-create",
};

export interface DraftDef {
  /** Stable id, generated on first save; also the `draft:<id>` action id. */
  id: string;
  kind: DraftKind;
  /** Row title — what the user had named the thing, or a fallback like "Untitled Quicklink". */
  title: string;
  /** Row subtitle — usually the most identifying field typed so far (a link). */
  subtitle?: string;
  /** Row icon, same conventions as `LauncherAction.icon`. */
  icon?: string;
  /** The form's own state. Opaque here; only the form that wrote it reads it. */
  values: Record<string, unknown>;
  /** Epoch ms of the last save, for ordering the list newest-first. */
  updatedAt: number;
}

/** A draft on its way in from a form. No `id` on the first save. */
export interface DraftInput {
  id?: string;
  kind: DraftKind;
  title: string;
  subtitle?: string;
  icon?: string;
  values: Record<string, unknown>;
}

/** IPC channels for the forms that read/write drafts ↔ main. */
export const DRAFT_CHANNELS = {
  list: "draft:list",
  get: "draft:get",
  save: "draft:save",
  delete: "draft:delete",
} as const;
