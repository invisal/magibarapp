/**
 * Sends the platform's paste keystroke to whichever app is frontmost — called
 * right after the launcher hides, so focus has already returned to the app the
 * user was in. Best-effort: on failure the entry is still on the clipboard, so
 * the user can paste by hand.
 *
 * macOS needs the Accessibility permission (System Events keystroke); Windows
 * uses `SendKeys`; Linux uses `xdotool`, or `wtype`/`ydotool` on Wayland.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Lets the window manager hand focus back to the previous app after `hide()`. */
const FOCUS_SETTLE_MS = 200;

/** X11/XWayland windows take `xdotool`. A native Wayland session has no
 *  generic way to inject keys into other apps, so try `wtype`, then
 *  `ydotool` (needs its daemon), before giving up. */
async function pasteOnLinux(): Promise<void> {
  const wayland =
    process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
  const attempts: Array<[string, string[]]> = [
    ["xdotool", ["key", "ctrl+v"]],
    ["wtype", ["-M", "ctrl", "v", "-m", "ctrl"]],
    ["ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]],
  ];
  if (wayland) attempts.unshift(attempts.splice(1, 1)[0]);
  let lastError: unknown;
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function sendPasteKeystroke(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
  try {
    if (process.platform === "darwin") {
      await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to keystroke "v" using command down',
      ]);
    } else if (process.platform === "win32") {
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
      ]);
    } else {
      await pasteOnLinux();
    }
  } catch (error) {
    console.error("[clipboard-history] sendPasteKeystroke() failed:", error);
  }
}
