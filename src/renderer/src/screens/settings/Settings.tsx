import { useEffect, useState } from "react";
import type { CalculatorSettings, NumberFormatPreference } from "@shared/types";
import { useHotkeyRecorder } from "@renderer/lib/use-hotkey-recorder";
import { ShortcutLabel, WindowFrame } from "@renderer/shared/ui";

function Row({
  title,
  description,
  controlId,
  children,
}: {
  title: string;
  description: string;
  /** `id` of the row's form control — its title then labels it and the description describes it. */
  controlId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-4">
      <div className="min-w-0">
        {controlId ? (
          <label htmlFor={controlId} className="block text-foreground">
            {title}
          </label>
        ) : (
          <div className="text-foreground">{title}</div>
        )}
        <div
          id={controlId ? `${controlId}-description` : undefined}
          className="text-xs text-foreground-subtle"
        >
          {description}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function HotkeyRow() {
  const { hotkey, recording, error, startRecording } = useHotkeyRecorder();

  return (
    <Row
      title="Toggle shortcut"
      description="Global hotkey that shows and hides the launcher."
    >
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={startRecording}
          className="rounded border border-border px-2 py-1 font-sans text-xs text-foreground-subtle hover:bg-item-hover"
        >
          {recording ? (
            "Press keys… (Esc to cancel)"
          ) : hotkey ? (
            <ShortcutLabel accelerator={hotkey} />
          ) : (
            "…"
          )}
        </button>
        {error && (
          <span className="max-w-64 text-right text-xs text-red-500">
            {error}
          </span>
        )}
      </div>
    </Row>
  );
}

function LaunchAtLoginRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    window.api.launchAtLogin.get().then(setEnabled);
  }, []);

  async function toggle(next: boolean): Promise<void> {
    setEnabled(await window.api.launchAtLogin.set(next));
  }

  return (
    <Row
      title="Launch at login"
      controlId="setting-launch-at-login"
      description="Start Magibar automatically when you sign in."
    >
      <input
        id="setting-launch-at-login"
        aria-describedby="setting-launch-at-login-description"
        type="checkbox"
        checked={enabled ?? false}
        disabled={enabled === null}
        onChange={(e) => void toggle(e.target.checked)}
      />
    </Row>
  );
}

function AccessibilityRow() {
  const [trusted, setTrusted] = useState<boolean | null>(null);

  useEffect(() => {
    window.api.window.getAccessibilityStatus().then(setTrusted);
  }, []);

  async function grant(): Promise<void> {
    const result = await window.api.window.requestAccessibility();
    setTrusted(result);
  }

  return (
    <Row
      title="Accessibility access"
      description="Required so Window Management can move and resize other apps' windows."
    >
      {trusted === null ? (
        <span className="text-xs text-foreground-subtle">Checking…</span>
      ) : trusted ? (
        <span className="text-xs text-foreground-subtle">Granted</span>
      ) : (
        <button
          onClick={() => void grant()}
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-item-hover"
        >
          Grant Access
        </button>
      )}
    </Row>
  );
}

function GapSizeRow() {
  const [gapPx, setGapPx] = useState<number | null>(null);

  useEffect(() => {
    window.api.window.getGapSize().then(setGapPx);
  }, []);

  async function save(value: number): Promise<void> {
    setGapPx(value);
    await window.api.window.setGapSize(value);
  }

  return (
    <Row
      title="Window gap"
      controlId="setting-gap-size"
      description='Spacing a custom layout inserts when its "Use preferred gap settings" is on.'
    >
      <div className="flex items-center gap-1.5">
        <input
          id="setting-gap-size"
          aria-describedby="setting-gap-size-description"
          type="number"
          min={0}
          value={gapPx ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) void save(Math.max(0, n));
          }}
          className="w-16 rounded border border-border bg-transparent px-2 py-1 text-right text-xs outline-none"
        />
        <span className="text-xs text-foreground-subtle">px</span>
      </div>
    </Row>
  );
}

const NUMBER_FORMATS: ReadonlyArray<{
  value: NumberFormatPreference;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "dot", label: "1,234.5" },
  { value: "comma", label: "1.234,5" },
];

function CalculatorRows() {
  const [prefs, setPrefs] = useState<CalculatorSettings | null>(null);

  useEffect(() => {
    window.api.calculatorSettings.get().then(setPrefs);
  }, []);

  async function update(patch: Partial<CalculatorSettings>): Promise<void> {
    setPrefs(await window.api.calculatorSettings.set(patch));
  }

  return (
    <>
      <Row
        title="Crypto prices"
        controlId="setting-crypto-prices"
        description="Fetch live prices every 10 minutes so conversions like 5 btc in gbp work."
      >
        <input
          id="setting-crypto-prices"
          aria-describedby="setting-crypto-prices-description"
          type="checkbox"
          checked={prefs?.cryptoEnabled ?? false}
          disabled={!prefs}
          onChange={(e) => void update({ cryptoEnabled: e.target.checked })}
        />
      </Row>
      <Row
        title="Number format"
        controlId="setting-number-format"
        description="Decimal and thousands separators for calculator input and results."
      >
        <select
          id="setting-number-format"
          aria-describedby="setting-number-format-description"
          value={prefs?.numberFormat ?? "system"}
          disabled={!prefs}
          onChange={(e) =>
            void update({
              numberFormat: e.target.value as NumberFormatPreference,
            })
          }
          className="rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
        >
          {NUMBER_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

function Settings() {
  return (
    <WindowFrame title="Settings" contentClassName="overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-foreground-subtle">
          Configure how Magibar behaves.
        </p>

        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            General
          </h2>
          <HotkeyRow />
          <Row
            title="Show Onboarding"
            description="Walk through what Magibar can do, step by step."
          >
            <button
              onClick={() => window.api.onboarding.open()}
              className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-item-hover"
            >
              Replay
            </button>
          </Row>
          <LaunchAtLoginRow />
        </section>

        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            Window Management
          </h2>
          {window.api.platform === "darwin" && <AccessibilityRow />}
          <GapSizeRow />
        </section>

        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            Calculator
          </h2>
          <CalculatorRows />
        </section>

        <p className="mt-8 text-xs text-foreground-subtle">
          More options coming soon.
        </p>
      </div>
    </WindowFrame>
  );
}

export default Settings;
