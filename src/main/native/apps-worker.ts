/**
 * Runs out-of-process via `ELECTRON_RUN_AS_NODE` (spawned from apps.ts), never inside
 * Electron's main/browser process. The `@magibar/win` native calls this makes
 * are synchronous, and Electron's "main process" is the actual Chromium browser
 * process — calling them there would freeze the whole app (window paint, IPC,
 * everything) for as long as icon resolution takes. Spawning this as a child process
 * keeps that work off the browser process's event loop, the same way the PowerShell
 * script this replaced did.
 *
 * Talks to its parent the same way the old PowerShell script did: reads nothing from
 * stdin, writes one JSON blob to stdout on completion.
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { extractIconPng, extractPackagedIconPng, listStartApps, resolveShortcut } from '@magibar/win'
import { listLauncherGames, type GameAppResult } from './game-libraries'
import * as iconCache from './icon-cache'

const START_MENU_DIRS = [
  process.env.ProgramData
    ? join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : null,
  process.env.APPDATA
    ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : null
].filter((dir): dir is string => Boolean(dir))

const MAX_DEPTH = 4
const SKIP_NAME_PATTERN = /uninstall|read ?me|help|website|documentation|license/i
const PACKAGED_ICON_SIZE = 48
const SHORTCUT_EXTENSIONS = new Set(['.lnk', '.url'])
/**
 * `.url` Internet Shortcuts with these schemes are web pages ("Homepage", "Steam
 * Support Center"), not apps. Anything else is an app protocol — `steam://rungameid/…`,
 * `uplay://launch/…`, `com.epicgames.launcher://…` — which is how game launchers
 * add their games to the Start Menu, so those are kept as apps.
 */
const WEB_URL_SCHEMES = new Set(['http', 'https', 'ftp', 'mailto', 'file'])

export interface ShortcutAppResult {
  kind: 'shortcut'
  path: string
  title: string
  /** Linux: "Settings" for a GNOME Settings page, telling it apart from an app. */
  subtitle?: string
  icon?: string
  /**
   * The executable this entry resolves to, when there is one — used for "Open
   * With", which has to hand a path or URL to a real program. Windows: the
   * `.exe` a `.lnk` points at. Linux: the first word of the entry's `Exec`.
   * macOS has no equivalent; the `.app` bundle path is the target.
   */
  target?: string
  /**
   * Linux: the `.desktop` entry's `Exec` as argv, with field codes stripped —
   * the fallback `launchLinuxApp` spawns when glib's `gio` isn't installed.
   */
  exec?: string[]
  /** Linux: the entry's `Terminal=true`, meaning it must run inside a terminal emulator. */
  terminal?: boolean
  /**
   * Other names the app goes by, fuzzy-matched. macOS: the bundle's file
   * name, when its display name differs. Linux: its `GenericName`, executable
   * and reverse-DNS id stem (Files → "File Manager", "nautilus").
   */
  altNames?: string[]
  /** Linux: the entry's `Keywords`, lowercased single words — see `searchWords` on `Action`. */
  searchWords?: string[]
}

export interface PackagedAppResult {
  kind: 'packaged'
  appId: string
  title: string
  icon?: string
}

export type { GameAppResult }

export interface AppsWorkerResult {
  shortcuts: ShortcutAppResult[]
  packaged: PackagedAppResult[]
  /** Launcher-library games with no shortcut of their own — see game-libraries.ts. */
  games: GameAppResult[]
}

async function collectShortcuts(dir: string, depth = 0, results: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH) return results

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectShortcuts(fullPath, depth + 1, results)
    } else if (entry.isFile() && SHORTCUT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath)
    }
  }

  return results
}

/** `.lnk` target/icon paths can carry unexpanded env vars (e.g. `%windir%\...`). */
function expandEnvironmentVariables(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
}

function toDataUrl(png: Buffer | null): string | undefined {
  return png ? `data:image/png;base64,${png.toString('base64')}` : undefined
}

/**
 * Resolves a `.lnk` shortcut's target executable and icon in one pass (the icon
 * walks the same fallback chain the old PowerShell script used: the shortcut's
 * declared icon location first, then its target executable, then the `.lnk` file
 * itself). `target` is returned only when the shortcut points at an `.exe`, so
 * the launcher can hand it a path/URL argument for "Open With".
 */
function resolveShortcutAssets(shortcutPath: string): { icon?: string; target?: string } {
  try {
    const info = resolveShortcut(shortcutPath)
    const target = info?.targetPath ? expandEnvironmentVariables(info.targetPath) : ''
    const declaredIcon = info?.iconPath ? expandEnvironmentVariables(info.iconPath) : ''
    const iconPath = declaredIcon || target || shortcutPath
    const iconIndex = info?.iconIndex ?? 0

    // Key the cache on whichever candidate the fallback chain below tries first and
    // can actually stat. The extracted PNG is stored under that key regardless of
    // which candidate produced it — the declared icon file changing is a good enough
    // proxy for "this app was updated", and a stat failure disables caching here.
    const key =
      iconCache.fileKey(iconPath, iconIndex) ??
      (target ? iconCache.fileKey(target, 0) : null) ??
      iconCache.fileKey(shortcutPath, 0)

    const exeTarget = /\.exe$/i.test(target) ? target : undefined

    const cached = iconCache.read(key)
    if (cached) return { icon: toDataUrl(cached), target: exeTarget }

    let png = extractIconPng(iconPath, iconIndex)
    if (!png && target && target !== iconPath) png = extractIconPng(target, 0)
    if (!png) png = extractIconPng(shortcutPath, 0)

    if (png) iconCache.write(key, png)
    return { icon: toDataUrl(png), target: exeTarget }
  } catch (error) {
    console.error(`[apps-worker] Failed to resolve shortcut ${shortcutPath}:`, error)
    return {}
  }
}

