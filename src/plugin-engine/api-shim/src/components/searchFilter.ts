/**
 * The launcher-search-driven filtering `List` and `Grid` both need, applied
 * by `reconciler.ts`'s serializer to the *committed host tree* rather than to
 * React children — so an item an extension wraps in its own component
 * (`<RepoItem />` rendering a `List.Item`) is filtered exactly like a direct
 * `List.Item`, same as real Raycast (which filters what was rendered, not
 * what was written).
 */

export interface FilterableNode {
  type: string;
  props: Record<string, unknown>;
  children: FilterableNode[];
}

function plainText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    return plainText((value as { value: unknown }).value);
  }
  return undefined;
}

/** Every whitespace-separated term of `query` must appear somewhere in the
 *  item's title, subtitle, or keywords (case-insensitive). */
export function itemMatches(
  props: Record<string, unknown>,
  query: string,
): boolean {
  const keywords = Array.isArray(props.keywords) ? props.keywords : [];
  const haystack = [
    plainText(props.title),
    plainText(props.subtitle),
    ...keywords,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/** Drops `itemType` nodes that don't match, and any `sectionType` node left
 *  empty; everything else (an empty view, a dropdown) passes through. */
export function filterHostChildren<T extends FilterableNode>(
  children: T[],
  query: string,
  itemType: string,
  sectionType: string,
): T[] {
  const result: T[] = [];
  for (const child of children) {
    if (child.type === sectionType) {
      const items = filterHostChildren(
        child.children as T[],
        query,
        itemType,
        sectionType,
      );
      if (items.some((c) => c.type === itemType)) {
        result.push({ ...child, children: items });
      }
    } else if (child.type === itemType) {
      if (itemMatches(child.props, query)) result.push(child);
    } else {
      result.push(child);
    }
  }
  return result;
}
