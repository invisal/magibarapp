/**
 * Raycast extensions often download a helper CLI on first run and pick the
 * macOS build on anything that isn't Windows (Speedtest fetches Ookla's
 * `macosx-universal.tgz`), so on Linux they end up spawning a Mach-O file —
 * which `sh` then tries to run as a script. On Linux the plugin hosts hand
 * extensions a wrapped `child_process` (see `runtime.ts`) that swaps such a
 * spawn for a Linux build of the same tool: one already on `PATH`, or one
 * from `LINUX_BUILDS`, downloaded and checksum-verified into `linuxBinDir()`.
 */
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { rewriteLibraryPaths, toLinuxPath } from "./linux-paths.ts";

interface LinuxBuild {
  /** Download URL for a Linux arch name (`x86_64`, `aarch64`, …). */
  url(arch: string): string;
  /** sha256 of the archive, per Linux arch name. */
  sha256: Record<string, string>;
  /** The executable's path inside the `.tgz`. */
  member: string;
}

/** Pinned Linux builds, keyed by the executable's basename. */
export const LINUX_BUILDS: Record<string, LinuxBuild> = {
  speedtest: {
    url: (arch) =>
      `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-${arch}.tgz`,
    sha256: {
      x86_64:
        "5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7",
      aarch64:
        "3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3",
      armhf: "e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d",
      i386: "9ff7e18dbae7ee0e03c66108445a2fb6ceea6c86f66482e1392f55881b772fe8",
    },
    member: "speedtest",
  },
};

const LINUX_ARCH: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  arm: "armhf",
  ia32: "i386",
};

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

export function isMachO(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(4);
    return (
      readSync(fd, head, 0, 4, 0) === 4 &&
      MACH_O_MAGIC.has(head.readUInt32BE(0))
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Where downloaded Linux builds live; also on the plugin hosts' `PATH`. */
export function linuxBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "magibar",
    "bin",
  );
}

/** A runnable Linux `name` on `path` (or in `linuxBinDir()`), skipping
 *  `exclude` and anything that's itself a Mach-O file. */
export function findLinuxExecutable(
  name: string,
  path: string | undefined,
  exclude?: string,
): string | null {
  const excluded = exclude ? safeRealpath(exclude) : null;
  const dirs = [...(path ?? "").split(delimiter), linuxBinDir()];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    if (safeRealpath(candidate) === excluded || isMachO(candidate)) continue;
    return candidate;
  }
  return null;
}

function safeRealpath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

const execFileAsync = promisify(childProcess.execFile);
const provisioning = new Map<string, Promise<string>>();

/** Downloads, verifies and unpacks `LINUX_BUILDS[name]` into `dir` (once per
 *  process); resolves to the executable's path. On failure writes
 *  `<name>.failed` with the reason, which the trampoline reports. */
export function provisionLinuxBuild(
  name: string,
  dir: string = linuxBinDir(),
  nodeArch: string = process.arch,
): Promise<string> {
  const target = join(dir, name);
  let pending = provisioning.get(target);
  if (!pending) {
    rmSync(`${target}.failed`, { force: true });
    pending = downloadLinuxBuild(name, dir, nodeArch).catch(async (error) => {
      provisioning.delete(target);
      const reason = error instanceof Error ? error.message : String(error);
      await writeFile(
        `${target}.failed`,
        `${name}: couldn't install the Linux build — ${reason}\n`,
      ).catch(() => {});
      throw error;
    });
    provisioning.set(target, pending);
  }
  return pending;
}

