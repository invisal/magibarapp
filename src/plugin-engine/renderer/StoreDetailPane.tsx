/**
 * The right-hand pane of "Search Raycast Store": everything about the
 * highlighted extension before installing it — what it is, what it looks
 * like (its Store screenshots), which of its commands Magibar can run, and
 * the Store's facts about it.
 *
 * One scroll area, top to bottom, with the Install button in the header —
 * selecting a row only shows it here; installing is this button (or Enter).
 *
 * Search results already carry most of it; screenshots and the changelog
 * come from a per-extension lookup (`useStoreDetail`), fetched once the
 * highlight settles on a row.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "cnfast";
import { Detail } from "@renderer/shared/ui/Detail";
import { relativeAge } from "@shared/format";
import type {
  StoreDetailResponse,
  StoreExtensionSearchResult,
} from "@plugin-engine/host/protocol";

/** Arrowing through results shouldn't fire a lookup per row passed. */
const DETAIL_DELAY_MS = 150;

type LoadedDetail = Extract<StoreDetailResponse, { ok: true }>;

/** Screenshots/changelog for `result`, or `null` while loading / on error
 *  (the pane just shows what search already knew). */
function useStoreDetail(
  result: StoreExtensionSearchResult | null,
): LoadedDetail | null {
  const key = result ? `${result.author}/${result.name}` : null;
  const [detail, setDetail] = useState<{
    key: string;
    detail: LoadedDetail;
  } | null>(null);

  useEffect(() => {
    if (!result || !key) return;
    let live = true;
    const timer = setTimeout(() => {
      void window.api.pluginEngine
        .storeDetail(result.author, result.name)
        .then((response) => {
          if (live && response.ok) setDetail({ key, detail: response });
        });
    }, DETAIL_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `result` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return detail && detail.key === key ? detail.detail : null;
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 mb-1.5 text-[11px] font-medium tracking-wide text-foreground-subtle uppercase">
      {children}
    </div>
  );
}

/** The pane's primary button — Install, Reinstall, progress, or why not. */
export interface InstallAction {
  label: string;
  onClick?: () => void;
  /** Greyed out, not clickable (installing, or can't install). */
  disabled?: boolean;
  /** Secondary look (Reinstall of an installed extension). */
  secondary?: boolean;
}

export function InstallButton({ action }: { action: InstallAction }) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      onClick={action.onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-opacity [-webkit-app-region:no-drag]",
        action.secondary
          ? "bg-input text-foreground hover:bg-item-selected"
          : "bg-foreground text-background hover:opacity-90",
        action.disabled && "cursor-default opacity-50 hover:opacity-50",
      )}
    >
      <span className="max-w-40 truncate">{action.label}</span>
      {!action.disabled && <span className="opacity-60">↵</span>}
    </button>
  );
}

function Header({
  result,
  action,
}: {
  result: StoreExtensionSearchResult;
  action: InstallAction;
}) {
  return (
    <div className="flex items-start gap-3">
      {result.iconDataUri ? (
        <img
          src={result.iconDataUri}
          alt=""
          className="h-12 w-12 shrink-0 rounded-lg object-contain"
        />
      ) : (
        <span className="grid h-12 w-12 shrink-0 place-items-center text-3xl">
          🧩
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{result.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground-subtle">
          {result.authorAvatarUrl && (
            <img
              src={result.authorAvatarUrl}
              alt=""
              className="h-3.5 w-3.5 rounded-full"
            />
          )}
          <span className="truncate">{result.authorName ?? result.author}</span>
        </div>
        {result.description && (
          <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
            {result.description}
          </p>
        )}
      </div>
      <InstallButton action={action} />
    </div>
  );
}

/** The Store screenshots side by side, scrolled horizontally. */
function Screenshots({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1">
      {urls.map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          className="w-full shrink-0 snap-start rounded-md border border-border object-contain"
        />
      ))}
    </div>
  );
}

function Commands({ result }: { result: StoreExtensionSearchResult }) {
  if (result.commands.length === 0) return null;
  return (
    <>
      <SectionTitle>Commands</SectionTitle>
      <ul className="space-y-1.5">
        {result.commands.map((command) => (
          <li key={command.name} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span
                className={
                  command.supported ? "font-medium" : "text-foreground-subtle"
                }
              >
                {command.title}
              </span>
              {!command.supported && (
                <span className="text-[11px] text-amber-500">
                  Not supported
                </span>
              )}
            </div>
            {command.description && (
              <div className="text-foreground-subtle">
                {command.description}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function LatestChange({ detail }: { detail: LoadedDetail | null }) {
  const latest = detail?.changelog[0];
  if (!latest) return null;
  return (
    <>
      <SectionTitle>
        Latest change{latest.date ? ` · ${latest.date}` : ""}
      </SectionTitle>
      <div className="text-xs font-medium">{latest.title}</div>
      {latest.markdown && (
        <div className="text-xs text-foreground-subtle">
          <Detail.Markdown>{latest.markdown}</Detail.Markdown>
        </div>
      )}
    </>
  );
}

export function StoreDetailPane({
  result,
  status,
  action,
}: {
  result: StoreExtensionSearchResult | null;
  /** Install progress / outcome for this extension, if any. */
  status?: ReactNode;
  action: InstallAction;
}): ReactNode {
  const detail = useStoreDetail(result);
  if (!result) {
    return (
      <Detail.Empty>
        Search thousands of extensions — select one to see its details.
      </Detail.Empty>
    );
  }
  const now = Date.now();
  return (
    <div className="h-full overflow-y-auto p-4">
      <Header result={result} action={action} />
      <Screenshots urls={detail?.screenshots ?? []} />
      <Commands result={result} />
      <LatestChange detail={detail} />
      <SectionTitle>Information</SectionTitle>
      <Detail.Row label="Status" value={status} />
      <Detail.Row
        label="Author"
        value={result.authorName ?? result.author}
        icon={result.authorAvatarUrl}
      />
      <Detail.Row
        label="Downloads"
        value={result.downloadCount.toLocaleString()}
      />
      <Detail.Row
        label="Platforms"
        value={
          result.supported
            ? (result.platforms?.join(", ") ?? "macOS")
            : `${result.platforms?.join(", ") ?? "macOS"} — not this platform`
        }
      />
      {result.categories.length > 0 && (
        <Detail.TagList
          label="Categories"
          items={result.categories.map((text) => ({ text }))}
        />
      )}
      <Detail.Row
        label="Updated"
        value={
          result.updatedAt
            ? relativeAge(result.updatedAt * 1000, now)
            : undefined
        }
      />
      <Detail.Row
        label="Published"
        value={
          result.createdAt
            ? relativeAge(result.createdAt * 1000, now)
            : undefined
        }
      />
    </div>
  );
}
