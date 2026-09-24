/** `showHUD`/`closeMainWindow`. */
import { getHostTransport } from "../host-bridge.ts";

export async function showHUD(title: string): Promise<void> {
  getHostTransport().sendEffect({ op: "hud", title });
}

export async function closeMainWindow(): Promise<void> {
  getHostTransport().sendEffect({ op: "close-main-window" });
}