interface InternetShortcut {
  url: string
  iconFile?: string
  iconIndex: number
}

/** Reads the `[InternetShortcut]` section of a `.url` file (an INI file, ANSI/UTF-8 or UTF-16). */
function readInternetShortcut(shortcutPath: string): InternetShortcut | null {
  let text: string
  try {
    const raw = readFileSync(shortcutPath)
    text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')
  } catch {
    return null
  }

  const values = new Map<string, string>()
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inSection = trimmed.toLowerCase() === '[internetshortcut]'
      continue
    }
    const eq = trimmed.indexOf('=')
    if (inSection && eq > 0) values.set(trimmed.slice(0, eq).toLowerCase(), trimmed.slice(eq + 1).trim())
  }

  const url = values.get('url')
  if (!url) return null
  return {
    url,
    iconFile: values.get('iconfile') || undefined,
    iconIndex: Number.parseInt(values.get('iconindex') ?? '0', 10) || 0
  }
}

/** True for a `.url` that launches an app (see `WEB_URL_SCHEMES`), false for a web link. */
function isAppUrlShortcut(shortcutPath: string): boolean {
  const scheme = readInternetShortcut(shortcutPath)?.url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]
  return Boolean(scheme) && !WEB_URL_SCHEMES.has(scheme!.toLowerCase())
}

/**
 * The `.url` counterpart of `resolveShortcutAssets`: the icon comes from the
 * shortcut's `IconFile` (game launchers point it at an `.ico` they cache per game).
 * There's no `target` — the shortcut opens a protocol URL, not an executable.
 */
function resolveUrlShortcutAssets(shortcutPath: string): { icon?: string; target?: undefined } {
  try {
    const info = readInternetShortcut(shortcutPath)
    const iconFile = info?.iconFile ? expandEnvironmentVariables(info.iconFile) : ''
    if (!iconFile) return {}
    const iconIndex = info?.iconIndex ?? 0

    const key = iconCache.fileKey(iconFile, iconIndex)
    const cached = iconCache.read(key)
    if (cached) return { icon: toDataUrl(cached) }

    const png = extractIconPng(iconFile, iconIndex)
    if (png) iconCache.write(key, png)
    return { icon: toDataUrl(png) }
  } catch (error) {
    console.error(`[apps-worker] Failed to resolve shortcut ${shortcutPath}:`, error)
    return {}
  }
}

function resolvePackagedIcon(appId: string): string | undefined {
  try {
    const key = iconCache.packagedKey(appId)
    const cached = iconCache.read(key, iconCache.PACKAGED_TTL_MS)
    if (cached) return toDataUrl(cached)

    const png = extractPackagedIconPng(appId, PACKAGED_ICON_SIZE)
    if (png) iconCache.write(key, png)
    return toDataUrl(png)
  } catch (error) {
    console.error(`[apps-worker] Failed to resolve icon for ${appId}:`, error)
    return undefined
  }
}

function isUrlShortcut(shortcutPath: string): boolean {
  return extname(shortcutPath).toLowerCase() === '.url'
}

async function main(): Promise<void> {
  const shortcutLists = await Promise.all(START_MENU_DIRS.map((dir) => collectShortcuts(dir)))
  const shortcutPaths = shortcutLists.flat()

  const seenNames = new Set<string>()
  const uniqueShortcutPaths = shortcutPaths.filter((shortcutPath) => {
    const name = basename(shortcutPath, extname(shortcutPath)).toLowerCase()
    if (SKIP_NAME_PATTERN.test(name) || seenNames.has(name)) return false
    if (isUrlShortcut(shortcutPath) && !isAppUrlShortcut(shortcutPath)) return false
    seenNames.add(name)
    return true
  })

  const shortcuts: ShortcutAppResult[] = uniqueShortcutPaths.map((shortcutPath) => {
    const { icon, target } = isUrlShortcut(shortcutPath)
      ? resolveUrlShortcutAssets(shortcutPath)
      : resolveShortcutAssets(shortcutPath)
    return {
      kind: 'shortcut',
      path: shortcutPath,
      title: basename(shortcutPath, extname(shortcutPath)),
      ...(icon ? { icon } : {}),
      ...(target ? { target } : {})
    }
  })

  let startApps: { name: string; appId: string }[] = []
  try {
    startApps = listStartApps()
  } catch (error) {
    console.error('[apps-worker] Failed to list packaged applications:', error)
  }

  const packaged: PackagedAppResult[] = []
  for (const app of startApps) {
    const title = app.name?.trim()
    if (!title) continue

    const nameKey = title.toLowerCase()
    if (SKIP_NAME_PATTERN.test(nameKey) || seenNames.has(nameKey)) continue
    seenNames.add(nameKey)

    packaged.push({ kind: 'packaged', appId: app.appId, title, icon: resolvePackagedIcon(app.appId) })
  }

  // Drop cache entries for apps that are no longer installed. Guarded on a non-empty
  // run so a transient failure to enumerate either source doesn't wipe the cache.
  if (shortcuts.length > 0 || packaged.length > 0) iconCache.prune()

  const games = await listLauncherGames([...shortcuts, ...packaged].map((entry) => entry.title))

  const result: AppsWorkerResult = { shortcuts, packaged, games }
  process.stdout.write(JSON.stringify(result))
}

main().catch((error) => {
  console.error('[apps-worker] Fatal error:', error)
  process.exitCode = 1
})
