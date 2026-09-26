/**
 * The Raycast Store client: search listings, and download an extension's
 * prebuilt package.
 *
 * Uses the same (undocumented) endpoint raycast.com's own store pages call —
 * also what Tinycast uses. Every listing carries a `download_url`: a
 * pre-signed S3 link (valid ~24h, so always re-resolved right before a
 * download) to a zip of the extension exactly as Raycast itself installs it:
 *
 *   <name>/package.json      the full manifest
 *   <name>/<command>.js      one `ray build` bundle per command — CommonJS,
 *                            every npm dependency (incl. @raycast/utils)
 *                            inlined; only @raycast/api, react, and Node
 *                            built-ins left as `require`s
 *   <name>/<command>.js.map  (skipped)
 *   <name>/assets/…
 *
 * So a Store install needs no npm, no bundler, and no GitHub API quota —
 * `host/runtime.ts` runs those bundles as-is. Everything Store-specific
 * lives in this one module, so if the endpoint ever changes, this is the
 * only file to adapt (and the GitHub source-build path still works).
 *
 * `fetch` is injectable throughout, so this is testable offline.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { unzip, type Unzipped } from "fflate";
import { encodeAsIs, fetchIconDataUri, type IconEncoder } from "./icon.ts";

export const STORE_SEARCH_URL =
  "https://www.raycast.com/frontend_api/extensions/search";

const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Larger than any real extension package (the biggest are ~30MB, mostly
 *  source maps) — a backstop against a runaway download, not a real limit. */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;

/** The fields of a Store listing this module reads. */
export interface StoreListing {
  name: string;
  title: string;
  description?: string;
  author?: { handle?: string; name?: string; avatar?: string | null };
  owner?: { handle?: string; name?: string; avatar?: string | null };
  categories?: string[];
  created_at?: number;
  icons?: { light?: string | null; dark?: string | null };
  platforms?: string[] | null;
  download_count?: number;
  commands?: unknown[];
  download_url?: string;
  commit_sha?: string;
  updated_at?: number;
  status?: string;
  /** Non-zero once Raycast has disabled an extension (e.g. for security). */
  kill_listed_at?: number;
}

/** One command as the Store lists it. */
export interface StoreCommand {
  name: string;
  title: string;
  description?: string;
  /** `"view"`, `"no-view"`, `"menu-bar"`, … */
  mode?: string;
}

export interface StoreSearchHit {
  name: string;
  author: string;
  authorName?: string;
  authorAvatarUrl?: string;
  title: string;
  description?: string;
  iconUrl: string | null;
  platforms: string[] | null;
  downloadCount: number;
  commandCount: number;
  commands: StoreCommand[];
  categories: string[];
  /** Unix seconds. */
  createdAt?: number;
  updatedAt?: number;
}

function storeCommands(value: unknown): StoreCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c.name !== "string") return [];
    return [
      {
        name: c.name,
        title: typeof c.title === "string" && c.title ? c.title : c.name,
        description:
          typeof c.description === "string" && c.description
            ? c.description
            : undefined,
        mode: typeof c.mode === "string" ? c.mode : undefined,
      },
    ];
  });
}

type FetchLike = typeof fetch;

/** Can `process.platform` run an extension listed for `platforms`? A
 *  listing without the field predates Windows support: macOS only. Raycast
 *  has no Linux build, so Linux gets the benefit of the doubt. */
export function isPlatformSupported(
  platforms: string[] | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "darwin") return !platforms || platforms.includes("macOS");
  if (platform === "win32") return !!platforms?.includes("Windows");
  return true;
}

export function platformLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "darwin"
    ? "macOS"
    : platform === "win32"
      ? "Windows"
      : "Linux";
}

export function mapListing(listing: StoreListing): StoreSearchHit {
  return {
    name: listing.name,
    author: listing.author?.handle ?? listing.owner?.handle ?? "",
    authorName: listing.author?.name,
    authorAvatarUrl:
      listing.author?.avatar ?? listing.owner?.avatar ?? undefined,
    title: listing.title || listing.name,
    description: listing.description,
    iconUrl: listing.icons?.light ?? listing.icons?.dark ?? null,
    platforms: listing.platforms ?? null,
    downloadCount: listing.download_count ?? 0,
    commandCount: Array.isArray(listing.commands) ? listing.commands.length : 0,
    commands: storeCommands(listing.commands),
    categories: Array.isArray(listing.categories)
      ? listing.categories.filter((c): c is string => typeof c === "string")
      : [],
    createdAt: listing.created_at,
    updatedAt: listing.updated_at,
  };
}

