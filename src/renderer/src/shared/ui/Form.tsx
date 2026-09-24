import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { Switch } from "@base-ui/react/switch";
import { cn } from "cnfast";

/**
 * A form for framed-window screens. Each row centers its control in the window
 * with the label hanging off to the left in a fixed-width column (a mirrored
 * spacer on the right keeps the control column optically centered). Drop it
 * inside `Layout.Content`; submit/cancel usually live in `Layout.Footer`.
 *
 *   <Form onSubmit={save}>
 *     <Form.Field label="Name">
 *       <Form.Input value={name} onChange={(e) => setName(e.target.value)} />
 *     </Form.Field>
 *     <Form.Checkbox
 *       label="Expose as a launcher command"
 *       checked={exposed}
 *       onChange={(e) => setExposed(e.target.checked)}
 *     />
 *   </Form>
 *
 * The form is controlled by its inputs, so `onSubmit` is optional — pass it only
 * when you want Enter-to-submit (and a `type="submit"` button); it fires after
 * `preventDefault()`. `labelWidth` (default 128) and `controlWidth` (default
 * 340) size the two columns, in px.
 *
 * `variant="stacked"` drops the three-track row entirely and puts each label
 * *above* a full-width control, for a form that has to live in a narrow column
 * — the Create Command sidebar, which is ~224px wide and can't fit the centered
 * layout's 128 + 340 + 128 minimum. Same fields, same controls, same tokens.
 */

type FormVariant = "centered" | "stacked";

interface FormLayout {
  labelWidth: number;
  controlWidth: number;
  variant: FormVariant;
}

const FormContext = createContext<FormLayout>({
  labelWidth: 128,
  controlWidth: 340,
  variant: "centered",
});

