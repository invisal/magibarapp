import { useEffect, useState } from "react";
import type { CoachLayout } from "@shared/tour";
import { useTour } from "@renderer/lib/use-tour";
import { Keycaps, TourButton, TourCard } from "@renderer/shared/ui";

const isMac = window.api.platform === "darwin";
const CARD_WIDTH = 300;
/** Space kept between the card and the overlay window's edge, so its drop shadow is never clipped into a straight line. */
const SHADOW_MARGIN = 24;
/** Extra distance the callout keeps from the icon while the tray menu is open, so it clears the menu. */
const MENU_CLEARANCE = 108;

/**
 * The tour overlay window's whole UI. It's transparent and click-through; the
 * only interactive thing is the card, which asks main for clicks while hovered.
 */
export default function Coach() {
  const tour = useTour();
  const [layout, setLayout] = useState<CoachLayout | null>(null);

  useEffect(() => window.api.tour.onCoachLayout(setLayout), []);

  if (!tour || !layout) return null;

  const hover = (interactive: boolean) => ({
    onMouseEnter: () => window.api.tour.setCoachInteractive(interactive),
    onMouseLeave: () => window.api.tour.setCoachInteractive(false),
  });

  if (tour.step === "launch" && layout.kind === "center") {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <div {...hover(true)}>
          <TourCard
            step="launch"
            className="w-[360px]"
            title="Now try it — press your shortcut"
            actions={undefined}
          >
            <div className="mt-1 flex flex-col items-start gap-3">
              <Keycaps accelerator={tour.hotkey} size="sm" animate />
              <span>
                Do it from any app — Magibar opens right where you are.
              </span>
            </div>
          </TourCard>
        </div>
      </div>
    );
  }

  if (tour.step === "done" && layout.kind === "center") {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <div {...hover(true)}>
          <TourCard
            step="done"
            className="w-[380px]"
            title="You're all set"
            actions={
              <TourButton onClick={() => window.api.tour.advance()}>
                Finish
              </TourButton>
            }
          >
            That's the loop: open it, type, act. Convert currencies, snap
            windows, search your clipboard — just start typing. You can replay
            this tour from Settings.
          </TourCard>
        </div>
      </div>
    );
  }

  if (tour.step !== "tray" || layout.kind !== "anchor") return null;

  const below = layout.placement === "below";
  const gap = 30 + (tour.menuOpen ? MENU_CLEARANCE : 0);
  // The tray menu drops down to the right of the icon, so once it's open the
  // card slides left to sit under the menu's labels and points at them.
  const anchorX = tour.menuOpen ? layout.ringX + 50 : layout.ringX;
  const cardLeft = Math.min(
    Math.max(
      tour.menuOpen ? layout.ringX - 40 : layout.ringX - CARD_WIDTH / 2,
      SHADOW_MARGIN,
    ),
    layout.width - CARD_WIDTH - SHADOW_MARGIN,
  );
  const place = isMac ? "menu bar" : "system tray";
  const verb = isMac ? "Click" : "Right-click";

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Hidden while the menu is open — the OS already highlights the icon then. */}
      {!tour.menuOpen && (
        <div
          className="tour-ring"
          style={{ left: layout.ringX, top: layout.ringY }}
        />
      )}
      <div
        {...hover(true)}
        className="absolute"
        style={{
          left: cardLeft,
          ...(below
            ? { top: layout.ringY + gap }
            : { bottom: layout.height - layout.ringY + gap }),
        }}
      >
        <div className="tour-nudge">
          <TourCard
            step="tray"
            arrow={{
              side: below ? "top" : "bottom",
              x: anchorX - cardLeft,
            }}
            title={
              tour.menuOpen ? (
                <>
                  Now choose <span className="text-sky-300">Settings</span>
                </>
              ) : (
                <>
                  Find Magibar in your{" "}
                  <span className="text-sky-300">{place}</span>
                </>
              )
            }
          >
            {tour.menuOpen
              ? "This is where you'll find Settings, and where you can quit Magibar."
              : `${verb} the highlighted icon. Magibar runs quietly from here, so there's no Dock window to look for.`}
          </TourCard>
        </div>
      </div>
    </div>
  );
}
