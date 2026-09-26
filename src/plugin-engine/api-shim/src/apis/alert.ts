/**
 * `confirmAlert`/`Alert`. Backed by a native OS dialog (`host/main-rpc.ts`'s
 * `showConfirmAlert`, via Electron's `dialog.showMessageBox`) rather than a
 * rendered React tree — real Raycast's alert isn't part of a command's own
 * `List`/`Detail` output, so there's no reconciler tree to build here.
 *
 * A genuine round trip to main and back in both modes (see `host-bridge.ts`'s
 * `HostTransport.request`).
 */
import { getHostTransport } from "../host-bridge.ts";

export const AlertActionStyle = {
  Default: "default",
  Destructive: "destructive",
  Cancel: "cancel",
} as const;

export type AlertActionStyleValue =
  (typeof AlertActionStyle)[keyof typeof AlertActionStyle];

export interface AlertActionOptions {
  title: string;
  /** Accepted for signature compatibility; a native dialog button can't be
   *  styled per-action, so this doesn't change how it renders. */
  style?: AlertActionStyleValue;
  onAction?: () => void | Promise<void>;
}

export interface AlertOptions {
  title: string;
  message?: string;
  /** Accepted for signature compatibility — see `AlertActionOptions.style`. */
  icon?: unknown;
  primaryAction?: AlertActionOptions;
  dismissAction?: AlertActionOptions;
}

export const Alert = { ActionStyle: AlertActionStyle };

export async function confirmAlert(options: AlertOptions): Promise<boolean> {
  const confirmed = (await getHostTransport().request({
    method: "confirm-alert",
    options: {
      title: options.title,
      message: options.message,
      primaryActionTitle: options.primaryAction?.title,
      dismissActionTitle: options.dismissAction?.title,
    },
  })) as boolean;
  if (confirmed) await options.primaryAction?.onAction?.();
  else await options.dismissAction?.onAction?.();
  return confirmed;
}
