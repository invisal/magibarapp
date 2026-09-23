/**
 * Parsing for freedesktop.org desktop entries (`.desktop` files) — the Linux
 * equivalent of a Start-Menu shortcut or a `.app` bundle.
 *
 * Deliberately pure: no `node:fs`, no Electron, no I/O of any kind. Walking the
 * XDG directories and resolving icons is apps-linux.ts's job; everything here is
 * string in, structure out, so the `node --test` suite can cover the fiddly
 * parts (locale fallback, `Exec` field codes, quoting) directly — which matters
 * more than usual, since the people writing this code are rarely running Linux.
 *
 * Follows the Desktop Entry Specification 1.5. Only what a launcher actually
 * needs is modelled: the `[Desktop Entry]` group of `Type=Application` entries.
 * Actions, MIME associations and D-Bus activation are ignored.
 */

/** The `[Desktop Entry]` fields a launcher cares about. */
export interface DesktopEntry {
  /** `Type` — only `Application` is launchable; `Link` and `Directory` are not. */
  type: string
  /** Localized `Name`, falling back to the unlocalized one. */
  name: string
  /** Localized `GenericName` — e.g. "Web Browser" for Firefox. */
  genericName?: string
  /** Localized `Keywords` — extra search terms the entry asks to be found by. */
  keywords: string[]
  /** `Categories` — the menu categories the entry belongs to. */
  categories: string[]
  /** Raw `Exec` value, field codes and all — pass to `parseExecCommand`. */
  exec?: string
  /** `Icon`: either an absolute path or a themed icon name to look up. */
  icon?: string
  /** `NoDisplay=true` — installed, but deliberately not shown in menus. */
  noDisplay: boolean
  /** `Hidden=true` — the spec's "deleted by the user" tombstone. */
  hidden: boolean
  /** `Terminal=true` — must be spawned inside a terminal emulator. */
  terminal: boolean
  /** `TryExec`: if set and not resolvable on `PATH`, the entry should be hidden. */
  tryExec?: string
  /** `OnlyShowIn`: show *only* in these desktop environments. */
  onlyShowIn: string[]
  /** `NotShowIn`: hide in these desktop environments. */
  notShowIn: string[]
}

/**
 * Field codes the spec defines for `Exec`. All are dropped: they expand to the
 * files/URLs being opened, and a launcher starting an app with no arguments has
 * nothing to put in them. `%i` officially expands to `--icon <Icon>`, but
 * dropping it only costs a window icon, so it's treated the same way.
 *
 * `%%` is a literal `%` and is handled before this ever applies.
 */
const FIELD_CODE = /^%[fFuUdDnNickvm]$/

/**
 * Keys whose value is a boolean. The spec says `true`/`false` exactly, but
 * `0`/`1` appear in the wild often enough to be worth accepting.
 */
function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1'
}

/** Splits a `;`-separated list value, dropping the empty trailing field. */
function parseList(value: string): string[] {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * Unescapes a desktop-entry value. The spec defines exactly these sequences;
 * a stray backslash before anything else is left alone rather than eaten, since
 * Windows-style paths in third-party `.desktop` files are common enough that
 * swallowing them would corrupt more values than it fixed.
 */
function unescapeValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\' || i === value.length - 1) {
      out += value[i]
      continue
    }
    const next = value[++i]
    if (next === 's') out += ' '
    else if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === '\\') out += '\\'
    else out += `\\${next}`
  }
  return out
}

/**
 * The locale-suffix lookup order for `$LANG` of the form `lang_COUNTRY@MODIFIER`,
 * most specific first, per the spec's "Localized values for keys" rules. The
 * encoding part (`.UTF-8`) is stripped — it never appears in a key suffix.
 *
 * Exported for the test suite; `parseDesktopEntry` applies it internally.
 */
