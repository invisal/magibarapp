import { useState, type ComponentType } from "react";
import { cn } from "cnfast";
import { WindowFrame } from "@renderer/shared/ui";
import { useShortcut } from "@renderer/lib/use-shortcut";
import type { Direction, StepProps } from "./parts";
import WelcomeStep from "./steps/WelcomeStep";
import ShortcutStep from "./steps/ShortcutStep";
import SearchStep from "./steps/SearchStep";
import WindowsStep from "./steps/WindowsStep";
import FinishStep from "./steps/FinishStep";

const STEPS: ReadonlyArray<{
  id: string;
  Component: ComponentType<StepProps>;
}> = [
  { id: "welcome", Component: WelcomeStep },
  { id: "shortcut", Component: ShortcutStep },
  { id: "search", Component: SearchStep },
  { id: "windows", Component: WindowsStep },
  { id: "finish", Component: FinishStep },
];

function Onboarding() {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<Direction>("forward");
  const last = index === STEPS.length - 1;

  function go(next: number): void {
    if (next < 0) return;
    if (next >= STEPS.length) {
      window.api.onboarding.finish();
      return;
    }
    setDirection(next > index ? "forward" : "back");
    setIndex(next);
  }

  useShortcut({ "Alt+Left": () => go(index - 1) });

  const { id, Component } = STEPS[index];

  return (
    <WindowFrame>
      {/* `key` remounts the step so its slide-in and its own state reset. */}
      <Component key={id} direction={direction} onNext={() => go(index + 1)} />
      <footer className="flex h-14 shrink-0 items-center px-9">
        <button
          type="button"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          className="w-16 rounded text-left text-sm text-foreground-subtle transition-colors outline-none hover:text-foreground focus-visible:text-foreground disabled:invisible"
        >
          Back
        </button>
        <div
          className="flex flex-1 items-center justify-center gap-2"
          role="tablist"
          aria-label="Progress"
        >
          {STEPS.map((step, i) => (
            <span
              key={step.id}
              role="tab"
              aria-selected={i === index}
              aria-label={`Step ${i + 1} of ${STEPS.length}`}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                i === index ? "w-5 bg-foreground" : "w-1.5 bg-white/20",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => window.api.onboarding.finish()}
          className={cn(
            "w-16 rounded text-right text-sm text-foreground-subtle transition-colors outline-none hover:text-foreground focus-visible:text-foreground",
            last && "invisible",
          )}
        >
          Skip
        </button>
      </footer>
    </WindowFrame>
  );
}

export default Onboarding;
