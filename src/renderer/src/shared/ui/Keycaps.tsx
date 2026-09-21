import { Fragment } from "react";
import { cn } from "cnfast";
import { isMac, shortcutTokens } from "@renderer/lib/shortcut";
import { WindowsKeyIcon } from "./ShortcutLabel";
import "./tour.css";

/** An accelerator drawn as big, pressable keycaps (⌘ ⇧ Space), à la a keyboard. */
export function Keycaps({
  accelerator,
  size = "lg",
  animate,
}: {
  accelerator: string;
  size?: "lg" | "sm";
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
              "tour-tile flex items-center justify-center rounded-2xl font-sans font-medium text-foreground transition-colors",
              animate && "tour-press",
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
