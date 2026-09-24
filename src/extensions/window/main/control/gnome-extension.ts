import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Install/enable/status management for Magibar's GNOME Shell extension — the
 * only way to move windows on a GNOME Wayland session (see the module doc in
 * `resources/gnome-extension/magibar@magibar.app/extension.js` for why an
 * external process cannot).
 *
 * Talking to the extension is the native addon's job (`gnomeShellAvailable`
 * and friends in `native/linux/src/lib.rs`); this module only deals with
 * getting it onto disk and switched on, which is file copying plus
 * `gsettings` and has no reason to be native.
 */

const execFileAsync = promisify(execFile);

/**
 * `electron` is resolved lazily rather than imported at the top of the file so
 * that the pure helpers here (`withExtensionEnabled`) stay importable under a
 * plain `node --test`, which is how this repo runs its suite — a top-level
 * `import { app } from "electron"` fails outside an Electron process and would
 * take the whole module, tests included, down with it.
 */
const nodeRequire = createRequire(import.meta.url);
function electronApp(): typeof import("electron").app {
  return (nodeRequire("electron") as typeof import("electron")).app;
}

export const EXTENSION_UUID = "magibar@magibar.app";

/**
 * The `API_VERSION` of the extension bundled with this build of Magibar. An
 * installed copy reporting anything lower is overwritten by `install()` —
 * otherwise a Magibar update would keep talking to whatever extension an older
 * version left behind, against an interface it no longer matches.
 */
export const BUNDLED_EXTENSION_VERSION = 1;

/**
 * GNOME Shell only scans for extensions at startup: a directory that appears
 * while the shell is running is not picked up, and the `ReloadExtension` D-Bus
 * method that used to force it was removed (GNOME 50 answers it with
 * `NotSupported`). On X11 the shell can be restarted in place with `Alt+F2 r`,
 * but on Wayland the shell *is* the display server, so there is nothing to
 * restart into — the session has to be logged out and back in.
 *
 * So a fresh install genuinely cannot take effect until the user logs out. The
 * UI says so rather than pretending otherwise, and `install()` still writes and
 * enables everything up front so that logging back in is the only step left.
 */
export type GnomeExtensionState =
  /** Not a GNOME session at all — nothing to install, the X11 path is all there is. */
  | "unavailable"
  /** Installed, enabled, and answering on D-Bus right now. */
  | "active"
  /** Files are on disk but GNOME Shell hasn't loaded them: needs a log out/in. */
  | "needs-restart"
  /** Nothing installed yet. */
  | "not-installed";

