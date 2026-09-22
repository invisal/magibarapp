import { Fragment, type ReactNode } from "react";
import { cn } from "cnfast";
import { isMac, shortcutTokens } from "@renderer/lib/shortcut";
import { WindowsKeyIcon } from "@renderer/shared/ui";

/** Which way the tour just moved, so the incoming step slides in from the right side. */
export type Direction = "forward" | "back";

export interface StepProps {
  onNext: () => void;
  direction: Direction;
}

/**
 * One tour page: an illustrated hero on top, then title, copy and the actions.
 * Every step renders through this so the rhythm (sizes, spacing, where the
 * button sits) never drifts between pages.
 */
export function StepLayout({
  tone,
  hero,
  title,
  description,
  direction,
  children,
}: {
  tone: "blue" | "violet" | "teal" | "amber" | "green";
  hero: ReactNode;
  title: string;
  description: ReactNode;
  direction: Direction;
  /** The step's actions — buttons, hints. Sits under the copy. */
  children: ReactNode;
}) {
  return (
    <div className="ob-step flex min-h-0 flex-1 flex-col" data-dir={direction}>
      <div
        data-tone={tone}
        className="ob-hero flex h-[286px] shrink-0 items-center justify-center px-8"
      >
        {hero}
      </div>
      <div className="-mt-6 flex min-h-0 flex-1 flex-col px-9">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">
          {title}
        </h1>
        <p className="mt-2 max-w-[44ch] text-[15px] leading-relaxed text-foreground-subtle">
          {description}
        </p>
        <div className="mt-6 flex flex-col items-start gap-3">{children}</div>
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  disabled,
  onClick,
  autoFocus,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={onClick}
      className="ob-primary h-11 min-w-36 rounded-xl px-6 text-[15px] font-medium text-white transition-[filter,background] outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

export function TextButton({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded text-sm text-foreground-subtle underline-offset-4 transition-colors outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A small green tick shown once a step's task is done. */
export function DoneBadge({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="ob-pop flex items-center gap-2 rounded-full bg-green-500/15 py-1 pr-3 pl-1.5 text-sm text-green-400"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="8" className="fill-green-500/25" />
        <path
          d="M4.6 8.3l2.2 2.2 4.6-4.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </div>
  );
}

/** An accelerator drawn as big, pressable keycaps (⌘ ⇧ Space), à la a keyboard. */
export function Keycaps({
  accelerator,
  size = "lg",
  lit,
  animate,
}: {
  accelerator: string;
  size?: "lg" | "sm";
  /** Tints the caps green — "you did it". */
  lit?: boolean;
  /** Loops the press animation. */
  animate?: boolean;
}) {
  const mac = isMac();
  const tokens = shortcutTokens(accelerator, mac);
  return (
    <div className="flex items-center gap-2.5" aria-label={accelerator}>
      {tokens.map((token, i) => (
        <Fragment key={i}>
          <kbd
            className={cn(
              "ob-tile flex items-center justify-center rounded-2xl font-sans font-medium text-foreground transition-colors",
              animate && "ob-press",
              lit && "border-green-400/50 text-green-300",
              size === "lg"
                ? cn(
                    "h-[76px] text-3xl",
                    token.label.length > 2 ? "px-6 text-2xl" : "w-[76px]",
                  )
                : cn(
                    "h-8 rounded-lg text-sm",
                    token.label.length > 2 ? "px-2.5" : "w-8",
                  ),
            )}
          >
            {token.isWinKey ? <WindowsKeyIcon /> : token.label}
          </kbd>
        </Fragment>
      ))}
    </div>
  );
}

/** Simple stroked 24px icons (Lucide-style) for the feature tiles. */
export function Icon({ d, className }: { d: string[]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {d.map((path, i) => (
        <path key={i} d={path} />
      ))}
    </svg>
  );
}
