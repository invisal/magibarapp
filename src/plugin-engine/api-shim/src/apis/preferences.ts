/** `getPreferenceValues`. Static, resolved once from what the host process
 *  was spawned with — see `context.ts` — no round trip needed. */
import { getPluginContext } from "../context.ts";

export function getPreferenceValues<
  T extends Record<string, unknown> = Record<string, unknown>,
>(): T {
  return getPluginContext().preferenceValues as T;
}
