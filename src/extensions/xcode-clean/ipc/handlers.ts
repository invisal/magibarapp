import { shell, type IpcMain } from "electron";
import { cleanItems } from "../main/cleaner";
import type { XcodeScanner } from "../main/scanner";
import { XCODE_CLEAN_CHANNELS } from "../shared/types";

/** Wires the Clean Xcode screen's scan/clean/reveal calls to the scanner. */
export function registerXcodeCleanIpc(
  ipc: IpcMain,
  scanner: XcodeScanner,
): void {
  ipc.handle(
    XCODE_CLEAN_CHANNELS.scan,
    async () => (await scanner.scan()).initial,
  );
  ipc.handle(XCODE_CLEAN_CHANNELS.clean, (_event, ids: string[]) =>
    cleanItems(ids, (id) => scanner.lookup(id)),
  );
  ipc.handle(XCODE_CLEAN_CHANNELS.reveal, (_event, id: string) => {
    const entry = scanner.lookup(id);
    if (entry) shell.showItemInFolder(entry.item.path);
  });
}
