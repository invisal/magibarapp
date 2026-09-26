/**
 * The Raycast-style chrome every plugin view screen shares: the footer's
 * command badge (icon + title, bottom-left) and primary-action button
 * (bottom-right, beside Actions ⌘K), and a top-level `Detail`'s metadata
 * sidebar (label above value, as Raycast lays it out).
 */
import type { ReactNode } from "react";
import { Footer } from "@renderer/shared/ui/Footer";
import { iconSrc, isGlyphIcon } from "@renderer/lib/icon";
import type {
  PluginActionNode,
  PluginDetailMetadataItem,
} from "@plugin-engine/host/protocol";

function SmallIcon({ icon, size = 14 }: { icon: string; size?: number }) {
  const src = iconSrc(icon);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className="shrink-0 rounded-sm object-contain"
      />
    );
  }
  return isGlyphIcon(icon) ? (
    <span className="shrink-0 leading-none">{icon}</span>
  ) : null;
}

/** Footer, bottom-left: which command this is. */
export function CommandBadge({
  icon,
  title,
}: {
  icon?: string;
  title: string;
}): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {icon && <SmallIcon icon={icon} size={16} />}
      <Footer.Label className="text-foreground">{title}</Footer.Label>
    </span>
  );
}

/** Footer, bottom-right: the action ↵ (or ⌘↵ in a form) runs. */
export function PrimaryActionButton({
  action,
  shortcut,
  onInvoke,
}: {
  action: PluginActionNode | undefined;
  shortcut: string;
  onInvoke: (actionId: string) => void;
}): ReactNode {
  if (!action) return null;
  return (
    <Footer.Button
      variant="primary"
      shortcut={shortcut}
      onClick={() => onInvoke(action.id)}
    >
      {action.title}
    </Footer.Button>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[11px] font-medium text-foreground-subtle">
      {children}
    </div>
  );
}

function tagStyle(color: string | undefined) {
  return color
    ? {
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }
    : { backgroundColor: "var(--color-input)" };
}

/** A top-level `Detail`'s `metadata`, as the right-hand panel. */
export function MetadataSidebar({
  items,
}: {
  items: PluginDetailMetadataItem[];
}): ReactNode {
  return (
    <div className="space-y-3 text-xs">
      {items.map((item, i) => {
        switch (item.kind) {
          case "label":
            return (
              <div key={i}>
                <Title>{item.title}</Title>
                <div
                  className="flex min-w-0 items-center gap-1.5 font-medium"
                  style={item.color ? { color: item.color } : undefined}
                >
                  {item.icon && <SmallIcon icon={item.icon} />}
                  {item.text && (
                    <span className="min-w-0 break-words">{item.text}</span>
                  )}
                </div>
              </div>
            );
          case "tag-list":
            return (
              <div key={i}>
                <Title>{item.title}</Title>
                <div className="flex flex-wrap gap-1">
                  {item.items.map((tag, j) => (
                    <span
                      key={j}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
                      style={tagStyle(tag.color)}
                    >
                      {tag.icon && <SmallIcon icon={tag.icon} size={12} />}
                      {tag.text}
                    </span>
                  ))}
                </div>
              </div>
            );
          case "link":
            return (
              <div key={i}>
                <Title>{item.title}</Title>
                <a
                  href={item.target}
                  title={item.target}
                  className="block truncate font-medium text-accent hover:underline"
                >
                  {item.text}
                </a>
              </div>
            );
          case "separator":
            return <hr key={i} className="border-border" />;
        }
      })}
    </div>
  );
}
