import { createScreen } from "@renderer/screens/launcher/router/createScreen";
import XcodeCleanScreen from "./renderer/XcodeCleanScreen";
import { XCODE_CLEAN_ROUTE } from "./shared/types";

/** The Clean Xcode list, which lives in `./renderer` and knows nothing about the router. */
function XcodeClean() {
  return <XcodeCleanScreen />;
}

export default [
  createScreen({
    name: XCODE_CLEAN_ROUTE,
    component: () => <XcodeClean />,
  }),
];
