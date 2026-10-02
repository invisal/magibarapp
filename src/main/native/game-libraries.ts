/**
 * Games installed through a game launcher's own library, for every platform.
 *
 * The per-platform app scanners only see what the launcher chose to export as a
 * regular app entry: a Start Menu shortcut on Windows, a `.desktop` file on
 * Linux. That misses a lot. Steam on macOS installs games as `.app` bundles
 * deep under `~/Library/Application Support/Steam`, outside every app folder
 * the macOS scanner trusts. Flatpak Steam writes its `.desktop` files inside
 * its own sandbox. And on every OS, a game installed with "create shortcut"
 * unticked, or in a second library folder, has no app entry at all.
 *
 * The launcher's own manifests are the reliable source, so this reads them
 * directly and launches each game through the launcher's URL scheme
 * (`steam://rungameid/<id>`), which works the same on every platform.
 *
 * Pure Node, with no Electron imports: the Windows apps worker
 * (apps-worker.ts) imports it as well as the main-process scanners.
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GameAppResult {
  kind: 'game'
  /** Which launcher owns the game, e.g. `steam`. */
  launcher: string
  /** The launcher's id for the game, unique within `launcher`. */
  gameId: string
  title: string
  /** The URL that launches the game through its launcher. */
  url: string
  icon?: string
}

/** Steam's "fully installed" bit in an app manifest's `StateFlags`. Updating games keep it. */
const STEAM_STATE_INSTALLED = 4

/** Steam manifests for tools, not games: shared redistributables and the Linux compat layers. */
const STEAM_NON_GAME_IDS = new Set(['228980'])
const STEAM_NON_GAME_NAME = /^(proton\b|steam linux runtime|steamworks common)/i

/** Steam's small client icons are ~32px JPEGs; anything bigger is not the icon. */
const MAX_ICON_BYTES = 256 * 1024

/**
 * Normalizes a title for duplicate detection. Shortcut filenames can't contain
 * `:` and similar characters, so the Start Menu's "NTE Neverness to Everness"
 * has to match Steam's "NTE: Neverness to Everness".
 */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Unescapes a Valve KeyValues quoted string (`\\` and `\"`). */
function unescapeVdf(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

/** Every `"path"` value in a `libraryfolders.vdf`: the Steam library folders. */
export function parseLibraryFolders(content: string): string[] {
  const paths: string[] = []
  for (const match of content.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    paths.push(unescapeVdf(match[1]))
  }
  return paths
}

export interface SteamManifest {
  appId: string
  name: string
  stateFlags: number
}

/** The fields this module needs from an `appmanifest_<id>.acf`, or `null` if it lacks them. */
export function parseAppManifest(content: string): SteamManifest | null {
  const field = (key: string): string | undefined => {
    const match = content.match(new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'i'))
    return match ? unescapeVdf(match[1]) : undefined
  }
  const appId = field('appid')
  const name = field('name')?.trim()
  if (!appId || !name) return null
  return { appId, name, stateFlags: Number.parseInt(field('StateFlags') ?? '0', 10) || 0 }
}

/** Whether a manifest is an installed game, not a tool or a half-finished download. */
export function isInstalledSteamGame(manifest: SteamManifest): boolean {
  return (
    (manifest.stateFlags & STEAM_STATE_INSTALLED) !== 0 &&
    !STEAM_NON_GAME_IDS.has(manifest.appId) &&
    !STEAM_NON_GAME_NAME.test(manifest.name)
  )
}

/** Windows: Steam records its install folder in the registry; the default is the fallback. */
async function windowsSteamRoot(): Promise<string[]> {
  const roots: string[] = []
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true }
    )
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/)
    if (match) roots.push(match[1].trim())
  } catch {
    /* Steam not installed, or the key is missing — try the default location */
  }
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
  if (programFiles) roots.push(join(programFiles, 'Steam'))
  return roots
}

