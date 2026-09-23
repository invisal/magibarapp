/**
 * Integration cover for the Linux app scanner.
 *
 * `listLinuxApplications` reads its search paths from `$XDG_DATA_HOME` /
 * `$XDG_DATA_DIRS` and touches nothing but the filesystem, so pointing those at
 * a fixture tree exercises the real walk, precedence, filtering and icon lookup
 * on any platform — which is the point, since this code ships to a platform its
 * authors mostly aren't running.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { listLinuxApplications } from './apps-linux.ts'
import type { ShortcutAppResult } from './apps-worker.ts'

let root: string
let home: string
let system: string
const saved = { ...process.env }

/** Writes a `.desktop` file, creating its directory. */
async function desktop(
  dir: string,
  name: string,
  lines: string[]
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), `[Desktop Entry]\n${lines.join('\n')}\n`)
}

/** Writes an icon whose contents are just a marker, so tests can identify it. */
async function icon(path: string, marker: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, marker)
}

/** Decodes the marker back out of a data URL. */
function markerOf(dataUrl: string | undefined): string | undefined {
  const base64 = dataUrl?.split(',')[1]
  return base64 ? Buffer.from(base64, 'base64').toString('utf8') : undefined
}

const find = (
  apps: ShortcutAppResult[],
  title: string
): ShortcutAppResult | undefined => apps.find((app) => app.title === title)

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'magibar-linux-'))
  home = join(root, 'home')
  system = join(root, 'system')

  const userApps = join(home, 'applications')
  const systemApps = join(system, 'applications')

  await desktop(systemApps, 'firefox.desktop', [
    'Type=Application',
    'Name=Firefox',
    'Exec=firefox %u',
    'Icon=firefox'
  ])
  // Same desktop file ID as the system copy — the user's must win.
  await desktop(systemApps, 'editor.desktop', [
    'Type=Application',
    'Name=System Editor',
    'Exec=/usr/bin/sysedit'
  ])
  await desktop(userApps, 'editor.desktop', [
    'Type=Application',
    'Name=My Editor',
    // A path with a space must be quoted, per the spec.
    'Exec="/opt/my editor/bin" --flag'
  ])
  // Excluded, each for a different reason.
  await desktop(systemApps, 'hidden.desktop', [
    'Type=Application',
    'Name=Tombstoned',
    'Exec=x',
    'Hidden=true'
  ])
  await desktop(systemApps, 'nodisplay.desktop', [
    'Type=Application',
    'Name=Url Handler',
    'Exec=x',
    'NoDisplay=true'
  ])
  await desktop(systemApps, 'link.desktop', [
    'Type=Link',
    'Name=A Bookmark',
    'URL=https://example.com'
  ])
  await desktop(systemApps, 'uninstalled.desktop', [
    'Type=Application',
    'Name=Uninstalled',
    'Exec=ghost',
    'TryExec=/nonexistent/ghost'
  ])
  await desktop(systemApps, 'present.desktop', [
    'Type=Application',
    'Name=Present',
    'Exec=sh',
    'TryExec=/bin/sh'
  ])
  // A terminal app, and one in a subdirectory (desktop file ID gets a dash).
  await desktop(systemApps, 'htop.desktop', [
    'Type=Application',
    'Name=Htop',
    'Exec=htop',
    'Terminal=true'
  ])
  await desktop(join(systemApps, 'kde4'), 'konsole.desktop', [
    'Type=Application',
    'Name=Konsole',
    'Exec=konsole'
  ])
  // Localized name.
  await desktop(systemApps, 'files.desktop', [
    'Type=Application',
    'Name=Files',
    'Name[de]=Dateien',
    'Exec=nautilus'
  ])
  // Icon given as an absolute path rather than a theme name.
  await desktop(systemApps, 'abs.desktop', [
    'Type=Application',
    'Name=Absolute',
    'Exec=abs',
    `Icon=${join(system, 'custom.png')}`
  ])
  await icon(join(system, 'custom.png'), 'ABSOLUTE')

  // hicolor holds firefox at two sizes; 64x64 is preferred over 48x48.
  await icon(join(system, 'icons/hicolor/48x48/apps/firefox.png'), 'SMALL')
  await icon(join(system, 'icons/hicolor/64x64/apps/firefox.png'), 'BEST')

  process.env.XDG_DATA_HOME = home
  process.env.XDG_DATA_DIRS = system
  process.env.XDG_CURRENT_DESKTOP = 'GNOME'
  delete process.env.LC_ALL
  delete process.env.LC_MESSAGES
  process.env.LANG = 'en_US.UTF-8'
})

