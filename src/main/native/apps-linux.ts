/**
 * Linux equivalent of apps-mac.ts / the Windows apps worker.
 *
 * An application on Linux is a `.desktop` file somewhere under the XDG data
 * directories, and its icon is a themed name resolved against the icon-theme
 * directories. Neither needs a native module — this is all filesystem work — but
 * unlike macOS there is no Spotlight to ask, so the directories are walked
 * directly. Parsing lives in desktop-entry.ts (pure, unit-tested); this module
 * does the I/O and the icon lookup.
 *
 * Two things are handled carefully:
 *
 *  - **Precedence.** Entries are identified by desktop file ID, not by name, and
 *    the first directory to define an ID wins — that's what lets a user's
 *    `~/.local/share/applications/foo.desktop` override the system one instead
 *    of showing twice.
 *  - **Icon cost.** Icons are read straight off disk as PNG/SVG (no conversion
 *    step, unlike macOS's `.icns`), but a theme can hold the same icon at eight
 *    sizes. The theme directories are indexed *once* into a name→path map at the
 *    smallest useful size, rather than searched per app, which turns ~100 apps ×
 *    hundreds of candidate paths into a few dozen `readdir`s.
 *
 * Produces the same serializable `AppsWorkerResult` the other platforms do.
 * Linux has no `packaged` analogue, so that list is always empty.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { AppsWorkerResult, ShortcutAppResult } from './apps-worker'
import {
  desktopFileId,
  isLaunchable,
  isSettingsPanel,
  parseDesktopEntry,
  parseExecCommand,
  type DesktopEntry
} from './desktop-entry.ts'

/** How deep to recurse inside an `applications/` directory. */
const MAX_WALK_DEPTH = 5

/**
 * Largest icon file worth inlining as a data URL. The size preference below
 * normally lands on a 48–64px PNG of a few KB, but a theme that ships only a
 * huge `scalable` SVG could otherwise push megabytes into the apps cache, which
 * is re-read and re-parsed on every cold start.
 */
const MAX_ICON_BYTES = 512 * 1024

/** Icon file extensions a `<img src>` in the renderer can actually display. */
const ICON_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml']
])

/**
 * Icon-theme size directories, best first. 64px is the render size the other
 * platforms use, so it heads the list; the rest trade up or down from there,
 * with `scalable` last — an SVG always *works*, but it's the largest to inline
 * and the slowest for the renderer to rasterize.
 */
const ICON_SIZE_DIRS = [
  '64x64',
  '48x48',
  '96x96',
  '128x128',
  '32x32',
  '256x256',
  '512x512',
  'scalable'
]

/** Where application icons sit inside a theme's size directory. */
const ICON_CATEGORY_DIRS = ['apps', 'applications']

/**
 * Icon themes to index, beyond whichever one the desktop is actually using.
 * `hicolor` is the spec-mandated fallback every app installs into, so it is the
 * one that really matters; the others are the defaults of the major desktops and
 * cost nothing to miss.
 */
const FALLBACK_ICON_THEMES = ['hicolor', 'Adwaita', 'breeze', 'gnome']

/** Terminal emulators tried, in order, for a `Terminal=true` entry. */
const TERMINALS: Array<[string, string[]]> = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['alacritty', ['-e']],
  ['kitty', []],
  ['xterm', ['-e']]
]

