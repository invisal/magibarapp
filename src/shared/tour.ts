/**
 * The guided tour's progress — a pure state machine shared by the main process
 * (which owns it and feeds it real events) and every renderer that draws a
 * piece of the tour. Deliberately free of Electron so it can be unit-tested.
 *
 * The tour walks the user through the real UI, one action at a time:
 *   tray → hotkey → launch → search → actions → actions-use → done
 * Each step advances only when the thing it asks for actually happens.
 */

export type TourStep =
  | "tray"
  | "hotkey"
  | "launch"
  | "search"
  /** Open the launcher's Actions menu (⌘K). */
  | "actions"
  /** The menu is open — pick something in it. Counts as part of the `actions` step number. */
  | "actions-use"
  | "done";

/** Steps that ask the user to do something (and so are numbered "Step n of 5"). */
export const TOUR_ACTION_STEPS: readonly TourStep[] = [
  "tray",
  "hotkey",
  "launch",
  "search",
  "actions",
];

/** Zero-based position of `step` among `TOUR_ACTION_STEPS`, or -1 for steps that aren't numbered (`done`). */
export function tourStepIndex(step: TourStep): number {
  return TOUR_ACTION_STEPS.indexOf(step === "actions-use" ? "actions" : step);
}

export interface TourProgress {
  /** `null` while no tour is running. */
  step: TourStep | null;
  /** The tray icon's menu is open — the `tray` step then points at "Settings" instead of the icon. */
  menuOpen: boolean;
}

/** What crosses IPC to every window: the progress plus what a card needs to print. */
export interface TourState extends TourProgress {
  /** The current global toggle shortcut, as an Electron accelerator. */
  hotkey: string;
}

export type TourEvent =
  | "menu-opened"
  | "menu-closed"
  | "settings-opened"
  | "settings-closed"
  | "hotkey-confirmed"
  | "launcher-shown"
  | "search-answered"
  /** The launcher's Actions menu opened / closed, or the user picked an item in it. */
  | "actions-opened"
  | "actions-closed"
  | "actions-used"
  /** The user pressed a card's own button (e.g. "Keep this shortcut", "Finish"). */
  | "advance";

/** The events a renderer may report to main; everything else originates in the main process itself. */
export type TourReportEvent = Extract<
  TourEvent,
  "actions-opened" | "actions-closed" | "actions-used"
>;

export const TOUR_REPORT_EVENTS: readonly TourReportEvent[] = [
  "actions-opened",
  "actions-closed",
  "actions-used",
];

export const TOUR_IDLE: TourProgress = { step: null, menuOpen: false };
export const TOUR_START: TourProgress = { step: "tray", menuOpen: false };

/** Where a tour geometry hint should place the overlay for the tray step. */
export interface CoachLayout {
  kind: "anchor" | "center";
  /** `anchor`: the tray icon's centre, in the overlay window's own coordinates. */
  ringX: number;
  ringY: number;
  /** `anchor`: whether the callout hangs below the icon (menu bar) or above it (taskbar). */
  placement: "below" | "above";
  /** Overlay window size, so the renderer can clamp the card inside it. */
  width: number;
  height: number;
}

/**
 * Advances `progress` on `event`. Events that don't apply to the current step
 * are ignored, so a stray one (Settings opened during the search step) can
 * never push the tour somewhere it shouldn't be.
 */
export function reduceTour(
  progress: TourProgress,
  event: TourEvent,
): TourProgress {
  switch (progress.step) {
    case "tray":
      if (event === "menu-opened") return { ...progress, menuOpen: true };
      if (event === "menu-closed") return { ...progress, menuOpen: false };
      if (event === "settings-opened")
        return { step: "hotkey", menuOpen: false };
      return progress;
    case "hotkey":
      if (event === "hotkey-confirmed" || event === "advance") {
        return { step: "launch", menuOpen: false };
      }
      // Closing Settings mid-step strands the highlight — send them back to find it again.
      if (event === "settings-closed") return TOUR_START;
      return progress;
    case "launch":
      if (event === "launcher-shown")
        return { step: "search", menuOpen: false };
      return progress;
    case "search":
      if (event === "search-answered")
        return { step: "actions", menuOpen: false };
      return progress;
    case "actions":
      if (event === "actions-opened")
        return { step: "actions-use", menuOpen: false };
      return progress;
    case "actions-use":
      if (event === "actions-used") return { step: "done", menuOpen: false };
      // Dismissed without picking anything: ask again.
      if (event === "actions-closed")
        return { step: "actions", menuOpen: false };
      return progress;
    case "done":
      if (event === "advance") return TOUR_IDLE;
      return progress;
    default:
      return progress;
  }
}
