/**
 * Runs exposed Widgets and caches their last value, so the launcher can show a
 * value the instant it opens and refresh it in the background — mirroring the
 * app-list stale-then-refresh behaviour.
 *
 * The value cache is persisted through the Widget extension's `ExtensionStorage`
 * (injected by `WidgetSource`), under the `values` key of
 * `<userData>/extensions/widget.json`. The actual code execution happens in
 * `./worker.ts` (bundled as `widget-worker.js`), spawned per run; `runCode` is
 * injectable so the `node --test` suite can drive the runner without a build.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionStorage } from "@core/storage";
import type { WidgetTestResult } from "../shared/types";
import type { UserCodeResult } from "./run-user-code";

/** Storage key holding the `Record<string, CachedValue>`. */
const KEY = "values";

/** How long a cached value is considered fresh enough to skip a background re-run. */
export const DEFAULT_TTL_MS = 60_000;

/** In-worker timeout for a single run (kept in sync with run-user-code's default). */
const RUN_TIMEOUT_MS = 10_000;

/** Hard wall-clock kill for the worker process, a bit above the in-worker timeout. */
const HARD_KILL_MS = RUN_TIMEOUT_MS + 3_000;

type ValueState = "ready" | "error";

interface CachedValue {
  value: string | number | null;
  state: ValueState;
  error?: string;
  fetchedAt: number;
}

type RunCode = (code: string, timeoutMs: number) => Promise<UserCodeResult>;

function isCachedValue(value: unknown): value is CachedValue {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CachedValue>;
  const v = c.value;
  const validValue =
    v === null || typeof v === "string" || typeof v === "number";
  return (
    validValue &&
    (c.state === "ready" || c.state === "error") &&
    typeof c.fetchedAt === "number"
  );
}

function isValueMap(value: unknown): value is Record<string, CachedValue> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every(isCachedValue)
  );
}

export class WidgetRunner {
  private readonly storage: ExtensionStorage;
  private readonly runCode: RunCode;
  private readonly now: () => number;

  private values: Record<string, CachedValue> = {};
  private loaded = false;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    storage: ExtensionStorage,
    opts?: { runCode?: RunCode; now?: () => number },
  ) {
    this.storage = storage;
    this.runCode = opts?.runCode ?? spawnWorker;
    this.now = opts?.now ?? Date.now;
  }

  init(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = this.storage.get<unknown>(KEY);
    if (isValueMap(raw)) this.values = raw;
  }

  /** Launcher-row subtitle for `id`. `''` when it has never produced a value. */
  getSubtitle(id: string): string {
    this.init();
    const cached = this.values[id];
    if (!cached) return "";
    if (cached.state === "error" && cached.value === null) {
      return `⚠ ${cached.error ?? "error"}`;
    }
    return formatValue(cached.value);
  }

  isLoading(id: string): boolean {
    return this.inFlight.has(id);
  }

  /**
   * Re-run `id` unless a run is already in flight or its value is still fresh.
   * Resolves once settled either way, so a caller can await "is this up to date
   * now" — a no-op call resolves immediately.
   */
  refreshIfStale(
    id: string,
    code: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): Promise<void> {
    this.init();
    const existing = this.inFlight.get(id);
    if (existing) {
      console.log(`[widget] ${id}: skip run — already in flight`);
      return existing;
    }
    const cached = this.values[id];
    if (cached) {
      const age = this.now() - cached.fetchedAt;
      if (age < ttlMs) {
        console.log(
          `[widget] ${id}: skip run — cache fresh (age ${age}ms, ttl ${ttlMs}ms)`,
        );
        return Promise.resolve();
      }
      console.log(
        `[widget] ${id}: cache stale (age ${age}ms, ttl ${ttlMs}ms) — running`,
      );
    } else {
      console.log(`[widget] ${id}: no cache — running`);
    }
    return this.run(id, code);
  }

  /** Force a run now. Single-flight per `id`: concurrent callers share one run. */
  run(id: string, code: string): Promise<void> {
    this.init();
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    console.log(`[widget] ${id}: executing code`);
    const startedAt = this.now();
    const task = this.runCode(code, RUN_TIMEOUT_MS)
      .then((result) => this.store(id, result))
      .catch((error) => this.store(id, { ok: false, error: toMessage(error) }))
      .finally(() => {
        this.inFlight.delete(id);
        console.log(
          `[widget] ${id}: execution finished in ${this.now() - startedAt}ms`,
        );
      });

    this.inFlight.set(id, task);
    return task;
  }

  /** One-shot run with no caching, for the editor's "Test" button. */
  async runOnce(code: string): Promise<WidgetTestResult> {
    try {
      const result = await this.runCode(code, RUN_TIMEOUT_MS);
      return result.ok
        ? { ok: true, value: result.value, logs: result.logs }
        : { ok: false, error: result.error, logs: result.logs };
    } catch (error) {
      return { ok: false, error: toMessage(error) };
    }
  }

  /** Drop cached values whose Widget no longer exists / is no longer exposed. */
  prune(keepIds: Iterable<string>): void {
    this.init();
    const keep = new Set(keepIds);
    let changed = false;
    for (const id of Object.keys(this.values)) {
      if (!keep.has(id)) {
        delete this.values[id];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private store(id: string, result: UserCodeResult): void {
    if (result.ok) {
      this.values[id] = {
        value: result.value,
        state: "ready",
        fetchedAt: this.now(),
      };
    } else {
      // Keep the last known value on failure — a stale number beats a blank row.
      this.values[id] = {
        value: this.values[id]?.value ?? null,
        state: "error",
        error: result.error,
        fetchedAt: this.now(),
      };
    }
    this.persist();
  }

  private persist(): void {
    this.storage.set(KEY, this.values);
  }
}

function formatValue(value: string | number | null): string {
  if (value === null) return "—";
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default `runCode`: spawn the worker, pipe the code in, parse its JSON out. */
function spawnWorker(code: string, timeoutMs: number): Promise<UserCodeResult> {
  return new Promise((resolve) => {
    const workerPath = join(import.meta.dirname, "widget-worker.js");
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // `stripTypeScriptTypes` (used in run-user-code) is still experimental and
        // prints a warning to stderr on first use; keep the worker's stderr clean.
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          "--disable-warning=ExperimentalWarning",
        ]
          .filter(Boolean)
          .join(" "),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: UserCodeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: `Widget worker killed after ${HARD_KILL_MS}ms`,
      });
    }, HARD_KILL_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", () => {
      try {
        finish(JSON.parse(stdout) as UserCodeResult);
      } catch {
        finish({
          ok: false,
          error: stderr.trim() || "Widget worker produced no output",
        });
      }
    });

    child.stdin.write(JSON.stringify({ code, timeoutMs }));
    child.stdin.end();
  });
}
