/**
 * `popToRoot`/`clearSearchBar`. Both fire-and-forget, and both a genuine
 * no-op (not an error) outside List mode — a no-view command has no screen
 * pushed and no search bar to begin with, so there's nothing to collapse or
 * reset (see `host-bridge.ts`'s `HostTransport` doc comment).
 */
import { getHostTransport } from "../host-bridge.ts";

export async function popToRoot(): Promise<void> {
  getHostTransport().popToRoot();
}

export async function clearSearchBar(): Promise<void> {
  getHostTransport().clearSearchBar();
}