/** The per-extension endpoint — a listing plus what search leaves out
 *  (screenshots, changelog). Same unofficial API family as search. */
export const STORE_DETAIL_URL = "https://www.raycast.com/api/v1/extensions";

export interface StoreChangelogEntry {
  title: string;
  date?: string;
  markdown?: string;
}

export interface StoreDetail {
  /** Screenshot image URLs, in the Store's order. */
  screenshots: string[];
  /** Newest first. */
  changelog: StoreChangelogEntry[];
}

const detailCache = new Map<string, { at: number; detail: StoreDetail }>();

/** An author handle / extension name safe to put in a URL path. */
const STORE_SEGMENT = /^[\w.-]+$/;

/** Screenshots and changelog for one extension; cached like search. */
export async function fetchStoreDetail(
  author: string,
  name: string,
  opts: { fetch?: FetchLike } = {},
): Promise<StoreDetail> {
  if (!STORE_SEGMENT.test(author) || !STORE_SEGMENT.test(name)) {
    throw new Error("invalid extension reference");
  }
  const key = `${author}/${name}`;
  const cached = detailCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return cached.detail;
  }
  const res = await (opts.fetch ?? fetch)(`${STORE_DETAIL_URL}/${key}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`the extension store returned an error (${res.status})`);
  }
  const body = (await res.json()) as {
    metadata?: unknown;
    changelog?: { versions?: unknown };
  };
  const screenshots = Array.isArray(body.metadata)
    ? body.metadata.filter(
        (url): url is string =>
          typeof url === "string" && url.startsWith("https://"),
      )
    : [];
  const versions = Array.isArray(body.changelog?.versions)
    ? body.changelog.versions
    : [];
  const changelog = versions.flatMap((raw): StoreChangelogEntry[] => {
    const v = raw as Record<string, unknown> | null;
    if (!v || typeof v.title !== "string") return [];
    return [
      {
        title: v.title,
        date: typeof v.date === "string" ? v.date : undefined,
        markdown: typeof v.markdown === "string" ? v.markdown : undefined,
      },
    ];
  });
  const detail = { screenshots, changelog };
  detailCache.set(key, { at: Date.now(), detail });
  return detail;
}

async function fetchListings(
  query: string,
  perPage: number,
  fetchImpl: FetchLike,
): Promise<StoreListing[]> {
  const url = `${STORE_SEARCH_URL}?${new URLSearchParams({
    q: query,
    per_page: String(perPage),
  })}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`the extension store returned an error (${res.status})`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("the extension store returned an unexpected response");
  }
  return (body.data as StoreListing[]).filter(
    (listing) =>
      typeof listing?.name === "string" &&
      listing.status !== "deprecated" &&
      listing.status !== "removed" &&
      !listing.kill_listed_at,
  );
}

const searchCache = new Map<string, { at: number; hits: StoreSearchHit[] }>();

export async function searchStore(
  query: string,
  opts: { fetch?: FetchLike; perPage?: number } = {},
): Promise<StoreSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const cacheKey = trimmed.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS)
    return cached.hits;

  const listings = await fetchListings(
    trimmed,
    opts.perPage ?? 20,
    opts.fetch ?? fetch,
  );
  const hits = listings.map(mapListing);
  searchCache.set(cacheKey, { at: Date.now(), hits });
  return hits;
}

/** Icons for search hits, fetched in parallel; `null` where unavailable. */
export async function fetchHitIcons(
  hits: StoreSearchHit[],
  opts: { fetch?: FetchLike; encode?: IconEncoder } = {},
): Promise<(string | null)[]> {
  return Promise.all(
    hits.map((hit) =>
      hit.iconUrl
        ? fetchIconDataUri(hit.iconUrl, {
            fetch: opts.fetch,
            encode: opts.encode ?? encodeAsIs,
          })
        : Promise.resolve(null),
    ),
  );
}

