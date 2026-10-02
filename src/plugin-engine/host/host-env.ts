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
 * to (see `linux-shims.ts`).
 */
export function hostEnv(): NodeJS.ProcessEnv {
  const packaged = !!process.versions.electron && !process.defaultApp;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? (packaged ? "production" : "development"),
  };
  if (process.platform === "linux") {
    try {
      env.PATH = withLinuxShimPath(env.PATH, ensureLinuxShimDir());
    } catch (error) {
      console.error(
        "[plugin-engine] couldn't write macOS command shims:",
        error,
      );
    }
  }
  return env;
}
