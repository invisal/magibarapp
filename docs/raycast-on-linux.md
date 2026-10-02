# Raycast extensions on Linux

Raycast publishes extensions for macOS and Windows only, but Store packages are
prebuilt JS bundles that Magibar runs against its own `@raycast/api` shim, so
Linux installs them like any other platform. Whether a given extension _works_
depends on what it touches.

## What Magibar does on Linux

- Installs every Store extension; on install it scans the bundles for macOS-only
  usage (`osascript`, `.app/Contents`, `~/Library`, `mdfind`/`sips`/…) and
  reports a "macOS-only on Linux" warning. It never blocks the install.
- `open(target, app)` launches through `gio launch` using the `.desktop` entry;
  `getApplications()` returns desktop-file IDs as `bundleId`.
- `getFrontmostApplication()` works for X11/XWayland windows (needs `xprop`).
- Extension processes get a `PATH` shim dir with `open` → `xdg-open`,
  `pbcopy`/`pbpaste` → `wl-clipboard`/`xclip`/`xsel`, and an `osascript` stub
  that fails with an explanation (`src/plugin-engine/host/linux-shims.ts`).
- `Clipboard.paste` uses `xdotool`, or `wtype`/`ydotool` on Wayland.

## Recommended packages

`xdg-utils`, `libglib2.0-bin` (gio), `x11-utils` (xprop), `xdotool`,
`wl-clipboard` or `xclip`.

## Won't work

AppleScript, Swift/compiled macOS helpers, Finder/Spotlight/Keychain
integrations, menu-bar commands, AI, and `getSelectedText`.

## Checking an extension

`node --disable-warning=ExperimentalWarning scripts/raycast-compat.ts <name…>`
(child_process is disabled there, so shell-outs show as load errors only).
