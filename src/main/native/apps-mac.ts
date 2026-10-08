/**
 * macOS equivalent of the Windows apps worker (apps-worker.ts).
 *
 * Unlike Windows, macOS needs no native module: an application is just a `.app`
 * bundle on disk, Spotlight (`mdfind`) enumerates them, and a bundle's icon is a
 * plain `.icns` file inside it.
 *
 * The one thing to be careful about is that this runs in Electron's main (browser)
 * process: decoding an `.icns` — some hold 1024px images — is not cheap, and doing
 * it hundreds of times synchronously would freeze the whole app (that includes the
 * global hotkey). So icon conversion is handed to `sips`, which runs out of
 * process, and results are cached on disk so only the first run and the occasional
 * changed app pay for it.
 *
 * Produces the same serializable `AppsWorkerResult` the Windows path does, mapping
 * every app to a `shortcut` entry (its `.app` path); macOS has no `packaged`
 * analogue, so that list is always empty.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { AppsWorkerResult, ShortcutAppResult } from './apps-worker'
import { listLauncherGames } from './game-libraries'

const execFileAsync = promisify(execFile)

/** Pixel size the icon PNGs are rendered at. */
const ICON_SIZE = 64

/** Max apps whose icons are converted at once (each spawns a `sips` process). */
const ICON_CONCURRENCY = 6

const SKIP_NAME_PATTERN = /uninstall|read ?me|^help$/i

/** Directories walked on every scan, alongside Spotlight — see `collectAppPaths`. */
const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  '/System/Library/CoreServices/Applications',
  // Mostly background agents, but Finder lives here — `CORE_SERVICE_APPS` is
  // what keeps the rest of it out.
  '/System/Library/CoreServices',
  join(homedir(), 'Applications')
]

/**
 * Spotlight indexes every `.app` on the machine — inside node_modules, on external
 * volumes, buried in `/System/Library/**`. Keep only bundles that live directly in
 * a real application folder (at most one subdirectory deep, e.g. `.../Utilities/`).
 */
const APP_ROOTS = [
  '/Applications',
  '/System/Applications',
  '/System/Library/CoreServices/Applications',
  join(homedir(), 'Applications')
]

/**
 * Apps sitting directly in `/System/Library/CoreServices`, which can't be an
 * app root: it's shared with the agents that make up the desktop itself —
 * Dock.app, SystemUIServer.app, loginwindow.app — none of which anyone
 * launches. Finder is the one real application in there, so it's named rather
 * than matched.
 */
const CORE_SERVICE_APPS = new Set(['/System/Library/CoreServices/Finder.app'])

/**
 * Apps some bundles ship inside themselves for launching on their own —
 * Xcode's Instruments, Device Hub and FileMerge, Finder's AirDrop and Recents.
 * Spotlight and Raycast list them like any other app.
 */
const EMBEDDED_APPS_DIR = '.app/Contents/Applications/'

function isInAppRoot(path: string): boolean {
  return APP_ROOTS.some((root) => {
    if (!path.startsWith(`${root}/`)) return false
    const rest = path.slice(root.length + 1)
    return rest.split('/').length <= 2 // 1 = directly in root, 2 = one folder deep
  })
}

/**
 * Every installed `.app` bundle path, from Spotlight *and* a walk of the known
 * app folders — both every time, not one as a fallback for the other.
 *
 * Spotlight alone catches apps in non-standard locations, but it can come back
 * healthy-looking and still be incomplete: `/System/Library/CoreServices` (where
 * Finder lives) is exactly the kind of path that ends up unindexed — indexing
 * switched off for the system volume, a privacy-list entry, a machine still
 * rebuilding its index after an update. That yields ~300 apps minus Finder, so a
 * fallback conditioned on Spotlight returning *nothing* never fires and the
 * missing app stays missing.
 *
 * The walk is one `readdir` per `APP_DIRS` entry, so running it unconditionally
 * is cheap insurance, and `isTopLevelApp` already drops the background agents it
 * drags in from `/System/Library/CoreServices` alongside Finder.
 */
async function collectAppPaths(): Promise<{ paths: string[]; displayNames: Map<string, string> }> {
  const [displayNames, scanned] = await Promise.all([spotlightApps(), scanAppDirs()])
  return { paths: [...new Set([...displayNames.keys(), ...scanned])], displayNames }
}

