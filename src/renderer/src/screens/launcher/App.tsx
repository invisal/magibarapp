import { useEffect } from "react";
import { LauncherHostProvider } from "./host";
import { RouteStackProvider, useRouteStack } from "./router/context";
import { RouteStackOutlet } from "./router/Outlet";

/**
 * A bound action hotkey can fire while the launcher window is hidden (that's
 * the point — see `runBoundAction` in `main/index.ts`). Most actions just run
 * silently, but one that wants to navigate (e.g. it opens an editor screen)
 * has nowhere to return that request to, since there was no renderer-side
 * `execute()` call to resolve — main pushes it here instead, after revealing
 * the window itself.
 */
function HotkeyNavigateListener() {
  const { push } = useRouteStack();
  useEffect(() => window.api.actionHotkeys.onTriggerNavigate(push), [push]);
  return null;
}

/**
 * The launcher window shell. All of the search UI lives in `LauncherScreen`; it
 * is just the root entry of a navigation stack, and screens pushed on top of it
 * (Create / Edit / Duplicate Quicklink, …) render through `RouteStackOutlet`.
 * See `router/` for how the stack works and `host.tsx` for the state shared
 * across screens.
 */
function App() {
  return (
    <LauncherHostProvider>
      <RouteStackProvider>
        <HotkeyNavigateListener />
        <RouteStackOutlet />
      </RouteStackProvider>
    </LauncherHostProvider>
  );
}

export default App;
