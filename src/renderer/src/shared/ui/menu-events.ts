/**
 * A tiny in-window event bus for `Footer.Menu`, so something outside the menu
 * (the guided tour) can follow what the user does with it without the menu
 * knowing who's listening or the screens threading callbacks through.
 */
export type FooterMenuEventType =
  /** The popup opened. */
  | "open"
  /** The popup closed (by any path, including after picking an item). */
  | "close"
  /** The user picked a row that did something: ran, or opened a submenu / panel. */
  | "choose";

const bus = new EventTarget();

export function emitFooterMenuEvent(type: FooterMenuEventType): void {
  bus.dispatchEvent(new Event(type));
}

/** Subscribes to one kind of event; returns the unsubscribe. */
export function onFooterMenuEvent(
  type: FooterMenuEventType,
  listener: () => void,
): () => void {
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
}