/** Where a Steam installation may live on this platform. Missing ones are skipped later. */
async function steamRootCandidates(): Promise<string[]> {
  const home = homedir()
  switch (process.platform) {
    case 'win32':
      return windowsSteamRoot()
    case 'darwin':
      return [join(home, 'Library', 'Application Support', 'Steam')]
    case 'linux': {
      const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
      return [
        join(home, '.steam', 'steam'),
        join(dataHome, 'Steam'),
        join(home, '.steam', 'debian-installation'),
        join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
        join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
      ]
    }
    default:
      return []
  }
}

/** `paths` with missing entries dropped and symlinked duplicates (`~/.steam/steam`) merged. */
async function existingUnique(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((path) => realpath(path).catch(() => null)))
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of resolved) {
    if (!path) continue
    // Windows paths are case-insensitive; the registry stores Steam's in lowercase.
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    result.push(path)
  }
  return result
}

/** The game's small client icon from Steam's library cache, as a data URL. */
async function steamIcon(steamRoot: string, appId: string): Promise<string | undefined> {
  const cache = join(steamRoot, 'appcache', 'librarycache')
  const candidates: string[] = []
  // Current layout: `librarycache/<appid>/<sha1>.jpg` is the client icon; the
  // other files there are named artwork (`header.jpg`, `logo.png`) or folders.
  try {
    const entries = await readdir(join(cache, appId), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /^[0-9a-f]{40}\.jpg$/i.test(entry.name)) {
        candidates.push(join(cache, appId, entry.name))
      }
    }
  } catch {
    /* not cached in the current layout */
  }
  // Older Steam clients kept flat `librarycache/<appid>_icon.jpg` files.
  candidates.push(join(cache, `${appId}_icon.jpg`))

  for (const path of candidates) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_ICON_BYTES) continue
      const data = await readFile(path)
      return `data:image/jpeg;base64,${data.toString('base64')}`
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

async function listSteamGames(): Promise<GameAppResult[]> {
  const roots = await existingUnique(await steamRootCandidates())
  const games = new Map<string, GameAppResult>()

  for (const root of roots) {
    // Newer clients keep the library list under `steamapps/`, older ones under `config/`.
    let libraries = [root]
    for (const file of [
      join(root, 'steamapps', 'libraryfolders.vdf'),
      join(root, 'config', 'libraryfolders.vdf')
    ]) {
      try {
        libraries.push(...parseLibraryFolders(await readFile(file, 'utf8')))
      } catch {
        /* missing — the root itself is still a library */
      }
    }
    libraries = await existingUnique(libraries)

    for (const library of libraries) {
      const steamapps = join(library, 'steamapps')
      let files: string[]
      try {
        files = await readdir(steamapps)
      } catch {
        continue
      }

      for (const file of files) {
        if (!/^appmanifest_\d+\.acf$/i.test(file)) continue
        let manifest: SteamManifest | null
        try {
          manifest = parseAppManifest(await readFile(join(steamapps, file), 'utf8'))
        } catch {
          continue
        }
        if (!manifest || !isInstalledSteamGame(manifest) || games.has(manifest.appId)) continue

        games.set(manifest.appId, {
          kind: 'game',
          launcher: 'steam',
          gameId: manifest.appId,
          title: manifest.name,
          url: `steam://rungameid/${manifest.appId}`,
          icon: await steamIcon(root, manifest.appId)
        })
      }
    }
  }

  return [...games.values()]
}

/**
 * Installed launcher games whose titles aren't already among `knownTitles` (the
 * platform scanner's own entries), so a game that also has a shortcut or
 * `.desktop` file is listed once, under the platform's entry. Never throws: a
 * launcher that can't be read just contributes nothing.
 */
export async function listLauncherGames(knownTitles: Iterable<string>): Promise<GameAppResult[]> {
  const known = new Set<string>()
  for (const title of knownTitles) known.add(titleKey(title))

  let games: GameAppResult[]
  try {
    games = await listSteamGames()
  } catch (error) {
    console.error('[game-libraries] Failed to read the Steam library:', error)
    return []
  }

  return games.filter((game) => {
    const key = titleKey(game.title)
    if (!key || known.has(key)) return false
    known.add(key)
    return true
  })
}
