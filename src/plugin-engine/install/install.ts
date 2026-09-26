/**
 * Orchestrates one install, end to end, into a `PluginRegistryEntry` ready
 * for `PluginRegistry.upsert()` (the caller's job — `PluginHostSource` owns
 * the registry instance, this module doesn't know about it).
 *
 * Three sources, two pipelines, one output shape (see `paths.ts`):
 *
 *  - **store** — the primary path: resolve the listing, download its
 *    prebuilt zip, extract. No npm, no bundler (see `store.ts`).
 *  - **github** — a raycast/extensions folder link is *rewritten to a store
 *    install* (the Store publishes every extension in that repo, prebuilt);
 *    any other repo is fetched and built from source.
 *  - **local** — a folder on disk, built from source.
 *
 * Every pipeline builds the complete `<pluginId>/` tree in a staging
 * directory next to the real one, and only swaps it in once everything
 * succeeded — so a failed reinstall/update leaves the working install
 * untouched. The plugin's own data (`storage.json`, `cache.json`,
 * `support/`) carries over into the new tree.
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bundlePlugin, writeDistPackageJson } from "./bundle.ts";
import { fetchLocalFolder } from "./fetch-local.ts";
import {
  fetchGithubFolder,
  parseGithubFolderUrl,
  writeFetchedFiles,
} from "./fetch-github.ts";
import { installDependencies } from "./npm-install.ts";
import {
  downloadZip,
  extractPackage,
  isPlatformSupported,
  platformLabel,
  resolveStoreExtension,
} from "./store.ts";
import {
  parseManifest,
  type RaycastManifest,
  type RaycastManifestCommand,
} from "../manifest.ts";
import { pluginIdFromName } from "../paths.ts";
import type { PluginRegistryEntry, PluginSourceRef } from "../registry.ts";
import type { InstallSourceInput, InstallStage } from "../host/protocol.ts";

export type InstallSource = InstallSourceInput;

export type InstallResult =
  { ok: true; entry: PluginRegistryEntry } | { ok: false; error: string };

export interface InstallOptions {
  onProgress?: (stage: InstallStage, message: string) => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
}

/** Thrown inside the pipeline for an expected, user-facing failure. */
class InstallError extends Error {}

/** `raycast/extensions/extensions/<folder>` (any ref) -> its folder and ref. */
export function raycastExtensionsFolder(
  url: string,
): { name: string; ref: string | null } | null {
  const parsed = parseGithubFolderUrl(url);
  if (!parsed) return null;
  if (parsed.owner.toLowerCase() !== "raycast") return null;
  if (parsed.repo.toLowerCase() !== "extensions") return null;
  const match = parsed.path.replace(/\/+$/, "").match(/^extensions\/([^/]+)$/);
  return match ? { name: match[1], ref: parsed.ref } : null;
}

/** A raycast/extensions link becomes a Store install; anything else is
 *  left as-is. */
export function normalizeSource(source: InstallSource): InstallSource {
  if (source.kind !== "github") return source;
  const folder = raycastExtensionsFolder(source.url);
  return folder ? { kind: "store", name: folder.name, folder } : source;
}

/** The manifest identity behind a raycast/extensions folder, read off
 *  raw.githubusercontent.com (a CDN — no API quota). `null` if unreachable,
 *  in which case the folder name is the best guess. */
async function folderManifestIdentity(
  folder: { name: string; ref: string | null },
  fetchImpl: typeof fetch,
): Promise<{ name: string; author?: string; title?: string } | null> {
  const url = `https://raw.githubusercontent.com/raycast/extensions/${folder.ref ?? "main"}/extensions/${folder.name}/package.json`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const pkg = (await res.json()) as {
      name?: unknown;
      author?: unknown;
      title?: unknown;
    };
    if (typeof pkg.name !== "string") return null;
    return {
      name: pkg.name,
      author: typeof pkg.author === "string" ? pkg.author : undefined,
      title: typeof pkg.title === "string" ? pkg.title : undefined,
    };
  } catch {
    return null;
  }
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function readManifest(sourceDir: string): Promise<RaycastManifest> {
  let text: string;
  try {
    text = await readFile(join(sourceDir, "package.json"), "utf8");
  } catch {
    throw new InstallError("no package.json found at the root of that folder");
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) throw new InstallError(parsed.error);
  return parsed.manifest;
}

