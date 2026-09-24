import { createScreen } from "@renderer/screens/launcher/router/createScreen";
import { useRouteStack } from "@renderer/screens/launcher/router/context";
import { useLauncherHost } from "@renderer/screens/launcher/host";
import CreateQuicklink from "./renderer/CreateQuicklink";
import SearchQuicklinksScreen from "./renderer/SearchQuicklinksScreen";

/**
 * Adapter that connects the prop-driven `CreateQuicklink` form to the navigation
 * stack and the launcher host. Keeping the router knowledge here means the form
 * itself stays a plain component that's trivial to render in isolation; the
 * three routes below just pick which of these props to fill in from their payload.
 */
function QuicklinkForm({
  seed,
  editId,
  duplicateId,
  draftId,
}: {
  seed?: string;
  editId?: string;
  duplicateId?: string;
  draftId?: string;
}) {
  const { pop } = useRouteStack();
  const { setQuery, reload } = useLauncherHost();

  return (
    <CreateQuicklink
      seed={seed}
      editId={editId}
      duplicateId={duplicateId}
      draftId={draftId}
      // The form has already parked or cleared its draft by the time this runs
      // (see its `leave()`); `reload()` is what re-queries main, so the
      // launcher's "Drafts" section reflects that on the way back.
      onCancel={() => {
        pop();
        reload();
      }}
      onCreated={(name) => {
        pop();
        setQuery(name);
        reload();
      }}
    />
  );
}

/** The manager list, which lives in `./renderer` and knows nothing about the router. */
function SearchQuicklinks() {
  const { push, reset } = useRouteStack();
  const { setQuery } = useLauncherHost();

  return (
    <SearchQuicklinksScreen
      push={push}
      dismiss={() => {
        // Opening a link has to reach past the stack: the launcher should be
        // gone afterwards, and back where it started next time it opens.
        setQuery("");
        reset();
        window.api.hide();
      }}
    />
  );
}

export default [
  createScreen({
    name: "quicklink-search",
    component: () => <SearchQuicklinks />,
  }),
  createScreen({
    name: "quicklink-create",
    // Also the route a "Drafts" row reopens into (see `@extensions/draft`'s
    // `DRAFT_ROUTES`), which is why it takes a `draftId` as well as a seed.
    component: (payload) => {
      const { seed, draftId } =
        (payload as { seed?: string; draftId?: string } | undefined) ?? {};
      return <QuicklinkForm seed={seed} draftId={draftId} />;
    },
  }),
  createScreen({
    name: "quicklink-edit",
    component: (payload) => (
      <QuicklinkForm editId={(payload as { id: string }).id} />
    ),
  }),
  createScreen({
    name: "quicklink-duplicate",
    component: (payload) => (
      <QuicklinkForm duplicateId={(payload as { id: string }).id} />
    ),
  }),
];
