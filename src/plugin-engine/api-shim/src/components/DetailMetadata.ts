/**
 * `Detail.Metadata` (and `List.Item.Detail.Metadata`, which re-exports this
 * same object — see `components/List.ts`). Shared so top-level `Detail`
 * (`components/Detail.ts`) doesn't duplicate it.
 */
import { createElement, type ReactNode } from "react";

function MetadataRoot({ children }: { children?: ReactNode }) {
  return createElement("detail-metadata", null, children);
}

export interface MetadataLabelProps {
  title: string;
  text?: string;
  icon?: string;
}

function Label(props: MetadataLabelProps) {
  return createElement("detail-metadata-label", props);
}

export interface MetadataTagListItemProps {
  text: string;
  color?: string;
}

function TagListItem(props: MetadataTagListItemProps) {
  return createElement("detail-metadata-taglist-item", props);
}

export interface MetadataTagListProps {
  title: string;
  children?: ReactNode;
}

function TagList({ title, children }: MetadataTagListProps) {
  return createElement("detail-metadata-taglist", { title }, children);
}

export interface MetadataLinkProps {
  title: string;
  target: string;
  text: string;
}

function Link(props: MetadataLinkProps) {
  return createElement("detail-metadata-link", props);
}

function Separator() {
  return createElement("detail-metadata-separator", null);
}

export const Metadata = Object.assign(MetadataRoot, {
  Label,
  TagList: Object.assign(TagList, { Item: TagListItem }),
  Link,
  Separator,
});
