/**
 * Installs an extension's own npm dependencies — source builds only (see
 * `bundle.ts`); Store installs ship prebuilt bundles and never get here.
 * Real Raycast extensions regularly import third-party packages (and almost
 * always `@raycast/utils`), which `bundle.ts` inlines from a real
 * `node_modules`.
 *
 * Runs in the staged source directory, so `node_modules` is part of the
 * installed plugin's `source/` (a re-bundle never needs a re-install).
 *
 * Finding npm: an app launched from Finder/Dock gets launchd's bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which never contains a Homebrew, nvm,
 * Volta, fnm, or mise install of Node. `resolveNpm` asks the user's login
 * shell first (which sources their profile), then probes the usual install
 * locations.
 *
 * `--ignore-scripts`: dependency install scripts don't run (the same safer
 * default Tinycast uses) — bundling only needs the packages' files.
 * `--legacy-peer-deps`: extensions routinely pin `react`/`@raycast/api`
 * versions whose peer ranges conflict; npm 7+'s strict resolution would
 * refuse the whole install over something bundling never even uses.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RaycastManifest } from "../manifest.ts";

const execFileAsync = promisify(execFile);

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** npm's own install output can be chatty; the default 1MB buffer isn't
 *  enough for a dependency tree of any real size. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SHELL_LOOKUP_TIMEOUT_MS = 5_000;

export type NpmInstallResult = { ok: true } | { ok: false; error: string };

function newestNvmBin(): string[] {
  const root = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(root)) return [];
  const versions = readdirSync(root)
    .filter((v) => /^v\d+/.test(v))
    .sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
    );
  return versions.map((v) => join(root, v, "bin"));
}

/** Candidate directories that might hold `npm`, most likely first. */
export function candidateNpmDirs(platform = process.platform): string[] {
  const home = homedir();
  if (platform === "win32") {
    return [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
      join(home, "AppData", "Local", "Volta", "bin"),
      join(
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        "fnm_multishells",
      ),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".volta", "bin"),
    ...newestNvmBin(),
    join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".asdf", "shims"),
    "/usr/bin",
  ];
}

async function npmFromLoginShell(): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("where", ["npm.cmd"], {
        timeout: SHELL_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
      });
      return stdout.split(/\r?\n/).find((line) => line.trim()) ?? null;
    } catch {
      return null;
    }
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "command -v npm"], {
      timeout: SHELL_LOOKUP_TIMEOUT_MS,
    });
    // A profile can print banners; the path is the last absolute line.
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .reverse()
      .find((l) => l.startsWith("/"));
    return line && existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

let resolvedNpm: string | null | undefined;

/** Absolute path to `npm`, or `null` if Node.js doesn't seem to be
 *  installed. Cached for the life of the process once found. */
export async function resolveNpm(): Promise<string | null> {
  if (resolvedNpm) return resolvedNpm;
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const fromShell = await npmFromLoginShell();
  const found =
    fromShell ??
    candidateNpmDirs()
      .map((dir) => join(dir, npmName))
      .find((candidate) => existsSync(candidate)) ??
    null;
  resolvedNpm = found;
  return found;
}

function tail(text: string, lines: number): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

export async function installDependencies(
  sourceDir: string,
  manifest: RaycastManifest,
): Promise<NpmInstallResult> {
  const dependencies = manifest.dependencies;
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return { ok: true };
  }

  const npm = await resolveNpm();
  if (!npm) {
    return {
      ok: false,
      error:
        "Node.js/npm is required to build extensions from source, and it couldn't be found. Install Node.js from nodejs.org (or install it from the Store instead, which needs no build).",
    };
  }

  // npm's own shebang (`#!/usr/bin/env node`) needs `node` on PATH too —
  // the directory npm lives in always has it.
  const env = {
    ...process.env,
    PATH: [dirname(npm), process.env.PATH ?? ""]
      .filter(Boolean)
      .join(delimiter),
  };

  try {
    await execFileAsync(
      npm,
      [
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        "--ignore-scripts",
      ],
      {
        cwd: sourceDir,
        env,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        // `.cmd` files can only be run through a shell on Windows.
        shell: process.platform === "win32",
      },
    );
    return { ok: true };
  } catch (error) {
    const e = error as Error & { killed?: boolean; stderr?: string };
    if (e.killed) {
      return {
        ok: false,
        error: `installing this extension's dependencies timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes`,
      };
    }
    const details = e.stderr ? tail(e.stderr, 20) : e.message;
    return {
      ok: false,
      error: `installing this extension's dependencies failed:\n${details}`,
    };
  }
}
