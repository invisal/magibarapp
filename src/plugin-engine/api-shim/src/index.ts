/**
 * The public surface this module exposes as `@raycast/api` to plugin code —
 * `host/runtime.ts` hands it to every `require("@raycast/api")` a prebuilt
 * command bundle makes (Raycast Store bundles and source builds alike keep
 * `@raycast/api` external, the way `ray build` does).
 *
 * Anything real Raycast exports that isn't listed here still resolves, to
 * `unsupported.ts`'s `missingApi` stub (see `runtime.ts`), so an extension
 * touching an unimplemented API fails with a clear message only if that code
 * path actually runs. `MenuBarExtra`, `AI`, OAuth sign-in,
 * `BrowserExtension`, and `WindowManagement` are deliberate stubs: present
 * (so module-scope references like `AI.Model.X` or
 * `new OAuth.PKCEClient(...)` don't break loading) but failing loudly when
 * actually used.
 */
import { unsupportedComponent, unsupportedFunction } from "./unsupported.ts";
import { getEnvironment, type Environment } from "./apis/environment.ts";
import { LocalStorage } from "./apis/local-storage.ts";

export { List } from "./components/List.ts";
export { ActionPanel } from "./components/ActionPanel.ts";
export { Action } from "./components/Action.ts";
export { Detail } from "./components/Detail.ts";
export { Grid } from "./components/Grid.ts";
export { Form } from "./components/Form.ts";
export { useNavigation } from "./navigation.ts";
export type { Navigation } from "./navigation.ts";
export { showToast, Toast, ToastStyle } from "./apis/toast.ts";
export type { ToastOptions, ToastStyleValue } from "./apis/toast.ts";
export { showHUD, closeMainWindow } from "./apis/hud.ts";
export { Clipboard, open } from "./apis/clipboard.ts";
export { LocalStorage } from "./apis/local-storage.ts";
export type { LocalStorageValue } from "./apis/local-storage.ts";
export { getPreferenceValues } from "./apis/preferences.ts";
export { confirmAlert, Alert } from "./apis/alert.ts";
export type {
  AlertOptions,
  AlertActionOptions,
  AlertActionStyleValue,
} from "./apis/alert.ts";
export { popToRoot, clearSearchBar } from "./apis/navigation.ts";
export { Keyboard } from "./apis/keyboard.ts";
export { Cache } from "./apis/cache.ts";
export type { CacheOptions } from "./apis/cache.ts";
export {
  LaunchType,
  launchCommand,
  updateCommandMetadata,
  openExtensionPreferences,
  openCommandPreferences,
} from "./apis/launch.ts";
export {
  getApplications,
  getFrontmostApplication,
  getDefaultApplication,
  showInFinder,
  trash,
  getSelectedText,
  getSelectedFinderItems,
  captureException,
} from "./apis/system.ts";
export type { Application } from "./apis/system.ts";
export { Image, PopToRootType } from "./apis/image.ts";

/** Lazy: real Raycast exposes this as a plain object, but its values depend
 *  on per-run context set after this module is first evaluated (see
 *  `context.ts`) — a `Proxy` defers every read to that point instead. */
export const environment: Environment = new Proxy({} as Environment, {
  get: (_target, prop) => getEnvironment()[prop as keyof Environment],
  has: (_target, prop) => prop in getEnvironment(),
  ownKeys: () => Reflect.ownKeys(getEnvironment()),
  getOwnPropertyDescriptor: (_target, prop) => ({
    configurable: true,
    enumerable: true,
    value: getEnvironment()[prop as keyof Environment],
  }),
});

/**
 * Real Raycast ships hundreds of named icons/colors; there's no bundled icon
 * asset set, so both resolve to their own key as a plain string (`Icon.Star`
 * -> `"Star"`) — not visually faithful, but non-crashing, and the renderer's
 * icon slot already falls back gracefully for a name it can't resolve to an
 * image. `Color.Dynamic` is a class in real Raycast; here it passes its
 * `{ light, dark }` input through (see `reconciler.ts`'s `color()`).
 */
