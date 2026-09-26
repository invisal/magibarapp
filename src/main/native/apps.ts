import { app } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { AppsWorkerResult } from './apps-worker'
import { listMacApplications } from './apps-mac'
import { listLinuxApplications } from './apps-linux'

/**
 * Native capability: enumerate installed applications and their icons.
 *
 * The actual resolution happens in apps-worker.ts, spawned as a separate
 * `ELECTRON_RUN_AS_NODE` process — see that file for why. This module just spawns
 * it and parses its output. It deals only in the serializable `AppsWorkerResult`;
 * persisting it and turning it into launcher actions (with their main-process
 * `run` handlers) is the caller's job — see src/main/sources/apps.
 */
function runAppsWorker(): Promise<AppsWorkerResult> {
  const workerPath = join(import.meta.dirname, 'apps-worker.js')
  const iconCacheDir = join(app.getPath('userData'), 'icon-cache')

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [workerPath],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          BENPOCKET_ICON_CACHE_DIR: iconCacheDir
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message))
          return
        }
        try {
          resolve(JSON.parse(stdout) as AppsWorkerResult)
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

/**
 * Resolves the current set of installed applications. On Windows this runs off the
 * browser process (see `runAppsWorker`); on macOS and Linux it resolves inline,
 * since their enumeration and icon lookups are already async and non-blocking
 * (see apps-mac / apps-linux). Returns `null` on an unsupported platform or a
 * failure, leaving callers to keep their last known-good list.
 */
export async function listApplications(): Promise<AppsWorkerResult | null> {
  try {
    if (process.platform === 'win32') return await runAppsWorker()
    if (process.platform === 'darwin') return await listMacApplications()
    if (process.platform === 'linux') return await listLinuxApplications()
    return null
  } catch (error) {
    console.error('[native] Failed to resolve installed applications:', error)
    return null
  }
}

export type { AppsWorkerResult, ShortcutAppResult, PackagedAppResult } from './apps-worker'
