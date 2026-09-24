/**
 * `Clipboard`/`open`. Writes are fire-and-forget effects; reads are a live
 * round trip to main (see `host-bridge.ts`'s `HostTransport.request`).
 * `paste` copies and — on the main side — hides the launcher so the user can
 * paste into whatever was focused before (there's no synthetic keystroke).
 */
import { getHostTransport } from "../host-bridge.ts";

type ClipboardContent =
  string | number | { text?: string; file?: string; html?: string };

function contentText(content: ClipboardContent): string {
  if (typeof content === "string") return content;
  if (typeof content === "number") return String(content);
  return content.text ?? content.file ?? content.html ?? "";
}

async function readText(): Promise<string | undefined> {
  const text = (await getHostTransport().request({
    method: "clipboard-read",
  })) as string;
  return text || undefined;
}

export const Clipboard = {
  async copy(content: ClipboardContent): Promise<void> {
    getHostTransport().sendEffect({
      op: "clipboard-copy",
      text: contentText(content),
    });
  },
  async paste(content: ClipboardContent): Promise<void> {
    getHostTransport().sendEffect({
      op: "clipboard-paste",
      text: contentText(content),
    });
  },
  async clear(): Promise<void> {
    getHostTransport().sendEffect({ op: "clipboard-clear" });
  },
  readText,
  async read(): Promise<{ text: string; file?: string; html?: string }> {
    return { text: (await readText()) ?? "" };
  },
};

/** `open(target, application?)` — `application` is a name, path, bundle id,
 *  or an `Application` object from `getApplications()`. */
export async function open(
  target: string,
  application?: string | { path?: string; name?: string; bundleId?: string },
): Promise<void> {
  const app =
    typeof application === "string"
      ? application
      : (application?.path ?? application?.bundleId ?? application?.name);
  getHostTransport().sendEffect({ op: "open", target, application: app });
}
