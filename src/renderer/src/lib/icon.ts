/**
 * An action's `icon` is a plain string: an emoji, an image URL the CSP lets
 * through (`data:`), or a reference to a bundled asset (`brand:<id>`, see
 * `public/brand-icons/`). Everything that draws one goes through `iconSrc`,
 * so a new kind of icon only needs teaching to this file.
 */

const BRAND_PREFIX = "brand:";

/** The `icon` value that points at a bundled brand logo. */
export const brandIcon = (id: string): string => `${BRAND_PREFIX}${id}`;

/**
 * The `<img src>` for `icon`, or `undefined` when it's a glyph (emoji / text)
 * to render as text instead. Relative to the page like the rest of the
 * renderer's assets, so it resolves the same under the dev server and `file://`.
 */
export function iconSrc(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.startsWith(BRAND_PREFIX)) {
    const id = encodeURIComponent(icon.slice(BRAND_PREFIX.length));
    return `${import.meta.env.BASE_URL}brand-icons/${id}.svg`;
  }
  return /^(https?:|data:|file:)/.test(icon) ? icon : undefined;
}

/**
 * Whether a non-URL `icon` string is safe to render as literal text in a
 * fixed-width glyph slot (an emoji, a symbol) rather than something that
 * will overflow it. The plugin engine's shim feeds two kinds of string
 * through this same "not a loadable image" fallback that were never a
 * glyph to begin with: a bare Raycast icon name (`Icon.XmarkCircle` ->
 * `"XmarkCircle"` — real Raycast ships a bundled icon set, ours doesn't, so
 * the shim's `Icon` proxy resolves to the name itself, see
 * `plugin-engine/api-shim/src/index.ts`) and a raw filesystem path (an
 * `{fileIcon}` or a plugin passing a `.icns` path straight through). Both
 * are PascalCase-or-path text, never pure symbol/emoji — checking for any
 * ASCII letter rejects both while still allowing a genuine emoji/symbol
 * glyph through (at the cost of also rejecting a plain-letter icon like
 * `"A"`, which no current caller uses).
 */
export function isGlyphIcon(icon: string): boolean {
  return !/[a-zA-Z]/.test(icon);
}
