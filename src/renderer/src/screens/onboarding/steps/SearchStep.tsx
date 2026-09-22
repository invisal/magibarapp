import { useEffect, useRef, useState } from "react";
import { cn } from "cnfast";
import type { QueryResult } from "@shared/types";
import { iconSrc } from "@renderer/lib/icon";
import {
  DoneBadge,
  PrimaryButton,
  StepLayout,
  TextButton,
  type StepProps,
} from "../parts";

const SUGGESTIONS = [
  "24 * 7",
  "100 usd in eur",
  "20% of 480",
  "5pm tokyo in london",
];

function ResultIcon({ icon }: { icon?: string }) {
  const src = iconSrc(icon);
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-base">
      {src ? (
        <img src={src} alt="" className="size-5 object-contain" />
      ) : (
        <span>{icon ?? "•"}</span>
      )}
    </span>
  );
}

/** A live, miniature launcher: the query goes through the real search + calculator. */
export default function SearchStep({ onNext, direction }: StepProps) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [solved, setSolved] = useState(false);
  // Drops answers to a keystroke that's since been superseded.
  const latest = useRef(0);

  useEffect(() => {
    const query = text.trim();
    const id = ++latest.current;
    if (!query) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      window.api
        .query(query)
        .then((r) => {
          if (id !== latest.current) return;
          setResult(r);
          if (r.calculation) setSolved(true);
        })
        .catch(() => undefined);
    }, 90);
    return () => clearTimeout(timer);
  }, [text]);

  const calc = result?.calculation;
  const rows = result?.result.slice(0, calc ? 1 : 3) ?? [];

  return (
    <StepLayout
      tone="teal"
      direction={direction}
      hero={
        <div className="ob-tile w-full max-w-[420px] overflow-hidden rounded-2xl">
          <div className="flex h-12 items-center gap-3 border-b border-white/10 px-4">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
              className="shrink-0 text-foreground-subtle"
            >
              <circle
                cx="7"
                cy="7"
                r="4.75"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M10.6 10.6L14 14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder="Try  24 * 7"
              aria-label="Try a search or a calculation"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-foreground-subtle/70"
            />
          </div>
          <div className="min-h-[104px] p-1.5">
            {calc ? (
              <div className="ob-pop flex items-baseline justify-between rounded-lg bg-white/[0.07] px-3 py-3">
                <span className="truncate text-sm text-foreground-subtle">
                  {calc.expression} =
                </span>
                <span className="pl-3 text-2xl font-semibold text-foreground tabular-nums">
                  {calc.value}
                </span>
              </div>
            ) : rows.length > 0 ? (
              rows.map((row, i) => (
                <div
                  key={row.id}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-lg px-1.5",
                    i === 0 && "bg-white/[0.07]",
                  )}
                >
                  <ResultIcon icon={row.icon} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {row.title}
                  </span>
                  <span className="text-xs text-foreground-subtle capitalize">
                    {row.type}
                  </span>
                </div>
              ))
            ) : (
              <div className="flex flex-wrap gap-1.5 p-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setText(s)}
                    className="rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-xs text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      }
      title="Just start typing"
      description="Type an app's name to open it, or ask a question: maths, unit and currency conversions, dates, time zones. Answers appear as you type."
    >
      <div className="flex items-center gap-4">
        <PrimaryButton disabled={!solved} onClick={onNext}>
          Continue
        </PrimaryButton>
        {solved ? (
          <DoneBadge>Answered instantly</DoneBadge>
        ) : (
          <TextButton onClick={onNext}>Skip for now</TextButton>
        )}
      </div>
    </StepLayout>
  );
}
