/**
 * Deliberately unsupported surface (`MenuBarExtra`, `AI`, OAuth sign-in,
 * `BrowserExtension`, `WindowManagement`, …): fails loudly,
 * never silently. A top-level unsupported component throws during render —
 * caught by `reconciler.ts`'s error boundary and reported as
 * `{ type: "error" }` rather than a blank/crashed screen. An unsupported
 * *function* throws synchronously, which a no-view command's outer try/catch
 * turns into its ordinary `{ ok: false, error }` result.
 */

export class UnsupportedApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedApiError";
  }
}

function message(name: string): string {
  return `"${name}" is not supported in Magibar yet.`;
}

/** A component that throws as soon as React tries to render it. */
export function unsupportedComponent(name: string): () => never {
  return function Unsupported(): never {
    throw new UnsupportedApiError(message(name));
  };
}

/** A function that throws as soon as it's called. */
export function unsupportedFunction(
  name: string,
): (...args: unknown[]) => never {
  return () => {
    throw new UnsupportedApiError(message(name));
  };
}

/**
 * `host/runtime.ts`'s safety net for an `@raycast/api` export this shim
 * doesn't have at all: callable (throws), constructible (throws), renderable
 * as a component (throws during render, so the error boundary reports it),
 * and property access returns a nested stub — so `Foo.Bar.baz()` reports
 * `"Foo.Bar.baz"` rather than `Cannot read properties of undefined`.
 */
export function missingApi(name: string): unknown {
  const fail = unsupportedFunction(name);
  return new Proxy(function missing() {}, {
    apply: () => fail(),
    construct: () => fail(),
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "prototype" || prop === "$$typeof") {
        return undefined;
      }
      if (prop === "name" || prop === "displayName") return name;
      return missingApi(`${name}.${prop}`);
    },
  });
}
