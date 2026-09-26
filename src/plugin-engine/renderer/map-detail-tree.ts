/**
 * Turns a `PluginDetailBody` (from `host/protocol.ts`) into `shared/ui/Detail.tsx`
 * elements — shared by `PluginListScreen`'s master/detail pane
 * (`List.Item.Detail`) and, once it lands, `PluginDetailScreen` (a top-level
 * `Detail` command).
 */
import { createElement, Fragment, type ReactNode } from "react";
import type { PluginDetailMetadataItem } from "@plugin-engine/host/protocol";
import { Detail } from "@renderer/shared/ui/Detail";

export function renderDetailMarkdown(
  markdown: string | undefined,
  isLoading: boolean | undefined,
): ReactNode {
  if (markdown) return createElement(Detail.Markdown, null, markdown);
  if (isLoading) return null;
  return createElement(Detail.Empty, null, "Nothing to show.");
}

export function renderDetailMetadata(
  items: PluginDetailMetadataItem[] | undefined,
): ReactNode {
  if (!items || items.length === 0) return null;
  return createElement(
    Fragment,
    null,
    items.map((item, i) => {
      switch (item.kind) {
        case "label":
          return createElement(Detail.Row, {
            key: i,
            label: item.title,
            value: item.text,
            icon: item.icon,
          });
        case "tag-list":
          return createElement(Detail.TagList, {
            key: i,
            label: item.title,
            items: item.items,
          });
        case "link":
          return createElement(Detail.Link, {
            key: i,
            label: item.title,
            text: item.text,
            target: item.target,
          });
        case "separator":
          return createElement("hr", {
            key: i,
            className: "my-1.5 border-border",
          });
      }
    }),
  );
}
