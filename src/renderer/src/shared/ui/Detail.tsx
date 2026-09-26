import { useMemo, type ReactNode } from "react";
import { cn } from "cnfast";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { iconSrc } from "@renderer/lib/icon";

/**
 * The right-hand pane of a master/detail `ListScreen` — what the highlighted
 * row *is*, at a glance, and everything known about it underneath.
 *
 *   <Detail>
 *     <Detail.Preview>
 *       <Detail.Media src={dataUrl} />
 *     </Detail.Preview>
 *     <Detail.Info>
 *       <Detail.Row label="Size" value="2.3 MB" />
 *     </Detail.Info>
 *   </Detail>
 *
 * A pane built from these parts reads the same as every other: one content
 * region that takes the space left over, then a fixed metadata block with a
 * hairline above it. Search Quicklinks is built on them; the Clipboard History
 * pane still hand-rolls its own halves and should move onto these when it's
 * next touched — the two had already drifted apart on padding, row type scale
 * and the wording of "nothing selected".
 *
 * The pane is narrow (~240–400px inside a 640px launcher), so everything here
 * is built to truncate rather than push: `Row` values clip with a tooltip,
 * `Media` contains rather than crops, `Text` scrolls in both directions.
 */

function DetailRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {children}
    </div>
  );
}

/** Nothing is highlighted (an empty list, or nothing selected yet). */
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-xs text-foreground-subtle">
      {children}
    </div>
  );
}

/**
 * The content region: takes the height the `Info` block leaves. Centered by
 * default, for a preview that is one object (an image, a file card);
 * `align="start"` for content that reads from the top-left instead (text, a
 * table, a list of folder entries).
 */
