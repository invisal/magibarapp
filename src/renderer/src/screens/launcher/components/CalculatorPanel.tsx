import { cn } from "cnfast";
import type { ComponentPropsWithRef } from "react";
import type { Calculation } from "../../../../../shared/types";
import ExpressionTokens from "./ExpressionTokens";

/** Text the user can select and copy, despite the launcher's global `user-select: none`. */
const SELECTABLE = "cursor-text select-text";
/** `pre-wrap` keeps deliberate formatting (the multi-zone list's aligned
 *  `"  ·  "` separators) but wraps onto more lines instead of forcing a
 *  horizontal scrollbar when a value is too wide for the panel. */
const VALUE = `${SELECTABLE} whitespace-pre-wrap break-words`;

type CalculationChip = { label: string; value: string };

function Label({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-subtle">
      {children}
    </div>
  );
}

/**
 * A row of label/value chips — `Calculation.items` (every zone a multi-zone
 * country spans) or `Calculation.details` (a result's extras: "You save 16",
 * "Clock 2:30:00"; an empty label shows just the value). For `items`: one
 * `{ city, "HH:MM · GMT±N" }` pair each) — a single horizontally-scrolling
 * row of chips at a smaller size, rather than cramming N cities into the
 * single-value line at `text-2xl` or wrapping the panel to N/4 lines tall.
 * Each chip's own background (an additional 5% white layered on the panel's
 * highlight overlay) reads as a distinct object regardless of whether the
 * row itself is highlighted; the trailing `GMT±N` (split off `value` here,
 * purely for styling — the string itself is still one selectable unit)
 * stays visually secondary to the time.
 */
function ResultItems({ items }: { items: CalculationChip[] }) {
  return (
    <div
      className={`${SELECTABLE} flex min-w-0 flex-nowrap gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden`}
    >
      {items.map((item) => {
        const [time, offset] = item.value.split(" · ");
        return (
          <div
            key={`${item.label}|${item.value}`}
            className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md bg-item-hover px-2 py-1"
          >
            {item.label && (
              <span className="text-[13px] text-foreground-subtle">
                {item.label}
              </span>
            )}
            <span className="text-[13px] font-semibold text-foreground tabular-nums">
              {time}
            </span>
            {offset && (
              <span className="text-[11px] text-foreground-subtle">
                {offset}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface CalculatorPanelProps extends ComponentPropsWithRef<"div"> {
  calculation: Calculation;
  highlighted: boolean;
}

/**
 * The first row of the result list whenever a query resolves to a `Calculation`.
 * Labelled Expression / Result fields split by a rule; both values are selectable
 * so they can be copied by hand. A `footnote` (currency's "Updated 2 days ago")
 * sits bottom-right of the result. Height is intrinsic to its content, so a
 * wrapped `value` grows the panel instead of clipping — the one exception is
 * `items` (see `ResultItems`), which scrolls horizontally instead of wrapping,
 * to keep a long multi-zone listing from pushing the rest of the results down
 * the list.
 */
function CalculatorPanel({
  calculation,
  highlighted,
  className,
  ...rest
}: CalculatorPanelProps) {
  return (
    <div
      {...rest}
      className={cn(
        "flex min-h-36.5 cursor-default flex-col justify-center gap-3 rounded-lg px-4 py-3.5",
        highlighted ? "bg-item-selected" : "bg-item-hover",
        className,
      )}
    >
      <div>
        <Label>Expression</Label>
        <div className={`${VALUE} text-[15px]`}>
          {calculation.tokens ? (
            <ExpressionTokens tokens={calculation.tokens} />
          ) : (
            <span className="text-foreground">{calculation.expression}</span>
          )}
        </div>
      </div>

      <div className="border-t border-border" />

      <div>
        <Label>Result</Label>
        <div className="flex items-start justify-between gap-3">
          {calculation.items ? (
            <ResultItems items={calculation.items} />
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              <div
                className={`${VALUE} min-w-0 text-2xl font-semibold text-foreground`}
              >
                {calculation.value}
              </div>
              {calculation.details && calculation.details.length > 0 && (
                <ResultItems items={calculation.details} />
              )}
            </div>
          )}
          {calculation.footnote && (
            <div className="shrink-0 pt-1 text-[11px] text-foreground-subtle">
              {calculation.footnote}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CalculatorPanel;
