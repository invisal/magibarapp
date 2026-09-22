import { useCallback, useEffect, useState } from "react";
import {
  createLoneSuperTapTracker,
  eventToAccelerator,
} from "@renderer/lib/shortcut";

/**
 * Shared state for the "toggle shortcut" recorder (Settings → General, and the
 * onboarding tour): reads the bound accelerator, records a new one on demand
 * and reports why a rebind was refused.
 */
export function useHotkeyRecorder(): {
  hotkey: string | null;
  recording: boolean;
  error: string | null;
  startRecording: () => void;
  stopRecording: () => void;
} {
  const [hotkey, setHotkey] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api.hotkey.get().then(setHotkey);
  }, []);

  const applyHotkey = useCallback(async (accelerator: string) => {
    setRecording(false);
    setError(null);
    const result = await window.api.hotkey.set(accelerator);
    setHotkey(result.hotkey);
    setError(
      result.success
        ? null
        : "That shortcut is already in use — kept the previous one.",
    );
  }, []);

  useEffect(() => {
    if (!recording) return;

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
        setRecording(false);
        return;
      }

      const accelerator = eventToAccelerator(e);
      if (!accelerator) return;

      void applyHotkey(accelerator);
    }

    function onKeyUp(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      const accelerator = tapTracker.onKeyUp(e);
      if (accelerator) void applyHotkey(accelerator);
    }

    // If the window ever goes to the background while recording, treat it as
    // Escape rather than leaving every key swallowed until the user comes
    // back and remembers to cancel it themselves.
    function onVisibilityChange(): void {
      if (document.hidden) setRecording(false);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // `Win`/`Cmd`-involving keystrokes (a lone tap, or a `mods+key` combo)
    // never reach the listeners above at all — the OS intercepts them before
    // a plain focused window sees them, the same problem `RegisterHotKey`
    // has for *registering* one. Native forwarding covers exactly that gap.
    // `tapTracker.cancel()` on every native report matters even though the
    // *reported* keystroke itself never reaches `onKeyDown`/`onKeyUp` above —
    // see `createLoneSuperTapTracker`'s doc comment: a suppressed `T` inside
    // `Command+T` never clears `tapTracker`'s solo-tap candidacy the normal
    // way, and `Command`'s own un-suppressed keyup would otherwise misread
    // the hold as a clean tap and clobber this.
    window.api.hotkey.captureStart();
    const unsubscribe = window.api.hotkey.onCaptured((accelerator) => {
      tapTracker.cancel();
      void applyHotkey(accelerator);
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.api.hotkey.captureStop();
      unsubscribe();
    };
  }, [recording, applyHotkey]);

  return {
    hotkey,
    recording,
    error,
    startRecording: () => {
      setError(null);
      setRecording(true);
    },
    stopRecording: () => setRecording(false),
  };
}