export const Icon = new Proxy({} as Record<string, string>, {
  get: (_target, prop) => (typeof prop === "string" ? prop : undefined),
});
class DynamicColor {
  light: string;
  dark: string;
  adjustContrast?: boolean;
  constructor(input: {
    light: string;
    dark: string;
    adjustContrast?: boolean;
  }) {
    this.light = input.light;
    this.dark = input.dark;
    this.adjustContrast = input.adjustContrast;
  }
}
export const Color = new Proxy(
  { Dynamic: DynamicColor } as Record<string, unknown>,
  {
    get: (target, prop) => {
      if (typeof prop !== "string") return undefined;
      return prop in target ? target[prop] : prop;
    },
  },
);

export const MenuBarExtra = Object.assign(
  unsupportedComponent("MenuBarExtra"),
  {
    Item: unsupportedComponent("MenuBarExtra.Item"),
    Section: unsupportedComponent("MenuBarExtra.Section"),
    Submenu: unsupportedComponent("MenuBarExtra.Submenu"),
    Separator: unsupportedComponent("MenuBarExtra.Separator"),
  },
);

export const AI = {
  ask: unsupportedFunction("AI.ask"),
  /** Read at module scope by AI-optional extensions (`AI.Model["…"]`). */
  Model: new Proxy({} as Record<string, string>, {
    get: (_target, prop) => (typeof prop === "string" ? prop : undefined),
  }),
  Creativity: {
    None: "none",
    Low: "low",
    Medium: "medium",
    High: "high",
    Maximum: "maximum",
  },
};

/**
 * `OAuth.PKCEClient` constructs fine — `@raycast/utils`' `OAuthService` does
 * so at module scope (`OAuthService.github({...})`), long before knowing
 * whether the user set a personal-access-token preference instead. Stored
 * tokens are honored; only an actual browser sign-in (which needs Raycast's
 * own OAuth redirect proxy) fails, with a message pointing at the fallback.
 */
class PKCEClient {
  readonly providerName: string;
  readonly providerId?: string;
  readonly description?: string;
  readonly redirectMethod: string;

  constructor(options: {
    providerName: string;
    providerId?: string;
    description?: string;
    redirectMethod: string;
  }) {
    this.providerName = options.providerName;
    this.providerId = options.providerId;
    this.description = options.description;
    this.redirectMethod = options.redirectMethod;
  }

  private key(): string {
    return `__oauth_tokens:${this.providerId ?? this.providerName}`;
  }

  async authorizationRequest(): Promise<never> {
    throw new Error(
      `Signing in with ${this.providerName} isn't supported in Magibar yet. If this extension has an access-token preference, set it in the extension's preferences instead.`,
    );
  }

  async authorize(): Promise<never> {
    return this.authorizationRequest();
  }

  async getTokens(): Promise<Record<string, unknown> | undefined> {
    const raw = await LocalStorage.getItem<string>(this.key());
    if (!raw) return undefined;
    const tokens = JSON.parse(raw) as Record<string, unknown> & {
      expiresIn?: number;
      updatedAt?: string;
    };
    return {
      ...tokens,
      updatedAt: new Date(tokens.updatedAt ?? Date.now()),
      isExpired() {
        if (!tokens.expiresIn || !tokens.updatedAt) return false;
        return (
          new Date(tokens.updatedAt).getTime() + tokens.expiresIn * 1000 <
          Date.now() + 10_000
        );
      },
    };
  }

  async setTokens(tokens: Record<string, unknown>): Promise<void> {
    await LocalStorage.setItem(
      this.key(),
      JSON.stringify({ ...tokens, updatedAt: new Date().toISOString() }),
    );
  }

  async removeTokens(): Promise<void> {
    await LocalStorage.removeItem(this.key());
  }
}

export const OAuth = {
  PKCEClient,
  RedirectMethod: { Web: "web", App: "app", AppURI: "appURI" },
};

export const BrowserExtension = {
  getTabs: unsupportedFunction("BrowserExtension.getTabs"),
  getContent: unsupportedFunction("BrowserExtension.getContent"),
};
export const WindowManagement = {
  getWindowsOnActiveDesktop: unsupportedFunction(
    "WindowManagement.getWindowsOnActiveDesktop",
  ),
  getActiveWindow: unsupportedFunction("WindowManagement.getActiveWindow"),
  setWindowBounds: unsupportedFunction("WindowManagement.setWindowBounds"),
  getDesktops: unsupportedFunction("WindowManagement.getDesktops"),
  DesktopType: { User: "user", FullScreen: "fullscreen" },
};
