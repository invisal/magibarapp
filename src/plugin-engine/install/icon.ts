/**
 * Remote icon -> `data:` URI, for the Store results list. An icon has to be
 * inlined here, in main, since the launcher's CSP is `img-src 'self' data:`
 * and would never load a raw remote URL — same shape as
 * `quicklink/main/favicon.ts`'s `asDataUri`.
 *
 * Store icons are full-size PNGs (often 200KB+); `encode` lets the Electron
 * side downscale them (`nativeImage`) before they cross IPC, while keeping
 * this module free of Electron imports for tests.
 */

export type IconEncoder = (bytes: Uint8Array, mime: string) => string | null;

export const encodeAsIs: IconEncoder = (bytes, mime) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

const ICON_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

export async function fetchIconDataUri(
  url: string,
  opts: { fetch?: typeof fetch; encode?: IconEncoder } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetch ?? fetch;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mime.startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > ICON_MAX_BYTES) return null;
    return (opts.encode ?? encodeAsIs)(bytes, mime);
  } catch {
    return null;
  }
}