function FormRoot({
  onSubmit,
  labelWidth = 128,
  controlWidth = 340,
  variant = "centered",
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"form"> & {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Width of the right-aligned label column, in px. Ignored when stacked. */
  labelWidth?: number;
  /** Max width of the centered control column, in px. Ignored when stacked. */
  controlWidth?: number;
  /** `"stacked"` puts labels above full-width controls, for narrow columns. */
  variant?: FormVariant;
}) {
  return (
    <FormContext.Provider value={{ labelWidth, controlWidth, variant }}>
      <form
        {...rest}
        onSubmit={
          onSubmit &&
          ((event) => {
            event.preventDefault();
            onSubmit(event);
          })
        }
        className={cn(
          "flex w-full flex-col",
          variant === "stacked" ? "gap-2.5" : "gap-4 mt-6",
          className,
        )}
      >
        {children}
      </form>
    </FormContext.Provider>
  );
}

/** The centered three-track row shared by `Field`, `Switch` and `Actions`:
 * `[label] [control] [spacer]`, the spacer mirroring the label column so the
 * control column sits in the middle of the window. `left` is the label cell's
 * contents — a `<label>` element for `Field`, nothing for the rest.
 *
 * Under `variant="stacked"` it collapses to label-above-control instead. Only
 * `Field` passes `left`; `Switch` and `Actions` pass nothing and must render no
 * label line at all (not an empty one), hence the guard. */
function Row({
  left,
  children,
  className,
}: {
  left?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { labelWidth, controlWidth, variant } = useContext(FormContext);

  if (variant === "stacked") {
    return (
      <div className={cn("flex w-full min-w-0 flex-col gap-1", className)}>
        {left ? (
          <div className="text-xs font-medium tracking-wide text-foreground-subtle">
            {left}
          </div>
        ) : null}
        {children}
      </div>
    );
  }

  return (
    <div className={cn("flex justify-center gap-4", className)}>
      <div
        style={{ width: labelWidth }}
        className="shrink-0 pt-2 text-right text-sm text-foreground-subtle"
      >
        {left}
      </div>
      <div
        className="flex w-full min-w-0 flex-col gap-1.5"
        style={{ maxWidth: controlWidth }}
      >
        {children}
      </div>
      <span aria-hidden className="shrink-0" style={{ width: labelWidth }} />
    </div>
  );
}

/* --------------------------------- field ---------------------------------- */

interface FieldContextValue {
  id: string;
  descriptionId: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * A labelled control with optional helper text and an error slot. The label is
 * wired to whatever control you nest (via context), so it works with
 * `Form.Input`, a `<textarea>`, or a `<select>`.
 */
function Field({
  label,
  description,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  /** Helper text shown under the control. */
  description?: ReactNode;
  /** When set, the field renders its error state and shows this below. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const descriptionId = description || error ? `${id}-description` : undefined;

  return (
    <FieldContext.Provider
      value={{ id, descriptionId, invalid: Boolean(error) }}
    >
      <Row
        className={className}
        left={
          <label htmlFor={id}>
            {label}
            {required ? <span className="text-red-500"> *</span> : null}
          </label>
        }
      >
        {children}
        {error ? (
          <p id={descriptionId} className="text-xs text-red-500">
            {error}
          </p>
        ) : description ? (
          <p id={descriptionId} className="text-xs text-foreground-subtle">
            {description}
          </p>
        ) : null}
      </Row>
    </FieldContext.Provider>
  );
}

/** Read the enclosing `Form.Field`'s wiring, if any. Exported for custom
 * controls (a `<textarea>`, a picker) that want the same label/aria hookup. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

/* ---------------------------- input / textarea --------------------------- */

/** Shared styling for the text controls. */
const CONTROL_CLASS = cn(
  "w-full rounded border border-border bg-input px-3 py-2 text-sm text-foreground outline-none",
  "placeholder:text-foreground-subtle focus:border-foreground-subtle",
  "aria-invalid:border-red-500",
);

/** Wiring an enclosing `Form.Field` supplies to its control. */
function useFieldControlProps(rest: {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: ComponentPropsWithoutRef<"input">["aria-invalid"];
}) {
  const field = useContext(FieldContext);
  return {
    id: field?.id ?? rest.id,
    "aria-describedby": field?.descriptionId ?? rest["aria-describedby"],
    "aria-invalid": field?.invalid || rest["aria-invalid"] || undefined,
  };
}

/** A text input styled for the framed windows. Works standalone or inside a
 * `Form.Field` (which supplies its `id` and error state). */
const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        {...rest}
        {...useFieldControlProps(rest)}
        className={cn(CONTROL_CLASS, className)}
      />
    );
  },
);

/** A multi-line text input. Same styling and `Form.Field` wiring as `Input`;
 * vertically resizable, three rows tall by default. */
const TextArea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<"textarea">
>(function TextArea({ className, rows = 3, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(CONTROL_CLASS, "resize-y", className)}
    />
  );
});

/**
 * A control shaped like an `Input` but acting as a button, with a trailing "→".
 * For a field whose value is edited on another screen — put the current value
 * (or a type name) as the children and navigate on `onClick`.
 *
 *   <Form.Field label="Code">
 *     <Form.Trigger onClick={editCode}>TypeScript</Form.Trigger>
 *   </Form.Field>
 */
const Trigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button">
>(function Trigger({ className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(
        CONTROL_CLASS,
        "flex items-center justify-between gap-2 text-left",
        "enabled:hover:border-foreground-subtle disabled:opacity-50",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <span aria-hidden className="shrink-0 text-foreground-subtle">
        →
      </span>
    </button>
  );
});

/* -------------------------------- switch -------------------------------- */

/** An on/off toggle with its label alongside, sitting in the centered control
 * column like the fields above it. Built on Base UI's Switch; props pass
 * through to `Switch.Root` (`checked`, `onCheckedChange`, `disabled`, `name`,
 * …).
 *
 * Centered forms read `[toggle] Label`, like a checkbox. Stacked ones read
 * `Label … [toggle]` across the full width, in the same `text-xs` as the field
 * labels above it — in a narrow column that lines the labels up and puts the
 * control on the edge you scan for it. */
/** Track / thumb geometry per size. The thumb's travel is the track's inner
 *  width minus the thumb, so these three have to move together. */
const SWITCH_SIZE = {
  sm: {
    root: "h-4 w-7",
    thumb: "h-3 w-3 data-[checked]:translate-x-3",
  },
  md: {
    root: "h-5 w-9",
    thumb: "h-4 w-4 data-[checked]:translate-x-4",
  },
} as const;

function FormSwitch({
  label,
  size = "md",
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<typeof Switch.Root>, "className" | "size"> & {
  label: ReactNode;
  /** Track size. `sm` for dense columns; `md` (default) elsewhere. */
  size?: keyof typeof SWITCH_SIZE;
  className?: string;
}) {
  const { variant } = useContext(FormContext);
  const stacked = variant === "stacked";
  const dims = SWITCH_SIZE[size];

  const toggle = (
    <Switch.Root
      {...rest}
      className={cn(
        "relative shrink-0 rounded-full bg-input p-0.5 outline-none transition-colors focus-visible:border focus-visible:border-foreground-subtle data-[checked]:bg-foreground",
        dims.root,
      )}
    >
      <Switch.Thumb
        className={cn(
          "block rounded-full bg-foreground shadow transition-transform data-[checked]:bg-background",
          dims.thumb,
        )}
      />
    </Switch.Root>
  );

  return (
    <Row className={className}>
      <label
        className={cn(
          "flex items-center py-1 text-foreground-subtle",
          stacked
            ? "justify-between gap-2 text-xs font-medium tracking-wide"
            : "gap-2.5 text-sm",
        )}
      >
        {stacked ? (
          <>
            {label}
            {toggle}
          </>
        ) : (
          <>
            {toggle}
            {label}
          </>
        )}
      </label>
    </Row>
  );
}

/* -------------------------------- dropdown / tag picker ------------------ */

export interface FormPickerItem {
  value: string;
  title: string;
  icon?: string;
}

/** A single-select control. Same styling/`Form.Field` wiring as `Input`. */
const Dropdown = forwardRef<
  HTMLSelectElement,
  Omit<ComponentPropsWithoutRef<"select">, "children"> & {
    items: FormPickerItem[];
  }
>(function Dropdown({ items, className, ...rest }, ref) {
  return (
    <select
      ref={ref}
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(CONTROL_CLASS, className)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.title}
        </option>
      ))}
    </select>
  );
});

