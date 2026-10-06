/**
 * Raycast extensions are written against macOS, so the paths they build —
 * `join(homedir(), "Library", "Application Support", "Code", …)` — point at
 * folders Linux keeps elsewhere (`~/.config/Code/…`). On Linux the plugin
 * hosts hand extensions an `fs` (see `runtime.ts`) whose path arguments go
 * through `toLinuxPath`, which maps the macOS layout onto the XDG one.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** `~/Library/<from>` → `~/<to>`, most specific first. A `null` target means
 *  there's no Linux equivalent — the path is left alone. */
const LIBRARY_MAP: Array<[string, string | null]> = [
  ["Application Support/Google/Chrome Beta", ".config/google-chrome-beta"],
  ["Application Support/Google/Chrome Dev", ".config/google-chrome-unstable"],
  ["Application Support/Google/Chrome", ".config/google-chrome"],
  ["Application Support/Microsoft Edge", ".config/microsoft-edge"],
  ["Application Support/Firefox/Profiles", ".mozilla/firefox"],
  ["Application Support/Firefox", ".mozilla/firefox"],
  ["Application Support/zen", ".zen"],
  ["Application Support", ".config"],
  ["Preferences", ".config"],
  ["Caches", ".cache"],
  ["Logs", ".local/state"],
];

let home = homedir();

/** Test seam. */
export function setHomeForTests(dir: string): void {
  home = dir;
}

/** The Linux counterpart of a macOS `~/Library/…` path; anything else comes
 *  back unchanged. Under `~/.config`, the first folder is matched
 *  case-insensitively — Linux builds often lowercase it (`obsidian`). */
export function toLinuxPath(path: string): string {
  const library = join(home, "Library") + sep;
  if (!path.startsWith(library)) return path;
  const rest = path.slice(library.length);
  for (const [from, to] of LIBRARY_MAP) {
    if (rest !== from && !rest.startsWith(from + "/")) continue;
    if (to === null) return path;
    const tail = rest.slice(from.length + 1);
    return join(home, to, to === ".config" ? matchCase(tail) : tail);
  }
  return path;
}

/** `Foo/bar` under `~/.config`, with `Foo` swapped for an existing folder
 *  that differs only in case. */
function matchCase(tail: string): string {
  if (!tail) return tail;
  const [first, ...more] = tail.split("/");
  const config = join(home, ".config");
  if (fs.existsSync(join(config, first))) return tail;
  try {
    const match = fs
      .readdirSync(config)
      .find((entry) => entry.toLowerCase() === first.toLowerCase());
    if (match) return [match, ...more].join("/");
  } catch {
    // No ~/.config — keep the name as is.
  }
  return tail;
}

/** `toLinuxPath` for paths embedded in a shell command string — prefix
 *  replacement only (also matching `Application\\ Support`), no case
 *  matching. */
export function rewriteLibraryPaths(text: string): string {
  const library = join(home, "Library") + sep;
  if (!text.includes(library)) return text;
  for (const [from, to] of LIBRARY_MAP) {
    if (to === null) continue;
    for (const variant of new Set([from, from.replace(/ /g, "\\ ")])) {
      text = text.split(`${library}${variant}`).join(join(home, to));
    }
  }
  return text;
}

function mapArg(value: unknown): unknown {
  if (typeof value === "string") return toLinuxPath(value);
  if (value instanceof URL && value.protocol === "file:") {
    const mapped = toLinuxPath(value.pathname);
    return mapped === value.pathname ? value : new URL(`file://${mapped}`);
  }
  return value;
}

/** Functions whose *second* argument is a path too. */
const TWO_PATHS = new Set([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "symlink",
  "symlinkSync",
]);

function wrapFunction<F extends (...args: unknown[]) => unknown>(
  name: string,
  fn: F,
): F {
  return new Proxy(fn, {
    apply(target, self, args: unknown[]) {
      if (args.length > 0) args[0] = mapArg(args[0]);
      if (args.length > 1 && TWO_PATHS.has(name)) args[1] = mapArg(args[1]);
      return Reflect.apply(target, self, args);
    },
  });
}

/** `fs` or `fs/promises` with every path-taking function going through
 *  `toLinuxPath`. Classes (`ReadStream`, `Stats`…) and constants pass
 *  through untouched. */
export function wrapFsModule<T extends object>(module: T): T {
  // Keyed by the original, so later monkey-patches (graceful-fs) still show.
  const wrappers = new WeakMap<object, unknown>();
  return new Proxy(module, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      const wrappable =
        (prop === "promises" && typeof value === "object" && value !== null) ||
        (typeof value === "function" &&
          typeof prop === "string" &&
          /^[a-z]/.test(prop));
      if (!wrappable) return value;
      let wrapped = wrappers.get(value as object);
      if (!wrapped) {
        wrapped =
          typeof value === "function"
            ? wrapFunction(
                prop as string,
                value as (...args: unknown[]) => unknown,
              )
            : wrapFsModule(value as object);
        wrappers.set(value as object, wrapped);
      }
      return wrapped;
    },
  });
}
