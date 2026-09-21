import { Fragment } from "react";
import { cn } from "cnfast";
import { isMac, shortcutTokens } from "@renderer/lib/shortcut";

/**
 * The Windows 11-style four-pane flag glyph, swapped in wherever a Win/Super
 * modifier token would otherwise render as text (see `ShortcutLabel` below)
 * — there's no single Unicode glyph for it that looks as good as ⌘ does for
 * mac, so this renders it properly instead of the "Win"/⊞ text approximation.
 * `currentColor`-filled and sized in `em` so it drops into a `<kbd>` badge or
 * a large placeholder (`HotkeyPanel`'s idle state) at whatever font-size
 * surrounds it, no separate sizing per call site.
 */
export function WindowsKeyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 88 88"
      aria-hidden
      className={cn(
        "inline-block h-[0.72em] w-[0.72em] -translate-y-[0.04em] align-middle fill-current",
        className,
      )}
    >
      <path d="M0 12.4 37.5 7.5 37.5 42 0 42.2Z" />
      <path d="M41.9 6.9 88 0 88 41.6 41.9 42Z" />
      <path d="M0 46.3 37.5 46.4 37.5 80.9 0 76Z" />
      <path d="M41.9 46.8 88 47.1 88 88 41.9 81Z" />
    </svg>
  );
}

/**
 * Renders a bound accelerator as JSX — the same tokens `formatShortcut`
 * joins into plain text, except the Win/Super token (non-mac only; mac keeps
 * its plain "⌘" glyph) renders as {@link WindowsKeyIcon} instead of text.
 * Drop-in replacement for `{formatShortcut(accelerator)}` inside a `<kbd>`
 * or similar.
 */
export function ShortcutLabel({
  accelerator,
  mac = isMac(),
}: {
  accelerator: string;
  mac?: boolean;
}) {
  const tokens = shortcutTokens(accelerator, mac);
  return (
    <>
      {tokens.map((token, i) => (
        <Fragment key={i}>
          {i > 0 && (mac ? (token.label.length > 1 ? " " : "") : "+")}
          {token.isWinKey ? <WindowsKeyIcon /> : token.label}
        </Fragment>
      ))}
    </>
  );
}
