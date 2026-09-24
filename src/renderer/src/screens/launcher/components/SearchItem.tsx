import { cn } from "cnfast";
import { useEffect, useRef, useState, type ComponentPropsWithRef } from "react";
import type { LauncherAction } from "../../../../../shared/types";
import { iconSrc } from "@renderer/lib/icon";
import { ShortcutLabel } from "@renderer/shared/ui";
import { useOnceVisible } from "@renderer/shared/ui/useOnceVisible";

const TYPE_LABEL: Record<LauncherAction["type"], string> = {
  application: "Application",
  command: "Command",
  quicklink: "Quicklink",
  widget: "Widget",
  calculation: "Calculation",
  plugin: "Plugin",
};

function ItemIcon({ icon, fallback }: { icon?: string; fallback: string }) {
  const [broken, setBroken] = useState(false);

  const glyph = <span className="text-foreground-subtle">{fallback}</span>;
  const src = iconSrc(icon);

  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-lg">
      {!icon ? (
        glyph
      ) : src ? (
        broken ? (
          glyph
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            className="h-5 w-5 object-contain"
            onError={() => setBroken(true)}
          />
        )
      ) : (
        <span>{icon}</span>
      )}
    </span>
  );
}

interface SearchItemProps extends ComponentPropsWithRef<"div"> {
  action: LauncherAction;
  highlighted: boolean;
  /** The global hotkey bound to this action, if any — see `@extensions/hotkey`. Shown next to the title regardless of highlight state. */
  boundAccelerator?: string;
  /**
   * Bumping this (to any new number) tells this row to force-refresh its
   * subtitle right now, bypassing whatever staleness cache the source uses —
   * e.g. the row menu's "Refresh". `undefined` most of the time; App.tsx only
   * sets it for the one row being refreshed. Not a value store — see App.tsx.
   */
  forceRefreshToken?: number;
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border border-foreground-subtle border-t-transparent"
      aria-label="Loading"
    />
  );
}

function SearchItem({
  action,
  highlighted,
  boundAccelerator,
  className,
  forceRefreshToken,
  ...rest
}: SearchItemProps) {
  const { id, icon, title, type, shortcut, keyword, isDeferredSubtitle } =
    action;

  // This row owns both its subtitle and loading state once it's deferred —
  // `requestSubtitle` resolves with the fresh value directly (there's no
  // separate push channel to listen on instead). Seeded from the prop so a
  // freshly-mounted row shows whatever was already cached (and its correct
  // "no cache yet" loading state) instead of a blank flash. Deliberately NOT
  // `action.isLoading || pending`: `action.isLoading` is a snapshot from
  // whenever `provide()` last ran and never updates on its own, so once our
  // own fetch resolves it would stay stuck `true` forever with nothing to
  // clear it back to `false`.
  const [subtitle, setSubtitle] = useState(action.subtitle);
  const [loading, setLoading] = useState(!!action.isLoading);

  // A new `provide()` result (the user typed something, re-running the query)
  // can hand this same row a newer subtitle/loading state than what we've
  // fetched ourselves — both read the same backend cache, so the prop is
  // never *behind* our own last fetch, only possibly ahead of it.
  useEffect(() => {
    setSubtitle(action.subtitle);
    setLoading(!!action.isLoading);
  }, [action.subtitle, action.isLoading]);

  // Every row is mounted (the list isn't virtualized), so a deferred subtitle
  // — a Widget hitting its API — waits until the row first scrolls near the
  // viewport instead of firing for the whole list. The main process
  // caches/dedupes (TTL + single-flight), so re-requesting is cheap. Re-fires
  // with `force: true` when `forceRefreshToken` changes (LauncherScreen sets it
  // for exactly one row at a time, e.g. the row menu's "Refresh").
  const contentRef = useRef<HTMLDivElement>(null);
  const seen = useOnceVisible(contentRef);
  useEffect(() => {
    if (!isDeferredSubtitle || !seen) return;
    let cancelled = false;
    setLoading(true);
    const opts = forceRefreshToken !== undefined ? { force: true } : undefined;
    window.api
      .requestSubtitle(id, opts)
      .then((fresh) => {
        if (!cancelled && fresh !== undefined) setSubtitle(fresh);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isDeferredSubtitle, seen, forceRefreshToken]);

  return (
    <div
      {...rest}
      className={cn(
        "flex h-10 cursor-default items-center gap-2 rounded px-1 py-1",
        highlighted
          ? "bg-item-selected text-foreground"
          : "hover:bg-item-hover",
        className,
      )}
    >
      <ItemIcon icon={icon} fallback={type === "quicklink" ? "🔗" : "?"} />
      <div
        ref={contentRef}
        className="flex min-w-0 flex-1 items-baseline gap-2"
      >
        <span className="shrink-0 truncate">{title}</span>
        {boundAccelerator && (
          <kbd
            title="Global hotkey"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-xs text-foreground-subtle"
          >
            <ShortcutLabel accelerator={boundAccelerator} />
          </kbd>
        )}
        {shortcut && highlighted ? (
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-xs text-foreground-subtle">
            <ShortcutLabel accelerator={shortcut} />
          </kbd>
        ) : loading ? (
          <Spinner />
        ) : (
          <span className="min-w-0 truncate text-foreground-subtle font-medium">
            {subtitle}
          </span>
        )}
      </div>

      {keyword && (
        <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-sans text-xs text-foreground-subtle">
          {keyword}
        </kbd>
      )}
      <span className="shrink-0 rounded px-1.5 py-0.5 text-foreground-subtle">
        {TYPE_LABEL[type]}
      </span>
    </div>
  );
}

export default SearchItem;
