/**
 * Two routes sharing one form:
 *
 *  - `"plugin-preferences"` — an extension's preferences (extension-level,
 *    then each command's), reached right after an install that has required
 *    ones, from "Manage Extensions", from a command's
 *    `openExtensionPreferences()`, or automatically when launching a command
 *    whose required preferences aren't set (`continueWith` then launches it
 *    once saved — see `PluginHostSource.launch`).
 *  - `"plugin-arguments"` — a command's `arguments`, when it has required
 *    ones the launcher's inline argument chip didn't cover.
 *
 * Built on `shared/ui`'s `Layout` + `Form`, like every other form screen.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Form, Layout } from "@renderer/shared/ui";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import type {
  PluginArgumentField,
  PluginPreferenceField,
  PluginPreferencesPayload,
} from "@plugin-engine/host/protocol";
import type { LaunchOptionsInput } from "@plugin-engine/host/ipc-preload";

interface ContinueWith {
  actionId: string;
  options: LaunchOptionsInput;
}

export interface PluginPreferencesRoutePayload {
  pluginId: string;
  /** Launch this command once saved. */
  continueWith?: ContinueWith;
  justInstalled?: boolean;
  /** `openCommandPreferences()` — scroll that command's section into view. */
  focusCommand?: string;
}

export interface PluginArgumentsRoutePayload {
  actionId: string;
  title: string;
  pluginTitle: string;
  fields: PluginArgumentField[];
  values: Record<string, unknown>;
  options: LaunchOptionsInput;
}

/** A field in the shape this form renders — preferences and arguments
 *  normalized to one list. */
interface FieldSpec {
  name: string;
  kind: "text" | "password" | "checkbox" | "dropdown";
  title: string;
  description?: string;
  placeholder?: string;
  label?: string;
  required: boolean;
  data?: { title: string; value: string }[];
  section?: string;
}

function preferenceSpec(field: PluginPreferenceField): FieldSpec {
  const kind =
    field.type === "password"
      ? "password"
      : field.type === "checkbox"
        ? "checkbox"
        : field.type === "dropdown"
          ? "dropdown"
          : "text";
  const placeholder =
    field.placeholder ??
    (field.type === "file"
      ? "/path/to/file"
      : field.type === "directory"
        ? "/path/to/folder"
        : field.type === "appPicker"
          ? "Application name or path"
          : undefined);
  return {
    name: field.name,
    kind,
    title: field.title ?? field.name,
    description: field.description,
    placeholder,
    label: field.label,
    required: field.required,
    data: field.data,
    section: field.commandTitle,
  };
}

function initialValue(
  spec: FieldSpec,
  stored: unknown,
  fallback: unknown,
): unknown {
  if (stored !== undefined && stored !== null && stored !== "") return stored;
  if (fallback !== undefined) return fallback;
  if (spec.kind === "checkbox") return false;
  if (spec.kind === "dropdown") return spec.data?.[0]?.value ?? "";
  return "";
}

/** Values with required fields left blank. */
function missingRequired(
  specs: FieldSpec[],
  values: Record<string, unknown>,
): Set<string> {
  const missing = new Set<string>();
  for (const spec of specs) {
    if (!spec.required || spec.kind === "checkbox") continue;
    const value = values[spec.name];
    if (value === undefined || value === null || String(value).trim() === "") {
      missing.add(spec.name);
    }
  }
  return missing;
}

