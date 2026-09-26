/**
 * A standalone top-level `Detail` command — no search bar, no rows (compare
 * `List.Item.Detail`'s pane inside `PluginListScreen`, which shares
 * `map-detail-tree.ts`'s markdown rendering with this screen).
 *
 * Laid out as Raycast does: the markdown on the left, `metadata` (if any)
 * as a panel on the right with each label above its value, and the footer
 * carrying the command (bottom-left) and its primary action (bottom-right).
 */
import { useState } from "react";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { Footer } from "@renderer/shared/ui/Footer";
import type { PluginDetailTree } from "@plugin-engine/host/protocol";
import { renderDetailMarkdown } from "./map-detail-tree";
import {
  actionPanelToMenuItems,
  actionShortcuts,
  defaultAction,
} from "./map-tree";
import {
  CommandBadge,
  MetadataSidebar,
  PrimaryActionButton,
} from "./PluginChrome";
import { usePanelShortcuts } from "./action-shortcuts";
import { isMac } from "@renderer/lib/shortcut";

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
  commandIcon,
  invokeAction,
  onBack,
}: {
  tree: PluginDetailTree;
  title: string;
  commandIcon?: string;
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
  usePanelShortcuts(tree.actionPanel, "detail", invokeAction, !menuOpen);
  const menuItems = actionPanelToMenuItems(
    tree.actionPanel,
    invokeAction,
    actionShortcuts(tree.actionPanel, "detail", isMac()),
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-1 px-2 [-webkit-app-region:drag]">
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
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-4">
          {renderDetailMarkdown(tree.markdown, tree.isLoading)}
        </div>
        {tree.metadata && tree.metadata.length > 0 && (
          <div className="w-[34%] shrink-0 overflow-y-auto border-l border-border px-4 pb-4">
            <MetadataSidebar items={tree.metadata} />
          </div>
        )}
      </div>

      <Footer>
        <Footer.Left>
          <CommandBadge
            icon={commandIcon}
            title={tree.navigationTitle ?? title}
          />
        </Footer.Left>
        <Footer.Right>
          <PrimaryActionButton
            action={defaultAction(tree.actionPanel)}
            shortcut="Enter"
            onInvoke={invokeAction}
          />
          {menuItems.length > 0 && (
            <Footer.Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={menuItems}
            />
          )}
        </Footer.Right>
      </Footer>
    </div>
  );
}
