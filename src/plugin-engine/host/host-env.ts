/**
 * The environment both plugin host processes are started with. The bundled
 * React (see `runtime.ts`) picks its development or production build from
 * `NODE_ENV` when it loads — unset in a packaged app, which would silently
 * mean the slower, warning-heavy development build.
 *
 * Packaged-ness comes from `process.defaultApp` (Electron sets it only when
 * running unpackaged, via `electron .`) rather than `app.isPackaged`, so this
 * stays importable without Electron (see `no-view-runner.test.ts`).
 */
export function hostEnv(): NodeJS.ProcessEnv {
  const packaged = !!process.versions.electron && !process.defaultApp;
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? (packaged ? "production" : "development"),
  };
}