function checkPlatform(
  platforms: string[] | null | undefined,
  platform: NodeJS.Platform,
): void {
  if (!isPlatformSupported(platforms, platform)) {
    const listed = platforms?.length ? platforms.join(", ") : "macOS";
    throw new InstallError(
      `this extension only supports ${listed}, not ${platformLabel(platform)}`,
    );
  }
}

interface StagedPlugin {
  id: string;
  manifest: RaycastManifest;
  /** Commands that actually have a bundle — may be fewer than the
   *  manifest's for a Store package (see `stageStore`). */
  commands: RaycastManifestCommand[];
  sourceRef: PluginSourceRef;
}

/** Extracts the Store package into `<staging>/incoming`, then lays it out
 *  as `<staging>/<id>/{source,dist}`. */
async function stageStore(
  staging: string,
  source: Extract<InstallSource, { kind: "store" }>,
  opts: InstallOptions,
  platform: NodeJS.Platform,
): Promise<StagedPlugin> {
  const progress = opts.onProgress ?? (() => {});
  progress("resolving", `Looking up "${source.name}"…`);
  let ref: { name: string; author?: string; title?: string } = source;
  if (source.folder) {
    ref =
      (await folderManifestIdentity(source.folder, opts.fetch ?? fetch)) ??
      source;
  }
  const resolved = await resolveStoreExtension(ref, { fetch: opts.fetch });
  if (!resolved.ok) throw new InstallError(resolved.error);
  const { listing } = resolved;
  checkPlatform(listing.platforms, platform);

  progress("downloading", "Downloading…");
  let lastReport = 0;
  const bytes = await downloadZip(
    listing.download_url,
    (received, total) => {
      const now = Date.now();
      if (now - lastReport < 200 && received !== total) return;
      lastReport = now;
      progress(
        "downloading",
        total
          ? `Downloading ${formatMB(received)} / ${formatMB(total)} MB…`
          : `Downloading ${formatMB(received)} MB…`,
      );
    },
    { fetch: opts.fetch },
  );

  progress("extracting", "Extracting…");
  const incoming = join(staging, "incoming");
  await extractPackage(bytes, incoming);
  const manifest = await readManifest(incoming);
  const id = pluginIdFromName(manifest.name);
  if (!id) {
    throw new InstallError(
      `manifest "name" ("${manifest.name}") didn't produce a usable id`,
    );
  }

  const pluginRoot = join(staging, id);
  const sourceDir = join(pluginRoot, "source");
  const distDir = join(pluginRoot, "dist");
  await mkdir(pluginRoot, { recursive: true });
  await rename(incoming, sourceDir);
  await writeDistPackageJson(distDir);

  // A manifest command without a bundle (an AI tool, or one the Store
  // build skipped) is dropped rather than failing the whole install.
  const commands: RaycastManifestCommand[] = [];
  for (const command of manifest.commands) {
    const built = join(sourceDir, `${command.name}.js`);
    if (!existsSync(built)) continue;
    await rename(built, join(distDir, `${command.name}.js`));
    commands.push(command);
  }
  if (commands.length === 0) {
    throw new InstallError(
      "the Store package has no runnable commands for Magibar (menu-bar-only or AI-only extensions aren't supported)",
    );
  }

  return {
    id,
    manifest,
    commands,
    sourceRef: {
      kind: "store",
      name: listing.name,
      author:
        listing.author?.handle ?? listing.owner?.handle ?? ref.author ?? "",
      commitSha: listing.commit_sha,
      updatedAt: listing.updated_at,
    },
  };
}

/** Fetches source into `<staging>/incoming`, then installs dependencies and
 *  bundles it into `<staging>/<id>/{source,dist}`. */