function envList(name: string, fallback: string): string[] {
  const raw = process.env[name]?.trim()
  return (raw && raw.length > 0 ? raw : fallback)
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** `$XDG_DATA_HOME`, defaulting to `~/.local/share` per the base-directory spec. */
function dataHome(): string {
  const raw = process.env.XDG_DATA_HOME?.trim()
  return raw && isAbsolute(raw) ? raw : join(homedir(), '.local', 'share')
}

/** `$XDG_DATA_DIRS`, defaulting to `/usr/local/share:/usr/share`. */
function dataDirs(): string[] {
  return envList('XDG_DATA_DIRS', '/usr/local/share:/usr/share').filter(
    isAbsolute
  )
}

/**
 * Every directory that may hold `.desktop` files, highest precedence first.
 *
 * The Flatpak and Snap exports are normally already in `$XDG_DATA_DIRS`, but
 * only because their installers edit the profile — a Magibar started from a
 * session that never sourced it (a bare `.desktop` autostart, an AppImage run
 * from a file manager) sees a stripped environment and would silently lose every
 * Flatpak app. Listing them explicitly is the same lesson as the macOS scanner:
 * union the sources, don't make one a fallback for the other.
 */
function applicationDirs(): string[] {
  const home = homedir()
  const dirs = [
    join(dataHome(), 'applications'),
    ...dataDirs().map((dir) => join(dir, 'applications')),
    join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications'
  ]
  return [...new Set(dirs)]
}

/** Icon-theme base directories, highest precedence first. */
function iconBaseDirs(): string[] {
  const dirs = [
    join(dataHome(), 'icons'),
    join(homedir(), '.icons'),
    ...dataDirs().map((dir) => join(dir, 'icons'))
  ]
  return [...new Set(dirs)]
}

/** Flat directories of unthemed icons — the spec's last-resort location. */
function pixmapDirs(): string[] {
  return [...new Set(dataDirs().map((dir) => join(dir, 'pixmaps')))]
}

/** `$XDG_CURRENT_DESKTOP`, split — Ubuntu reports `ubuntu:GNOME`. */
function currentDesktops(): string[] {
  return (process.env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** `$LC_MESSAGES`, else `$LANG` — what localized `Name[…]` keys resolve against. */
function currentLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
}

/**
 * The desktop's configured icon theme, read from GTK's settings file. `gsettings`
 * would be more authoritative but costs a subprocess and isn't present on
 * non-GNOME systems; missing the active theme only means icons come from
 * `hicolor` instead, which every app installs into anyway.
 */
async function configuredIconTheme(): Promise<string | null> {
  const settings = join(homedir(), '.config', 'gtk-3.0', 'settings.ini')
  try {
    const content = await readFile(settings, 'utf8')
    const match = content.match(/^\s*gtk-icon-theme-name\s*=\s*(.+)$/m)
    return match?.[1].trim() || null
  } catch {
    return null
  }
}

/** Recursively lists `.desktop` files under `dir`, as paths relative to it. */
async function walkDesktopFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // A directory in the search path simply not existing is the normal case.
    return []
  }

  const found: string[] = []
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const children = await walkDesktopFiles(join(dir, entry.name), depth + 1)
        return children.map((child) => `${entry.name}/${child}`)
      }
      if (entry.name.endsWith('.desktop')) found.push(entry.name)
      return []
    })
  )
  return [...found, ...nested.flat()]
}

/** Whether `command` resolves to something executable, for `TryExec`. */
async function resolvesOnPath(command: string): Promise<boolean> {
  const isExecutable = (path: string): Promise<boolean> =>
    access(path, constants.X_OK).then(
      () => true,
      () => false
    )

  if (command.includes('/')) return isExecutable(command)
  const dirs = envList('PATH', '/usr/local/bin:/usr/bin:/bin')
  const hits = await Promise.all(dirs.map((dir) => isExecutable(join(dir, command))))
  return hits.includes(true)
}

/** One indexed icon: where it is, and how good a match the location was. */
interface IconCandidate {
  path: string
  /** Lower is better — theme rank first, then size-directory rank. */
  score: number
}

/**
 * Builds the icon-name → file map once per scan, by listing each
 * `<base>/<theme>/<size>/<category>` directory that exists. Scoring keeps the
 * best hit when several themes or sizes offer the same name.
 */
