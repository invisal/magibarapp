/**
 * A minimal, view-agnostic shell used two ways by `PluginViewScreen`: as the
 * loading state before the first render message arrives (when a command's
 * view type — List/Detail/… — isn't known yet, so no view-specific chrome
 * can be shown), and as the error state when a command's render threw. Not
 * built on `shared/ui/ListScreen.tsx` — that's List-shaped chrome (a search
 * box, rows), wrong for either case here.
 */
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { useShortcut } from "@renderer/lib/use-shortcut";

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

export function PluginErrorScreen({
  title,
  message,
  onConfigure,
}: {
  title: string;
  /** `null`/`undefined` renders a loading state; a string renders that
   *  error message. */
  message?: string | null;
  /** Offered with an error — the fix for most failures (a missing token,
   *  a sign-in the extension can do by API key instead) is a preference. */
  onConfigure?: () => void;
}) {
  const { stack, pop } = useRouteStack();
  const canGoBack = stack.length > 1;
  useShortcut({
    Escape: pop,
    "CommandOrControl+,": message && onConfigure ? onConfigure : undefined,
  });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-2 p-1 [-webkit-app-region:drag]">
        {canGoBack && (
          <button
            type="button"
            aria-label="Back"
            onClick={pop}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-item-hover hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <BackIcon />
          </button>
        )}
        <span className="truncate px-1 text-sm font-medium">{title}</span>
      </div>
      <div className="grid flex-1 place-items-center px-6 text-center text-sm">
        {message ? (
          <div className="flex max-w-md flex-col items-center gap-3">
            <span className="text-red-500">{message}</span>
            {onConfigure ? (
              <button
                type="button"
                onClick={onConfigure}
                className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-item-hover"
              >
                Configure Extension (⌘,)
              </button>
            ) : null}
          </div>
        ) : (
          <span className="text-foreground-subtle">Loading…</span>
        )}
      </div>
    </div>
  );
}
