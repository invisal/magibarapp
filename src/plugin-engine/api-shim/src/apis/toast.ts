/**
 * `showToast`/`Toast`. Shown in the command's own screen for a view command,
 * or as a native OS notification for a no-view one (see `host/main-rpc.ts`
 * and `host/list-host-manager.ts`), text-only: there's no
 * clickable "primary/secondary action" support yet, so `primaryAction` /
 * `secondaryAction` are accepted and kept on the instance (`@raycast/utils`'s
 * `showFailureToast` sets them) but never shown.
 *
 * `Toast` is both a class (real Raycast lets extensions `new Toast(options)`
 * and `.show()` it) and the namespace holding `Toast.Style`.
 */
import { getHostTransport } from "../host-bridge.ts";

export const ToastStyle = {
  Success: "success",
  Failure: "failure",
  Animated: "animated",
} as const;

export type ToastStyleValue = (typeof ToastStyle)[keyof typeof ToastStyle];

export interface ToastOptions {
  title: string;
  message?: string;
  style?: ToastStyleValue;
  primaryAction?: unknown;
  secondaryAction?: unknown;
}

export class Toast {
  static readonly Style = ToastStyle;

  private _title: string;
  private _message: string | undefined;
  private _style: ToastStyleValue;
  private shown = false;
  primaryAction: unknown;
  secondaryAction: unknown;

  constructor(options: ToastOptions) {
    this._title = options.title;
    this._message = options.message;
    this._style = options.style ?? ToastStyle.Success;
    this.primaryAction = options.primaryAction;
    this.secondaryAction = options.secondaryAction;
  }

  get title(): string {
    return this._title;
  }
  set title(value: string) {
    this._title = value;
    this.update();
  }
  get message(): string | undefined {
    return this._message;
  }
  set message(value: string | undefined) {
    this._message = value;
    this.update();
  }
  get style(): ToastStyleValue {
    return this._style;
  }
  set style(value: ToastStyleValue) {
    this._style = value;
    this.update();
  }

  // Arrow properties: extensions pass these around unbound
  // (`onAction: toast.hide`).
  show = async (): Promise<void> => {
    this.shown = true;
    this.send();
  };

  hide = async (): Promise<void> => {
    this.shown = false;
    getHostTransport().sendEffect({ op: "hide-toast" });
  };

  /** Re-sends the whole toast — a view command's screen shows it in place
   *  (so a progress toast updates live); for a no-view command main only
   *  turns *settled* (non-animated) toasts into OS notifications. */
  private update(): void {
    if (this.shown) this.send();
  }

  private send(): void {
    getHostTransport().sendEffect({
      op: "toast",
      title: this._title,
      message: this._message,
      style: this._style,
    });
  }
}

/** Also accepts the legacy `showToast(style, title, message)` signature
 *  older extensions still use. */
export async function showToast(
  optionsOrStyle: ToastOptions | ToastStyleValue,
  title?: string,
  message?: string,
): Promise<Toast> {
  const options: ToastOptions =
    typeof optionsOrStyle === "string"
      ? { style: optionsOrStyle, title: title ?? "", message }
      : optionsOrStyle;
  const toast = new Toast(options);
  await toast.show();
  return toast;
}
