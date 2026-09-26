/**
 * Preference resolution: turns a registry entry's stored values plus its
 * manifest schema into exactly what `getPreferenceValues()` returns inside
 * the command, and decides which required preferences still need a value
 * before a command may run. Pure — no Electron, no filesystem.
 */
import { basename, extname } from "node:path";
import type { RaycastPreference } from "./manifest.ts";
import type { PluginRegistryEntry } from "./registry.ts";
import type {
  PluginPreferenceField,
  PluginPreferencesPayload,
} from "./host/protocol.ts";

/** Where a command-level preference's value lives in `preferenceValues`. */
export function commandPreferenceKey(
  commandName: string,
  name: string,
): string {
  return `${commandName}.${name}`;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Real Raycast hands `appPicker` preferences over as an `Application`. */
function toApplication(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  const looksLikePath = value.includes("/") || value.includes("\\");
  if (!looksLikePath) return { name: value, path: value, bundleId: value };
  return { name: basename(value, extname(value)), path: value };
}

function defaultValue(preference: RaycastPreference): unknown {
  if (preference.default !== undefined) return preference.default;
  switch (preference.type) {
    case "checkbox":
      return false;
    case "dropdown":
      return preference.data?.[0]?.value;
    case "appPicker":
      return undefined;
    default:
      return "";
  }
}

function resolveOne(preference: RaycastPreference, stored: unknown): unknown {
  const value = isEmpty(stored) ? defaultValue(preference) : stored;
  if (preference.type === "checkbox") return value === true || value === "true";
  if (preference.type === "appPicker") return toApplication(value);
  return value;
}

/** `getPreferenceValues()` for one command: extension-level preferences
 *  plus that command's own, each falling back to its manifest default. */
export function resolvePreferenceValues(
  entry: PluginRegistryEntry,
  commandName: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const preference of entry.preferences ?? []) {
    values[preference.name] = resolveOne(
      preference,
      entry.preferenceValues[preference.name],
    );
  }
  const command = entry.commands.find((c) => c.name === commandName);
  for (const preference of command?.preferences ?? []) {
    values[preference.name] = resolveOne(
      preference,
      entry.preferenceValues[
        commandPreferenceKey(commandName, preference.name)
      ],
    );
  }
  return values;
}

/** Required preferences with neither a stored value nor a manifest default.
 *  With `commandName`, only what that command needs; without, the whole
 *  extension (for the post-install prompt). A required checkbox always has
 *  a value (unchecked), so it never counts as missing. */
export function missingRequiredPreferences(
  entry: PluginRegistryEntry,
  commandName?: string,
): string[] {
  const missing: string[] = [];
  const check = (preference: RaycastPreference, key: string): void => {
    if (!preference.required || preference.type === "checkbox") return;
    if (isEmpty(entry.preferenceValues[key]) && isEmpty(preference.default)) {
      missing.push(key);
    }
  };
  for (const preference of entry.preferences ?? []) {
    check(preference, preference.name);
  }
  const commands = commandName
    ? entry.commands.filter((c) => c.name === commandName)
    : entry.commands;
  for (const command of commands) {
    for (const preference of command.preferences ?? []) {
      check(preference, commandPreferenceKey(command.name, preference.name));
    }
  }
  return missing;
}

function toField(
  preference: RaycastPreference,
  command?: { name: string; title: string },
): PluginPreferenceField {
  return {
    name: command
      ? commandPreferenceKey(command.name, preference.name)
      : preference.name,
    type: preference.type,
    title: preference.title,
    description: preference.description,
    placeholder: preference.placeholder,
    label: preference.label,
    required: preference.required === true,
    default: preference.default,
    data: preference.data,
    commandName: command?.name,
    commandTitle: command?.title,
  };
}

/** Everything the renderer's preferences form needs for one plugin. */
export function preferencesPayload(
  entry: PluginRegistryEntry,
): PluginPreferencesPayload {
  const fields: PluginPreferenceField[] = (entry.preferences ?? []).map((p) =>
    toField(p),
  );
  for (const command of entry.commands) {
    for (const preference of command.preferences ?? []) {
      fields.push(toField(preference, command));
    }
  }
  return {
    pluginId: entry.id,
    title: entry.title,
    fields,
    values: { ...entry.preferenceValues },
  };
}
