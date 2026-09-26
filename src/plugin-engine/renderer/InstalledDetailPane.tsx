/**
 * The right-hand pane of "Manage Extensions": the selected extension's
 * settings, edited in place, with its commands and install details — one
 * scroll area, like Search Raycast Store's pane (`StoreDetailPane`).
 */
import { useState, type ReactNode } from "react";
import { cn } from "cnfast";
import { Detail } from "@renderer/shared/ui/Detail";
import { useShortcut } from "@renderer/lib/use-shortcut";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { relativeAge } from "@shared/format";
import type { InstalledPluginSummary } from "@plugin-engine/host/protocol";
import { FieldsForm, usePluginPreferences } from "./PluginPreferencesScreen";

const SOURCE_LABEL: Record<InstalledPluginSummary["source"], string> = {
  store: "Store",
  github: "GitHub",
  local: "Local folder",
};

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 mb-1.5 text-[11px] font-medium tracking-wide text-foreground-subtle uppercase">
      {children}
    </div>
  );
}

function PaneButton({
  children,
  onClick,
  disabled,
  tone = "secondary",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-opacity [-webkit-app-region:no-drag]",
        tone === "primary" && "bg-foreground text-background hover:opacity-90",
        tone === "secondary" &&
          "bg-input text-foreground hover:bg-item-selected",
        tone === "danger" && "bg-input text-red-500 hover:bg-red-500/15",
        disabled && "cursor-default opacity-50 hover:opacity-50",
      )}
    >
      {children}
    </button>
  );
}

/** Uninstall needs a second click — the button turns into the question. */
function UninstallButton({
  title,
  onUninstall,
  disabled,
}: {
  title: string;
  onUninstall: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <span onMouseLeave={() => setArmed(false)}>
      <PaneButton
        tone="danger"
        disabled={disabled}
        onClick={() => {
          if (armed) onUninstall();
          else setArmed(true);
        }}
      >
        {armed ? `Uninstall ${title}?` : "Uninstall"}
      </PaneButton>
    </span>
  );
}

function Settings({
  plugin,
  onSaved,
}: {
  plugin: InstalledPluginSummary;
  onSaved: () => void;
}) {
  const prefs = usePluginPreferences(plugin.id);
  const [justSaved, setJustSaved] = useState(false);

  async function save(): Promise<void> {
    if (await prefs.save()) {
      setJustSaved(true);
      onSaved();
    }
  }

  useShortcut({ "CommandOrControl+S": () => void save() });

  if (!prefs.data) {
    return <p className="text-xs text-foreground-subtle">Loading…</p>;
  }
  if (prefs.specs.length === 0) {
    return (
      <p className="text-xs text-foreground-subtle">
        This extension has no settings.
      </p>
    );
  }
  return (
    <div>
      {plugin.missingRequiredPreferences && (
        <p className="mb-3 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-500">
          Needs setup — fill in the fields marked * before its commands can run.
        </p>
      )}
      <FieldsForm
        specs={prefs.specs}
        values={prefs.values}
        errors={prefs.errors}
        onChange={(name, value) => {
          setJustSaved(false);
          prefs.setValue(name, value);
        }}
        onSubmit={() => void save()}
        autoFocusFirst={false}
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        {justSaved && !prefs.dirty && (
          <span className="text-xs text-green-500">Saved</span>
        )}
        <PaneButton
          tone="primary"
          disabled={!prefs.dirty || prefs.busy}
          onClick={() => void save()}
        >
          Save <span className="opacity-60">⌘S</span>
        </PaneButton>
      </div>
    </div>
  );
}

function Commands({ plugin }: { plugin: InstalledPluginSummary }) {
  const { push } = useRouteStack();
  const [error, setError] = useState<string | null>(null);

  async function open(actionId: string): Promise<void> {
    const outcome = await window.api.pluginEngine.launch(actionId, {});
    if (outcome.error) setError(outcome.error);
    else if (outcome.navigate) push(outcome.navigate);
  }

  return (
    <>
      <ul className="space-y-0.5">
        {plugin.commands.map((command) => (
          <li key={command.actionId}>
            <button
              type="button"
              onClick={() => void open(command.actionId)}
              className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-item-hover"
            >
              {(command.iconDataUri ?? plugin.iconDataUri) ? (
                <img
                  src={(command.iconDataUri ?? plugin.iconDataUri)!}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded object-contain"
                />
              ) : (
                <span className="w-4 text-center">🧩</span>
              )}
              <span className="font-medium">{command.title}</span>
              {command.subtitle && (
                <span className="truncate text-foreground-subtle">
                  {command.subtitle}
                </span>
              )}
              <span className="ml-auto shrink-0 text-foreground-subtle opacity-0 group-hover:opacity-100">
                Open ↗
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 text-xs text-amber-500">⚠︎ {error}</p>}
    </>
  );
}

export function InstalledDetailPane({
  plugin,
  busy,
  onUpdate,
  onUninstall,
  onSettingsSaved,
}: {
  plugin: InstalledPluginSummary | null;
  /** An update/uninstall is running (for any extension). */
  busy: boolean;
  onUpdate: (plugin: InstalledPluginSummary) => void;
  onUninstall: (plugin: InstalledPluginSummary) => void;
  onSettingsSaved: () => void;
}): ReactNode {
  if (!plugin) {
    return (
      <Detail.Empty>
        Select an extension to see its settings and commands.
      </Detail.Empty>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-start gap-3">
        {plugin.iconDataUri ? (
          <img
            src={plugin.iconDataUri}
            alt=""
            className="h-12 w-12 shrink-0 rounded-lg object-contain"
          />
        ) : (
          <span className="grid h-12 w-12 shrink-0 place-items-center text-3xl">
            🧩
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{plugin.title}</div>
          {plugin.author && (
            <div className="mt-0.5 truncate text-xs text-foreground-subtle">
              {plugin.author}
            </div>
          )}
          {plugin.description && (
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
              {plugin.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <PaneButton disabled={busy} onClick={() => onUpdate(plugin)}>
            {plugin.source === "store" ? "Update" : "Reinstall"}
          </PaneButton>
          <UninstallButton
            title={plugin.title}
            disabled={busy}
            onUninstall={() => onUninstall(plugin)}
          />
        </div>
      </div>

      <SectionTitle>Settings</SectionTitle>
      {/* Keyed so switching extensions starts from that one's saved values. */}
      <div
        data-plugin-settings
        // Escape in a field hands the keyboard back to the list's search
        // box (Enter there is what brought it here).
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget
            .closest(".h-screen")
            ?.querySelector<HTMLInputElement>("input")
            ?.focus();
        }}
      >
        <Settings key={plugin.id} plugin={plugin} onSaved={onSettingsSaved} />
      </div>

      {plugin.commands.length > 0 && (
        <>
          <SectionTitle>Commands</SectionTitle>
          <Commands plugin={plugin} />
        </>
      )}

      <SectionTitle>Information</SectionTitle>
      <Detail.Row label="Source" value={SOURCE_LABEL[plugin.source]} />
      <Detail.Row label="Location" value={plugin.sourceLocation} />
      <Detail.Row label="Author" value={plugin.author} />
      <Detail.Row label="Version" value={plugin.version} />
      <Detail.Row
        label="Installed"
        value={relativeAge(plugin.installedAt, Date.now())}
      />
    </div>
  );
}
