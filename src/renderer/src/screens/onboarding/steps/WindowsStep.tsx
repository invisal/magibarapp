import { useEffect, useState } from "react";
import {
  DoneBadge,
  PrimaryButton,
  StepLayout,
  TextButton,
  type StepProps,
} from "../parts";

const isMac = window.api.platform === "darwin";

/** A tiny "screen" whose window keeps snapping to Left Half → Right Half → Maximize. */
function SnapDemo() {
  return (
    <div className="ob-tile relative h-[168px] w-[264px] rounded-2xl p-2">
      <div className="relative h-full w-full overflow-hidden rounded-lg bg-black/25">
        <div
          className="ob-snap absolute rounded-md border border-amber-200/40 bg-amber-300/25 shadow-lg"
          style={{ left: "3%", top: "4%", width: "47%", height: "92%" }}
        >
          <div className="flex gap-1 p-1.5">
            <span className="size-1.5 rounded-full bg-white/50" />
            <span className="size-1.5 rounded-full bg-white/30" />
            <span className="size-1.5 rounded-full bg-white/30" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * On macOS, moving other apps' windows needs the Accessibility permission, so
 * the step asks for it and polls until it's granted (the user flips a switch
 * in System Settings, outside this window). Elsewhere it's just a showcase.
 */
export default function WindowsStep({ onNext, direction }: StepProps) {
  const [trusted, setTrusted] = useState<boolean | null>(isMac ? null : true);

  useEffect(() => {
    if (!isMac || trusted) return;
    let cancelled = false;
    const check = (): void => {
      window.api.window.getAccessibilityStatus().then((ok) => {
        if (!cancelled) setTrusted(ok);
      });
    };
    check();
    const timer = setInterval(check, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trusted]);

  return (
    <StepLayout
      tone="amber"
      direction={direction}
      hero={<SnapDemo />}
      title="Tidy your windows"
      description={
        <>
          Type <em className="text-foreground not-italic">left half</em>,{" "}
          <em className="text-foreground not-italic">maximize</em> or{" "}
          <em className="text-foreground not-italic">center</em> to snap the
          window you're in — and bind any of them to their own shortcut.
          {isMac && !trusted && (
            <> macOS needs your permission to move other apps' windows.</>
          )}
        </>
      }
    >
      {isMac && !trusted ? (
        <div className="flex items-center gap-4">
          <PrimaryButton
            onClick={() => void window.api.window.requestAccessibility()}
          >
            Grant access
          </PrimaryButton>
          <TextButton onClick={onNext}>Maybe later</TextButton>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
          {isMac && <DoneBadge>Access granted</DoneBadge>}
        </div>
      )}
    </StepLayout>
  );
}
