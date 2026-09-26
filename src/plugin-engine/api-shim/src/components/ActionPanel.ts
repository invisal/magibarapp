/**
 * `ActionPanel`/`ActionPanel.Section`. Thin wrappers around intrinsic host
 * element types (`"action-panel"` / `"action-panel-section"`) that
 * `reconciler.ts`'s host config knows how to build and serialize — see that
 * file for why components stay this thin rather than doing any work
 * themselves.
 */
import { createElement, type ReactNode } from "react";

export interface ActionPanelSectionProps {
  title?: string;
  children?: ReactNode;
}

function ActionPanelSection({ title, children }: ActionPanelSectionProps) {
  return createElement("action-panel-section", { title }, children);
}

export interface ActionPanelSubmenuProps {
  title: string;
  icon?: unknown;
  shortcut?: unknown;
  children?: ReactNode;
}

/** No nested-menu UI yet — `reconciler.ts` flattens this into a titled
 *  section of the panel, so its actions stay reachable. */
function ActionPanelSubmenu({ title, children }: ActionPanelSubmenuProps) {
  return createElement("action-panel-submenu", { title }, children);
}

export interface ActionPanelProps {
  children?: ReactNode;
}

function ActionPanelRoot({ children }: ActionPanelProps) {
  return createElement("action-panel", null, children);
}

export const ActionPanel = Object.assign(ActionPanelRoot, {
  Section: ActionPanelSection,
  Submenu: ActionPanelSubmenu,
});
