/**
 * Top-level `Detail` (a standalone view, not `List.Item.Detail` — see
 * `components/List.ts` for that one, which shares `Metadata` with this file).
 */
import { createElement, type ReactNode } from "react";
import { Metadata } from "./DetailMetadata.ts";

export interface DetailProps {
  isLoading?: boolean;
  navigationTitle?: string;
  markdown?: string;
  metadata?: ReactNode;
  /** An `<ActionPanel>` element — passed through as a child, not a prop,
   *  same as `List.Item`'s `actions`. */
  actions?: ReactNode;
}

function DetailRoot({
  isLoading,
  navigationTitle,
  markdown,
  metadata,
  actions,
}: DetailProps) {
  return createElement(
    "detail",
    { isLoading, navigationTitle, markdown },
    metadata,
    actions,
  );
}

export const Detail = Object.assign(DetailRoot, { Metadata });
