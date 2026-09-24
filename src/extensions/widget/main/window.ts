import { BrowserWindow } from "electron";
import { join } from "node:path";
import {
  framelessChrome,
  persistWindowBounds,
  restoredBounds,
} from "@main/window-chrome";
import { showLauncher } from "@main/window";
import { settings } from "@main/actions";

/**
 * The Widget window is the CodeMirror editor for a single Widget — the
 * list and metadata form live in the launcher's navigation stack now. It's a
 * singleton framed window (same pattern as settings); opening it again just
 * points it at a different Widget (via the URL hash) and focuses it.
 */
export interface WidgetView {
  view: "code";
  id: string;
}

const WINDOW_WIDTH = 860;
const WINDOW_HEIGHT = 640;

let widgetWindow: BrowserWindow | null = null;

function hashFor(target: WidgetView): string {
  return encodeURIComponent(target.id);
}

export function openWidgetWindow(target: WidgetView): void {
  const hash = hashFor(target);

  if (widgetWindow) {
    if (widgetWindow.isMinimized()) widgetWindow.restore();
    void widgetWindow.webContents.executeJavaScript(
      `location.hash = ${JSON.stringify(`#${hash}`)}`,
    );
    widgetWindow.show();
    widgetWindow.focus();
    return;
  }

  widgetWindow = new BrowserWindow({
    ...restoredBounds(settings, "widget", {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    }),
    minWidth: 560,
    minHeight: 420,
    title: "Widget",
    show: false,
    autoHideMenuBar: true,
    ...framelessChrome,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  persistWindowBounds(widgetWindow, settings, "widget");
  widgetWindow.once("ready-to-show", () => widgetWindow?.show());
  widgetWindow.on("closed", () => {
    widgetWindow = null;
    // Every dismissal (Save, Cancel, ✕, ⌘W) funnels through here — bring the
    // launcher the user came from back to the front.
    showLauncher();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void widgetWindow.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}/widget.html#${hash}`,
    );
  } else {
    void widgetWindow.loadFile(join(import.meta.dirname, "../renderer/widget.html"), {
      hash,
    });
  }
}
