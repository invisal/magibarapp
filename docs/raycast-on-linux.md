# Raycast extensions on Linux

Raycast publishes extensions for macOS and Windows only, but Store packages are
prebuilt JS bundles that Magibar runs against its own `@raycast/api` shim, so
Linux installs them like any other platform. Most extensions are written
against macOS, so on Linux Magibar makes the extension's environment look as
much like a Mac as it reasonably can, then maps what the extension asks for
onto the Linux equivalent.

## What Magibar does on Linux

Install:

- Installs every Store extension; on install it scans the bundles for macOS-only
  usage (`osascript`, `.app/Contents`, `~/Library`, `mdfind`/`sips`/…) and
  reports a "macOS-only on Linux" warning. It never blocks the install.

Inside the extension process (`src/plugin-engine/host/runtime.ts` hands
extensions wrapped `fs`, `fs/promises`, `child_process` and `os` modules):

- **Linux looks like macOS** to extension code: `process.platform`,
  `os.platform()` and `os.type()` report `darwin`/`Darwin`. Extensions only
  know macOS and Windows — many build their paths and app tables in
  `if (darwin) … if (win32) …` and leave Linux with nothing (VS Code's recent
  projects), or refuse with "unsupported operating system" (Iconify). The
  macOS branch then reaches for macOS paths, tools and binaries, which the
  rest of this list maps onto Linux. Magibar's own shim code reads the real
  platform from `api-shim/src/platform.ts`. Set `MAGIBAR_REAL_PLATFORM=1` to
  turn this off when debugging an extension.
- **macOS paths** (`linux-paths.ts`): `~/Library/Application Support/<App>` →
  `~/.config/<App>` (folder name matched case-insensitively), with specific
  entries for Chrome, Edge and Firefox; `~/Library/Caches` → `~/.cache`;
  `~/Library/Preferences` → `~/.config`. Applies to every `fs` call and to
  arguments and shell strings passed to `child_process`.
- **Hard-coded tool paths** (`linux-binaries.ts`): spawning an absolute path
  that doesn't exist here (`/opt/homebrew/bin/brew`, `/usr/bin/open`,
  `….app/Contents/…/bin/code`) runs the same-named command from `PATH`.
- **macOS helper binaries**: many extensions download a helper CLI on first
  run and pick the macOS build on anything but Windows. Spawning a Mach-O file
  runs a same-named Linux executable from `PATH` instead. If there isn't one
  and `LINUX_BUILDS` pins a build (currently `speedtest`), that build is
  downloaded, checked against its sha256 and saved to `~/.cache/magibar/bin`.
  Anything else fails with a "macOS-only binary" message.
- **`PATH` shims** (`linux-shims.ts`, after the real `PATH` so installed tools
  win): `open` → `xdg-open`, `pbcopy`/`pbpaste` → `wl-clipboard`/`xclip`/
  `xsel`, `sqlite3` (on Magibar's built-in `node:sqlite` — `useSQL` needs it),
  `sw_vers` (from `/etc/os-release`), and an `osascript` stub that fails with
  an explanation.
- **Assets**: bundles read `join(__dirname, "assets", …)`; `dist/assets` links
  to the extension's assets (all platforms).
- **Newer API surface**: an unknown sub-component (`Action.InstallMCPServer`,
  `List.Item.Something`) renders as an action that says it's unsupported, or
  as nothing, instead of failing the whole view (all platforms).

Through the host (`main-rpc.ts`):

- `getApplications()` reports the macOS bundle id extensions look for
  (`com.microsoft.VSCode`, `com.google.Chrome`, …) for known apps — deb, snap
  and Flatpak names alike (`linux-bundle-ids.ts`) — and the desktop-file ID
  otherwise. `open(target, app)` launches through `gio launch` and accepts
  either.
- `getFrontmostApplication()` works for X11/XWayland windows (needs `xprop`).
- `Clipboard.paste` uses `xdotool`, or `wtype`/`ydotool` on Wayland.
- `getSelectedText()` reads the primary selection (`wl-paste --primary`,
  `xclip` or `xsel`), meaning whatever text is highlighted. X11 keeps that
  selection until something else is selected, so it can be stale.

## Recommended packages

`xdg-utils`, `libglib2.0-bin` (gio), `x11-utils` (xprop), `xdotool`,
`wl-clipboard` or `xclip`.

## Won't work

AppleScript/JXA (controlling Things, Music, iTerm, Arc, Apple Notes, Safari…),
Swift/compiled macOS helpers without a Linux build (add one to `LINUX_BUILDS`,
or install the tool on `PATH`), data stored only on Macs (Apple Notes,
Messages, Reminders), Finder/Spotlight/Keychain integrations, menu-bar
commands, AI, OAuth sign-in, and `getSelectedFinderItems`.

## Checking an extension

`node --disable-warning=ExperimentalWarning scripts/raycast-compat.ts <name…>`
(child_process is disabled there, so shell-outs show as load errors only).