function Preview({
  align = "center",
  className,
  children,
}: {
  align?: "center" | "start";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-auto p-3",
        align === "center" ? "flex items-center justify-center" : "",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A previewed image/thumbnail — contained, never cropped or upscaled past 1×. */
function Media({ src, alt = "" }: { src: string; alt?: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="max-h-full max-w-full rounded-md object-contain shadow-lg shadow-black/30"
    />
  );
}

/**
 * Monospaced text content (a file's first lines, a copied snippet). `wrap`
 * soft-wraps long lines, for prose; the default keeps them intact and scrolls
 * sideways, so indented code still lines up.
 */
function Text({
  wrap = false,
  children,
}: {
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <pre
      className={cn(
        "w-full font-mono text-[11px] leading-[1.6] text-foreground/90",
        wrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre",
      )}
    >
      {children}
    </pre>
  );
}

/**
 * The fallback preview when the content itself can't be shown: a large icon
 * with a name and a type line under it — a `.zip`, a video with no OS
 * thumbnail, a web link. Deliberately the same shape as a real preview so the
 * pane doesn't visibly degrade into an error state.
 */
function Card({
  icon,
  title,
  subtitle,
  tone = "default",
}: {
  /** A data-URI/emoji icon, or a ready-made element. */
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** `"muted"` for a fallback the user should read as a non-result (missing file). */
  tone?: "default" | "muted";
}) {
  return (
    <div className="flex max-w-full flex-col items-center gap-2 px-2 text-center">
      <span
        className={cn(
          "grid h-14 w-14 place-items-center text-4xl",
          tone === "muted" && "opacity-60",
        )}
      >
        {typeof icon === "string" && /^(data:|file:|https?:)/i.test(icon) ? (
          // `app.getFileIcon` tops out at 32px on Windows even for
          // `size: "large"`, so the box is kept near that rather than
          // scaling a small bitmap up into a blur.
          <img src={icon} alt="" className="h-12 w-12 object-contain" />
        ) : (
          icon
        )}
      </span>
      <span className="max-w-full truncate text-sm font-medium">{title}</span>
      {subtitle != null && (
        <span className="max-w-full text-xs text-foreground-subtle">
          {subtitle}
        </span>
      )}
    </div>
  );
}

/**
 * The metadata block pinned under the preview. Caps at 45% of the pane so a
 * long list of rows can never squeeze the preview out; scrolls past that.
 */
function Info({
  title = "Information",
  className,
  children,
}: {
  /** Heading above the rows. `null` for a block that needs none. */
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "max-h-[45%] shrink-0 overflow-y-auto border-t border-border p-3",
        className,
      )}
    >
      {title != null && (
        <div className="mb-1 text-[11px] font-medium tracking-wide text-foreground-subtle uppercase">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * One `Label · value` line. Renders nothing when `value` is empty, so a pane
 * can list every field it *might* know and let the blanks fall away.
 */
function Row({
  label,
  value,
  icon,
  title,
}: {
  label: ReactNode;
  value?: ReactNode;
  /** Small image shown before the value — an app icon, a favicon. */
  icon?: string;
  /** Hover tooltip, when `value` is an abbreviation of something longer. */
  title?: string;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px] text-xs">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span
        className="flex min-w-0 items-center gap-1.5 text-right"
        title={title ?? (typeof value === "string" ? value : undefined)}
      >
        {icon && iconSrc(icon) && (
          <img
            src={iconSrc(icon)}
            alt=""
            className="h-3.5 w-3.5 shrink-0 rounded-sm"
          />
        )}
        <span className="min-w-0 truncate">{value}</span>
      </span>
    </div>
  );
}

/** Real Raycast lets a markdown image URL carry `?raycast-width=`/
 *  `&raycast-height=` to size it (capped — can only shrink, never grow past
 *  the pane) — including on a `data:` URI, where a bare `?`/`&` appended
 *  after the base64 payload isn't valid syntax on its own (base64 never
 *  contains those characters, so this split is unambiguous). Strip them off
 *  before the browser ever sees the `src`, applying them as a max-width/
 *  max-height instead. */
function stripRaycastImageSize(href: string): {
  src: string;
  maxWidth?: number;
  maxHeight?: number;
} {
  const match = href.match(
    /^(.*?)[?&](?:raycast-width=(\d+)|raycast-height=(\d+))(?:&(?:raycast-width=(\d+)|raycast-height=(\d+)))?$/,
  );
  if (!match) return { src: href };
  const [, src, w1, h1, w2, h2] = match;
  const width = w1 ?? w2;
  const height = h1 ?? h2;
  return {
    src,
    maxWidth: width ? Number(width) : undefined,
    maxHeight: height ? Number(height) : undefined,
  };
}

/** Attribute-safe escaping for the hand-built `<img>` tag below — DOMPurify
 *  sanitizes the parsed result afterward regardless, but a raw `"` in
 *  `text`/`title` breaking out of its attribute shouldn't be relied on that
 *  defense-in-depth alone to catch. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const markdownRenderer = new Marked({ breaks: true });
markdownRenderer.use({
  renderer: {
    image({ href, title, text }) {
      const { src, maxWidth, maxHeight } = stripRaycastImageSize(href);
      const style =
        maxWidth || maxHeight
          ? ` style="${maxWidth ? `max-width:${maxWidth}px;` : ""}${maxHeight ? `max-height:${maxHeight}px;` : ""}"`
          : "";
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${titleAttr}${style}>`;
    },
  },
});

/**
 * Rendered markdown (headings, bold/italic, links, images, code, lists —
 * the common subset Raycast `Detail` commands actually use), sanitized
 * before it ever reaches `dangerouslySetInnerHTML` since it comes from
 * third-party extension code. Images load from `data:` and `https:` URLs
 * (the launcher's CSP `img-src`); `file:` and plain `http:` ones don't.
 */
function Markdown({ children }: { children: string }) {
  const html = useMemo(() => {
    const parsed = markdownRenderer.parse(children, { async: false });
    return DOMPurify.sanitize(parsed);
  }, [children]);
  return (
    <div
      className="prose prose-sm max-w-none text-foreground/90 [&_a]:text-accent [&_code]:rounded [&_code]:bg-input [&_code]:px-1 [&_img]:max-w-full [&_img]:rounded-md [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-input [&_pre]:p-2"
      // eslint-disable-next-line react/no-danger -- sanitized above via DOMPurify
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** One `Label · target` line, e.g. `Detail.Metadata.Link`. */
function Link({
  label,
  text,
  target,
}: {
  label: ReactNode;
  text: string;
  target: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px] text-xs">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <a
        href={target}
        title={target}
        className="min-w-0 truncate text-right text-accent hover:underline"
      >
        {text}
      </a>
    </div>
  );
}

/** A row of colored pills, e.g. `Detail.Metadata.TagList`. */
function TagList({
  label,
  items,
}: {
  label: ReactNode;
  items: { text: string; color?: string }[];
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px] text-xs">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className="flex min-w-0 flex-wrap justify-end gap-1">
        {items.map((item, i) => (
          <span
            key={i}
            className="truncate rounded-full px-1.5 py-0.5 text-[11px]"
            style={
              item.color
                ? { backgroundColor: `${item.color}26`, color: item.color }
                : { backgroundColor: "var(--color-input)" }
            }
          >
            {item.text}
          </span>
        ))}
      </span>
    </div>
  );
}

export const Detail = Object.assign(DetailRoot, {
  Empty,
  Preview,
  Media,
  Text,
  Card,
  Info,
  Row,
  Markdown,
  Link,
  TagList,
});
