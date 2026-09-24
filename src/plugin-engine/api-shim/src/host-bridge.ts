/**
 * The seam between the shim's React components/APIs and whatever process
 * they're actually running in. Two directions:
 *
 *  - Outbound: a `HostTransport`, injected once at startup by whichever entry
 *    point is hosting the command (`no-view-worker.ts` sends newline-delimited
 *    JSON over stdout; `list-host-process.ts` posts over `parentPort`) — see
 *    `configureHostTransport`. `apis/*.ts` and `reconciler.ts` call through it
 *    rather than knowing which process they're in.
 *  - Inbound: `searchTextStore`, a tiny external store `List` subscribes to
 *    via `useSyncExternalStore` (see `components/List.tsx`), fed by
 *    `list-host-process.ts` on a `search-text-changed` event — and the action
 *    registry, rebuilt on every render commit by `reconciler.ts`, that
 *    `invokeAction` dispatches an inbound `action-invoked` event against.
 */
import type {
  ConfirmAlertOptions,
  HostEffect,
  HostRequest,
  PluginViewTree,
} from "../../host/protocol.ts";

export type { ConfirmAlertOptions, HostEffect, HostRequest };

export interface HostTransport {
  /** List mode only — no-view has no tree to push. */
  sendRenderTree(tree: PluginViewTree): void;
  sendRenderError(message: string): void;
  sendEffect(effect: HostEffect): void;
  /** A round trip to main (clipboard reads, `confirmAlert`, application
   *  lookups, …) — live in both modes: List mode over `parentPort`, no-view
   *  over the worker's Node IPC channel. */
  request(request: HostRequest): Promise<unknown>;
  /** List mode only — collapses this screen's own route stack. A true no-op
   *  in no-view mode (nothing was ever pushed). */
  popToRoot(): void;
  /** List mode only — resets this screen's own search input. A true no-op
   *  in no-view mode (there's no search bar to clear). */
  clearSearchBar(): void;
}

let transport: HostTransport | null = null;

export function configureHostTransport(next: HostTransport): void {
  transport = next;
}

export function getHostTransport(): HostTransport {
  if (!transport) {
    throw new Error(
      "[@raycast/api shim] a host API was called before configureHostTransport() ran",
    );
  }
  return transport;
}

/* ------------------------------ search text ------------------------------ */

type Listener = () => void;

/**
 * The launcher's own search box drives every List's filtering (see
 * `components/List.tsx`) — there is no plugin-controlled `searchText` prop in
 * v1, only `onSearchTextChange` (to let a plugin react to it) and `filtering`.
 *
 * Kept per navigation frame (see `navigation.ts`): a pushed List starts with
 * an empty search, and popping back restores what the frame below had —
 * `setText` only ever writes to the current top frame, so a List hidden
 * under a pushed view never re-filters or re-fetches as the user types.
 */
class SearchTextStore {
  private readonly texts = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private topFrameId = ROOT_FRAME_ID;

  getText = (frameId: string): string => this.texts.get(frameId) ?? "";

  /** The top frame's text — what the renderer's search input shows. */
  getSnapshot = (): string => this.getText(this.topFrameId);

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setTopFrame(frameId: string): void {
    this.topFrameId = frameId;
  }

  getTopFrame(): string {
    return this.topFrameId;
  }

  /** Back to a single empty root frame — a freshly started command. */
  reset(): void {
    this.texts.clear();
    this.topFrameId = ROOT_FRAME_ID;
  }

  dropFrame(frameId: string): void {
    this.texts.delete(frameId);
  }

  setText(next: string): void {
    if (next === this.getSnapshot()) return;
    this.texts.set(this.topFrameId, next);
    for (const listener of this.listeners) listener();
  }
}

/** The frame id of a command's own root view (nothing pushed yet). */
export const ROOT_FRAME_ID = "root";

export const searchTextStore = new SearchTextStore();

/* -------------------------------- actions -------------------------------- */

type ActionHandler = () => void | Promise<void>;

/** Rebuilt from scratch on every render commit by `reconciler.ts`'s serializer. */
class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  reset(): void {
    this.handlers = new Map();
  }

  register(id: string, handler: ActionHandler): void {
    this.handlers.set(id, handler);
  }

  async invoke(id: string): Promise<void> {
    const handler = this.handlers.get(id);
    if (!handler) {
      console.warn(
        `[@raycast/api shim] action-invoked for unknown action id "${id}"`,
      );
      return;
    }
    await handler();
  }
}

export const actionRegistry = new ActionRegistry();

/* ---------------------------- dropdown change ----------------------------- */

/** `List.Dropdown`'s `onChange` — a single slot, not a map like
 *  `ActionRegistry`: real Raycast allows exactly one `searchBarAccessory`
 *  dropdown per `List`, so there's never more than one live handler at once.
 *  Rebuilt from scratch on every render commit by `reconciler.ts`'s
 *  serializer, same as `actionRegistry`. */
class DropdownChangeStore {
  private handler: ((value: string) => void) | null = null;
  /** What the user last picked, for an *uncontrolled* dropdown (one with no
   *  explicit `value` prop, only `defaultValue`) — kept across commits
   *  (unlike `handler`, which is rebuilt every commit) so `buildDropdown`
   *  can keep echoing it back on the wire instead of the tree reverting to
   *  `defaultValue` on every re-render once the extension's own `onChange`
   *  state update triggers one (see that function's doc comment). */
  private lastValue: string | null = null;

  reset(): void {
    this.handler = null;
  }

  register(handler: (value: string) => void): void {
    this.handler = handler;
  }

  invoke(value: string): void {
    this.lastValue = value;
    this.handler?.(value);
  }

  getLastValue(): string | null {
    return this.lastValue;
  }
}

export const dropdownChangeStore = new DropdownChangeStore();

/* ----------------------------- form fields -------------------------------- */

type FormFieldChangeHandler = (value: unknown) => void;

/** One `Form` field's `onChange`, keyed by field id — mirrors
 *  `ActionRegistry`'s shape (a map, since a form has many fields), rebuilt
 *  from scratch on every render commit by `reconciler.ts`'s serializer. */
class FormFieldChangeStore {
  private handlers = new Map<string, FormFieldChangeHandler>();

  reset(): void {
    this.handlers = new Map();
  }

  register(fieldId: string, handler: FormFieldChangeHandler): void {
    this.handlers.set(fieldId, handler);
  }

  invoke(fieldId: string, value: unknown): void {
    this.handlers.get(fieldId)?.(value);
  }
}

export const formFieldChangeStore = new FormFieldChangeStore();

/* ------------------------------ form submit ------------------------------- */

type FormSubmitHandler = (
  values: Record<string, unknown>,
) => void | boolean | Promise<void | boolean>;

/** `Action.SubmitForm`'s `onSubmit` — a single slot, not a map like
 *  `FormFieldChangeStore`: real Raycast allows exactly one `SubmitForm`
 *  action to actually submit a given form. Rebuilt from scratch on every
 *  render commit, same as `dropdownChangeStore`. */
class FormSubmitStore {
  private handler: FormSubmitHandler | null = null;

  reset(): void {
    this.handler = null;
  }

  register(handler: FormSubmitHandler): void {
    this.handler = handler;
  }

  async invoke(values: Record<string, unknown>): Promise<void> {
    await this.handler?.(values);
  }
}

export const formSubmitStore = new FormSubmitStore();