export function localeCandidates(locale: string | undefined): string[] {
  const raw = (locale ?? '').split('.')[0].trim()
  if (!raw || raw === 'C' || raw === 'POSIX') return []

  const [base, modifier] = raw.split('@')
  const [lang, country] = base.split('_')
  if (!lang) return []

  const candidates: string[] = []
  if (country && modifier) candidates.push(`${lang}_${country}@${modifier}`)
  if (country) candidates.push(`${lang}_${country}`)
  if (modifier) candidates.push(`${lang}@${modifier}`)
  candidates.push(lang)
  return candidates
}

/**
 * Parses the `[Desktop Entry]` group out of a `.desktop` file's contents.
 * Returns `null` when the file has no such group (an `.desktop` file that is
 * only `[Desktop Action …]`, or isn't a desktop entry at all).
 *
 * `locale` is the value of `$LC_MESSAGES`/`$LANG`; localized `Name[…]` keys are
 * resolved against it, falling back to the unlocalized `Name`.
 */
export function parseDesktopEntry(
  content: string,
  locale?: string
): DesktopEntry | null {
  const wanted = localeCandidates(locale)

  let inGroup = false
  let sawGroup = false
  const plain = new Map<string, string>()
  // key → locale suffix → value, for the localized variants we might want.
  const localized = new Map<string, Map<string, string>>()

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('[')) {
      // A new group header ends the one before it. Everything after
      // `[Desktop Entry]` (the `[Desktop Action …]` groups) is ignored.
      inGroup = line === '[Desktop Entry]'
      if (inGroup) sawGroup = true
      continue
    }
    if (!inGroup) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue
    const rawKey = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()

    const bracket = rawKey.indexOf('[')
    if (bracket === -1) {
      plain.set(rawKey, value)
      continue
    }
    if (!rawKey.endsWith(']')) continue
    const key = rawKey.slice(0, bracket)
    const suffix = rawKey.slice(bracket + 1, -1)
    if (!wanted.includes(suffix)) continue
    const byLocale = localized.get(key) ?? new Map<string, string>()
    byLocale.set(suffix, value)
    localized.set(key, byLocale)
  }

  if (!sawGroup) return null

  /** The best available value for `key`: most specific matching locale, else plain. */
  const read = (key: string): string | undefined => {
    const byLocale = localized.get(key)
    if (byLocale) {
      for (const suffix of wanted) {
        const hit = byLocale.get(suffix)
        if (hit !== undefined) return hit
      }
    }
    return plain.get(key)
  }

  const name = read('Name')
  const genericName = read('GenericName')?.trim()
  return {
    type: plain.get('Type')?.trim() ?? '',
    name: name ? unescapeValue(name) : '',
    genericName: genericName ? unescapeValue(genericName) : undefined,
    keywords: parseList(read('Keywords') ?? '').map(unescapeValue),
    categories: parseList(plain.get('Categories') ?? ''),
    exec: plain.get('Exec'),
    icon: read('Icon')?.trim() || undefined,
    noDisplay: parseBoolean(plain.get('NoDisplay') ?? ''),
    hidden: parseBoolean(plain.get('Hidden') ?? ''),
    terminal: parseBoolean(plain.get('Terminal') ?? ''),
    tryExec: plain.get('TryExec')?.trim() || undefined,
    onlyShowIn: parseList(plain.get('OnlyShowIn') ?? ''),
    notShowIn: parseList(plain.get('NotShowIn') ?? '')
  }
}

/**
 * Whether `entry` belongs in the launcher's list, per the spec's visibility
 * rules: it must be a runnable `Application`, not tombstoned (`Hidden`), not
 * opted out of menus (`NoDisplay` — updater helpers, MIME-handler stubs and
 * per-app URL handlers all set it), and not filtered out for the current
 * desktop environment.
 *
 * `desktops` is `$XDG_CURRENT_DESKTOP` split on `:` (e.g. `['ubuntu', 'GNOME']`).
 * Comparison is case-insensitive: the spec says these are case-sensitive names,
 * but real `.desktop` files disagree among themselves about `Gnome`/`GNOME` and
 * a case slip here silently hides an app.
 *
 * `TryExec` is *not* checked here — it needs a `PATH` lookup, which is I/O.
 */
