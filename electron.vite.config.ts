import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/**
 * Shared path aliases. Extensions (`src/extensions/<name>/`) hold code for every
 * Electron process at once, so they reach into `src/core` / `src/main` /
 * `src/shared` from a few directories deep — the aliases keep those imports flat.
 * `@core` is the process-agnostic foundation (extension base class + storage).
 * Kept in sync with `paths` in tsconfig.node.json / tsconfig.web.json.
 */
const nodeAlias = {
  "@core": resolve(__dirname, "src/core"),
  "@main": resolve(__dirname, "src/main"),
  "@shared": resolve(__dirname, "src/shared"),
  "@extensions": resolve(__dirname, "src/extensions"),
  "@plugin-engine": resolve(__dirname, "src/plugin-engine"),
};

/**
 * Serves `typescript/lib/typescript.js` (used by the Widget code editor's
 * language-service integration — see CodeEditor.tsx) as its own same-origin
 * script asset, with its trailing `//# sourceMappingURL=typescript.js.map`
 * comment stripped — that .map file doesn't actually ship in the `typescript`
 * npm package, and leaving the comment in makes Vite's dev server try (and
 * fail) to read it straight off disk, throwing an ENOENT.
 *
 * A plain `?url`/`?raw` import can't fix this on its own since it serves the
 * file byte-for-byte; this plugin re-serves a cleaned copy instead, as a
 * `virtual:typescript-runtime-url` module resolving to that copy's URL.
 */
function typescriptRuntimeAsset(): Plugin {
  const VIRTUAL_ID = "virtual:typescript-runtime-url";
  const RESOLVED_VIRTUAL_ID = "\0" + VIRTUAL_ID;
  const SOURCE_PATH = resolve(
    __dirname,
    "node_modules/typescript/lib/typescript.js",
  );
  const DEV_PATH = "/__typescript-runtime.js";
  let command: "build" | "serve" = "serve";

  function cleanedSource(): string {
    return readFileSync(SOURCE_PATH, "utf8").replace(
      /\/\/# sourceMappingURL=.*$/m,
      "",
    );
  }

  return {
    name: "typescript-runtime-asset",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(cleanedSource());
      });
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      if (command === "serve") {
        return `export default ${JSON.stringify(DEV_PATH)}`;
      }
      const refId = this.emitFile({
        type: "asset",
        name: "typescript.js",
        source: cleanedSource(),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${refId}`;
    },
  };
}

export default defineConfig({
  main: {
    // `@magibar/{win,mac,linux}` (each platform-restricted via their own
    // `os` field) and `electron-liquid-glass` are optionalDependencies with a
    // native addon, so externalizeDepsPlugin's default `pkg.dependencies` scan
    // misses them — list them explicitly so they stay a runtime `import`
    // instead of something Rollup tries (and fails) to bundle.
    plugins: [
      externalizeDepsPlugin({
        include: [
          "@magibar/win",
          "@magibar/mac",
          "@magibar/linux",
          "electron-liquid-glass",
        ],
      }),
    ],
    resolve: { alias: nodeAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Runs out-of-process (via ELECTRON_RUN_AS_NODE) so that resolving installed
          // apps and their icons — synchronous native calls — never blocks Electron's
          // main/browser process. See src/main/native/apps.ts.
          // Output name stays `apps-worker.js` (the input key); apps.ts resolves it
          // as `join(__dirname, 'apps-worker.js')` at runtime.
          "apps-worker": resolve(__dirname, "src/main/native/apps-worker.ts"),
          // Runs a Widget's user function out-of-process (same reason as above);
          // src/extensions/widget/main/runner.ts spawns it as `widget-worker.js`
          // (the input key below sets the output name).
          "widget-worker": resolve(
            __dirname,
            "src/extensions/widget/main/worker.ts",
          ),
          // One-shot worker for a plugin's no-view command, spawned the same
          // way as the two entries above; src/plugin-engine/host/
          // no-view-runner.ts resolves it as `plugin-noview-worker.js`.
          "plugin-noview-worker": resolve(
            __dirname,
            "src/plugin-engine/host/no-view-worker.ts",
          ),
          // Persistent `utilityProcess` hosting one running view command
          // instance; src/plugin-engine/host/list-host-manager.ts forks it
          // as `plugin-list-host.js`. Unlike the one-shot workers above,
          // this stays alive for the life of the open plugin screen.
          //
          // Both plugin entries compile in the @raycast/api shim plus React
          // and react-reconciler (devDependencies, so bundled rather than
          // externalized) — host/runtime.ts hands those to every installed
          // extension's prebuilt bundle, so nothing reads node_modules or
          // raw shim source at runtime.
          "plugin-list-host": resolve(
            __dirname,
            "src/plugin-engine/host/list-host-process.ts",
          ),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: nodeAlias },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": nodeAlias["@shared"],
        "@extensions": nodeAlias["@extensions"],
        "@plugin-engine": nodeAlias["@plugin-engine"],
      },
    },
    // The per-window HTML entries live in `src/renderer/` but pull their React
    // entry from `src/extensions/<name>/renderer/` — allow the dev server to
    // serve files from the repo root, not just the renderer root.
    server: { fs: { allow: [resolve(__dirname)] } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          settings: resolve(__dirname, "src/renderer/settings.html"),
          widget: resolve(__dirname, "src/renderer/widget.html"),
          onboarding: resolve(__dirname, "src/renderer/onboarding.html"),
        },
      },
    },
    plugins: [react(), typescriptRuntimeAsset()],
  },
});