async function buildIconIndex(): Promise<Map<string, string>> {
  const configured = await configuredIconTheme()
  const themes = [
    ...new Set([...(configured ? [configured] : []), ...FALLBACK_ICON_THEMES])
  ]

  const candidates = new Map<string, IconCandidate>()
  const offer = (name: string, path: string, score: number): void => {
    const existing = candidates.get(name)
    if (!existing || score < existing.score) candidates.set(name, { path, score })
  }

  const readIcons = async (
    dir: string,
    score: number
  ): Promise<Array<[string, string, number]>> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .filter((entry) => !entry.isDirectory())
        .filter((entry) => ICON_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => [
          basename(entry.name, extname(entry.name)),
          join(dir, entry.name),
          score
        ])
    } catch {
      return []
    }
  }

  const jobs: Array<Promise<Array<[string, string, number]>>> = []

  iconBaseDirs().forEach((base, baseRank) => {
    themes.forEach((theme, themeRank) => {
      ICON_SIZE_DIRS.forEach((size, sizeRank) => {
        for (const category of ICON_CATEGORY_DIRS) {
          // Theme identity dominates, then the base directory it came from,
          // then how close the size is to what we want to render.
          const score = themeRank * 1000 + baseRank * 100 + sizeRank
          jobs.push(readIcons(join(base, theme, size, category), score))
        }
      })
    })
  })

  // Unthemed pixmaps rank below every themed hit.
  for (const dir of pixmapDirs()) jobs.push(readIcons(dir, 900_000))

  for (const batch of await Promise.all(jobs)) {
    for (const [name, path, score] of batch) offer(name, path, score)
  }

  return new Map([...candidates].map(([name, hit]) => [name, hit.path]))
}

