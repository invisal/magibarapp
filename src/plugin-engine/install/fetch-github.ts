/**
 * GitHub-folder install: fetch one folder out of a repo via the plain GitHub
 * REST API, not `git clone` — no `git` binary dependency, and no need to
 * clone a large monorepo (like raycast/extensions) just for one extension's
 * folder.
 *
 * Only used for repos *other than* raycast/extensions — a raycast/extensions
 * link installs the prebuilt package from the Raycast Store instead (see
 * `install.ts`). Unauthenticated GitHub API calls are rate-limited to 60
 * requests/hour/IP, which is plenty for that occasional use.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ParsedGithubFolder {
  owner: string;
  repo: string;
  /** `null` when the input didn't name one — resolved via `resolveDefaultBranch`. */
  ref: string | null;
  path: string;
}

const GITHUB_URL_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)\/(.+?)\/?$/;

/**
 * Accepts a full GitHub URL (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`,
 * e.g. a raycast/extensions folder link) or a bare `owner/repo/path/to/folder`
 * with no explicit ref.
 */
export function parseGithubFolderUrl(input: string): ParsedGithubFolder | null {
  const trimmed = input.trim();

  const urlMatch = trimmed.match(GITHUB_URL_PATTERN);
  if (urlMatch) {
    const [, owner, repo, ref, path] = urlMatch;
    return { owner, repo, ref, path };
  }

  if (trimmed.includes("://")) return null;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [owner, repo, ...rest] = parts;
  return { owner, repo, ref: null, path: rest.join("/") };
}

const GITHUB_API = "https://api.github.com";
const DOWNLOAD_CONCURRENCY = 8;

export async function resolveDefaultBranch(
  owner: string,
  repo: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`);
  if (!res.ok) {
    throw new Error(
      `GitHub API error (${res.status}) looking up ${owner}/${repo}`,
    );
  }
  const data = (await res.json()) as { default_branch?: string };
  if (!data.default_branch)
    throw new Error(
      `GitHub API didn't return a default branch for ${owner}/${repo}`,
    );
  return data.default_branch;
}

export type FetchGithubFolderResult =
  { ok: true; files: Map<string, Buffer> } | { ok: false; error: string };

interface GithubTreeEntry {
  path: string;
  type: string;
  sha: string;
}

interface GithubTreeListing {
  tree: GithubTreeEntry[];
  truncated: boolean;
}

async function fetchTree(
  owner: string,
  repo: string,
  shaOrRef: string,
  recursive: boolean,
): Promise<
  { ok: true; listing: GithubTreeListing } | { ok: false; status: number }
> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${shaOrRef}${recursive ? "?recursive=1" : ""}`,
  );
  if (!res.ok) return { ok: false, status: res.status };
  const listing = (await res.json()) as GithubTreeListing;
  return { ok: true, listing };
}

/** Pure — splits and trims a folder path into segments, dropping any empty
 *  ones from a leading/trailing/doubled slash. */
export function splitFolderPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Walks `git/trees` one path segment at a time (non-recursive) to find
 *  the target folder's own sha without ever asking for a recursive listing of
 *  anything bigger than that folder. */
async function resolveFolderSha(
  owner: string,
  repo: string,
  branch: string,
  segments: string[],
): Promise<{ ok: true; sha: string } | { ok: false; status: number }> {
  let sha = branch;
  for (const segment of segments) {
    const result = await fetchTree(owner, repo, sha, false);
    if (!result.ok) return result;
    const entry = result.listing.tree.find(
      (e) => e.path === segment && e.type === "tree",
    );
    if (!entry) return { ok: false, status: 404 };
    sha = entry.sha;
  }
  return { ok: true, sha };
}

/** Fetches every file under `ref.path` in the repo, keyed by path relative
 *  to that folder (so `extensions/foo/package.json` -> `package.json`).
 *  Costs `segments.length + 1` API calls total, regardless of how many
 *  files the folder holds, and — since the one recursive call is rooted at
 *  the folder's own sha, never at the repo root — is immune to GitHub's
 *  tree-API truncation on huge repos like raycast/extensions. */
export async function fetchGithubFolder(
  ref: ParsedGithubFolder,
): Promise<FetchGithubFolderResult> {
  try {
    const branch = ref.ref ?? (await resolveDefaultBranch(ref.owner, ref.repo));
    const segments = splitFolderPath(ref.path);

    const resolved = await resolveFolderSha(
      ref.owner,
      ref.repo,
      branch,
      segments,
    );
    if (!resolved.ok) {
      if (resolved.status === 404) {
        return {
          ok: false,
          error: `no files found under "${ref.path}" in ${ref.owner}/${ref.repo}@${branch} — check the path`,
        };
      }
      return {
        ok: false,
        error: `GitHub API error (${resolved.status}) listing ${ref.owner}/${ref.repo}@${branch}`,
      };
    }

    const listed = await fetchTree(ref.owner, ref.repo, resolved.sha, true);
    if (!listed.ok) {
      return {
        ok: false,
        error: `GitHub API error (${listed.status}) listing ${ref.owner}/${ref.repo}@${branch}`,
      };
    }
    if (listed.listing.truncated) {
      return {
        ok: false,
        error: `GitHub truncated the listing for "${ref.path}" in ${ref.owner}/${ref.repo}@${branch} — this shouldn't happen for a single extension folder`,
      };
    }

    const blobs = listed.listing.tree.filter((entry) => entry.type === "blob");
    if (blobs.length === 0) {
      return {
        ok: false,
        error: `no files found under "${ref.path}" in ${ref.owner}/${ref.repo}@${branch} — check the path`,
      };
    }

    const path = ref.path.replace(/^\/+|\/+$/g, "");
    const files = new Map<string, Buffer>();
    // raw.githubusercontent.com is a CDN with no meaningful rate limit —
    // a few downloads in flight at once, not one at a time.
    let failure: string | null = null;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (failure === null && next < blobs.length) {
        const entry = blobs[next++];
        const rawUrl = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${path}/${entry.path}`;
        const fileRes = await fetch(rawUrl);
        if (!fileRes.ok) {
          failure = `failed to download "${entry.path}" (${fileRes.status})`;
          return;
        }
        files.set(entry.path, Buffer.from(await fileRes.arrayBuffer()));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, blobs.length) },
        worker,
      ),
    );
    if (failure !== null) return { ok: false, error: failure };
    return { ok: true, files };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeFetchedFiles(
  files: Map<string, Buffer>,
  destDir: string,
): Promise<void> {
  for (const [relativePath, content] of files) {
    const target = join(destDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
