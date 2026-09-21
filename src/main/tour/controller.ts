import { BrowserWindow, ipcMain, type Rectangle } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import {
  reduceTour,
  TOUR_IDLE,
  TOUR_REPORT_EVENTS,
  TOUR_START,
  type TourReportEvent,
  type TourEvent,
  type TourProgress,
  type TourState,
} from "../../shared/tour";
import {
  destroyCoach,
  hideCoach,
  registerCoachIpc,
  showCoachAtTray,
  showCoachCentered,
} from "./coach-window";

/**
 * Owns the guided tour. Everything that can move it along reports in through
 * `tourEvent` (tray menu opened, Settings opened, launcher shown, …); the
 * controller runs the pure `reduceTour`, mirrors the result to every window
 * so each can draw its own piece, and keeps the tray overlay in step.
 *
 * Collaborators are injected through `configureTour` rather than imported: the
 * tray and settings window both call back *into* here, and importing them in
 * return would make a cycle.
 */
interface TourDeps {
  /** The tray icon's on-screen rectangle; zero-sized where the OS doesn't report one (Linux). */
  getTrayBounds: () => Rectangle;
  getHotkey: () => string;
  openSettings: () => void;
  /** Persists that the user has been through (or dismissed) the tour. */
  markCompleted: () => void;
}

let deps: TourDeps | null = null;
let progress: TourProgress = TOUR_IDLE;

export function configureTour(next: TourDeps): void {
  deps = next;
}

export function isTourActive(): boolean {
  return progress.step !== null;
}

function snapshot(): TourState {
  return { ...progress, hotkey: deps?.getHotkey() ?? "" };
}

function broadcast(): void {
  const state = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.tourState, state);
  }
}

/** Puts the overlay where the current step wants it (or hides it). */
function syncCoach(): void {
  if (progress.step === "tray") {
    const bounds = deps?.getTrayBounds();
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      showCoachAtTray(bounds);
      return;
    }
    hideCoach();
    return;
  }
  // "launch" asks for the shortcut; "done" is the closing card. Both live in the
  // overlay rather than the launcher: picking an action dismisses the launcher,
  // so the closing card can't depend on it still being on screen.
  if (progress.step === "launch" || progress.step === "done") {
    showCoachCentered();
    return;
  }
  hideCoach();
}

function apply(next: TourProgress): void {
  const finished = progress.step !== null && next.step === null;
  progress = next;
  if (finished) {
    deps?.markCompleted();
    destroyCoach();
  } else if (progress.step === "tray") {
    // `watchTray` places (and re-places) the overlay itself.
    watchTray();
  } else {
    syncCoach();
  }
  broadcast();
}

/** Feed the tour something that just happened. Cheap and safe to call unconditionally. */
export function tourEvent(event: TourEvent): void {
  if (progress.step === null) return;
  const next = reduceTour(progress, event);
  if (next !== progress) apply(next);
}

/** How often to re-read the tray icon's position while the tour points at it. */
const TRAY_WATCH_MS = 150;
/** How many empty reads to tolerate before deciding the OS doesn't report a tray position at all. */
const TRAY_BOUNDS_MAX_EMPTY_READS = 20;

let trayWatch: NodeJS.Timeout | null = null;

function stopTrayWatch(): void {
  if (trayWatch) clearInterval(trayWatch);
  trayWatch = null;
}

/**
 * Keeps the overlay glued to the tray icon for as long as the tray step is
 * showing. The icon's position isn't stable: right after launch the OS hasn't
 * placed it yet (bounds read as empty), and it then shifts whenever the menu
 * bar re-flows as other apps' icons come and go. Re-reading on a short timer
 * and re-placing the overlay on any change covers both.
 *
 * Only a tray that never reports a position (Linux) falls back to opening
 * Settings for the user, which `settings-opened` turns into the next step.
 */
function watchTray(): void {
  if (trayWatch) return;
  let lastKey = "";
  let emptyReads = 0;
  trayWatch = setInterval(() => {
    if (progress.step !== "tray") return stopTrayWatch();
    const b = deps?.getTrayBounds();
    if (b && b.width > 0 && b.height > 0) {
      const key = `${b.x},${b.y},${b.width},${b.height}`;
      if (key !== lastKey) {
        lastKey = key;
        syncCoach();
      }
    } else if (lastKey === "" && ++emptyReads >= TRAY_BOUNDS_MAX_EMPTY_READS) {
      stopTrayWatch();
      deps?.openSettings();
    }
  }, TRAY_WATCH_MS);
}

/** Begins the tour at the tray step. */
export function startTour(): void {
  apply(TOUR_START);
}

/** Ends the tour early. */
export function endTour(): void {
  deps?.markCompleted();
  progress = TOUR_IDLE;
  stopTrayWatch();
  destroyCoach();
  broadcast();
}

export function registerTourIpc(): void {
  registerCoachIpc();
  ipcMain.handle(IPC_CHANNELS.tourGetState, (): TourState => snapshot());
  ipcMain.on(IPC_CHANNELS.tourAdvance, () => tourEvent("advance"));
  ipcMain.on(IPC_CHANNELS.tourReport, (_event, reported: unknown) => {
    // Renderer input: only the events a renderer is allowed to report.
    if (TOUR_REPORT_EVENTS.includes(reported as TourReportEvent)) {
      tourEvent(reported as TourReportEvent);
    }
  });
  ipcMain.on(IPC_CHANNELS.tourSkip, () => endTour());
  ipcMain.on(IPC_CHANNELS.tourReplay, () => {
    if (!isTourActive()) startTour();
  });
}
