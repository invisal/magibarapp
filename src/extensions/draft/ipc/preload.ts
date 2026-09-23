import { ipcRenderer } from "electron";
import {
  DRAFT_CHANNELS,
  type DraftDef,
  type DraftInput,
} from "../shared/types";

/** `window.api.draft` — the bridge any form uses to keep its unsaved state. */
export const draftApi = {
  list: (): Promise<DraftDef[]> => ipcRenderer.invoke(DRAFT_CHANNELS.list),
  get: (id: string): Promise<DraftDef | null> =>
    ipcRenderer.invoke(DRAFT_CHANNELS.get, id),
  /** Create (no `id`) or update; resolves with the saved draft, id included. */
  save: (input: DraftInput): Promise<DraftDef> =>
    ipcRenderer.invoke(DRAFT_CHANNELS.save, input),
  delete: (id: string): Promise<void> =>
    ipcRenderer.invoke(DRAFT_CHANNELS.delete, id),
};
