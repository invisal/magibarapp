import { PrimaryButton, StepLayout, type StepProps } from "../parts";

/** The three-star mark from the launcher's search bar, scaled up as the app's "logo". */
function Mark() {
  return (
    <svg width="64" height="64" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g className="magic-intro">
        <path
          className="magic-float"
          d="M9 2l1 2.5L12.5 5.5 10 6.5 9 9 8 6.5 5.5 5.5 8 4.5 9 2z"
          fill="currentColor"
        />
        <path
          className="magic-float magic-float--b"
          d="M4.5 9l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L2.5 11l1.4-.6.6-1.4z"
          fill="currentColor"
        />
        <path
          className="magic-float magic-float--c"
          d="M12 10.8l.3.7.7.3-.7.3-.3.7-.3-.7L11 11.8l.7-.3.3-.7z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export default function WelcomeStep({ onNext, direction }: StepProps) {
  return (
    <StepLayout
      tone="blue"
      direction={direction}
      hero={
        <div className="ob-tile flex h-28 w-28 items-center justify-center rounded-[30px] text-sky-300">
          <Mark />
        </div>
      }
      title="Welcome to Magibar"
      description="One keystroke to launch apps, do quick maths, manage windows and get to anything you use every day. Let's take two minutes to set it up."
    >
      <PrimaryButton autoFocus onClick={onNext}>
        Get started
      </PrimaryButton>
    </StepLayout>
  );
}