export type ResolveResult =
  | { ok: true; listing: StoreListing & { download_url: string } }
  | { ok: false; error: string };

/** Looks an extension up by exact `name` (plus `author` handle, when known —
 *  `name` alone isn't unique across the Store) and returns its listing with
 *  a *fresh* `download_url`. The Store's search is full-text, so a name
 *  like `raycast-system-monitor` may only match once its dashes are spaces,
 *  or by its title — each is tried in turn until an exact match turns up. */
export async function resolveStoreExtension(
  ref: { name: string; author?: string; title?: string },
  opts: { fetch?: FetchLike } = {},
): Promise<ResolveResult> {
  const queries = [
    ...new Set([ref.name, ref.name.replace(/-/g, " "), ref.title]),
  ].filter((q): q is string => !!q?.trim());
  let lastError: string | null = null;
  let listing: StoreListing | undefined;
  for (const query of queries) {
    let listings: StoreListing[];
    try {
      listings = await fetchListings(query, 50, opts.fetch ?? fetch);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    const matches = listings.filter((l) => l.name === ref.name);
    listing = ref.author
      ? matches.find(
          (l) =>
            l.author?.handle === ref.author || l.owner?.handle === ref.author,
        )
      : matches[0];
    if (listing) break;
  }
  if (!listing) {
    return {
      ok: false,
      error:
        lastError ??
        `couldn't find "${ref.name}"${ref.author ? ` by ${ref.author}` : ""} in the extension store`,
    };
  }
  if (!listing.download_url) {
    return {
      ok: false,
      error: `the store listing for "${ref.name}" has no download`,
    };
  }
  return {
    ok: true,
    listing: listing as StoreListing & { download_url: string },
  };
}

/** Downloads `url`, reporting `(receivedBytes, totalBytes | null)`. */
export async function downloadZip(
  url: string,
  onProgress: (received: number, total: number | null) => void,
  opts: { fetch?: FetchLike } = {},
): Promise<Uint8Array> {
  const res = await (opts.fetch ?? fetch)(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`downloading the extension failed (${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total && total > MAX_ZIP_BYTES) {
    throw new Error("the extension package is unexpectedly large");
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_ZIP_BYTES) {
      await reader.cancel();
      throw new Error("the extension package is unexpectedly large");
    }
    chunks.push(value);
    onProgress(received, total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A zip entry's path, made safe to join under a destination directory —
 *  `null` for anything that could escape it (absolute paths, drive letters,
 *  `..` segments). */
export function safeRelativePath(entryPath: string): string | null {
  const unified = entryPath.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const segments = unified.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  const normalized = normalize(segments.join(sep));
  if (isAbsolute(normalized) || normalized.startsWith("..")) return null;
  return normalized;
}

function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(
      bytes,
      // Source maps are most of a package's size and nothing here reads them.
      { filter: (file) => !file.name.endsWith(".map") },
      (error, files) => (error ? reject(error) : resolve(files)),
    );
  });
}

/** Extracts a Store package into `destDir`, dropping the single top-level
 *  `<name>/` folder every Store zip wraps its contents in. Returns the
 *  relative paths written. */
export async function extractPackage(
  bytes: Uint8Array,
  destDir: string,
): Promise<string[]> {
  let files: Unzipped;
  try {
    files = await unzipAsync(bytes);
  } catch (error) {
    throw new Error(
      `the downloaded package isn't a valid zip: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = Object.entries(files).filter(
    ([name]) => !name.endsWith("/") && !name.startsWith("__MACOSX/"),
  );
  const firstSegments = new Set(
    entries.map(([name]) => name.replace(/\\/g, "/").split("/")[0]),
  );
  const wrapped =
    firstSegments.size === 1 &&
    entries.every(([name]) => name.replace(/\\/g, "/").includes("/"));

  const written: string[] = [];
  for (const [name, content] of entries) {
    // Validate the entry's own path before unwrapping — otherwise a `..`
    // first segment would pass for the wrapper folder and get stripped.
    const raw = safeRelativePath(name);
    if (!raw) {
      throw new Error(`the package contains an unsafe path: "${name}"`);
    }
    const relative = wrapped ? raw.split(sep).slice(1).join(sep) : raw;
    if (!relative) continue;
    const target = join(destDir, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(relative);
  }
  return written;
}
