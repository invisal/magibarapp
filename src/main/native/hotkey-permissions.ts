/**
 * mac-only recovery for hotkeys that can't start because of the privacy
 * grants their `CGEventTap` needs (see `native/mac/src/lib.rs`). macOS ties
 * each grant to the app's code signature, so an entry left behind by a
 * differently-signed build of the same bundle id (a dev copy, an earlier
 * release) shows as "on" in System Settings yet is refused for the current
 * app — and toggling it doesn't help, the entry has to be deleted first.
 * `tccutil reset` is what does that, and works without admin rights for the
 * user's own entries.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, shell, systemPreferences } from "electron";
import { requestHotkeyPermissions } from "./hotkeys";

const execFileAsync = promisify(execFile);

/** `appId` in `electron-builder.yml` — what macOS keys the app's privacy grants on. */
const BUNDLE_ID = "app.magibar";

/**
 * `PostEvent` is its own service and is *not* covered by resetting
 * `Accessibility` — it's the one an active event tap is actually checked
 * against, and the one that held the stale entry in practice.
 */
const TCC_SERVICES = ["Accessibility", "ListenEvent", "PostEvent"];

const INPUT_MONITORING_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";

/**
 * Drops this app's existing (possibly stale) grants, then re-requests them so
 * macOS shows its prompts for the *current* build, and opens the Input
 * Monitoring pane since that one has no prompt on some macOS versions.
 * A dev run has a different identity than `BUNDLE_ID`, so resetting there
 * would touch nothing useful — it only re-requests.
 */
export async function repairHotkeyPermissions(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (app.isPackaged) {
    await Promise.all(
      TCC_SERVICES.map((service) =>
        execFileAsync("/usr/bin/tccutil", ["reset", service, BUNDLE_ID]).catch(
          (error: unknown) =>
            console.error(`[hotkeys] tccutil reset ${service} failed:`, error),
        ),
      ),
    );
  }
  systemPreferences.isTrustedAccessibilityClient(true);
  requestHotkeyPermissions();
  void shell.openExternal(INPUT_MONITORING_PANE);
}