async function stageSource(
  staging: string,
  source: Extract<InstallSource, { kind: "github" | "local" }>,
  opts: InstallOptions,
  platform: NodeJS.Platform,
): Promise<StagedPlugin> {
  const progress = opts.onProgress ?? (() => {});
  const incoming = join(staging, "incoming");

  if (source.kind === "local") {
    progress("fetching", "Copying the extension folder…");
    const info = await stat(source.path).catch(() => null);
    if (!info?.isDirectory()) {
      throw new InstallError(`"${source.path}" isn't a folder`);
    }
    await fetchLocalFolder(source.path, incoming);
    // A local folder may already have its own node_modules/dist — fine to
    // keep node_modules (saves a reinstall), but never a stale build.
    await rm(join(incoming, "dist"), { recursive: true, force: true });
  } else {
    const parsed = parseGithubFolderUrl(source.url);
    if (!parsed) {
      throw new InstallError(
        `couldn't parse "${source.url}" as a GitHub folder URL (expected .../tree/<ref>/<path> or owner/repo/path)`,
      );
    }
    progress("fetching", "Downloading files from GitHub…");
    const fetched = await fetchGithubFolder(parsed);
    if (!fetched.ok) throw new InstallError(fetched.error);
    await writeFetchedFiles(fetched.files, incoming);
  }

  const manifest = await readManifest(incoming);
  checkPlatform(manifest.platforms, platform);
  const id = pluginIdFromName(manifest.name);
  if (!id) {
    throw new InstallError(
      `manifest "name" ("${manifest.name}") didn't produce a usable id`,
    );
  }
  const pluginRoot = join(staging, id);
  const sourceDir = join(pluginRoot, "source");
  await mkdir(pluginRoot, { recursive: true });
  await rename(incoming, sourceDir);

  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    progress("installing-dependencies", "Installing dependencies (npm)…");
    const deps = await installDependencies(sourceDir, manifest);
    if (!deps.ok) throw new InstallError(deps.error);
  }

  progress("bundling", "Building commands…");
  const bundled = await bundlePlugin(staging, id, sourceDir, manifest.commands);
  if (!bundled.ok) throw new InstallError(bundled.error);

  return {
    id,
    manifest,
    commands: manifest.commands,
    sourceRef:
      source.kind === "github"
        ? { kind: "github", url: source.url }
        : { kind: "local", path: source.path },
  };
}

/** Files that belong to the *user's* use of a plugin, not to its package —
 *  carried over from the old install into the new one. */
const PRESERVED_ENTRIES = ["storage.json", "cache.json", "support"];

async function swapIntoPlace(
  pluginsRoot: string,
  staging: string,
  id: string,
): Promise<void> {
  const staged = join(staging, id);
  const target = join(pluginsRoot, id);
  if (existsSync(target)) {
    for (const name of PRESERVED_ENTRIES) {
      const from = join(target, name);
      if (existsSync(from))
        await cp(from, join(staged, name), { recursive: true });
    }
    await rename(target, join(staging, "previous"));
  }
  await rename(staged, target);
}

function toEntry(staged: StagedPlugin): PluginRegistryEntry {
  const { manifest } = staged;
  return {
    id: staged.id,
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    icon: manifest.icon,
    version: manifest.version,
    author: manifest.author,
    owner: manifest.owner,
    sourceRef: staged.sourceRef,
    installedAt: Date.now(),
    commands: staged.commands.map((command) => ({
      name: command.name,
      title: command.title,
      subtitle: command.subtitle,
      mode: command.mode,
      icon: command.icon,
      preferences: command.preferences,
      arguments: command.arguments,
    })),
    preferences: manifest.preferences,
    preferenceValues: {},
  };
}

export async function installPlugin(
  pluginsRoot: string,
  source: InstallSource,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const platform = opts.platform ?? process.platform;
  const normalized = normalizeSource(source);
  await mkdir(pluginsRoot, { recursive: true });
  // Inside `pluginsRoot`, so the final swap is a same-filesystem rename.
  const staging = await mkdtemp(join(pluginsRoot, ".staging-"));
  try {
    const staged =
      normalized.kind === "store"
        ? await stageStore(staging, normalized, opts, platform)
        : await stageSource(staging, normalized, opts, platform);
    opts.onProgress?.("finishing", "Finishing…");
    await swapIntoPlace(pluginsRoot, staging, staged.id);
    return { ok: true, entry: toEntry(staged) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Leftover staging directories from an install interrupted by a crash or
 *  quit — swept once at startup. */
export async function sweepStaging(pluginsRoot: string): Promise<void> {
  if (!existsSync(pluginsRoot)) return;
  for (const name of await readdir(pluginsRoot)) {
    if (name.startsWith(".staging-")) {
      await rm(join(pluginsRoot, name), { recursive: true, force: true });
    }
  }
}
