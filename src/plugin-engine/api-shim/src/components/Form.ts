/**
 * `Form` and its field components. Each field is a thin `createElement`
 * wrapper carrying `onChange` as a plain prop (never serialized — pulled out
 * at commit time by `reconciler.ts`'s `buildFormItemNode`, registered into
 * `host-bridge.ts`'s `formFieldChangeStore`, the same idiom `Action`'s
 * `onAction` already uses for `actionRegistry`).
 */
import { createElement, type ReactNode } from "react";

export interface FormProps {
  isLoading?: boolean;
  navigationTitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

function FormRoot({
  isLoading,
  navigationTitle,
  actions,
  children,
}: FormProps) {
  return createElement(
    "form",
    { isLoading, navigationTitle },
    actions,
    children,
  );
}

interface FieldBaseProps {
  id: string;
  title?: string;
  info?: string;
  error?: string;
  storeValue?: boolean;
}

export interface TextFieldProps extends FieldBaseProps {
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}

function makeTextLikeField(intrinsic: string) {
  return function TextLikeField({
    value,
    defaultValue,
    onChange,
    ...rest
  }: TextFieldProps) {
    return createElement(intrinsic, {
      ...rest,
      value: value ?? defaultValue,
      onChange,
    });
  };
}

const TextField = makeTextLikeField("form-text-field");
const PasswordField = makeTextLikeField("form-password-field");
const TextArea = makeTextLikeField("form-text-area");

export interface CheckboxProps extends FieldBaseProps {
  label?: string;
  value?: boolean;
  defaultValue?: boolean;
  onChange?: (value: boolean) => void;
}

function Checkbox({ value, defaultValue, onChange, ...rest }: CheckboxProps) {
  return createElement("form-checkbox", {
    ...rest,
    value: value ?? defaultValue,
    onChange,
  });
}

export interface DropdownItemProps {
  value: string;
  title: string;
  icon?: string;
}

function DropdownItem(props: DropdownItemProps) {
  return createElement("form-dropdown-item", props);
}

export interface DropdownProps extends FieldBaseProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  children?: ReactNode;
}

function Dropdown({
  value,
  defaultValue,
  onChange,
  children,
  ...rest
}: DropdownProps) {
  return createElement(
    "form-dropdown",
    { ...rest, value: value ?? defaultValue, onChange },
    children,
  );
}

export interface TagPickerItemProps {
  value: string;
  title: string;
  icon?: string;
}

function TagPickerItem(props: TagPickerItemProps) {
  return createElement("form-tag-picker-item", props);
}

export interface TagPickerProps extends FieldBaseProps {
  value?: string[];
  defaultValue?: string[];
  onChange?: (value: string[]) => void;
  children?: ReactNode;
}

function TagPicker({
  value,
  defaultValue,
  onChange,
  children,
  ...rest
}: TagPickerProps) {
  return createElement(
    "form-tag-picker",
    { ...rest, value: value ?? defaultValue, onChange },
    children,
  );
}

export interface DatePickerProps extends FieldBaseProps {
  value?: Date | null;
  defaultValue?: Date | null;
  type?: "date" | "datetime";
  onChange?: (value: Date | null) => void;
}

function DatePicker({
  value,
  defaultValue,
  onChange,
  ...rest
}: DatePickerProps) {
  const date = value ?? defaultValue;
  return createElement("form-date-picker", {
    ...rest,
    value: date ? date.toISOString() : undefined,
    onChange: onChange
      ? (iso: string) => onChange(iso ? new Date(iso) : null)
      : undefined,
  });
}

export interface FilePickerProps extends FieldBaseProps {
  value?: string[];
  defaultValue?: string[];
  allowMultiple?: boolean;
  canChooseDirectories?: boolean;
  onChange?: (value: string[]) => void;
}

function FilePicker({
  value,
  defaultValue,
  onChange,
  ...rest
}: FilePickerProps) {
  return createElement("form-file-picker", {
    ...rest,
    value: value ?? defaultValue,
    onChange,
  });
}

function Separator() {
  return createElement("form-separator", null);
}

export interface DescriptionProps {
  title?: string;
  text: string;
}

function Description(props: DescriptionProps) {
  return createElement("form-description", props);
}

function DropdownSection({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return createElement("form-dropdown-section", { title }, children);
}

/** A form's `searchBarAccessory` link — no slot for it in Magibar's form
 *  chrome yet, so it renders nothing rather than failing. */
function LinkAccessory(_props: { text: string; target: string }): null {
  return null;
}

export const Form = Object.assign(FormRoot, {
  TextField,
  PasswordField,
  TextArea,
  Checkbox,
  Dropdown: Object.assign(Dropdown, {
    Item: DropdownItem,
    Section: DropdownSection,
  }),
  TagPicker: Object.assign(TagPicker, { Item: TagPickerItem }),
  DatePicker,
  FilePicker,
  Separator,
  Description,
  LinkAccessory,
});

/** `Form.DatePicker.Type` / `Form.DatePicker.isFullDay` — static members
 *  real Raycast hangs off the component. */
Object.assign(Form.DatePicker, {
  Type: { Date: "date", DateTime: "datetime" },
  isFullDay(value: Date | null | undefined): boolean {
    return (
      !!value &&
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0
    );
  },
});
