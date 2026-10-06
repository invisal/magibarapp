import { linuxBinDir } from "./linux-binaries.ts";
import { ensureLinuxShimDir, withLinuxShimPath } from "./linux-shims.ts";

/**
 * The environment both plugin host processes are started with. The bundled
 * React (see `runtime.ts`) picks its development or production build from
 * `NODE_ENV` when it loads — unset in a packaged app, which would silently
 * mean the slower, warning-heavy development build.
 *
 * Packaged-ness comes from `process.defaultApp` (Electron sets it only when
 * running unpackaged, via `electron .`) rather than `app.isPackaged`, so this
 * stays importable without Electron (see `no-view-runner.test.ts`).
 *
 * On Linux, `PATH` also gets stand-ins for macOS tools extensions shell out
 * to (see `linux-shims.ts`), and the directory Linux builds of extension
 * helper binaries are downloaded to (see `linux-binaries.ts`).
 */
export function hostEnv(): NodeJS.ProcessEnv {
  const packaged = !!process.versions.electron && !process.defaultApp;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? (packaged ? "production" : "development"),
  };
  if (process.platform === "linux") {
    // Shims written in JS (`sqlite3`) run on this same binary as plain Node.
    env.MAGIBAR_NODE = process.execPath;
    try {
      env.PATH = withLinuxShimPath(
        withLinuxShimPath(env.PATH, ensureLinuxShimDir()),
        linuxBinDir(env),
      );
    } catch (error) {
      console.error(
        "[plugin-engine] couldn't write macOS command shims:",
        error,
      );
    }
  }
  return env;
}
