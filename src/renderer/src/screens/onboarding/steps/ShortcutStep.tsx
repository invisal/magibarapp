import { useEffect, useState } from "react";
import { useHotkeyRecorder } from "@renderer/lib/use-hotkey-recorder";
import {
  DoneBadge,
  Keycaps,
  PrimaryButton,
  StepLayout,
  TextButton,
  type StepProps,
} from "../parts";
import { ShortcutLabel } from "@renderer/shared/ui";

/**
 * Gated on the real thing: the step completes when main reports the launcher
 * was actually shown, i.e. the user's global shortcut works on their machine.
 */
export default function ShortcutStep({ onNext, direction }: StepProps) {
  const { hotkey, recording, error, startRecording, stopRecording } =
    useHotkeyRecorder();
  const [launched, setLaunched] = useState(false);

  useEffect(
    () => window.api.onboarding.onLauncherShown(() => setLaunched(true)),
    [],
  );

  return (
    <StepLayout
      tone="violet"
      direction={direction}
      hero={
        recording ? (
          <div className="ob-tile flex h-[76px] items-center rounded-2xl px-8 text-lg text-foreground-subtle">
            Press your new shortcut…
          </div>
        ) : hotkey ? (
          <Keycaps accelerator={hotkey} lit={launched} animate={!launched} />
        ) : null
      }
      title="Open it from anywhere"
      description={
        launched ? (
          <>
            That's the launcher. Press{" "}
            <kbd className="font-sans text-foreground">Esc</kbd> or click away
            to hide it again.
          </>
        ) : (
          <>
            Magibar lives in the background. Press{" "}
            {hotkey ? (
              <kbd className="font-sans text-foreground">
                <ShortcutLabel accelerator={hotkey} />
              </kbd>
            ) : (
              "the shortcut"
            )}{" "}
            right now to summon it — from any app.
          </>
        )
      }
    >
      <div className="flex items-center gap-4">
        <PrimaryButton disabled={!launched} onClick={onNext}>
          Continue
        </PrimaryButton>
        OR
        <PrimaryButton onClick={startRecording}>
          Record New Hotkey
        </PrimaryButton>
      </div>
      <div className="flex flex-col items-start gap-1 mt-2">
        {recording ? (
          <TextButton onClick={stopRecording}>Cancel (Esc)</TextButton>
        ) : (
          <>
            {launched ? (
              <DoneBadge>Nice, it works</DoneBadge>
            ) : (
              <TextButton onClick={onNext}>Skip for now</TextButton>
            )}
          </>
        )}

        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </StepLayout>
  );
}
