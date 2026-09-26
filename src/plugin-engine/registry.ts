/**
 * The list of installed plugins, persisted via the existing `ExtensionStorage`
 * (`@core/storage` — already solves atomic JSON persistence) rather than a new
 * store: one document at `<userData>/plugins/registry.json`, single key
 * `"installed"`.
 */
import type { ExtensionStorage } from "@core/storage";
import type { RaycastArgument, RaycastPreference } from "./manifest.ts";
import type { InstallSourceInput } from "./host/protocol.ts";

export interface PluginRegistryCommand {
  name: string;
  title: string;
  subtitle?: string;
  mode: "view" | "no-view";
  icon?: string;
  preferences?: RaycastPreference[];
  arguments?: RaycastArgument[];
  /** Set by the command itself via `updateCommandMetadata({ subtitle })` —
   *  shown instead of `subtitle` in the launcher. */
  subtitleOverride?: string;
}

export type PluginSourceRef =
  | {
      kind: "store";
      name: string;
      author: string;
      /** The raycast/extensions commit the Store built this from. */
      commitSha?: string;
      /** The Store listing's `updated_at` (unix seconds) at install time. */
      updatedAt?: number;
    }
  | { kind: "github"; url: string }
  | { kind: "local"; path: string };

export interface PluginRegistryEntry {
  id: string;
  /** The manifest `name` — `environment.extensionName`. Older entries
   *  predate the field; `id` is the fallback. */
  name?: string;
  title: string;
  description?: string;
  icon?: string;
  version?: string;
  author?: string;
  owner?: string;
  sourceRef: PluginSourceRef;
  installedAt: number;
  commands: PluginRegistryCommand[];
  /** Extension-level preference schema (command-level ones live on each
   *  command). */
  preferences?: RaycastPreference[];
  /** What the user entered — extension-level preferences keyed by name,
   *  command-level ones by `<commandName>.<name>`. Manifest defaults are
   *  *not* stored here; `preferences.ts` merges them in at launch. */
  preferenceValues: Record<string, unknown>;
}

/** Where an installed plugin came from, as an install request again — for
 *  updates and for rebuilding an install an older version made. */
export function reinstallSource(
  entry: PluginRegistryEntry,
): InstallSourceInput {
  const ref = entry.sourceRef;
  if (ref.kind === "store") {
    return { kind: "store", name: ref.name, author: ref.author };
  }
  return ref.kind === "github"
    ? { kind: "github", url: ref.url }
    : { kind: "local", path: ref.path };
}

const KEY = "installed";

function isEntry(value: unknown): value is PluginRegistryEntry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PluginRegistryEntry).id === "string" &&
    Array.isArray((value as PluginRegistryEntry).commands)
  );
}

export class PluginRegistry {
  private readonly storage: ExtensionStorage;

  constructor(storage: ExtensionStorage) {
    this.storage = storage;
  }

  list(): PluginRegistryEntry[] {
    const raw = this.storage.get<unknown[]>(KEY, []);
    return raw.filter(isEntry);
  }

  get(id: string): PluginRegistryEntry | undefined {
    return this.list().find((entry) => entry.id === id);
  }

  /** Insert, or replace the existing entry with the same `id` (a reinstall). */
  upsert(entry: PluginRegistryEntry): void {
    const rest = this.list().filter((existing) => existing.id !== entry.id);
    this.storage.set(KEY, [...rest, entry]);
  }

  setPreferenceValues(id: string, values: Record<string, unknown>): void {
    const existing = this.get(id);
    if (existing) this.upsert({ ...existing, preferenceValues: values });
  }

  setCommandSubtitle(
    id: string,
    commandName: string,
    subtitle: string | null,
  ): void {
    const existing = this.get(id);
    if (!existing) return;
    this.upsert({
      ...existing,
      commands: existing.commands.map((command) =>
        command.name === commandName
          ? { ...command, subtitleOverride: subtitle ?? undefined }
          : command,
      ),
    });
  }

  remove(id: string): void {
    this.storage.set(
      KEY,
      this.list().filter((entry) => entry.id !== id),
    );
  }
}
