import type { ReactNode } from "react";
import { cn } from "cnfast";
import { TOUR_ACTION_STEPS, tourStepIndex, type TourStep } from "@shared/tour";
import "./tour.css";

/**
 * The speech-bubble every tour step is told through. It lives in whichever
 * window the step is about, so the same card looks identical whether it hangs
 * off the tray icon, sits under the shortcut row in Settings or floats over the
 * launcher.
 */
export function TourCard({
  step,
  title,
  children,
  actions,
  className,
  arrow,
}: {
  step: TourStep;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons under the copy. */
  actions?: ReactNode;
  className?: string;
  /** A small pointer toward the thing being described, `x` px from the card's left (or `fromRight` px from its right). */
  arrow?: { side: "top" | "bottom"; x?: number; fromRight?: number };
}) {
  const index = tourStepIndex(step);
  return (
    <div
      role="dialog"
      aria-label="Guided tour"
      className={cn(
        "tour-card relative w-[300px] rounded-2xl border border-white/12 bg-popover p-4 text-foreground shadow-[0_10px_24px_-10px_rgb(0_0_0/55%),0_2px_6px_-2px_rgb(0_0_0/30%)]",
        className,
      )}
    >
      {arrow && (
        <span
          aria-hidden
          style={
            arrow.fromRight !== undefined
              ? { right: arrow.fromRight - 7 }
              : { left: (arrow.x ?? 0) - 7 }
          }
          className={cn(
            "absolute size-3.5 rotate-45 bg-popover",
            arrow.side === "top"
              ? "-top-[7px] border-t border-l border-white/12"
              : "-bottom-[7px] border-r border-b border-white/12",
          )}
        />
      )}
      <div className="flex items-center justify-between">
        {index >= 0 ? (
          <div
            className="flex items-center gap-1"
            aria-label={`Step ${index + 1} of ${TOUR_ACTION_STEPS.length}`}
          >
            {TOUR_ACTION_STEPS.map((s, i) => (
              <span
                key={s}
                className={cn(
                  "h-1 rounded-full transition-all",
                  i === index ? "w-4 bg-sky-400" : "w-1.5",
                  i < index && "bg-sky-400/60",
                  i > index && "bg-white/20",
                )}
              />
            ))}
          </div>
        ) : (
          <span className="text-[11px] font-medium tracking-wide text-green-400 uppercase">
            All done
          </span>
        )}
        {index >= 0 && (
          <button
            type="button"
            onClick={() => window.api.tour.skip()}
            className="rounded text-[11px] text-foreground-subtle transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
          >
            Skip tour
          </button>
        )}
      </div>
      <h2 className="mt-3 text-[15px] leading-snug font-semibold">{title}</h2>
      {children && (
        <div className="mt-1.5 text-[13px] leading-relaxed text-foreground-subtle">
          {children}
        </div>
      )}
      {actions && (
        <div className="mt-3.5 flex items-center gap-3">{actions}</div>
      )}
    </div>
  );
}

/** The blue action button on a `TourCard`. */
export function TourButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-lg bg-sky-500 px-3.5 text-[13px] font-medium text-white transition-colors outline-none hover:bg-sky-400 focus-visible:ring-2 focus-visible:ring-white/60"
    >
      {children}
    </button>
  );
}
