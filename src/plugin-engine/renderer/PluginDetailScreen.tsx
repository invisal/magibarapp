/**
 * A standalone top-level `Detail` command — no search bar, no rows (compare
 * `List.Item.Detail`'s pane inside `PluginListScreen`, which shares
 * `map-detail-tree.ts`'s rendering helpers with this screen).
 *
 * v1 layout simplification: markdown and metadata stack vertically (via
 * `shared/ui/Detail.tsx`'s existing `Preview`/`Info` primitives — the same
 * ones the master/detail pane already uses), rather than a side-by-side
 * markdown/metadata split the way real Raycast's `Detail` usually lays out.
 * Revisit if that reads wrong for a common case.
 */
import { useState } from "react";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { Detail } from "@renderer/shared/ui/Detail";
import { Footer } from "@renderer/shared/ui/Footer";
import type { PluginDetailTree } from "@plugin-engine/host/protocol";
import { renderDetailMarkdown, renderDetailMetadata } from "./map-detail-tree";
import { actionPanelToMenuItems } from "./map-tree";

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 3.5L4.5 8l5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PluginDetailScreen({
  tree,
  title,
  invokeAction,
  onBack,
}: {
  tree: PluginDetailTree;
  title: string;
  invokeAction: (actionId: string) => void;
  /** Back/Escape — defaults to popping the launcher route; a pushed plugin
   *  view passes its own (pop the plugin's navigation stack). */
  onBack?: () => void;
}) {
  const { stack, pop } = useRouteStack();
  const back = onBack ?? pop;
  const canGoBack = stack.length > 1 || !!onBack;
  const [menuOpen, setMenuOpen] = useState(false);
  // Escape closes the actions menu first while it's open.
  useShortcut({ Escape: !menuOpen && back });
  const menuItems = actionPanelToMenuItems(tree.actionPanel, invokeAction);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-2 p-1 [-webkit-app-region:drag]">
        {canGoBack && (
          <button
            type="button"
            aria-label="Back"
            onClick={back}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-item-hover hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <BackIcon />
          </button>
        )}
        <span className="truncate px-1 text-sm font-medium">
          {tree.navigationTitle ?? title}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <Detail>
          <Detail.Preview align="start">
            {renderDetailMarkdown(tree.markdown, tree.isLoading)}
          </Detail.Preview>
          {tree.metadata && (
            <Detail.Info title={null}>
              {renderDetailMetadata(tree.metadata)}
            </Detail.Info>
          )}
        </Detail>
      </div>

      <Footer>
        {menuItems.length > 0 && (
          <Footer.Right>
            <Footer.Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={menuItems}
            />
          </Footer.Right>
        )}
      </Footer>
    </div>
  );
}
