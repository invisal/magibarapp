/**
 * Turns plugin `HostEffect`s and `HostRequest`s into real OS actions — the
 * one place either host process kind's side effects actually happen, since
 * only Electron's main process can show a native notification, touch the
 * real clipboard, open a URL/file, or show a dialog.
 *
 * Effects that depend on *which plugin* sent them (`launch-command`,
 * `open-preferences`, `update-command-metadata`) are handled by
 * `PluginHostSource` before anything reaches here; toasts from a view
 * command are routed to its own screen by `list-host-manager.ts`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, Notification, clipboard, dialog, shell } from "electron";
import { getLauncherWindow, hideLauncher } from "@main/window";
import { listApplications } from "@main/native/apps";
import { sendPasteKeystroke } from "@extensions/clipboard-history/main/paste";
import type {
  ConfirmAlertOptions,
  HostApplication,
  HostEffect,
  HostRequest,
} from "./protocol.ts";

const execFileAsync = promisify(execFile);

async function openTarget(target: string, application?: string): Promise<void> {
  if (application && process.platform === "darwin") {
    // `open -a` takes an app name, a path to a .app, or (with -b) a bundle id.
    const isBundleId =
      /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(application) &&
      !application.includes("/");
    await execFileAsync("open", [
      isBundleId ? "-b" : "-a",
      application,
      target,
    ]);
    return;
  }
  const looksLikeUrl =
    /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:\\/i.test(target);
  if (looksLikeUrl) {
    await shell.openExternal(target);
  } else {
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  }
}

/** Effects every host kind shares. `toast` here is the no-view (native
 *  notification) presentation — an animated toast is a transient
 *  "working…" state that would only spam the notification center. */
export async function applyHostEffect(effect: HostEffect): Promise<void> {
  try {
    switch (effect.op) {
      case "toast":
        if (effect.style === "animated") return;
        new Notification({ title: effect.title, body: effect.message }).show();
        return;
      case "hide-toast":
        return;
      case "hud":
        new Notification({ title: effect.title }).show();
        return;
      case "clipboard-copy":
        clipboard.writeText(effect.text);
        return;
      case "clipboard-paste":
        clipboard.writeText(effect.text);
        hideLauncher();
        // `win.hide()` alone can leave this app frontmost on macOS — see
        // clipboard-history's own paste path, which this mirrors.
        if (process.platform === "darwin") app.hide();
        await sendPasteKeystroke();
        return;
      case "clipboard-clear":
        clipboard.clear();
        return;
      case "open":
        await openTarget(effect.target, effect.application);
        return;
      case "show-in-finder":
        shell.showItemInFolder(effect.path);
        return;
      case "close-main-window":
        hideLauncher();
        return;
      case "launch-command":
      case "open-preferences":
      case "update-command-metadata":
        // Plugin-scoped — `PluginHostSource.handleEffect` owns these.
        return;
    }
  } catch (error) {
    console.error(`[plugin-engine] effect "${effect.op}" failed:`, error);
  }
}

/** `confirmAlert()` — a native OS dialog, not a renderer round trip. Resolves
 *  `true` for the primary action, `false` for dismiss (including the window
 *  close button, via `cancelId`). */
export async function showConfirmAlert(
  options: ConfirmAlertOptions,
): Promise<boolean> {
  const primaryTitle = options.primaryActionTitle ?? "Confirm";
  const dismissTitle = options.dismissActionTitle ?? "Cancel";
  const dialogOptions = {
    type: "question" as const,
    buttons: [primaryTitle, dismissTitle],
    defaultId: 0,
    cancelId: 1,
    title: options.title,
    message: options.title,
    detail: options.message,
  };
  // A no-view command's launcher is already hidden — a sheet attached to
  // a hidden window would never be seen.
  const win = getLauncherWindow();
  const { response } = win?.isVisible()
    ? await dialog.showMessageBox(win, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return response === 0;
}

const APPLICATIONS_TTL_MS = 60_000;
let applicationsCache: { at: number; apps: HostApplication[] } | null = null;

async function applications(): Promise<HostApplication[]> {
  if (
    applicationsCache &&
    Date.now() - applicationsCache.at < APPLICATIONS_TTL_MS
  ) {
    return applicationsCache.apps;
  }
  const result = await listApplications();
  const apps: HostApplication[] = (result?.shortcuts ?? []).map((app) => ({
    name: app.title,
    path: app.path,
    bundleId: undefined,
  }));
  for (const app of result?.packaged ?? []) {
    apps.push({ name: app.title, path: app.appId, bundleId: app.appId });
  }
  applicationsCache = { at: Date.now(), apps };
  return apps;
}

/** The app that was frontmost before the launcher took focus (macOS). */
async function frontmostApplication(): Promise<HostApplication> {
  if (process.platform !== "darwin") {
    throw new Error("getFrontmostApplication() is only supported on macOS");
  }
  const self = app.getName().replace(/"/g, "");
  const { stdout } = await execFileAsync("osascript", [
    "-e",
    `tell application "System Events" to set p to first application process whose frontmost is true and name is not "${self}"`,
    "-e",
    'return (name of p) & "\\n" & (POSIX path of (application file of p as alias)) & "\\n" & (bundle identifier of p)',
  ]);
  const [name, path, bundleId] = stdout.trim().split("\n");
  if (!name) throw new Error("couldn't determine the frontmost application");
  return { name, path, bundleId: bundleId || undefined };
}

async function defaultApplication(target: string): Promise<HostApplication> {
  // Electron only knows protocol handlers — enough for URLs, the common case.
  const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : null;
  if (!url) {
    throw new Error(
      "getDefaultApplication() is only supported for URLs in Magibar",
    );
  }
  const info = await app.getApplicationInfoForProtocol(url);
  return {
    name: info.name,
    path: info.path,
    bundleId: undefined,
  };
}

export async function handleHostRequest(
  request: HostRequest,
): Promise<unknown> {
  switch (request.method) {
    case "clipboard-read":
      return clipboard.readText();
    case "confirm-alert":
      return showConfirmAlert(request.options);
    case "get-applications":
      // `path` asks for "apps that can open this file" — there's no
      // per-file handler lookup here, so every app is offered, which keeps
      // "Open With…" style pickers usable.
      return applications();
    case "get-frontmost-application":
      return frontmostApplication();
    case "get-default-application":
      return defaultApplication(request.path);
    case "trash":
      for (const path of request.paths) await shell.trashItem(path);
      return null;
  }
}