/** One `mdfind -attr` output line: `<path>   kMDItemDisplayName = <name>`. */
const MDFIND_LINE = /^(.+\.app)\s+kMDItemDisplayName = (.*)$/

/**
 * `.app` bundles Spotlight knows about, each mapped to its display name —
 * the name Finder and Raycast show, which can differ from the bundle's file
 * name ("Device Hub" for `DeviceHub.app`) and is localized. Empty if mdfind
 * fails or indexing is off.
 */
async function spotlightApps(): Promise<Map<string, string>> {
  const apps = new Map<string, string>()
  try {
    const { stdout } = await execFileAsync(
      'mdfind',
      ['-attr', 'kMDItemDisplayName', "kMDItemContentType == 'com.apple.application-bundle'"],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    for (const line of stdout.split('\n')) {
      const match = MDFIND_LINE.exec(line.trim())
      if (!match) continue
      const name = match[2].trim().replace(/\.app$/i, '')
      apps.set(match[1], name === '(null)' ? '' : name)
    }
  } catch (error) {
    console.error('[apps-mac] mdfind failed, relying on the directory scan:', error)
  }
  return apps
}

/** `.app` bundles directly inside `dir`; empty if it can't be read. */
async function appsIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.name.endsWith('.app')).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * `.app` bundles sitting directly in an `APP_DIRS` folder, plus any each of
 * those embeds in its `Contents/Applications` (see `EMBEDDED_APPS_DIR`).
 */
async function scanAppDirs(): Promise<string[]> {
  const topLevel = (await Promise.all(APP_DIRS.map(appsIn))).flat()
  const embedded = await Promise.all(
    topLevel.map((path) => appsIn(join(path, 'Contents', 'Applications')))
  )
  return [...topLevel, ...embedded.flat()]
}

/**
 * Drops nested bundles (helpers, XPC services, `.app`s bundled elsewhere in
 * another app's `Contents/`) and anything matching the skip pattern, keeping
 * only user-facing top-level applications — and the ones a top-level app
 * embeds in `Contents/Applications` for launching on their own.
 */
function isTopLevelApp(path: string): boolean {
  const embedIndex = path.indexOf(EMBEDDED_APPS_DIR)
  if (embedIndex !== -1) {
    const rest = path.slice(embedIndex + EMBEDDED_APPS_DIR.length)
    if (rest.includes('/')) return false
    return isTopLevelApp(path.slice(0, embedIndex + '.app'.length)) && !SKIP_NAME_PATTERN.test(basename(path, '.app'))
  }
  if (path.includes('.app/')) return false
  if (!isInAppRoot(path) && !CORE_SERVICE_APPS.has(path)) return false
  const name = basename(path, '.app')
  return name.length > 0 && !SKIP_NAME_PATTERN.test(name)
}

/**
 * The bundle's app icon: whichever `.icns` `Info.plist` names via `CFBundleIconFile`,
 * else — for the many bundles that carry document-type icons alongside the app one
 * — the largest `.icns` in `Contents/Resources` (the app icon is normally the one
 * shipped at every size up to 1024px, so it wins on file size).
 */
async function findIcnsPath(appPath: string): Promise<string | null> {
  const resourcesDir = join(appPath, 'Contents', 'Resources')

  try {
    const { stdout } = await execFileAsync('plutil', [
      '-extract',
      'CFBundleIconFile',
      'raw',
      '-o',
      '-',
      join(appPath, 'Contents', 'Info.plist')
    ])
    const named = stdout.trim()
    if (named) {
      const file = named.toLowerCase().endsWith('.icns') ? named : `${named}.icns`
      const full = join(resourcesDir, file)
      if (await stat(full).then((s) => s.isFile(), () => false)) return full
    }
  } catch {
    /* no key, or plutil failed — fall through to the directory scan */
  }

  let entries: string[]
  try {
    entries = await readdir(resourcesDir)
  } catch {
    return null
  }

  let best: { path: string; size: number } | null = null
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.icns')) continue
    const full = join(resourcesDir, entry)
    const size = await stat(full).then((s) => s.size, () => 0)
    if (!best || size > best.size) best = { path: full, size }
  }
  return best?.path ?? null
}

