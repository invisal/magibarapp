import type { IpcMain } from "electron";
import { Extension } from "@core/base";
import type { ActionDefinition } from "@main/types";
import { registerQuitProcessIpc } from "./ipc/handlers";
import { QuitProcessPoller } from "./main/poller";
import { QUIT_PROCESS_ICON } from "./shared/icon";
import { QUIT_PROCESS_ROUTE, type ProcessRow } from "./shared/types";

/**
 * Activity Monitor (Magibar's "Quit Processes"): a searchable list of every
 * running process — PID, name, live CPU% and memory — sortable by either
 * metric, with a "Quit"/"Force Quit" action per row. Its own list screen
 * (`../screen.tsx`, route `quit-process`) is pushed live snapshots from a
 * background poller that only runs while the screen is open (`init()` does
 * *not* start it — `main()`'s `start`/`stop` IPC does, driven by the
 * renderer's mount/unmount), unlike `ClipboardHistoryExtension`'s poller,
 * which has to watch the clipboard continuously in the background.
 *
 * Listing/killing itself is native (`main/process-source.ts` → `@magibar/*`,
 * via `sysinfo`) rather than a `ps`/PowerShell shell-out — see
 * `native/mac/src/lib.rs`'s `list_processes`/`kill_process`.
 */
export class QuitProcessExtension extends Extension {
  private readonly poller: QuitProcessPoller;
  /** Set by `main/index.ts` to push `updated` to the launcher window. */
  private onUpdate: ((rows: ProcessRow[]) => void) | null = null;

  constructor() {
    super("quit-process");
    this.poller = new QuitProcessPoller((rows) => this.onUpdate?.(rows));
  }

  /** Warms the process list and icon cache a few seconds after launch, off
   *  the startup path, so the first time the screen opens it has nothing
   *  cold to wait on (a cold first `list()` measured ~140 ms, warm ~10 ms). */
  init(): void {
    setTimeout(() => this.poller.prime(), 3000);
  }

  /** Called whenever the poller refreshes — lets `main/index.ts` push
   *  `updated` (with the fresh rows) to the launcher window. */
  onRefresh(cb: (rows: ProcessRow[]) => void): void {
    this.onUpdate = cb;
  }

  /** Called from `main/index.ts`'s `will-quit` handler, alongside the other
   *  extensions' pollers. */
  stopPolling(): void {
    this.poller.stop();
  }

  registerIpc(ipc: IpcMain): void {
    registerQuitProcessIpc(ipc, this.poller);
  }

  provide(): ActionDefinition[] {
    return [
      {
        action: {
          id: "quit-process:open",
          title: "Quit Processes",
          subtitle: "View running processes and quit or force quit them",
          altNames: ["Kill Process", "End Task", "Task Manager"],
          icon: QUIT_PROCESS_ICON,
          type: "command",
        },
        run: () => {},
      },
    ];
  }

  async execute(actionId: string): Promise<void> {
    if (actionId === "quit-process:open") {
      this.ctx.navigate(QUIT_PROCESS_ROUTE);
    }
  }
}