async function downloadLinuxBuild(
  name: string,
  dir: string,
  nodeArch: string,
): Promise<string> {
  const build = LINUX_BUILDS[name];
  const arch = LINUX_ARCH[nodeArch];
  const sha256 = arch ? build?.sha256[arch] : undefined;
  if (!build || !arch || !sha256) {
    throw new Error(`no Linux build of "${name}" for ${nodeArch}`);
  }
  const response = await fetch(build.url(arch));
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("archive too large");
  if (createHash("sha256").update(archive).digest("hex") !== sha256) {
    throw new Error("checksum mismatch");
  }

  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(join(dir, `.${name}-`));
  try {
    await writeFile(join(work, "archive.tgz"), archive);
    await execFileAsync("tar", ["-xzf", "archive.tgz", build.member], {
      cwd: work,
    });
    const unpacked = join(work, build.member);
    await chmod(unpacked, 0o755);
    // Atomic, so the trampoline never sees a half-written file.
    await rename(unpacked, join(dir, name));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return join(dir, name);
}

/** Waits for a Linux build being downloaded in-process, then execs it —
 *  lets `spawn()` hand back a real child right away. */
const TRAMPOLINE = `bin=$1; shift; i=0
while [ ! -x "$bin" ]; do
  if [ -e "$bin.failed" ]; then cat "$bin.failed" >&2; exit 126; fi
  i=$((i + 1)); if [ $i -gt 1200 ]; then echo "$(basename "$bin"): timed out installing the Linux build" >&2; exit 126; fi
  sleep 0.1
done
exec "$bin" "$@"`;

const FAIL = `printf '%s\\n' "$1" >&2; exit 126`;

type Invocation = { file: string; args: readonly string[] };

/** What to run instead of `file args` on Linux. `~/Library/…` arguments
 *  get their Linux paths; a hard-coded macOS tool path that doesn't exist
 *  here (`/opt/homebrew/bin/brew`, `/usr/bin/open`, `….app/Contents/…/code`)
 *  falls back to the same-named command on `PATH`; a Mach-O executable is
 *  swapped for a Linux build. `sync` callers block the event loop, so they
 *  can't wait for a download. */
export function linuxInvocation(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  sync: boolean,
): Invocation {
  args = args.map((arg) => (typeof arg === "string" ? toLinuxPath(arg) : arg));
  const path = (env ?? process.env).PATH;
  file = toLinuxPath(file);
  if (isAbsolute(file) && !existsSync(file)) {
    return { file: findLinuxExecutable(basename(file), path) ?? file, args };
  }
  if (!isMachO(file)) return { file, args };
  const name = basename(file);
  const local = findLinuxExecutable(name, path, file);
  if (local) return { file: local, args };

  if (!sync && LINUX_BUILDS[name] && LINUX_ARCH[process.arch]) {
    const target = join(linuxBinDir(), name);
    provisionLinuxBuild(name).catch((error) =>
      console.error(`[plugin-engine] Linux build of ${name}:`, error),
    );
    return {
      file: "/bin/sh",
      args: ["-c", TRAMPOLINE, "magibar-trampoline", target, ...args],
    };
  }
  return {
    file: "/bin/sh",
    args: [
      "-c",
      FAIL,
      "sh",
      `${name}: this Raycast extension runs a macOS-only binary — install a Linux "${name}" on your PATH to use it`,
    ],
  };
}

/** The shell-string form of `linuxInvocation`, for `exec` and
 *  `spawn(…, { shell: true })`: remaps `~/Library` paths anywhere in it and
 *  a missing absolute path in command position. */
export function linuxCommand(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  command = rewriteLibraryPaths(command);
  const head = /^(\s*)(?:"(\/[^"]+)"|'(\/[^']+)'|(\/[^\s;&|]+))/.exec(command);
  const file = head?.[2] ?? head?.[3] ?? head?.[4];
  if (!head || !file || existsSync(file)) return command;
  const local = findLinuxExecutable(basename(file), (env ?? process.env).PATH);
  if (!local) return command;
  return `${head[1]}'${local.replace(/'/g, "'\\''")}'${command.slice(head[0].length)}`;
}

type AnyFn = (...args: unknown[]) => unknown;
type SpawnOptions = { shell?: unknown; env?: NodeJS.ProcessEnv };

const isOptions = (value: unknown): value is SpawnOptions =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `[file, args?, ...rest]` → the same call with `linuxInvocation` applied. */
function rewriteCall(call: unknown[], sync: boolean): unknown[] {
  const [file, maybeArgs, ...more] = call;
  if (typeof file !== "string") return call;
  const hasArgs = Array.isArray(maybeArgs);
  const rest = hasArgs ? more : [maybeArgs, ...more].slice(0, call.length - 1);
  const options = rest.find(isOptions);
  if (options?.shell) {
    return [linuxCommand(file, options.env), ...call.slice(1)];
  }
  const next = linuxInvocation(
    file,
    hasArgs ? (maybeArgs as string[]) : [],
    options?.env,
    sync,
  );
  return [next.file, [...next.args], ...rest];
}

/** `[command, options?, callback?]` → the same with `linuxCommand` applied. */
function rewriteExec(call: unknown[]): unknown[] {
  const [command, ...rest] = call;
  if (typeof command !== "string") return call;
  return [linuxCommand(command, rest.find(isOptions)?.env), ...rest];
}

/** `child_process` with `spawn`/`execFile` (and their sync forms) routed
 *  through `linuxInvocation`, and `exec`/`execSync` through `linuxCommand`.
 *  The originals are looked up per call, so later patches to the module
 *  (the compat harness blocks process spawning) still apply. */
export function wrapChildProcess(
  cp: typeof childProcess = childProcess,
): typeof childProcess {
  const module = cp as unknown as Record<string, AnyFn>;
  const wrap = (name: string, rewrite: (call: unknown[]) => unknown[]): AnyFn =>
    function (this: unknown, ...call: unknown[]) {
      return module[name].apply(this, rewrite(call));
    };
  const async = (call: unknown[]) => rewriteCall(call, false);
  const sync = (call: unknown[]) => rewriteCall(call, true);
  const wrapped: Record<string, AnyFn> = {
    spawn: wrap("spawn", async),
    execFile: wrap("execFile", async),
    exec: wrap("exec", rewriteExec),
    spawnSync: wrap("spawnSync", sync),
    execFileSync: wrap("execFileSync", sync),
    execSync: wrap("execSync", rewriteExec),
  };
  // `promisify(execFile)`/`promisify(exec)` resolve `{ stdout, stderr }`
  // through this hook.
  for (const [name, rewrite] of [
    ["execFile", async],
    ["exec", rewriteExec],
  ] as const) {
    Object.defineProperty(wrapped[name], promisify.custom, {
      value: (...call: unknown[]) => {
        const original = module[name] as AnyFn & Record<symbol, AnyFn>;
        return (original[promisify.custom] ?? promisify(original))(
          ...rewrite(call),
        );
      },
    });
  }
  return new Proxy(cp, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && Object.hasOwn(wrapped, prop)
        ? wrapped[prop]
        : Reflect.get(target, prop, receiver),
  });
}