/** Reads an icon file into a data URL, or `undefined` if unusable. */
async function iconDataUrl(path: string): Promise<string | undefined> {
  const mime = ICON_EXTENSIONS.get(extname(path).toLowerCase())
  if (!mime) return undefined
  try {
    const size = await stat(path).then(
      (s) => s.size,
      () => Infinity
    )
    if (size > MAX_ICON_BYTES) return undefined
    const data = await readFile(path)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * Resolves an entry's `Icon` value: an absolute path is used as-is, anything
 * else is a themed name looked up in the index. A bare name that happens to end
 * in `.png`/`.svg` is also tried without its extension — technically against the
 * spec, but common enough in third-party `.desktop` files to be worth handling.
 */
async function resolveIcon(
  icon: string | undefined,
  index: Map<string, string>
): Promise<string | undefined> {
  if (!icon) return undefined
  if (isAbsolute(icon)) return iconDataUrl(icon)

  const direct = index.get(icon)
  if (direct) return iconDataUrl(direct)

  const ext = extname(icon).toLowerCase()
  if (ICON_EXTENSIONS.has(ext)) {
    const stripped = index.get(basename(icon, ext))
    if (stripped) return iconDataUrl(stripped)
  }
  return undefined
}

/** The GNOME Settings app's icon, used for Settings pages without their own. */
const SETTINGS_APP_ICON = 'org.gnome.Settings'

/**
 * `Exec` programs that only launch something else — their name says nothing
 * about the app, so they're never offered as a search alias.
 */
const LAUNCHER_WRAPPERS = new Set([
  'env',
  'sh',
  'bash',
  'flatpak',
  'snap',
  'gio',
  'gtk-launch',
  'xdg-open',
  'pkexec',
  'python',
  'python3',
  'java'
])

/**
 * Search terms beyond `Name`, so an app is found by what people actually type:
 * GNOME's apps are named for their role ("Files", "Text Editor"), but are
 * searched for by program ("nautilus") or category ("file manager") — which is
 * what GNOME's own overview matches on too.
 */
function searchTerms(
  id: string,
  argv: string[],
  entry: DesktopEntry
): { altNames: string[]; searchWords: string[] } {
  const names = new Set<string>()
  if (entry.genericName) names.add(entry.genericName)

  // A Settings page runs `gnome-control-center <page>` — that's the Settings
  // app's name, not the page's, and would match every page at once.
  const program = basename(argv[0])
  if (!LAUNCHER_WRAPPERS.has(program) && !isSettingsPanel(entry)) names.add(program)

  // Reverse-DNS ids carry the real app name: `org.gnome.Nautilus.desktop`.
  const stem = id.replace(/\.desktop$/, '')
  if (stem.includes('.')) names.add(stem.slice(stem.lastIndexOf('.') + 1))

  const lowerTitle = entry.name.toLowerCase()
  const altNames = [...names].filter((name) => name && name.toLowerCase() !== lowerTitle)

  // Matched per query word, so a multi-word keyword is split up.
  const searchWords = [
    ...new Set(entry.keywords.flatMap((keyword) => keyword.toLowerCase().split(/\s+/)))
  ].filter(Boolean)

  return { altNames, searchWords }
}

export async function listLinuxApplications(): Promise<AppsWorkerResult> {
  const desktops = currentDesktops()
  const locale = currentLocale()

  // The icon index only depends on the environment, so it builds alongside the
  // desktop-file walk rather than after it.
  const [iconIndex, ...perDir] = await Promise.all([
    buildIconIndex(),
    ...applicationDirs().map(async (dir) => ({
      dir,
      files: await walkDesktopFiles(dir)
    }))
  ])

  /** Desktop file ID → the winning entry. Earlier directories take precedence. */
  const byId = new Map<
    string,
    { id: string; path: string; argv: string[]; entry: DesktopEntry }
  >()

  for (const { dir, files } of perDir) {
    for (const relative of files) {
      const id = desktopFileId(relative)
      // First directory to define an ID wins — a later one is the shadowed
      // system copy, and must not overwrite the user's override.
      if (byId.has(id)) continue

      const path = join(dir, relative)
      let entry
      try {
        entry = parseDesktopEntry(await readFile(path, 'utf8'), locale)
      } catch {
        continue
      }
      if (!entry || !isLaunchable(entry, desktops)) continue

      const argv = parseExecCommand(entry.exec)
      if (!argv) continue

      // Claim the ID even if `TryExec` later rejects it: the user's copy of an
      // entry shadows the system one whether or not it ends up launchable.
      byId.set(id, { id, path, argv, entry })
    }
  }

  const resolved = await Promise.all(
    [...byId.values()].map(async ({ id, path, argv, entry }) => {
      // `TryExec` is the spec's "is this actually installed?" check — a
      // leftover `.desktop` from an uninstalled package still parses fine.
      if (entry.tryExec && !(await resolvesOnPath(entry.tryExec))) return null

      const panel = isSettingsPanel(entry)
      // Settings pages mostly use symbolic status/device icons the app-icon
      // index doesn't cover; the Settings app's own icon is the right stand-in.
      const icon =
        (await resolveIcon(entry.icon, iconIndex)) ??
        (panel ? await resolveIcon(SETTINGS_APP_ICON, iconIndex) : undefined)

      const shortcut: ShortcutAppResult = {
        kind: 'shortcut',
        path,
        title: entry.name,
        subtitle: panel ? 'Settings' : undefined,
        icon,
        target: argv[0],
        exec: argv,
        terminal: entry.terminal,
        ...searchTerms(id, argv, entry)
      }
      return shortcut
    })
  )

  const shortcuts = resolved
    .filter((item): item is ShortcutAppResult => item !== null)
    .sort((a, b) => a.title.localeCompare(b.title))

  return { shortcuts, packaged: [] }
}

/** Spawns a detached child, resolving once it is actually running. */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('spawn', () => {
      // Let the launcher exit without keeping the app as a child.
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

/** Wraps `argv` in the first terminal emulator that starts. */
async function spawnInTerminal(argv: string[]): Promise<void> {
  for (const [terminal, flags] of TERMINALS) {
    try {
      await spawnDetached(terminal, [...flags, ...argv])
      return
    } catch {
      // Not installed — try the next one.
    }
  }
  throw new Error('no terminal emulator found')
}

/**
 * Launches an app from the list. `gio launch` is preferred because it is the
 * desktop's own launcher: it re-reads the `.desktop` file and handles the parts
 * deliberately skipped here — D-Bus activation, startup notification, the
 * systemd scope apps are supposed to run in. The parsed `Exec` is the fallback
 * for systems without glib's tools.
 *
 * `shell.openPath` is *not* usable here: pointed at a `.desktop` file it asks
 * the desktop to open that file, which usually means a text editor.
 */
export async function launchLinuxApp(app: ShortcutAppResult): Promise<void> {
  try {
    await spawnDetached('gio', ['launch', app.path])
    return
  } catch {
    // glib tools not installed — fall through to the parsed Exec.
  }

  const argv = app.exec
  if (!argv || argv.length === 0) {
    console.error(`[apps-linux] No Exec to launch for ${app.path}`)
    return
  }

  try {
    if (app.terminal) await spawnInTerminal(argv)
    else await spawnDetached(argv[0], argv.slice(1))
  } catch (error) {
    console.error(`[apps-linux] Failed to launch ${app.path}:`, error)
  }
}