function FieldsForm({
  specs,
  values,
  onChange,
  errors,
  onSubmit,
}: {
  specs: FieldSpec[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  errors: Set<string>;
  onSubmit: () => void;
}): ReactNode {
  let lastSection: string | undefined;
  return (
    <Form variant="stacked" onSubmit={onSubmit}>
      {specs.map((spec, index) => {
        const heading =
          spec.section !== lastSection && spec.section ? (
            <Form.Description
              key={`section-${spec.section}`}
              text={spec.section}
            />
          ) : null;
        lastSection = spec.section;
        const error = errors.has(spec.name) ? "Required" : undefined;
        const value = values[spec.name];
        const field =
          spec.kind === "checkbox" ? (
            <Form.Switch
              key={spec.name}
              label={spec.label ?? spec.title}
              checked={value === true}
              onCheckedChange={(checked) => onChange(spec.name, checked)}
              size="sm"
            />
          ) : (
            <Form.Field
              key={spec.name}
              label={spec.required ? `${spec.title} *` : spec.title}
              description={spec.description}
              error={error}
            >
              {spec.kind === "dropdown" ? (
                <Form.Dropdown
                  items={spec.data ?? []}
                  value={String(value ?? "")}
                  onChange={(e) => onChange(spec.name, e.target.value)}
                />
              ) : (
                <Form.Input
                  autoFocus={index === 0}
                  type={spec.kind === "password" ? "password" : "text"}
                  value={String(value ?? "")}
                  placeholder={spec.placeholder}
                  onChange={(e) => onChange(spec.name, e.target.value)}
                />
              )}
            </Form.Field>
          );
        return heading ? [heading, field] : field;
      })}
    </Form>
  );
}

/** After saving/submitting: run `continueWith`, showing whatever it routes
 *  to in place of this screen. */
async function continueLaunch(
  continueWith: ContinueWith,
  nav: {
    replace: (r: { name: string; payload?: unknown }) => void;
    reset: () => void;
  },
): Promise<string | null> {
  const outcome = await window.api.pluginEngine.launch(
    continueWith.actionId,
    continueWith.options,
  );
  if (outcome.error) return outcome.error;
  if (outcome.navigate) nav.replace(outcome.navigate);
  else nav.reset();
  return null;
}

export function PluginPreferencesScreen(payload: unknown): ReactNode {
  const p = payload as PluginPreferencesRoutePayload | undefined;
  if (!p?.pluginId) return null;
  return <PreferencesForm {...p} />;
}

function PreferencesForm({
  pluginId,
  continueWith,
  justInstalled,
}: PluginPreferencesRoutePayload): ReactNode {
  const { pop, replace, reset } = useRouteStack();
  const [data, setData] = useState<PluginPreferencesPayload | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void window.api.pluginEngine.getPreferences(pluginId).then((loaded) => {
      if (!loaded) return;
      setData(loaded);
      const initial: Record<string, unknown> = {};
      for (const field of loaded.fields) {
        initial[field.name] = initialValue(
          preferenceSpec(field),
          loaded.values[field.name],
          field.default,
        );
      }
      setValues(initial);
    });
  }, [pluginId]);

  const specs = data?.fields.map(preferenceSpec) ?? [];

  async function save(): Promise<void> {
    if (busy || !data) return;
    const missing = missingRequired(specs, values);
    setErrors(missing);
    if (missing.size > 0) return;
    setBusy(true);
    await window.api.pluginEngine.setPreferences(pluginId, values);
    if (continueWith) {
      const error = await continueLaunch(continueWith, { replace, reset });
      setBusy(false);
      if (error) setFailure(error);
      return;
    }
    setBusy(false);
    pop();
  }

  useShortcut({ Escape: pop, "CommandOrControl+Enter": () => void save() });

  const title = data
    ? justInstalled
      ? `Set up ${data.title}`
      : `${data.title} Preferences`
    : "Preferences";

  return (
    <Layout>
      <Layout.Header title={title} onBack={pop} />
      <Layout.Content>
        {!data ? (
          <p className="text-sm text-foreground-subtle">Loading…</p>
        ) : specs.length === 0 ? (
          <p className="text-sm text-foreground-subtle">
            This extension has no preferences.
          </p>
        ) : (
          <>
            {justInstalled || continueWith ? (
              <p className="mb-3 text-sm text-foreground-subtle">
                {data.title} needs a few settings before it can run. Fields
                marked * are required.
              </p>
            ) : null}
            <FieldsForm
              specs={specs}
              values={values}
              errors={errors}
              onChange={(name, value) =>
                setValues((current) => ({ ...current, [name]: value }))
              }
              onSubmit={() => void save()}
            />
          </>
        )}
      </Layout.Content>
      <Layout.Footer>
        <Layout.Footer.Left>
          {failure ? (
            <Layout.Footer.Label>⚠︎ {failure}</Layout.Footer.Label>
          ) : null}
        </Layout.Footer.Left>
        <Layout.Footer.Right>
          <Layout.Footer.Button onClick={pop} shortcut="Escape">
            Cancel
          </Layout.Footer.Button>
          <Layout.Footer.Button
            variant="primary"
            shortcut="CommandOrControl+Enter"
            loading={busy}
            disabled={!data || specs.length === 0}
            onClick={() => void save()}
          >
            {continueWith ? "Save & Open" : "Save"}
          </Layout.Footer.Button>
        </Layout.Footer.Right>
      </Layout.Footer>
    </Layout>
  );
}

export function PluginArgumentsScreen(payload: unknown): ReactNode {
  const p = payload as PluginArgumentsRoutePayload | undefined;
  if (!p?.actionId) return null;
  return <ArgumentsForm {...p} />;
}

function ArgumentsForm({
  actionId,
  title,
  pluginTitle,
  fields,
  values: provided,
  options,
}: PluginArgumentsRoutePayload): ReactNode {
  const { pop, replace, reset } = useRouteStack();
  const specs: FieldSpec[] = fields.map((field) => ({
    name: field.name,
    kind:
      field.type === "password"
        ? "password"
        : field.type === "dropdown"
          ? "dropdown"
          : "text",
    title: field.placeholder ?? field.name,
    required: field.required,
    data: field.data,
  }));
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const spec of specs) {
      initial[spec.name] = initialValue(spec, provided[spec.name], undefined);
    }
    return initial;
  });
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    const missing = missingRequired(specs, values);
    setErrors(missing);
    if (missing.size > 0) return;
    setBusy(true);
    const error = await continueLaunch(
      { actionId, options: { ...options, arguments: values } },
      { replace, reset },
    );
    setBusy(false);
    if (error) setFailure(error);
  }

  useShortcut({ Escape: pop, "CommandOrControl+Enter": () => void submit() });

  return (
    <Layout>
      <Layout.Header title={`${title} — ${pluginTitle}`} onBack={pop} />
      <Layout.Content>
        <FieldsForm
          specs={specs}
          values={values}
          errors={errors}
          onChange={(name, value) =>
            setValues((current) => ({ ...current, [name]: value }))
          }
          onSubmit={() => void submit()}
        />
      </Layout.Content>
      <Layout.Footer>
        <Layout.Footer.Left>
          {failure ? (
            <Layout.Footer.Label>⚠︎ {failure}</Layout.Footer.Label>
          ) : null}
        </Layout.Footer.Left>
        <Layout.Footer.Right>
          <Layout.Footer.Button onClick={pop} shortcut="Escape">
            Cancel
          </Layout.Footer.Button>
          <Layout.Footer.Button
            variant="primary"
            shortcut="CommandOrControl+Enter"
            loading={busy}
            onClick={() => void submit()}
          >
            Open Command
          </Layout.Footer.Button>
        </Layout.Footer.Right>
      </Layout.Footer>
    </Layout>
  );
}