/**
 * A GNOME Settings page (Wi-Fi, Bluetooth, Displays, …). These are
 * `NoDisplay=true` so they stay out of the app grid, but GNOME's own search
 * still finds them — the category is how it tells them apart.
 */
export function isSettingsPanel(entry: DesktopEntry): boolean {
  return entry.categories.includes('X-GNOME-Settings-Panel')
}

export function isLaunchable(entry: DesktopEntry, desktops: string[]): boolean {
  if (entry.type !== 'Application') return false
  if (entry.hidden) return false
  if (entry.noDisplay && !isSettingsPanel(entry)) return false
  if (!entry.name || !entry.exec) return false

  const current = desktops.map((item) => item.toLowerCase()).filter(Boolean)
  if (entry.notShowIn.some((item) => current.includes(item.toLowerCase())))
    return false
  if (entry.onlyShowIn.length > 0) {
    if (!entry.onlyShowIn.some((item) => current.includes(item.toLowerCase())))
      return false
  }
  return true
}

/**
 * Turns an `Exec` value into an argv array: tokenized on unquoted whitespace,
 * with the spec's quoting rules applied and its field codes dropped.
 *
 * Returns `null` when nothing executable is left (an empty or field-codes-only
 * `Exec`), which the caller treats as "not launchable".
 *
 * Note that `%%` unescapes to a literal `%` *before* field-code removal, so
 * `Exec=fmt %%f` keeps its `%f` argument instead of losing it.
 */
export function parseExecCommand(exec: string | undefined): string[] | null {
  if (!exec) return null

  const tokens: string[] = []
  let current = ''
  let started = false
  let quoted = false
  /**
   * Whether anything in the current token came from an escape or a quoted
   * section. A field code is only a field code when it was written literally:
   * `%%f` means the user wants the two characters `%f` passed through, so once
   * an escape has contributed, the field-code filter must not fire on the
   * result. Without this, `Exec=fmt %%f` silently loses its argument.
   */
  let escaped = false

  const flush = (): void => {
    if (started && (escaped || !FIELD_CODE.test(current))) tokens.push(current)
    current = ''
    started = false
    escaped = false
  }

  for (let i = 0; i < exec.length; i++) {
    const char = exec[i]

    if (quoted) {
      // Inside double quotes only these four are escapable; a backslash before
      // anything else is a literal backslash (paths again).
      if (char === '\\' && i + 1 < exec.length) {
        const next = exec[i + 1]
        if (next === '"' || next === '`' || next === '$' || next === '\\') {
          current += next
          i++
          continue
        }
        current += char
        continue
      }
      if (char === '"') {
        quoted = false
        continue
      }
      current += char
      continue
    }

    if (char === '"') {
      quoted = true
      started = true
      escaped = true
      continue
    }
    if (char === ' ' || char === '\t') {
      flush()
      continue
    }
    if (char === '%' && i + 1 < exec.length) {
      const next = exec[i + 1]
      if (next === '%') {
        current += '%'
        started = true
        escaped = true
        i++
        continue
      }
    }
    current += char
    started = true
  }
  flush()

  return tokens.length > 0 ? tokens : null
}

/**
 * The entry's "desktop file ID": its path relative to the `applications/`
 * directory it was found in, with `/` replaced by `-` (e.g.
 * `kde4/konsole.desktop` → `kde4-konsole.desktop`).
 *
 * This — not the display name — is the spec's identity for an entry, and it's
 * what makes precedence work: a user's `~/.local/share/applications/foo.desktop`
 * is *the same entry* as `/usr/share/applications/foo.desktop` and must
 * shadow it, while two genuinely different apps that happen to both be called
 * "Terminal" must both survive.
 */
export function desktopFileId(relativePath: string): string {
  return relativePath.split('/').filter(Boolean).join('-')
}
