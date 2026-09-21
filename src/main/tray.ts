import { app, Menu, nativeImage, Tray } from "electron";
import trayIconPath from "../../resources/tray-icon.png?asset";
import trayTemplate1x from "../../resources/tray-iconTemplate.png?asset";
import trayTemplate2x from "../../resources/tray-iconTemplate@2x.png?asset";
import showIcon1x from "../../resources/menu-showTemplate.png?asset";
import showIcon2x from "../../resources/menu-showTemplate@2x.png?asset";
import settingsIcon1x from "../../resources/menu-settingsTemplate.png?asset";
import settingsIcon2x from "../../resources/menu-settingsTemplate@2x.png?asset";
import quitIcon1x from "../../resources/menu-quitTemplate.png?asset";
import quitIcon2x from "../../resources/menu-quitTemplate@2x.png?asset";
import { openSettingsWindow } from "./settings-window";

const isMac = process.platform === "darwin";

/**
 * Kept at module scope — Electron garbage-collects a `Tray` (silently
 * removing the icon) as soon as nothing references it, so this is the only
 * thing keeping it alive for the life of the app.
 */
let tray: Tray | null = null;
let toggle: (() => void) | null = null;
let getHotkey: (() => string) | null = null;

/**
 * Builds a template image (black + alpha) from 1x/2x files. macOS tints
 * template images to match the menu bar / menu, so they adapt to light, dark
 * and highlighted states. `?asset` doesn't bundle `@2x` siblings, so both
 * representations are attached explicitly.
 */
function templateImage(path1x: string, path2x: string) {
  const image = nativeImage.createFromPath(path1x);
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path2x).toPNG(),
  });
  image.setTemplateImage(true);
  return image;
}

function trayImage() {
  // The full-colour icon is 32px and macOS doesn't downscale it to menu-bar
  // size, which is why it looked bigger than its neighbours.
  return isMac
    ? templateImage(trayTemplate1x, trayTemplate2x)
    : nativeImage.createFromPath(trayIconPath);
}

function menuIcon(path1x: string, path2x: string) {
  return isMac ? templateImage(path1x, path2x) : undefined;
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Show Magibar",
      icon: menuIcon(showIcon1x, showIcon2x),
      accelerator: getHotkey?.(),
      // Display only — the global shortcut is registered separately.
      registerAccelerator: false,
      click: () => toggle?.(),
    },
    { type: "separator" },
    {
      label: "Settings",
      icon: menuIcon(settingsIcon1x, settingsIcon2x),
      accelerator: "CommandOrControl+,",
      registerAccelerator: false,
      click: () => openSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "Quit Magibar",
      icon: menuIcon(quitIcon1x, quitIcon2x),
      accelerator: "CommandOrControl+Q",
      registerAccelerator: false,
      click: () => app.quit(),
    },
  ]);
}

/** Rebuilds the tray menu, e.g. after the toggle hotkey changed. */
export function refreshTrayMenu(): void {
  tray?.setContextMenu(buildMenu());
}

/**
 * Creates the system tray icon. `toggleLauncher` and `currentHotkey` are
 * injected (see `index.ts`) to avoid an import cycle back through the app entry.
 */
export function createTray(
  toggleLauncher: () => void,
  currentHotkey: () => string,
): Tray {
  toggle = toggleLauncher;
  getHotkey = currentHotkey;

  tray = new Tray(trayImage());
  tray.setToolTip("Magibar");
  refreshTrayMenu();

  // Windows/Linux only fire 'click' for the left button — the menu above
  // already handles right-click there, and macOS shows it on either click.
  tray.on("click", toggleLauncher);

  return tray;
}