/** Cache filenames produced this run, so a later prune spares them. */
const touchedIconFiles = new Set<string>()

function iconCacheDir(): string {
  return join(app.getPath('userData'), 'mac-icon-cache')
}

function iconCacheKey(icnsPath: string, mtimeMs: number): string {
  return createHash('sha1').update(`${icnsPath}|${mtimeMs}|${ICON_SIZE}`).digest('hex')
}

/**
 * Converts `icnsPath` to a `${ICON_SIZE}px` PNG data URL, via `sips` (out of
 * process) with an on-disk cache keyed on the source file's mtime. Exported
 * for the plugin engine's `{ fileIcon }` icons (an extension naming an
 * `.icns` directly).
 */
export async function icnsToDataUrl(icnsPath: string): Promise<string | undefined> {
  const mtimeMs = await stat(icnsPath).then((s) => s.mtimeMs, () => 0)
  const cacheFile = join(iconCacheDir(), `${iconCacheKey(icnsPath, mtimeMs)}.png`)
  touchedIconFiles.add(basename(cacheFile))

  const cached = await readFile(cacheFile).catch(() => null)
  if (cached) return `data:image/png;base64,${cached.toString('base64')}`

  const tmp = join(tmpdir(), `benlaunch-icon-${createHash('sha1').update(icnsPath).digest('hex')}.png`)
  try {
    await execFileAsync('sips', [
      '-s',
      'format',
      'png',
      '-z',
      String(ICON_SIZE),
      String(ICON_SIZE),
      icnsPath,
      '--out',
      tmp
    ])
    const png = await readFile(tmp)
    await mkdir(iconCacheDir(), { recursive: true })
    await writeFileAtomic(cacheFile, png)
    return `data:image/png;base64,${png.toString('base64')}`
  } catch (error) {
    console.error(`[apps-mac] sips failed for ${icnsPath}:`, error)
    return undefined
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/**
 * The bundle's icon as a `${ICON_SIZE}px` PNG data URL, disk-cached — the
 * same lookup `listMacApplications()` uses per installed app, exposed so
 * other callers with an already-known `.app` path (e.g. clipboard history's
 * "Source" field) don't have to reimplement the `.icns`→PNG pipeline.
 */
export async function resolveIcon(appPath: string): Promise<string | undefined> {
  try {
    const icnsPath = await findIcnsPath(appPath)
    return icnsPath ? await icnsToDataUrl(icnsPath) : undefined
  } catch (error) {
    console.error(`[apps-mac] Failed to resolve icon for ${appPath}:`, error)
    return undefined
  }
}

/** Deletes cache PNGs not produced this run (apps uninstalled or updated). */
async function pruneIconCache(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(iconCacheDir())
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.png') && !touchedIconFiles.has(entry))
      .map((entry) => rm(join(iconCacheDir(), entry), { force: true }).catch(() => {}))
  )
}

/** Resolves each item with at most `limit` calls to `fn` in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export async function listMacApplications(): Promise<AppsWorkerResult> {
  const { paths, displayNames } = await collectAppPaths()
  const appPaths = paths.filter(isTopLevelApp)
  const titleOf = (path: string) => displayNames.get(path) || basename(path, '.app')

  const seenNames = new Set<string>()
  const uniquePaths = appPaths.filter((path) => {
    const name = titleOf(path).toLowerCase()
    if (seenNames.has(name)) return false
    seenNames.add(name)
    return true
  })

  const icons = await mapLimit(uniquePaths, ICON_CONCURRENCY, resolveIcon)
  if (uniquePaths.length > 0) await pruneIconCache()

  const shortcuts: ShortcutAppResult[] = uniquePaths.map((path, index) => {
    const title = titleOf(path)
    const fileName = basename(path, '.app')
    return {
      kind: 'shortcut',
      path,
      title,
      icon: icons[index],
      // Keep the bundle's file name searchable when the display name differs
      // (a localized name, or "Device Hub" vs `DeviceHub.app`).
      altNames: fileName !== title ? [fileName] : undefined
    }
  })

  // Steam games live under ~/Library/Application Support/Steam, outside every
  // app root above, so they come from Steam's own library instead.
  const games = await listLauncherGames(shortcuts.map((shortcut) => shortcut.title))

  return { shortcuts, packaged: [], games }
}
