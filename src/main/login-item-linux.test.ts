import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autostartDesktopEntry,
  autostartDesktopPath,
} from "./login-item-linux.ts";

test("the autostart entry lives under ~/.config/autostart", () => {
  assert.equal(
    autostartDesktopPath("/home/alice"),
    "/home/alice/.config/autostart/magibar-autostart.desktop",
  );
});

test("the desktop entry quotes Exec so a spaced install path still works", () => {
  const entry = autostartDesktopEntry("/opt/My Apps/Magibar/magibar");
  assert.match(entry, /^Exec="\/opt\/My Apps\/Magibar\/magibar"$/m);
});

test("the desktop entry marks itself enabled and visible", () => {
  const entry = autostartDesktopEntry("/usr/bin/magibar");
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Magibar$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
  assert.match(entry, /^Hidden=false$/m);
});
