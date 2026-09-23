import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  desktopFileId,
  isLaunchable,
  localeCandidates,
  parseDesktopEntry,
  parseExecCommand,
  type DesktopEntry
} from './desktop-entry.ts'

/** A minimal valid entry, for tests that only care about one field. */
function entry(overrides: Partial<DesktopEntry> = {}): DesktopEntry {
  return {
    type: 'Application',
    name: 'Example',
    exec: 'example',
    icon: undefined,
    noDisplay: false,
    hidden: false,
    terminal: false,
    tryExec: undefined,
    keywords: [],
    categories: [],
    onlyShowIn: [],
    notShowIn: [],
    ...overrides
  }
}

describe('parseDesktopEntry', () => {
  it('reads the standard fields', () => {
    const parsed = parseDesktopEntry(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Firefox',
        'Exec=firefox %u',
        'Icon=firefox',
        'Terminal=false'
      ].join('\n')
    )
    assert.equal(parsed?.type, 'Application')
    assert.equal(parsed?.name, 'Firefox')
    assert.equal(parsed?.exec, 'firefox %u')
    assert.equal(parsed?.icon, 'firefox')
    assert.equal(parsed?.terminal, false)
  })

  it('returns null without a [Desktop Entry] group', () => {
    assert.equal(parseDesktopEntry('[Desktop Action New]\nName=New'), null)
    assert.equal(parseDesktopEntry(''), null)
  })

  it('ignores keys in later groups', () => {
    const parsed = parseDesktopEntry(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Terminal',
        'Exec=xterm',
        '',
        '[Desktop Action new-window]',
        'Name=New Window',
        'Exec=xterm --new'
      ].join('\n')
    )
    // The action's Name/Exec must not leak into the entry.
    assert.equal(parsed?.name, 'Terminal')
    assert.equal(parsed?.exec, 'xterm')
  })

  it('skips comments and blank lines', () => {
    const parsed = parseDesktopEntry(
      ['# a comment', '', '[Desktop Entry]', '# another', 'Type=Application', 'Name=Ok', 'Exec=ok'].join(
        '\n'
      )
    )
    assert.equal(parsed?.name, 'Ok')
  })

  it('parses booleans, including the 0/1 seen in the wild', () => {
    const read = (line: string): DesktopEntry | null =>
      parseDesktopEntry(`[Desktop Entry]\nType=Application\nName=X\nExec=x\n${line}`)
    assert.equal(read('NoDisplay=true')?.noDisplay, true)
    assert.equal(read('NoDisplay=false')?.noDisplay, false)
    assert.equal(read('NoDisplay=1')?.noDisplay, true)
    assert.equal(read('Terminal=TRUE')?.terminal, true)
    // Absent means false, never undefined.
    assert.equal(read('')?.hidden, false)
  })

  it('splits the ;-separated show-in lists', () => {
    const parsed = parseDesktopEntry(
      ['[Desktop Entry]', 'Type=Application', 'Name=X', 'Exec=x', 'OnlyShowIn=GNOME;KDE;'].join('\n')
    )
    assert.deepEqual(parsed?.onlyShowIn, ['GNOME', 'KDE'])
  })

  it('reads localized GenericName and Keywords', () => {
    const parsed = parseDesktopEntry(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Files',
        'Exec=nautilus',
        'GenericName=File Manager',
        'GenericName[fr]=Gestionnaire de fichiers',
        'Keywords=folder;manager;explore;',
        'Keywords[fr]=dossier;'
      ].join('\n'),
      'fr_FR.UTF-8'
    )
    assert.equal(parsed?.genericName, 'Gestionnaire de fichiers')
    assert.deepEqual(parsed?.keywords, ['dossier'])
    const bare = parseDesktopEntry('[Desktop Entry]\nType=Application\nName=X\nExec=x')
    assert.deepEqual(bare?.keywords, [])
    assert.equal(bare?.genericName, undefined)
  })

  it('unescapes the spec escape sequences in Name', () => {
    const parsed = parseDesktopEntry(
      ['[Desktop Entry]', 'Type=Application', 'Exec=x', 'Name=Two\\sWords'].join('\n')
    )
    assert.equal(parsed?.name, 'Two Words')
  })

  it('leaves an unknown backslash sequence alone rather than eating it', () => {
    const parsed = parseDesktopEntry(
      ['[Desktop Entry]', 'Type=Application', 'Exec=x', 'Name=C:\\Program'].join('\n')
    )
    assert.equal(parsed?.name, 'C:\\Program')
  })

  describe('localized names', () => {
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      'Exec=x',
      'Name=Files',
      'Name[de]=Dateien',
      'Name[de_CH]=Dateien CH',
      'Name[fr]=Fichiers'
    ].join('\n')

    it('prefers the most specific matching locale', () => {
      assert.equal(parseDesktopEntry(content, 'de_CH.UTF-8')?.name, 'Dateien CH')
    })

    it('falls back to the bare language', () => {
      assert.equal(parseDesktopEntry(content, 'de_AT.UTF-8')?.name, 'Dateien')
    })

    it('falls back to the unlocalized value', () => {
      assert.equal(parseDesktopEntry(content, 'ja_JP.UTF-8')?.name, 'Files')
      assert.equal(parseDesktopEntry(content, undefined)?.name, 'Files')
      assert.equal(parseDesktopEntry(content, 'C')?.name, 'Files')
    })
  })
})

