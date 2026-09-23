/**
 * Turns a ranked, flat list of actions into the sectioned list the launcher
 * draws — the Raycast-style "Suggestions / Commands / Applications" headings.
 *
 * `query()` in `actions.ts` hands this whatever order it decided on (frecency
 * for the empty root list, fuzzy relevance for a typed one) and this only
 * *groups* it: every row gets a `group`, the few highest-frecency rows are
 * lifted into "Suggestions", and the list is stably re-sorted by
 * `ACTION_GROUP_ORDER`. Stability is the whole trick — the caller's ranking
 * survives untouched inside each section, so this never has to know how a row
 * was ranked.
 *
 * Electron-free, so the `node --test` suite drives it directly.
 */
import {
  ACTION_GROUP_ORDER,
  defaultActionGroup,
  type ActionGroup,
  type LauncherAction,
} from "../shared/types.ts";

/**
 * How many rows "Suggestions" holds at most. Four is the same order as
 * Raycast's: enough that a habit is reliably at the top, few enough that the
 * section below it is still on screen.
 */
export const SUGGESTION_LIMIT = 4;

export interface SectionOptions {
  /** actionId → decayed frecency (`Usage.scores()`). Only rows above 0 can be suggested. */
  scores: Map<string, number>;
  /** Cap on the "Suggestions" section. Default {@link SUGGESTION_LIMIT}; 0 disables it. */
  limit?: number;
  /** Root list only — give pinned rows their own section. See `defaultActionGroup`. */
  pinnedSection?: boolean;
}

const groupRank = (group: ActionGroup): number =>
  ACTION_GROUP_ORDER.indexOf(group);

/**
 * A row can be lifted into "Suggestions" only out of a type section. Drafts
 * and Pinned are deliberate, user-made sections — pulling a row out of one to
 * "suggest" it would just move it *down* the list and make the section it came
 * from look wrong.
 */
const isLiftable = (group: ActionGroup): boolean =>
  group === "Commands" || group === "Applications" || group === "Results";

/**
 * Assign every action its section and return the list re-sorted by section.
 *
 * Suggestions are *chosen* by frecency but *ordered* by the caller's ranking,
 * so the section reads as "the best of what you asked for" rather than
 * reshuffling relevance. A list whose rows all end up suggested collapses back
 * to a single section, which `ListScreen` then renders flat, with no heading.
 */
export function applySections(
  actions: LauncherAction[],
  opts: SectionOptions,
): LauncherAction[] {
  const { scores, limit = SUGGESTION_LIMIT, pinnedSection = false } = opts;

  const base = actions.map((action) => ({
    action,
    group: action.group ?? defaultActionGroup(action, { pinnedSection }),
  }));

  const suggested = new Set<string>(
    base
      .filter(
        (entry) =>
          isLiftable(entry.group) && (scores.get(entry.action.id) ?? 0) > 0,
      )
      // Highest frecency wins the limited number of slots. `sort` is stable, so
      // rows tied on frecency fall back to the caller's ranking.
      .sort(
        (a, b) =>
          (scores.get(b.action.id) ?? 0) - (scores.get(a.action.id) ?? 0),
      )
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.action.id),
  );

  return (
    base
      .map((entry) => ({
        ...entry,
        group: suggested.has(entry.action.id)
          ? ("Suggestions" as const)
          : entry.group,
      }))
      // Stable: the caller's ranking is preserved within each section.
      .sort((a, b) => groupRank(a.group) - groupRank(b.group))
      .map((entry) => ({ ...entry.action, group: entry.group }))
  );
}
