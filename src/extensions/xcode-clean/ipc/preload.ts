import { ipcRenderer } from "electron";
import { XCODE_CLEAN_CHANNELS } from "../shared/types";
import type { CleanResult, ScanSnapshot } from "../shared/types";

/** `window.api.xcodeClean` — the Clean Xcode screen's bridge to main. */
export const xcodeCleanApi = {
  /** (Re)scan. Resolves as soon as folders are listed; sizes then stream in through `onUpdated`. */
  scan: (): Promise<ScanSnapshot> =>
    ipcRenderer.invoke(XCODE_CLEAN_CHANNELS.scan),
  /** Fires each time a category finishes sizing. Returns an unsubscribe function. */
  onUpdated: (callback: (snapshot: ScanSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: ScanSnapshot) =>
      callback(snapshot);
    ipcRenderer.on(XCODE_CLEAN_CHANNELS.updated, listener);
    return () =>
      ipcRenderer.removeListener(XCODE_CLEAN_CHANNELS.updated, listener);
  },
  /** Permanently delete the folders behind these item ids. */
  clean: (ids: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(XCODE_CLEAN_CHANNELS.clean, ids),
  /** Show an item in Finder. */
  reveal: (id: string): Promise<void> =>
    ipcRenderer.invoke(XCODE_CLEAN_CHANNELS.reveal, id),
};
