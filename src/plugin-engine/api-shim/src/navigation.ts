/**
 * `useNavigation()` / `Action.Push` — real Raycast's view stack. The command's
 * root view and every pushed view stay mounted (so a view below keeps its
 * state, same as Raycast), each wrapped in a `"nav-frame"` host node;
 * `reconciler.ts`'s serializer only ever sends the *last* frame, so only the
 * top view's actions/dropdown/form handlers are registered and reachable.
 *
 * One `NavigationRoot` per running command instance — `createPluginRoot()`
 * wraps whatever it renders in one. `navigationController` is the imperative
 * handle `host/runtime.ts` uses for the renderer's inbound `pop` event.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ROOT_FRAME_ID, searchTextStore } from "./host-bridge.ts";

export interface Navigation {
  push(component: ReactNode, onPop?: () => void): void;
  pop(): void;
}

const noNavigation: Navigation = {
  push() {
    throw new Error(
      "useNavigation().push() is only available inside a view command",
    );
  },
  pop() {},
};

export const NavigationContext = createContext<Navigation>(noNavigation);

/** The id of the navigation frame a component renders inside — `List`/`Grid`
 *  read their search text through it (see `host-bridge.ts`'s
 *  `SearchTextStore`). */
export const FrameContext = createContext<string>(ROOT_FRAME_ID);

export function useNavigation(): Navigation {
  return useContext(NavigationContext);
}

interface Frame {
  id: string;
  element: ReactNode;
  onPop?: () => void;
}

let nextFrameId = 0;

/** Set while a `NavigationRoot` is mounted — `host/runtime.ts` calls through
 *  this for the renderer's `pop` event. */
export let navigationController: Navigation | null = null;

export function NavigationRoot({ root }: { root: ReactNode }): ReactNode {
  const [stack, setStack] = useState<Frame[]>(() => [
    { id: ROOT_FRAME_ID, element: root },
  ]);

  const push = useCallback((element: ReactNode, onPop?: () => void) => {
    const id = `frame-${++nextFrameId}`;
    searchTextStore.setTopFrame(id);
    setStack((current) => [...current, { id, element, onPop }]);
  }, []);

  const pop = useCallback(() => {
    setStack((current) => {
      if (current.length <= 1) return current;
      const popped = current[current.length - 1];
      const next = current.slice(0, -1);
      searchTextStore.dropFrame(popped.id);
      searchTextStore.setTopFrame(next[next.length - 1].id);
      // Deferred: `onPop` typically sets state in the view below, which
      // mustn't happen inside this state updater.
      if (popped.onPop) queueMicrotask(popped.onPop);
      return next;
    });
  }, []);

  const navigation = useMemo<Navigation>(() => ({ push, pop }), [push, pop]);
  navigationController = navigation;

  return createElement(
    NavigationContext.Provider,
    { value: navigation },
    stack.map((frame) =>
      createElement(
        "nav-frame",
        { key: frame.id, frameId: frame.id },
        createElement(
          FrameContext.Provider,
          { value: frame.id },
          frame.element,
        ),
      ),
    ),
  );
}