describe('localeCandidates', () => {
  it('orders from most to least specific', () => {
    assert.deepEqual(localeCandidates('sr_RS@latin.UTF-8'), [
      'sr_RS@latin',
      'sr_RS',
      'sr@latin',
      'sr'
    ])
    assert.deepEqual(localeCandidates('pt_BR'), ['pt_BR', 'pt'])
    assert.deepEqual(localeCandidates('en'), ['en'])
  })

  it('treats the C/POSIX locales as unlocalized', () => {
    assert.deepEqual(localeCandidates('C'), [])
    assert.deepEqual(localeCandidates('POSIX'), [])
    assert.deepEqual(localeCandidates(undefined), [])
    assert.deepEqual(localeCandidates(''), [])
  })
})

describe('isLaunchable', () => {
  it('accepts an ordinary application', () => {
    assert.equal(isLaunchable(entry(), []), true)
  })

  it('rejects non-Application types', () => {
    assert.equal(isLaunchable(entry({ type: 'Link' }), []), false)
    assert.equal(isLaunchable(entry({ type: 'Directory' }), []), false)
    assert.equal(isLaunchable(entry({ type: '' }), []), false)
  })

  it('rejects Hidden and NoDisplay entries', () => {
    assert.equal(isLaunchable(entry({ hidden: true }), []), false)
    assert.equal(isLaunchable(entry({ noDisplay: true }), []), false)
  })

  it('accepts a NoDisplay GNOME Settings panel, still honouring Hidden', () => {
    const panel = { noDisplay: true, categories: ['Settings', 'X-GNOME-Settings-Panel'] }
    assert.equal(isLaunchable(entry(panel), []), true)
    assert.equal(isLaunchable(entry({ ...panel, hidden: true }), []), false)
  })

  it('rejects an entry with nothing to run or show', () => {
    assert.equal(isLaunchable(entry({ exec: undefined }), []), false)
    assert.equal(isLaunchable(entry({ name: '' }), []), false)
  })

  it('honours NotShowIn for the current desktop', () => {
    const e = entry({ notShowIn: ['GNOME'] })
    assert.equal(isLaunchable(e, ['GNOME']), false)
    assert.equal(isLaunchable(e, ['KDE']), true)
  })

  it('honours OnlyShowIn for the current desktop', () => {
    const e = entry({ onlyShowIn: ['KDE'] })
    assert.equal(isLaunchable(e, ['KDE']), true)
    assert.equal(isLaunchable(e, ['GNOME']), false)
    // No desktop reported at all — an OnlyShowIn entry stays hidden.
    assert.equal(isLaunchable(e, []), false)
  })

  it('matches desktop names case-insensitively', () => {
    assert.equal(isLaunchable(entry({ onlyShowIn: ['GNOME'] }), ['gnome']), true)
    assert.equal(isLaunchable(entry({ notShowIn: ['gnome'] }), ['GNOME']), false)
  })

  it('matches any entry of a multi-desktop XDG_CURRENT_DESKTOP', () => {
    // Ubuntu reports `ubuntu:GNOME`; an OnlyShowIn=GNOME app must still show.
    assert.equal(
      isLaunchable(entry({ onlyShowIn: ['GNOME'] }), ['ubuntu', 'GNOME']),
      true
    )
  })
})

describe('parseExecCommand', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(parseExecCommand('env FOO=bar app'), ['env', 'FOO=bar', 'app'])
  })

  it('drops field codes', () => {
    assert.deepEqual(parseExecCommand('firefox %u'), ['firefox'])
    assert.deepEqual(parseExecCommand('gimp %U %f %F'), ['gimp'])
    assert.deepEqual(parseExecCommand('app %i %c %k'), ['app'])
  })

  it('keeps arguments that merely contain a percent', () => {
    assert.deepEqual(parseExecCommand('app --fmt=%s'), ['app', '--fmt=%s'])
  })

  it('unescapes %% to a literal percent without then dropping it', () => {
    assert.deepEqual(parseExecCommand('fmt %%f'), ['fmt', '%f'])
  })

  it('honours double quotes around paths with spaces', () => {
    assert.deepEqual(parseExecCommand('"/opt/my app/bin/run" --flag'), [
      '/opt/my app/bin/run',
      '--flag'
    ])
  })

  it('unescapes the four escapable characters inside quotes', () => {
    assert.deepEqual(parseExecCommand('app "a\\"b"'), ['app', 'a"b'])
    assert.deepEqual(parseExecCommand('app "a\\\\b"'), ['app', 'a\\b'])
    assert.deepEqual(parseExecCommand('app "a\\$b"'), ['app', 'a$b'])
  })

  it('keeps an empty quoted argument', () => {
    assert.deepEqual(parseExecCommand('app "" x'), ['app', '', 'x'])
  })

  it('collapses runs of whitespace', () => {
    assert.deepEqual(parseExecCommand('  app    --flag  '), ['app', '--flag'])
  })

  it('returns null when nothing executable remains', () => {
    assert.equal(parseExecCommand(''), null)
    assert.equal(parseExecCommand(undefined), null)
    assert.equal(parseExecCommand('   '), null)
    assert.equal(parseExecCommand('%f'), null)
  })
})

describe('desktopFileId', () => {
  it('joins subdirectories with a dash, per the spec', () => {
    assert.equal(desktopFileId('kde4/konsole.desktop'), 'kde4-konsole.desktop')
    assert.equal(desktopFileId('firefox.desktop'), 'firefox.desktop')
    assert.equal(desktopFileId('a/b/c.desktop'), 'a-b-c.desktop')
  })
})
