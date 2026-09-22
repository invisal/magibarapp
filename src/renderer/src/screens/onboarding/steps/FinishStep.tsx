import { PrimaryButton, StepLayout, Icon, type StepProps } from "../parts";

const FEATURES: ReadonlyArray<{
  title: string;
  hint: string;
  color: string;
  icon: string[];
}> = [
  {
    title: "Clipboard History",
    hint: "Everything you copied, searchable",
    color: "text-sky-300",
    icon: [
      "M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z",
      "M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2",
    ],
  },
  {
    title: "Quicklinks",
    hint: "Jump to sites, files and folders",
    color: "text-violet-300",
    icon: [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ],
  },
  {
    title: "Hotkeys & Aliases",
    hint: "Give any action its own shortcut",
    color: "text-pink-300",
    icon: [
      "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
    ],
  },
  {
    title: "Widgets",
    hint: "Live values from your own code",
    color: "text-emerald-300",
    icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  },
];

export default function FinishStep({ onNext, direction }: StepProps) {
  return (
    <StepLayout
      tone="green"
      direction={direction}
      hero={
        <div className="grid w-full max-w-[440px] grid-cols-2 gap-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="ob-tile flex flex-col gap-2 rounded-2xl p-3.5"
            >
              <Icon d={f.icon} className={f.color} />
              <div>
                <div className="text-sm font-medium">{f.title}</div>
                <div className="text-xs leading-snug text-foreground-subtle">
                  {f.hint}
                </div>
              </div>
            </div>
          ))}
        </div>
      }
      title="You're all set"
      description="There's plenty more to find — just type what you're after. You can replay this tour any time from Settings."
    >
      <PrimaryButton autoFocus onClick={onNext}>
        Open Magibar
      </PrimaryButton>
    </StepLayout>
  );
}