after(async () => {
  process.env = { ...saved }
  await rm(root, { recursive: true, force: true })
})

describe('listLinuxApplications', () => {
  it('finds applications and reports them sorted by title', async () => {
    const { shortcuts, packaged } = await listLinuxApplications()
    const titles = shortcuts.map((app) => app.title)

    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)))
    assert.ok(titles.includes('Firefox'))
    // Linux has no packaged-app analogue.
    assert.deepEqual(packaged, [])
  })

  it('parses Exec into argv with field codes stripped', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.deepEqual(find(shortcuts, 'Firefox')?.exec, ['firefox'])
    // Quoted path with a space survives as one argument.
    assert.deepEqual(find(shortcuts, 'My Editor')?.exec, [
      '/opt/my editor/bin',
      '--flag'
    ])
  })

  it('exposes the executable as `target` for Open With', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(find(shortcuts, 'Firefox')?.target, 'firefox')
  })

  it('carries the Terminal flag through', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(find(shortcuts, 'Htop')?.terminal, true)
    assert.equal(find(shortcuts, 'Firefox')?.terminal, false)
  })

  it('lets a user entry shadow the system one with the same ID', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.ok(find(shortcuts, 'My Editor'))
    assert.equal(find(shortcuts, 'System Editor'), undefined)
  })

  it('excludes Hidden, NoDisplay and non-Application entries', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(find(shortcuts, 'Tombstoned'), undefined)
    assert.equal(find(shortcuts, 'Url Handler'), undefined)
    assert.equal(find(shortcuts, 'A Bookmark'), undefined)
  })

  it('drops an entry whose TryExec is missing, keeping one that resolves', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(find(shortcuts, 'Uninstalled'), undefined)
    assert.ok(find(shortcuts, 'Present'))
  })

  it('walks subdirectories', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.ok(find(shortcuts, 'Konsole'))
  })

  it('resolves a themed icon, preferring the size closest to 64px', async () => {
    const { shortcuts } = await listLinuxApplications()
    const firefox = find(shortcuts, 'Firefox')
    assert.equal(markerOf(firefox?.icon), 'BEST')
    assert.ok(firefox?.icon?.startsWith('data:image/png;base64,'))
  })

  it('resolves an icon given as an absolute path', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(markerOf(find(shortcuts, 'Absolute')?.icon), 'ABSOLUTE')
  })

  it('leaves the icon undefined when nothing matches', async () => {
    const { shortcuts } = await listLinuxApplications()
    assert.equal(find(shortcuts, 'Konsole')?.icon, undefined)
  })

  it('honours the locale for localized names', async () => {
    process.env.LANG = 'de_DE.UTF-8'
    try {
      const { shortcuts } = await listLinuxApplications()
      assert.ok(find(shortcuts, 'Dateien'))
      assert.equal(find(shortcuts, 'Files'), undefined)
    } finally {
      process.env.LANG = 'en_US.UTF-8'
    }
  })

  it('honours OnlyShowIn against the current desktop', async () => {
    await desktop(join(system, 'applications'), 'kdeonly.desktop', [
      'Type=Application',
      'Name=Kde Only',
      'Exec=kthing',
      'OnlyShowIn=KDE'
    ])
    const gnome = await listLinuxApplications()
    assert.equal(find(gnome.shortcuts, 'Kde Only'), undefined)

    process.env.XDG_CURRENT_DESKTOP = 'KDE'
    try {
      const kde = await listLinuxApplications()
      assert.ok(find(kde.shortcuts, 'Kde Only'))
    } finally {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
    }
  })
})
