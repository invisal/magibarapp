import {
  createContext,
  useContext,
  useEffect,
  useState,
  type RefObject,
} from "react";

/**
 * The scroll container of the enclosing `ListScreen`, so `useOnceVisible`
 * measures "visible" against the list's own viewport (with a `rootMargin`)
 * rather than the window's.
 */
export const ListScrollRootContext =
  createContext<RefObject<HTMLElement | null> | null>(null);

/**
 * Latches `true` the first time `ref`'s element comes within `rootMargin` of
 * the enclosing `ListScreen`'s scroll viewport, and stays `true` for the life
 * of the component. For rows that do something expensive on mount (a Widget
 * fetching its subtitle over the network): a plain list mounts every row, so
 * "on mount" would fire for the whole list — gate the work on this instead.
 */
export function useOnceVisible(
  ref: RefObject<Element | null>,
  rootMargin = "80px",
): boolean {
  const rootRef = useContext(ListScrollRootContext);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { root: rootRef?.current ?? null, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootRef, rootMargin, seen]);

  return seen;
}
