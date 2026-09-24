/**
 * The source-build fallback (a local folder, or a GitHub repo other than
 * raycast/extensions): bundles each command the way `ray build` does, so the
 * output is interchangeable with a Raycast Store package's prebuilt bundles
 * and runs through the exact same `host/runtime.ts`.
 *
 * That means `@raycast/api`, `react`, and the JSX runtimes stay *external* —
 * `runtime.ts` supplies them at `require` time — while everything else
 * (including `@raycast/utils` and any npm dependency) is inlined from the
 * extension's own `node_modules` (see `npm-install.ts`).
 *
 * esbuild is loaded lazily: it's a native binary that only this path needs,
 * so a problem loading it can only ever break source builds, never the
 * app's startup or a Store install.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pluginBundlePath, pluginDistDir } from "../paths.ts";
import type { RaycastManifestCommand } from "../manifest.ts";

/** Left as `require`s for `host/runtime.ts` to answer — the same set
 *  `ray build` leaves external. */
export const RUNTIME_EXTERNALS = [
  "@raycast/api",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
];

const ENTRY_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;

export type BundleResult = { ok: true } | { ok: false; error: string };

/** `src/<name>.tsx` (the usual layout), `src/<name>/index.tsx`, or the same
 *  at the package root. */
export function findEntryFile(
  sourceDir: string,
  commandName: string,
): string | null {
  for (const dir of ["src", "."]) {
    for (const ext of ENTRY_EXTENSIONS) {
      const flat = join(sourceDir, dir, `${commandName}.${ext}`);
      if (existsSync(flat)) return flat;
    }
    for (const ext of ENTRY_EXTENSIONS) {
      const nested = join(sourceDir, dir, commandName, `index.${ext}`);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

/** A `package.json` beside the bundles pinning them to CommonJS — without
 *  it, an ancestor directory's `"type": "module"` would make Node load a
 *  `.js` bundle as ESM, and every `require`/`exports` in it would fail. */
export async function writeDistPackageJson(distDir: string): Promise<void> {
  await mkdir(distDir, { recursive: true });
  await writeFile(
    join(distDir, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2),
  );
}

/**
 * In a packaged app esbuild's JS sits inside `app.asar` and resolves its
 * native binary to a path *inside* the archive, which can't be executed —
 * electron-builder unpacks it (`asarUnpack` in `electron-builder.yml`), and
 * `ESBUILD_BINARY_PATH` (read once, when esbuild's module first loads) points
 * esbuild at that unpacked copy.
 */
function configureEsbuildBinary(): void {
  if (process.env.ESBUILD_BINARY_PATH || !process.versions.electron) return;
  try {
    const subpath =
      process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
    const resolved = createRequire(import.meta.url).resolve(
      `@esbuild/${process.platform}-${process.arch}/${subpath}`,
    );
    const unpacked = resolved.replace(
      /app\.asar([\\/])/,
      "app.asar.unpacked$1",
    );
    if (unpacked !== resolved && existsSync(unpacked)) {
      process.env.ESBUILD_BINARY_PATH = unpacked;
    }
  } catch {
    // Not packaged, or no binary for this platform — esbuild reports it.
  }
}

/** Bundles every command in `commands` found under `sourceDir` into
 *  `pluginsRoot/<pluginId>/dist/<command>.js`. */
export async function bundlePlugin(
  pluginsRoot: string,
  pluginId: string,
  sourceDir: string,
  commands: RaycastManifestCommand[],
): Promise<BundleResult> {
  let build: typeof import("esbuild").build;
  try {
    configureEsbuildBinary();
    ({ build } = await import("esbuild"));
  } catch (error) {
    return {
      ok: false,
      error: `the bundler (esbuild) couldn't be loaded, so extensions can't be built from source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  await writeDistPackageJson(pluginDistDir(pluginsRoot, pluginId));

  for (const command of commands) {
    const entry = findEntryFile(sourceDir, command.name);
    if (!entry) {
      return {
        ok: false,
        error: `couldn't find an entry file for command "${command.name}" (looked for src/${command.name}.{tsx,ts,jsx,js} and src/${command.name}/index.*)`,
      };
    }

    const outfile = pluginBundlePath(pluginsRoot, pluginId, command.name);
    try {
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: ["node20"],
        // Real Raycast extensions never `import React from "react"` — they're
        // written for the automatic JSX runtime, so this must match.
        jsx: "automatic",
        external: RUNTIME_EXTERNALS,
        loader: {
          ".png": "dataurl",
          ".svg": "dataurl",
          ".jpg": "dataurl",
          ".jpeg": "dataurl",
          ".gif": "dataurl",
          ".webp": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
          ".ttf": "dataurl",
          ".md": "text",
          ".txt": "text",
        },
        logLevel: "silent",
        write: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: /\.node\b/.test(message)
          ? `command "${command.name}" depends on a native Node addon (.node), which can't be bundled: ${message}`
          : `bundling command "${command.name}" failed: ${message}`,
      };
    }

    if (!existsSync(outfile)) {
      return {
        ok: false,
        error: `esbuild didn't produce an output for command "${command.name}"`,
      };
    }
  }
  return { ok: true };
}
