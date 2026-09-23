import { useEffect, useRef, useState } from "react";
import { Footer, ShortcutLabel, WindowsKeyIcon } from "@renderer/shared/ui";
import {
  createLoneSuperTapTracker,
  eventToAccelerator,
  isMac,
} from "@renderer/lib/shortcut";
import { iconSrc } from "@renderer/lib/icon";
import type { LauncherActionType } from "@shared/types";
import type { ActionHotkeyBinding } from "../shared/types";

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
 * The chord that force-reassigns a combo away from whatever other action
 * currently holds it (see `hasOverwritableConflict` below) — mirrors
 * `⌘⏎`/"Ctrl+Enter" conventions elsewhere for "confirm, destructively." Mac
 * routes *every* `mods+key` combo through the native capture channel while
 * recording (see the `onCaptured` handler), never through `onKeyDown`
 * directly — Windows only does that for `Win`-involving combos, so a plain
 * `Ctrl+Enter` (no `Win` held) reaches `onKeyDown` normally there. Both
 * paths check for this same string, so the gesture works either way.
 */
const OVERWRITE_ACCELERATOR = isMac() ? "Command+Return" : "Ctrl+Return";

/**
 * A short, human-readable label for the action bound to `id` — best-effort
 * only (there's no cheap general "resolve any actionId to its title" lookup
 * available here), so a conflict message can name what it'd overwrite
 * instead of just showing the raw id. Falls back to the id itself.
 */
function describeBoundAction(
  id: string,
  type: ActionHotkeyBinding["type"],
): string {
  if (type === "application") {
    const match = /\/([^/]+)\.app$/i.exec(id);
    if (match) return match[1];
  }
  if (id.startsWith("ql:")) return id.slice(3);
  if (id.startsWith("cmd:")) return id.slice(4);
  return id;
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
  // actionId -> binding for every OTHER action with a hotkey right now, plus
  // the app's own toggle shortcut — fetched once on open so a just-recorded
  // combo's conflict (if any) shows immediately, without waiting on a save
  // round-trip. Refreshed after a save attempt reports a conflict our local
  // snapshot didn't know about (e.g. it was set from another window).
  const [boundHotkeys, setBoundHotkeys] = useState<
    Record<string, ActionHotkeyBinding>
  >({});
  const [toggleAccelerator, setToggleAccelerator] = useState<string | null>(
    null,
  );

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function refreshBoundHotkeys(): void {
    void window.api.actionHotkeys.list().then(setBoundHotkeys);
    void window.api.hotkey.get().then(setToggleAccelerator);
  }
  useEffect(refreshBoundHotkeys, []);

  const isToggleConflict = pending !== null && pending === toggleAccelerator;
  const conflictingId = pending
    ? Object.keys(boundHotkeys).find(
        (id) => id !== actionId && boundHotkeys[id]?.accelerator === pending,
      )
    : undefined;
  const hasOverwritableConflict =
    !isToggleConflict && conflictingId !== undefined;

  // Read inside `onKeyDown`/`onCaptured` below the same way `pendingRef` is —
  // that effect only runs once per `actionId`/`actionType` (see its own doc
  // comment), so it needs a ref rather than closing over this render's value.
  const hasOverwritableConflictRef = useRef(hasOverwritableConflict);
  hasOverwritableConflictRef.current = hasOverwritableConflict;

  async function confirm(accelerator: string, force = false): Promise<void> {
    if (savingRef.current) return;
    setSaving(true);
    const result = await window.api.actionHotkeys.set(
      actionId,
      accelerator,
      actionType,
      force,
    );
    if (result.success) {
      onCloseRef.current();
      return;
    }
    setSaving(false);
    if (result.reason === "toggle") {
      setError("That's your toggle shortcut — change it in Settings first.");
    } else if (result.reason === "conflict") {
      // Keep `pending` so the overwrite gesture can retry immediately —
      // refresh in case our snapshot didn't already know about this
      // conflict, so the hint below picks it up right away.
      setError(null);
      refreshBoundHotkeys();
    } else {
      setPending(null);
      setError("That shortcut is already in use.");
    }
  }

  useEffect(() => {
    // A bare Meta press/release (no other key in between) isn't reachable
    // through `eventToAccelerator` — it only ever sees the keydown, and a
    // lone modifier has no accelerator-equivalent "key". Detecting that
    // needs the keyup too, tracked separately.
    const tapTracker = createLoneSuperTapTracker(
      window.api.platform === "win32" || window.api.platform === "darwin",
    );

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

      // Only reachable here on Windows, where a `Win`-free combo like
      // `Ctrl+Enter` isn't native-forwarded — see `OVERWRITE_ACCELERATOR`'s
      // doc comment for why mac instead handles this in `onCaptured` below.
      if (
        candidate === OVERWRITE_ACCELERATOR &&
        pendingRef.current &&
        hasOverwritableConflictRef.current
      ) {
        void confirm(pendingRef.current, true);
        return;
      }

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

    // `Win`/`Cmd`-involving keystrokes (a lone tap, or a `mods+key` combo)
    // never reach the listeners above at all — the OS intercepts them before
    // a plain focused window sees them. Native forwarding covers exactly
    // that gap. `tapTracker.cancel()` on every native report matters even
    // though the *reported* keystroke itself never reaches `onKeyDown`/
    // `onKeyUp` above — see `createLoneSuperTapTracker`'s doc comment: a
    // suppressed `T` inside `Command+T` never clears `tapTracker`'s solo-tap
    // candidacy the normal way, and `Command`'s own un-suppressed keyup
    // would otherwise misread the hold as a clean tap and clobber this.
    window.api.hotkey.captureStart();
    const unsubscribe = window.api.hotkey.onCaptured((candidate) => {
      tapTracker.cancel();

      // Mac's tap suppresses *every* `mods+key` combo while capturing — see
      // `OVERWRITE_ACCELERATOR`'s doc comment — so `Command+Return` reaches
      // here instead of `onKeyDown`, unlike on Windows.
      if (
        candidate === OVERWRITE_ACCELERATOR &&
        pendingRef.current &&
        hasOverwritableConflictRef.current
      ) {
        void confirm(pendingRef.current, true);
        return;
      }

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

  const overwriteHintLabel = isMac() ? "⌘⏎" : "Ctrl+Enter";
  const hint = error
    ? error
    : isToggleConflict
      ? "Used as toggle shortcut"
      : hasOverwritableConflict && conflictingId
        ? `Used by ${describeBoundAction(conflictingId, boundHotkeys[conflictingId].type)} — ${overwriteHintLabel} to reassign`
        : pending
          ? "Press Enter to confirm"
          : "Press a key combo…";

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
        <span className="max-w-full truncate px-3 text-xs text-foreground-subtle">
          {hint}
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
            shortcut={hasOverwritableConflict ? undefined : "Enter"}
            shortcutLabel={
              hasOverwritableConflict ? overwriteHintLabel : undefined
            }
            loading={saving}
            loadingLabel="Saving…"
            disabled={!pending || isToggleConflict}
            onClick={() =>
              pending && void confirm(pending, hasOverwritableConflict)
            }
          >
            {hasOverwritableConflict ? "Reassign" : "Save"}
          </Footer.Button>
        </Footer.Right>
      </Footer>
    </div>
  );
}

export default HotkeyPanel;
