import type { ReactNode } from "react";
import { cn } from "cnfast";
import { Footer } from "./Footer";
import { Header } from "./Header";

/**
 * A vertical page layout for framed-window screens: an optional header, a
 * scrolling content region, and a footer that stays pinned to the bottom of
 * the window.
 *
 *   <Layout>
 *     <Layout.Header title="Create Widget" onBack={onCancel} />
 *     <Layout.Content>…form…</Layout.Content>
 *     <Layout.Footer>
 *       <button>Cancel</button>
 *     </Layout.Footer>
 *   </Layout>
 *
 * Drop it straight inside `WindowFrame` — it fills the height it's given. The
 * default padding on `Content` and `Footer` can be overridden with `className`
 * (conflicting Tailwind classes win over the defaults).
 */
function LayoutRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col text-foreground", className)}
    >
      {children}
    </div>
  );
}

/** The scrolling body. */
function Content({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto p-6", className)}>
      {children}
    </div>
  );
}

export const Layout = Object.assign(LayoutRoot, { Header, Content, Footer });
