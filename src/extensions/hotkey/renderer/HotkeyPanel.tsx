import { useEffect, useRef, useState } from "react";
import { Footer, ShortcutLabel, WindowsKeyIcon } from "@renderer/shared/ui";
import {
  createLoneSuperTapTracker,
  eventToAccelerator,
  isMac,
} from "@renderer/lib/shortcut";
import { iconSrc } from "@renderer/lib/icon";
import type { LauncherActionType } from "@shared/types";

interface HotkeyPanelProps {
  actionId: string;
  actionType: LauncherActionType;
  title: string;
  icon?: string;
  /** The accelerator already bound to this action, if any. */
  current?: string;
  onClose: () => void;
}

/**
 * The content of the "Set/Change Hotkey" row's `panel` (see `renderer/context-menu.tsx`)
 * — captures the next key combo directly, rather than a text input. The
 * window-level capture-phase listener is set up once per mount (`pending`,
 * `saving` and `onClose` are read from refs inside it, not closed over
 * directly) so a parent re-render handing this a new-but-equivalent `onClose`
 * closure — which happens on every unrelated `LauncherScreen` render while
 * this panel is open — never tears down and re-adds the listener; doing that
 * on a `window`-level capture listener risked a keystroke slipping through
 * during the gap. Escape (here or "Cancel") cancels; Enter (here or "Save")
 * confirms.
 */
function HotkeyPanel({
  actionId,
  actionType,
  title,
  icon,
  current,
  onClose,
}: HotkeyPanelProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  async function confirm(accelerator: string): Promise<void> {
    if (savingRef.current) return;
    setSaving(true);
    const result = await window.api.actionHotkeys.set(
      actionId,
      accelerator,
      actionType,
    );
    if (result.success) {
      onCloseRef.current();
    } else {
      setSaving(false);
      setPending(null);
      setError("That shortcut is already in use.");
    }
  }

  useEffect(() => {
    // A bare Meta press/release (no other key in between) isn't reachable
    // through `eventToAccelerator` — it only ever sees the keydown, and a
    // lone modifier has no accelerator-equivalent "key". Detecting that
    // needs the keyup too, tracked separately.
    const tapTracker = createLoneSuperTapTracker();

    function onKeyDown(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      tapTracker.onKeyDown(e);
      if (e.repeat) return;

      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }

      // Bare Enter (no modifiers) confirms the pending combo — with a
      // modifier held, `eventToAccelerator` below claims it as a candidate
      // instead (e.g. binding Cmd+Enter itself is still possible).
      if (
        e.key === "Enter" &&
        pendingRef.current &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        void confirm(pendingRef.current);
        return;
      }

      const candidate = eventToAccelerator(e);
      if (!candidate) return;
      setError(null);
      setPending(candidate);
    }

    function onKeyUp(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      const candidate = tapTracker.onKeyUp(e);
      if (!candidate) return;
      setError(null);
      setPending(candidate);
    }

    // The launcher window is only ever hidden (blur-to-hide on a click
    // away, or after running an action), never unmounted or reloaded — so a
    // panel left open mid-recording would otherwise never run this effect's
    // cleanup at all, leaving these `window`-level listeners (which
    // unconditionally swallow every keydown/keyup while recording) attached
    // forever: every key stops working, in every window, until the app
    // restarts, since nothing ever calls `captureStop()` either. Electron
    // marks a hidden `BrowserWindow`'s page hidden for the Page Visibility
    // API, so this fires reliably right when that happens — treated the same
    // as pressing Escape.
    function onVisibilityChange(): void {
      if (document.hidden) onCloseRef.current();
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // `Win`-involving keystrokes (a lone tap, or `Win+<key>`) never reach the
    // listeners above at all — the OS intercepts them before a plain focused
    // window sees them. Native forwarding covers exactly that gap; a key
    // that doesn't involve `Win` never comes through this channel, only the
    // ones above, so there's no double-apply between the two paths.
    window.api.hotkey.captureStart();
    const unsubscribe = window.api.hotkey.onCaptured((candidate) => {
      setError(null);
      setPending(candidate);
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.api.hotkey.captureStop();
      unsubscribe();
    };
  }, [actionId, actionType]);

  const imageSrc = iconSrc(icon);

  return (
    <div className="flex flex-col gap-3 p-3 [-webkit-app-region:no-drag]">
      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground-subtle">
        {icon &&
          (imageSrc ? (
            <img
              src={imageSrc}
              alt=""
              className="h-3.5 w-3.5 shrink-0 object-contain"
            />
          ) : (
            <span className="shrink-0">{icon}</span>
          ))}
        <span className="truncate">
          {current ? "Change Hotkey" : "Set Hotkey"} — {title}
        </span>
      </div>
      <div className="flex flex-col items-center justify-center gap-1.5 rounded border border-border bg-input py-5">
        <span className="text-lg text-foreground">
          {pending ? (
            <ShortcutLabel accelerator={pending} />
          ) : isMac() ? (
            "⌘"
          ) : (
            <WindowsKeyIcon />
          )}
        </span>
        <span className="text-xs text-foreground-subtle">
          {error ?? (pending ? "Press Enter to confirm" : "Press a key combo…")}
        </span>
      </div>
      <Footer>
        <Footer.Left>
          <Footer.Button shortcutLabel="Esc" onClick={onClose}>
            Cancel
          </Footer.Button>
        </Footer.Left>
        <Footer.Right>
          <Footer.Button
            variant="primary"
            shortcut="Enter"
            loading={saving}
            loadingLabel="Saving…"
            disabled={!pending}
            onClick={() => pending && void confirm(pending)}
          >
            Save
          </Footer.Button>
        </Footer.Right>
      </Footer>
    </div>
  );
}

export default HotkeyPanel;