/** Whether this is a GNOME session, and so whether any of this applies. */
export function isGnomeSession(): boolean {
  if (process.platform !== "linux") return false;
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ""} ${process.env.XDG_SESSION_DESKTOP ?? ""}`;
  return desktop.toLowerCase().includes("gnome");
}

function extensionsDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ??
    join(electronApp().getPath("home"), ".local", "share");
  return join(dataHome, "gnome-shell", "extensions");
}

function installedDir(): string {
  return join(extensionsDir(), EXTENSION_UUID);
}

/**
 * The bundled extension's source directory. `resources/` ships next to `out/`
 * in a packaged build (see `files:` in `electron-builder.yml`) and sits at the
 * repo root in dev, which is exactly the difference `process.resourcesPath` vs
 * `app.getAppPath()` captures.
 */
function bundledDir(): string {
  const app = electronApp();
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return join(root, "resources", "gnome-extension", EXTENSION_UUID);
}

/**
 * The `API_VERSION` of the copy on disk, or `0` if nothing is installed.
 * Read out of the file rather than asked over D-Bus on purpose: this has to
 * answer for an extension that is installed but not yet loaded, which by
 * definition cannot respond to a method call.
 */
async function installedVersion(): Promise<number> {
  try {
    const source = await readFile(join(installedDir(), "extension.js"), "utf8");
    const match = source.match(/^const API_VERSION = (\d+);$/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Copies the bundled extension into the user's extensions directory and
 * enables it. Removes any previous copy first so a shrinking file set can't
 * leave orphans behind that GNOME would still try to load.
 *
 * Returns the state the session is in afterwards — `"active"` only in the
 * unusual case where the extension was already loaded and this was a
 * same-version re-install; a genuinely new install always lands on
 * `"needs-restart"`.
 */
export async function install(): Promise<GnomeExtensionState> {
  if (!isGnomeSession()) return "unavailable";

  const target = installedDir();
  await rm(target, { recursive: true, force: true });
  await mkdir(extensionsDir(), { recursive: true });
  await cp(bundledDir(), target, { recursive: true });

  // GNOME ships with user extensions globally switched off on some distro
  // images; enabling this one has no effect while that master switch is off.
  await gsettings([
    "set",
    "org.gnome.shell",
    "disable-user-extensions",
    "false",
  ]);
  await enable();

  return status();
}

/**
 * Adds the extension to `org.gnome.shell enabled-extensions`.
 *
 * Deliberately not `gnome-extensions enable`, which refuses with "extension
 * does not exist" for anything the running shell hasn't scanned — i.e. for
 * every fresh install, exactly when this needs to work. Writing the GSettings
 * key directly records the intent, and the shell honours it on next startup.
 */
async function enable(): Promise<void> {
  const current = await gsettings([
    "get",
    "org.gnome.shell",
    "enabled-extensions",
  ]);
  const updated = withExtensionEnabled(current);
  if (updated === null) return;
  await gsettings(["set", "org.gnome.shell", "enabled-extensions", updated]);
}

/**
 * `enabled-extensions` with Magibar's uuid appended, or `null` when it's
 * already there and nothing needs writing.
 *
 * Kept as a pure function over `gsettings get` output so its two sharp edges
 * are directly testable: GSettings prints an *empty* `as` array as `@as []`,
 * which `gsettings set` will not accept back, and appending to a non-empty
 * list means splicing before the closing bracket rather than any kind of
 * parse. Other extensions' entries must survive untouched — this key is the
 * user's whole enabled-extension set, not Magibar's.
 */
export function withExtensionEnabled(current: string | null): string | null {
  const entry = `'${EXTENSION_UUID}'`;
  const list = (current ?? "").trim();
  if (list.includes(entry)) return null;

  const normalized = list.replace(/^@as\s+/, "");
  if (normalized === "" || normalized === "[]") return `[${entry}]`;
  return `${normalized.slice(0, -1)}, ${entry}]`;
}

/**
 * Where this session currently stands. `active` is decided by the caller's
 * live D-Bus check (`gnomeShellAvailable`) rather than by anything on disk,
 * because "installed and enabled" and "actually running" genuinely differ
 * until the next login.
 */
export async function status(available = false): Promise<GnomeExtensionState> {
  if (!isGnomeSession()) return "unavailable";
  if (available) return "active";
  return (await installedVersion()) > 0 ? "needs-restart" : "not-installed";
}

/**
 * Whether the copy on disk is older than the one this build ships, and so
 * should be replaced. `0` (nothing installed) is not "outdated" — that's a
 * first install, which is a different prompt for the user.
 */
export async function isOutdated(): Promise<boolean> {
  const version = await installedVersion();
  return version > 0 && version < BUNDLED_EXTENSION_VERSION;
}

/**
 * Asks GNOME to log the session out, which is what actually loads a
 * newly-installed extension (see `GnomeExtensionState`).
 *
 * `gnome-session-quit --logout` deliberately, not `--force`: it raises GNOME's
 * own confirmation dialog, so the user still gets to cancel or save work.
 * Magibar never ends the session on its own — logging out closes everything
 * else the user has open, which is far too destructive to do off a single
 * click in a window-snapping prompt.
 */
export async function requestLogout(): Promise<void> {
  try {
    await execFileAsync("gnome-session-quit", ["--logout"]);
  } catch (error) {
    console.error("[window/linux] gnome-session-quit failed:", error);
  }
}

/** `gsettings` output, or `null` if the call failed (schema missing on a non-GNOME box, etc.). */
async function gsettings(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gsettings", args);
    return stdout;
  } catch (error) {
    console.error(`[window/linux] gsettings ${args.join(" ")} failed:`, error);
    return null;
  }
}
