/**
 * OS-integration APIs: applications, Finder/Explorer, trash, and the
 * selection readers. Anything needing an answer is a `request` round trip
 * to main (see `host/main-rpc.ts`'s `handleHostRequest`).
 */
import { getHostTransport } from "../host-bridge.ts";
import type { HostApplication } from "../../../host/protocol.ts";

export type Application = HostApplication;

export async function getApplications(path?: string): Promise<Application[]> {
  return (await getHostTransport().request({
    method: "get-applications",
    path,
  })) as Application[];
}

export async function getFrontmostApplication(): Promise<Application> {
  return (await getHostTransport().request({
    method: "get-frontmost-application",
  })) as Application;
}

export async function getDefaultApplication(
  path: string,
): Promise<Application> {
  return (await getHostTransport().request({
    method: "get-default-application",
    path,
  })) as Application;
}

export async function showInFinder(path: string): Promise<void> {
  getHostTransport().sendEffect({ op: "show-in-finder", path });
}

export async function trash(path: string | string[]): Promise<void> {
  await getHostTransport().request({
    method: "trash",
    paths: Array.isArray(path) ? path : [path],
  });
}

/** Real Raycast rejects both of these when nothing is selected, so
 *  extensions already handle a rejection gracefully — reading another app's
 *  selection needs accessibility plumbing Magibar doesn't have yet. */
export async function getSelectedText(): Promise<string> {
  throw new Error("Unable to get selected text: not supported in Magibar yet");
}

export async function getSelectedFinderItems(): Promise<{ path: string }[]> {
  throw new Error(
    "Unable to get selected Finder items: not supported in Magibar yet",
  );
}

export function captureException(exception: unknown): void {
  console.error("[@raycast/api shim] captureException:", exception);
}
