import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  isInstalledSteamGame,
  listLauncherGames,
  parseAppManifest,
  parseLibraryFolders,
  titleKey
} from './game-libraries.ts'

function manifest(appId: string, name: string, stateFlags = 4): string {
  return `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${stateFlags}"\n}\n`
}

/**
 * Builds a fake Steam install under a temp `$HOME`, in the layout this
 * platform's Steam uses, with a second library folder elsewhere. `os.homedir()`
 * reads `$HOME` on macOS and Linux, so the real lookup code runs unmodified.
 */
describe('listLauncherGames', { skip: process.platform === 'win32' }, () => {
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  let home: string

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'benlaunch-steam-'))
    process.env.HOME = home
    delete process.env.XDG_DATA_HOME

    const root =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Steam')
        : join(home, '.local', 'share', 'Steam')
    const secondLibrary = join(home, 'Games', 'SteamLibrary')

    await mkdir(join(root, 'steamapps'), { recursive: true })
    await mkdir(join(secondLibrary, 'steamapps'), { recursive: true })
    await writeFile(
      join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${secondLibrary}"\n\t}\n}\n`
    )
    await writeFile(join(root, 'steamapps', 'appmanifest_570.acf'), manifest('570', 'Dota 2'))
    await writeFile(
      join(root, 'steamapps', 'appmanifest_1493710.acf'),
      manifest('1493710', 'Proton Experimental')
    )
    await writeFile(
      join(secondLibrary, 'steamapps', 'appmanifest_4508340.acf'),
      manifest('4508340', 'NTE: Neverness to Everness')
    )
    await writeFile(
      join(secondLibrary, 'steamapps', 'appmanifest_1326470.acf'),
      manifest('1326470', 'Sons Of The Forest')
    )
    await writeFile(
      join(secondLibrary, 'steamapps', 'appmanifest_99.acf'),
      manifest('99', 'Still Downloading', 1026)
    )

    const iconDir = join(root, 'appcache', 'librarycache', '570')
    await mkdir(iconDir, { recursive: true })
    await writeFile(join(iconDir, `${'a'.repeat(40)}.jpg`), Buffer.from([0xff, 0xd8, 0xff]))
    await writeFile(join(iconDir, 'header.jpg'), Buffer.from([0]))
  })

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  })

  it('lists installed games from every library, skipping tools and known titles', async () => {
    const games = await listLauncherGames(['NTE Neverness to Everness'])
    const byTitle = new Map(games.map((game) => [game.title, game]))

    assert.deepEqual([...byTitle.keys()].sort(), ['Dota 2', 'Sons Of The Forest'])

    const dota = byTitle.get('Dota 2')
    assert.equal(dota?.url, 'steam://rungameid/570')
    assert.equal(dota?.launcher, 'steam')
    assert.equal(dota?.gameId, '570')
    assert.equal(dota?.icon, `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`)
    assert.equal(byTitle.get('Sons Of The Forest')?.icon, undefined)
  })
})

describe('parseLibraryFolders', () => {
  it('reads every library path, unescaping Windows backslashes', () => {
    const vdf = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"190826351"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"/home/me/Games/SteamLibrary"
\t}
}`
    assert.deepEqual(parseLibraryFolders(vdf), [
      'C:\\Program Files (x86)\\Steam',
      '/home/me/Games/SteamLibrary'
    ])
  })

  it('returns nothing for a file with no paths', () => {
    assert.deepEqual(parseLibraryFolders('"libraryfolders"\n{\n}'), [])
  })
})

describe('parseAppManifest', () => {
  const acf = `"AppState"
{
\t"appid"\t\t"4508340"
\t"universe"\t\t"1"
\t"name"\t\t"NTE: Neverness to Everness"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"NTE"
\t"UserConfig"
\t{
\t\t"name"\t\t"ignored nested name"
\t}
}`

  it('reads the id, top-level name and state', () => {
    assert.deepEqual(parseAppManifest(acf), {
      appId: '4508340',
      name: 'NTE: Neverness to Everness',
      stateFlags: 4
    })
  })

  it('unescapes quotes in names', () => {
    const manifest = parseAppManifest('"appid" "1"\n"name" "The \\"Game\\""\n"StateFlags" "4"')
    assert.equal(manifest?.name, 'The "Game"')
  })

  it('rejects a manifest without an id or name', () => {
    assert.equal(parseAppManifest('"name" "No id"'), null)
    assert.equal(parseAppManifest('"appid" "1"'), null)
  })
})

describe('isInstalledSteamGame', () => {
  const game = { appId: '570', name: 'Dota 2', stateFlags: 4 }

  it('accepts installed games, including ones with an update pending', () => {
    assert.equal(isInstalledSteamGame(game), true)
    assert.equal(isInstalledSteamGame({ ...game, stateFlags: 6 }), true)
    assert.equal(isInstalledSteamGame({ ...game, stateFlags: 1542 }), true)
  })

  it('rejects downloads that never finished', () => {
    assert.equal(isInstalledSteamGame({ ...game, stateFlags: 1026 }), false)
  })

  it('rejects redistributables and Linux compatibility tools', () => {
    assert.equal(
      isInstalledSteamGame({ appId: '228980', name: 'Steamworks Common Redistributables', stateFlags: 4 }),
      false
    )
    assert.equal(isInstalledSteamGame({ appId: '1493710', name: 'Proton Experimental', stateFlags: 4 }), false)
    assert.equal(
      isInstalledSteamGame({ appId: '1628350', name: 'Steam Linux Runtime 3.0 (sniper)', stateFlags: 4 }),
      false
    )
  })
})

describe('titleKey', () => {
  it('matches a shortcut name that lost punctuation the filesystem forbids', () => {
    assert.equal(titleKey('NTE: Neverness to Everness'), titleKey('NTE Neverness to Everness'))
  })

  it('keeps non-Latin titles', () => {
    assert.equal(titleKey('原神'), '原神')
  })
})