/**
 * A multi-select control. v1 simplification: a native `<select multiple>`
 * rather than removable chip UI — functional, not a faithful reproduction
 * of Raycast's `TagPicker` look. Revisit if that reads wrong for a common
 * case.
 */
const TagPicker = forwardRef<
  HTMLSelectElement,
  Omit<ComponentPropsWithoutRef<"select">, "children" | "value" | "onChange"> & {
    items: FormPickerItem[];
    value?: string[];
    onChange?: (value: string[]) => void;
  }
>(function TagPicker({ items, value, onChange, className, ...rest }, ref) {
  return (
    <select
      ref={ref}
      multiple
      value={value}
      onChange={(e) =>
        onChange?.(Array.from(e.target.selectedOptions, (o) => o.value))
      }
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(CONTROL_CLASS, "h-auto", className)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.title}
        </option>
      ))}
    </select>
  );
});

/* ------------------------------- date / file ------------------------------ */

/** A native date (or date+time) input. Same styling/`Form.Field` wiring as
 *  `Input`. */
const DatePicker = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<"input">, "type"> & {
    includeTime?: boolean;
  }
>(function DatePicker({ includeTime, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type={includeTime ? "datetime-local" : "date"}
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(CONTROL_CLASS, className)}
    />
  );
});

/** A native file input. Same styling/`Form.Field` wiring as `Input`. */
const FilePicker = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<"input">, "type">
>(function FilePicker({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      {...rest}
      {...useFieldControlProps(rest)}
      className={cn(
        CONTROL_CLASS,
        "file:mr-3 file:rounded file:border-0 file:bg-input file:px-2 file:py-1 file:text-foreground",
        className,
      )}
    />
  );
});

/* ---------------------------- description / separator --------------------- */

/** A label + block of text, no control — real Raycast's `Form.Description`. */
function Description({ title, text }: { title?: ReactNode; text: ReactNode }) {
  return (
    <Row left={title}>
      <p className="text-sm text-foreground-subtle">{text}</p>
    </Row>
  );
}

/** A plain horizontal divider between fields. */
function FormSeparator() {
  return <hr className="my-1 border-border" />;
}

/* -------------------------------- actions ------------------------------- */

/** A right-aligned button row aligned to the form's control column, for forms
 * that keep their actions inline instead of in `Layout.Footer`. */
function Actions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Row className={cn("pt-2", className)}>
      <div className="flex items-center justify-end gap-3">{children}</div>
    </Row>
  );
}

export const Form = Object.assign(FormRoot, {
  Field,
  Input,
  TextArea,
  Trigger,
  Switch: FormSwitch,
  Dropdown,
  TagPicker,
  DatePicker,
  FilePicker,
  Description,
  Separator: FormSeparator,
  Actions,
});
