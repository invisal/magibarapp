import { useEffect, useState } from "react";
import { cn } from "cnfast";
import { useTour } from "@renderer/lib/use-tour";
import {
  onFooterMenuEvent,
  ShortcutLabel,
  TourCard,
} from "@renderer/shared/ui";

/** Things worth typing, offered as one-click chips on the search step. */
const EXAMPLES = ["24 * 7", "20% of 480", "safari"] as const;

/**
 * Types `text` into the launcher's search box the way a user would, so React
 * (and the list under it) sees a real input event. The search box is the first
 * `<input>` in the window — the Actions menu's own field mounts later, in a portal.
 */
function typeIntoSearch(text: string): void {
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) return;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setValue?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

/** The on-screen rectangle of the first element matching `selector`, kept fresh while `active`. */
function useTargetRect(selector: string, active: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!active) return setRect(null);
    const measure = (): void => {
      const next =
        document.querySelector(selector)?.getBoundingClientRect() ?? null;
      setRect((prev) =>
        prev &&
        next &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };
    measure();
    const timer = setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [selector, active]);
  return rect;
}

/** Space kept between the halo and the window edge, so its ring is never clipped. */
const HALO_EDGE_GAP = 4;

/**
 * A halo around the Actions button. That button sits in the window's bottom-right
 * corner, so a halo padded outward (and its glow) would run off the window and be
 * cut into a straight edge — instead it hugs the button and is clamped to stay
 * inside the window, with a tight glow (`tour-focus--tight`).
 */
function TriggerHalo({ rect }: { rect: DOMRect }) {
  const left = Math.max(rect.left - 2, HALO_EDGE_GAP);
  const top = Math.max(rect.top - 2, HALO_EDGE_GAP);
  const right = Math.min(rect.right + 2, window.innerWidth - HALO_EDGE_GAP);
  const bottom = Math.min(rect.bottom + 2, window.innerHeight - HALO_EDGE_GAP);
  return (
    <div
      className="tour-focus tour-focus--tight fixed rounded-md"
      style={{ left, top, width: right - left, height: bottom - top }}
    />
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-foreground">
      {children}
    </kbd>
  );
}

/**
 * The guided tour's launcher steps, drawn over the real launcher: a halo on the
 * search bar while it asks for a query, then on the Actions button and the
 * menu it opens (the closing card lives in the overlay window — see `Coach`).
 * Pointer-transparent everywhere except the cards, so the launcher
 * underneath stays fully usable.
 */
export default function LauncherTour() {
  const tour = useTour();
  const step = tour?.step;
  const inActions = step === "actions" || step === "actions-use";

  // While the actions steps are showing, tell main what the Actions menu does.
  useEffect(() => {
    if (!inActions) return;
    const offs = [
      onFooterMenuEvent("open", () => window.api.tour.report("actions-opened")),
      onFooterMenuEvent("close", () =>
        window.api.tour.report("actions-closed"),
      ),
      onFooterMenuEvent("choose", () => window.api.tour.report("actions-used")),
    ];
    return () => offs.forEach((off) => off());
  }, [inActions]);

  const trigger = useTargetRect(
    '[data-tour="actions-trigger"]',
    step === "actions",
  );

  if (step !== "search" && step !== "actions" && step !== "actions-use") {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {step === "search" && (
        <div className="tour-focus absolute inset-x-2 top-1.5 h-[50px] rounded-xl" />
      )}
      {trigger && <TriggerHalo rect={trigger} />}

      <div
        className={cn(
          "absolute bottom-12 flex",
          // The Actions popup opens over the bottom-right, so the cards that
          // coexist with it keep to the left; the rest can sit centred / right.
          step === "search" && "inset-x-0 justify-center",
          step === "actions" && "right-3",
          step === "actions-use" && "left-3",
        )}
      >
        <div className="pointer-events-auto">
          {step === "search" && (
            <TourCard
              step="search"
              className="w-[540px]"
              title="Type anything to search"
              actions={
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-foreground-subtle">
                  <span>Try</span>
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => typeIntoSearch(example)}
                      className="rounded-full border border-white/12 bg-white/6 px-2.5 py-1 font-sans text-foreground transition-colors outline-none hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-sky-400/70"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              }
            >
              Maths, conversions and app names all work from the same box.
            </TourCard>
          )}

          {step === "actions" && (
            <TourCard
              step="actions"
              className="w-[330px]"
              arrow={{ side: "bottom", fromRight: 52 }}
              title="Open the Actions menu"
            >
              Every result has actions of its own. Press{" "}
              <Kbd>
                <ShortcutLabel accelerator="CommandOrControl+K" />
              </Kbd>{" "}
              or click the highlighted button.
            </TourCard>
          )}

          {step === "actions-use" && (
            <TourCard
              step="actions-use"
              className="w-[310px]"
              title="Now pick one"
            >
              Everything here acts on the highlighted result. Use ↑ ↓ and Enter,
              or just click one, to continue.
            </TourCard>
          )}
        </div>
      </div>
    </div>
  );
}
