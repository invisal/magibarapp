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
import { iconSrc } from "@renderer/lib/icon";
import type { PluginAuthRequest } from "@plugin-engine/host/protocol";

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
  auth,
}: {
  title: string;
  /** `null`/`undefined` renders a loading state; a string renders that
   *  error message. */
  message?: string | null;
  /** Offered with an error — the fix for most failures (a missing token,
   *  a sign-in the extension can do by API key instead) is a preference. */
  onConfigure?: () => void;
  /** The error is a sign-in the extension needs — shows a provider card
   *  instead of the raw message. */
  auth?: PluginAuthRequest | null;
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
        {message && auth ? (
          <AuthRequired auth={auth} onConfigure={onConfigure} />
        ) : message ? (
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

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="7"
        width="9"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.5 7V5.5a2.5 2.5 0 015 0V7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Raycast's sign-in screen, minus the browser flow Magibar can't run: the
 *  provider, what the extension wants it for, and the one thing the user
 *  can actually do — paste an access token into the extension's preferences. */
function AuthRequired({
  auth,
  onConfigure,
}: {
  auth: PluginAuthRequest;
  onConfigure?: () => void;
}) {
  const src = iconSrc(auth.icon);
  return (
    <div className="flex max-w-sm flex-col items-center gap-4">
      <div className="flex items-center">
        <div className="z-10 grid h-16 w-16 place-items-center overflow-hidden rounded-full border border-border bg-item-hover">
          {src ? (
            <img src={src} alt="" className="h-9 w-9 object-contain" />
          ) : (
            <span className="text-2xl font-semibold">
              {auth.providerName.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="-ml-3 grid h-11 w-11 place-items-center rounded-full border border-border bg-background text-foreground-subtle">
          <LockIcon />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{auth.providerName}</h2>
        <p className="text-foreground-subtle">
          {auth.description || `Sign in to ${auth.providerName} to continue.`}
        </p>
      </div>
      <p className="text-xs text-foreground-subtle">
        Browser sign-in isn't available in Magibar yet. If this extension
        supports an access token, add it in the extension's preferences.
      </p>
      {onConfigure ? (
        <button
          type="button"
          onClick={onConfigure}
          className="rounded-md border border-border bg-item-hover px-4 py-1.5 text-sm font-medium text-foreground hover:bg-white/10"
        >
          Open Preferences (⌘,)
        </button>
      ) : null}
    </div>
  );
}
