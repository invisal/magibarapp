/**
 * The subset of a Raycast extension's `package.json` this engine reads. Not a
 * full schema — only what's needed to enumerate commands, preferences, and
 * arguments.
 *
 * `mode: "view"` doesn't say whether a command renders `List`, `Detail`,
 * `Grid`, or `Form` — Raycast's manifest doesn't distinguish those, it's just
 * whatever the command's default export renders. So parsing only filters on
 * `mode` itself (`menu-bar` commands are skipped: there's no menu bar
 * surface to host them).
 */

export type RaycastCommandMode = "view" | "no-view";

export type RaycastPreferenceType =
  | "textfield"
  | "password"
  | "checkbox"
  | "dropdown"
  | "appPicker"
  | "file"
  | "directory";

export interface RaycastPreference {
  name: string;
  type: RaycastPreferenceType;
  title?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  /** `checkbox` only: the text beside the box. */
  label?: string;
  /** `dropdown` options. */
  data?: { title: string; value: string }[];
}

export type RaycastArgumentType = "text" | "password" | "dropdown";

export interface RaycastArgument {
  name: string;
  type: RaycastArgumentType;
  placeholder?: string;
  required: boolean;
  /** `dropdown` options. */
  data?: { title: string; value: string }[];
}

export interface RaycastManifestCommand {
  name: string;
  title: string;
  subtitle?: string;
  description?: string;
  mode: RaycastCommandMode;
  icon?: string;
  preferences?: RaycastPreference[];
  arguments?: RaycastArgument[];
}

export interface RaycastManifest {
  name: string;
  title: string;
  description?: string;
  icon?: string;
  author?: string;
  owner?: string;
  version?: string;
  /** `undefined` when the manifest predates the field — macOS only. */
  platforms?: string[];
  commands: RaycastManifestCommand[];
  preferences?: RaycastPreference[];
  /** Only read by the source-build path — `install/npm-install.ts` installs
   *  these before `install/bundle.ts` bundles. Store installs are prebuilt. */
  dependencies?: Record<string, string>;
}

export type ParseManifestResult =
  { ok: true; manifest: RaycastManifest } | { ok: false; error: string };

const PREFERENCE_TYPES: readonly RaycastPreferenceType[] = [
  "textfield",
  "password",
  "checkbox",
  "dropdown",
  "appPicker",
  "file",
  "directory",
];

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOptions(
  value: unknown,
): { title: string; value: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      title: String(o.title ?? o.value ?? ""),
      value: String(o.value ?? ""),
    }));
}

/**
 * Every known preference type is kept; an unknown (newer) one is treated as
 * a text field — the user can still type a value, which beats refusing to
 * install an extension over one preference.
 */
function parsePreferences(
  raw: unknown,
  where: string,
):
  | { ok: true; preferences: RaycastPreference[] }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, preferences: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${where}: "preferences" must be an array` };
  }

  const preferences: RaycastPreference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        error: `${where}: each preference must be an object`,
      };
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.name !== "string" || !p.name) {
      return { ok: false, error: `${where}: preference is missing "name"` };
    }
    const type = (PREFERENCE_TYPES as readonly string[]).includes(
      p.type as string,
    )
      ? (p.type as RaycastPreferenceType)
      : "textfield";
    preferences.push({
      name: p.name,
      type,
      title: optionalString(p.title),
      description: optionalString(p.description),
      required: p.required === true,
      default: p.default,
      placeholder: optionalString(p.placeholder),
      label: optionalString(p.label),
      data: parseOptions(p.data),
    });
  }
  return { ok: true, preferences };
}

function parseArguments(raw: unknown): RaycastArgument[] {
  if (!Array.isArray(raw)) return [];
  const args: RaycastArgument[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.name !== "string" || !a.name) continue;
    const type: RaycastArgumentType =
      a.type === "password" || a.type === "dropdown" ? a.type : "text";
    args.push({
      name: a.name,
      type,
      placeholder: optionalString(a.placeholder),
      required: a.required === true,
      data: parseOptions(a.data),
    });
  }
  return args;
}

export function parseManifest(packageJsonText: string): ParseManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(packageJsonText);
  } catch {
    return { ok: false, error: "package.json is not valid JSON" };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "package.json must be an object" };
  }
  const pkg = raw as Record<string, unknown>;

  if (typeof pkg.name !== "string" || !pkg.name) {
    return { ok: false, error: 'package.json is missing "name"' };
  }
  if (typeof pkg.title !== "string" || !pkg.title) {
    return { ok: false, error: 'package.json is missing "title"' };
  }
  if (!Array.isArray(pkg.commands) || pkg.commands.length === 0) {
    return { ok: false, error: 'package.json has no "commands"' };
  }

  const extensionPrefs = parsePreferences(pkg.preferences, "extension");
  if (!extensionPrefs.ok) return extensionPrefs;

  const dependencies = isStringRecord(pkg.dependencies)
    ? pkg.dependencies
    : undefined;

  const commands: RaycastManifestCommand[] = [];
  for (const raw of pkg.commands) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "each command must be an object" };
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name) {
      return { ok: false, error: 'a command is missing "name"' };
    }
    if (typeof c.title !== "string" || !c.title) {
      return { ok: false, error: `command "${c.name}" is missing "title"` };
    }
    // Anything other than view/no-view (menu-bar, etc.) is skipped, not fatal.
    if (c.mode !== "view" && c.mode !== "no-view") continue;

    const commandPrefs = parsePreferences(c.preferences, `command "${c.name}"`);
    if (!commandPrefs.ok) return commandPrefs;

    commands.push({
      name: c.name,
      title: c.title,
      subtitle: optionalString(c.subtitle),
      description: optionalString(c.description),
      mode: c.mode,
      icon: optionalString(c.icon),
      preferences: commandPrefs.preferences,
      arguments: parseArguments(c.arguments),
    });
  }

  if (commands.length === 0) {
    return {
      ok: false,
      error:
        'no supported commands (only "view"/"no-view" modes are supported — menu-bar commands aren\'t)',
    };
  }

  const platforms = Array.isArray(pkg.platforms)
    ? pkg.platforms.filter((p): p is string => typeof p === "string")
    : undefined;

  return {
    ok: true,
    manifest: {
      name: pkg.name,
      title: pkg.title,
      description: optionalString(pkg.description),
      icon: optionalString(pkg.icon),
      author: optionalString(pkg.author),
      owner: optionalString(pkg.owner),
      version: optionalString(pkg.version),
      platforms,
      commands,
      preferences: extensionPrefs.preferences,
      dependencies,
    },
  };
}
