import { useEffect, useState } from "react";
import type { TourState } from "@shared/tour";

/**
 * The guided tour's live state, mirrored from the main process — `null` until
 * the first read lands. `step` is `null` when no tour is running, so callers
 * just check `tour?.step === "…"`.
 */
export function useTour(): TourState | null {
  const [state, setState] = useState<TourState | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Subscribe first, then read: a change between the two would otherwise be lost.
    const unsubscribe = window.api.tour.onState((next) => {
      cancelled = true;
      setState(next);
    });
    void window.api.tour.getState().then((initial) => {
      if (!cancelled) setState(initial);
    });
    return unsubscribe;
  }, []);

  return state;
}
