/**
 * The `Form`-command screen — owns the controlled-input state for every
 * field, sending `form-value-changed` on each edit and `form-submit` (with
 * the full current snapshot) when the `Action.SubmitForm` action fires,
 * instead of the ordinary `action-invoked` path (a plain action id has no
 * room for the values payload).
 */
import { useMemo, useState, type ReactNode } from "react";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { Form } from "@renderer/shared/ui/Form";
import { Footer } from "@renderer/shared/ui/Footer";
import { useShortcut } from "@renderer/lib/use-shortcut";
import type {
  PluginFormItemNode,
  PluginFormTree,
  PluginInboundEvent,
} from "@plugin-engine/host/protocol";
import { initialFormValues } from "./map-form-tree";
import { actionPanelToMenuItems } from "./map-tree";

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 3.5L4.5 8l5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface PluginFormScreenProps {
  tree: PluginFormTree;
  title: string;
  invokeAction: (actionId: string) => void;
  sendEvent: (event: PluginInboundEvent) => void;
  /** Back/Escape — see `PluginDetailScreen`'s `onBack`. */
  onBack?: () => void;
}

function FormItem({
  item,
  value,
  onChange,
}: {
  item: PluginFormItemNode;
  value: unknown;
  onChange: (value: unknown) => void;
}): ReactNode {
  switch (item.kind) {
    case "separator":
      return <Form.Separator />;
    case "description":
      return <Form.Description title={item.title} text={item.text} />;
    // `Form.Switch` renders its own label/toggle row (it doesn't take
    // `Form.Field`'s `label` prop the way text controls do), so it's the
    // one kind rendered standalone rather than wrapped in a `Form.Field`.
    case "checkbox":
      return (
        <Form.Switch
          label={item.label ?? item.title ?? ""}
          checked={Boolean(value)}
          onCheckedChange={onChange}
          size="sm"
        />
      );
  }

  return (
    <Form.Field label={item.title} description={item.info} error={item.error}>
      {item.kind === "text-field" && (
        <Form.Input
          value={(value as string) ?? ""}
          placeholder={item.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {item.kind === "password-field" && (
        <Form.Input
          type="password"
          value={(value as string) ?? ""}
          placeholder={item.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {item.kind === "text-area" && (
        <Form.TextArea
          value={(value as string) ?? ""}
          placeholder={item.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {item.kind === "dropdown" && (
        <Form.Dropdown
          items={item.items}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {item.kind === "tag-picker" && (
        <Form.TagPicker
          items={item.items}
          value={(value as string[]) ?? []}
          onChange={onChange}
        />
      )}
      {item.kind === "date-picker" && (
        <Form.DatePicker
          includeTime={item.type === "datetime"}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {item.kind === "file-picker" && (
        <Form.FilePicker
          multiple={item.allowMultiple}
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            onChange(
              await Promise.all(files.map((f) => window.api.getPathForFile(f))),
            );
          }}
        />
      )}
    </Form.Field>
  );
}

export function PluginFormScreen({
  tree,
  title,
  invokeAction,
  sendEvent,
  onBack,
}: PluginFormScreenProps): ReactNode {
  const { stack, pop } = useRouteStack();
  const back = onBack ?? pop;
  const canGoBack = stack.length > 1 || !!onBack;
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialFormValues(tree.items),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  // Escape closes the actions menu first while it's open.
  useShortcut({ Escape: !menuOpen && back });

  const submitActionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const section of tree.actionPanel?.sections ?? []) {
      for (const action of section.actions) {
        if (action.kind === "submit-form") ids.add(action.id);
      }
    }
    return ids;
  }, [tree.actionPanel]);

  function setFieldValue(fieldId: string, value: unknown): void {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    sendEvent({ type: "form-value-changed", fieldId, value });
  }

  function handleActionSelect(actionId: string): void {
    if (submitActionIds.has(actionId)) {
      sendEvent({ type: "form-submit", values });
    } else {
      invokeAction(actionId);
    }
  }

  const menuItems = actionPanelToMenuItems(
    tree.actionPanel,
    handleActionSelect,
  );
  const primaryAction = tree.actionPanel?.sections[0]?.actions[0];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-2 p-1 [-webkit-app-region:drag]">
        {canGoBack && (
          <button
            type="button"
            aria-label="Back"
            onClick={back}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-foreground-subtle transition-colors hover:bg-item-hover hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <BackIcon />
          </button>
        )}
        <span className="truncate px-1 text-sm font-medium">
          {tree.navigationTitle ?? title}
        </span>
      </div>

      <form
        className="min-h-0 flex-1 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (primaryAction) handleActionSelect(primaryAction.id);
        }}
      >
        <Form variant="stacked">
          {tree.items.map((item) => (
            <FormItem
              key={"id" in item ? item.id : item.kind}
              item={item}
              value={"id" in item ? values[item.id] : undefined}
              onChange={(value) => {
                if ("id" in item) setFieldValue(item.id, value);
              }}
            />
          ))}
        </Form>
      </form>

      <Footer>
        {menuItems.length > 0 && (
          <Footer.Right>
            <Footer.Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={menuItems}
            />
          </Footer.Right>
        )}
      </Footer>
    </div>
  );
}
