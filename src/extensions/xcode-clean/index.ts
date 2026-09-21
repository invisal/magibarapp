import { homedir } from "node:os";
import type { IpcMain } from "electron";
import { Extension } from "@core/base";
import type { ActionDefinition } from "@main/types";
import { registerXcodeCleanIpc } from "./ipc/handlers";
import { measurePaths } from "./main/dir-size-mac";
import { XcodeScanner } from "./main/scanner";
import {
  isXcodeInstalled,
  isXcodeRunning,
  workspacePath,
} from "./main/workspace";
import { XCODE_CLEAN_ICON } from "./shared/icon";
import { XCODE_CLEAN_ROUTE, type ScanSnapshot } from "./shared/types";

/**
 * Clean Xcode: shows how much disk Xcode's caches take — Device Support,
 * DerivedData, Archives, documentation caches, old logs, SwiftPM/simulator
 * caches — and deletes the ones the user picks. Its own list screen
 * (`../screen.tsx`, route `xcode-clean`) starts a scan on mount; the folder
 * list comes back immediately and sizes are pushed as each category finishes
 * (`onScan`), because sizing is a native walk (`native/mac`'s `dir_size`) that
 * can take seconds on a large DerivedData.
 *
 * macOS only, and only when Xcode is installed — `provide()` contributes nothing otherwise. Nothing runs in the
 * background: no scan happens until the screen asks for one.
 */
export class XcodeCleanExtension extends Extension {
  private readonly scanner: XcodeScanner;
  /** Set by `main/index.ts` to push `updated` to the launcher window. */
  /** Resolved once — `provide()` runs on every launcher keystroke. */
  private installed: Promise<boolean> | null = null;
  private onUpdate: ((snapshot: ScanSnapshot) => void) | null = null;

  constructor() {
    super("xcode-clean");
    this.scanner = new XcodeScanner({
      home: homedir(),
      measure: measurePaths,
      workspacePath,
      xcodeRunning: isXcodeRunning,
      onChange: (snapshot) => this.onUpdate?.(snapshot),
    });
  }

  /** Called whenever a category finishes sizing — lets `main/index.ts` push `updated` to the launcher window. */
  onScan(cb: (snapshot: ScanSnapshot) => void): void {
    this.onUpdate = cb;
  }

  registerIpc(ipc: IpcMain): void {
    registerXcodeCleanIpc(ipc, this.scanner);
  }

  async provide(): Promise<ActionDefinition[]> {
    if (process.platform !== "darwin") return [];
    this.installed ??= isXcodeInstalled();
    if (!(await this.installed)) return [];
    return [
      {
        action: {
          id: "xcode-clean:open",
          title: "Clean Xcode",
          subtitle: "See what Xcode caches use and free up disk space",
          altNames: [
            "Xcode Clean",
            "Xcode Cache",
            "DerivedData",
            "Xcode Storage",
            "Device Support",
          ],
          icon: XCODE_CLEAN_ICON,
          type: "command",
        },
        run: () => {},
      },
    ];
  }

  async execute(actionId: string): Promise<void> {
    if (actionId === "xcode-clean:open") {
      this.ctx.navigate(XCODE_CLEAN_ROUTE);
    }
  }
}
