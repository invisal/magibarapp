import assert from "node:assert/strict";
import { test } from "node:test";

import { applySections, SUGGESTION_LIMIT } from "./sections.ts";
import type { ActionGroup, LauncherAction } from "../shared/types.ts";

type Spec = Partial<LauncherAction> & { id: string };

const action = (spec: Spec): LauncherAction => ({
  title: spec.id,
  type: "command",
  ...spec,
});

const scores = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

/** `[id, group]` pairs, for terse assertions about the shape of a sectioned list. */
const shape = (list: LauncherAction[]): [string, ActionGroup | undefined][] =>
  list.map((a) => [a.id, a.group]);

test("types an action by its `type` when nothing is used", () => {
  const out = applySections(
    [
      action({ id: "app", type: "application" }),
      action({ id: "cmd", type: "command" }),
    ],
    { scores: scores({}) },
  );

  assert.deepEqual(shape(out), [
    ["cmd", "Commands"],
    ["app", "Applications"],
  ]);
});

test("lifts the most-used rows into Suggestions, above their type sections", () => {
  const out = applySections(
    [
      action({ id: "cmd" }),
      action({ id: "app", type: "application" }),
      action({ id: "used" }),
    ],
    { scores: scores({ used: 5 }) },
  );

  assert.deepEqual(shape(out), [
    ["used", "Suggestions"],
    ["cmd", "Commands"],
    ["app", "Applications"],
  ]);
});

test("Suggestions are chosen by frecency but keep the caller's ranking", () => {
  // Caller ranked b, a, c; frecency says a is used most.
  const out = applySections(
    [action({ id: "b" }), action({ id: "a" }), action({ id: "c" })],
    { scores: scores({ a: 9, b: 1 }) },
  );

  assert.deepEqual(shape(out), [
    ["b", "Suggestions"],
    ["a", "Suggestions"],
    ["c", "Commands"],
  ]);
});

test("Suggestions is capped, and the losers stay in their type section", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const out = applySections(
    ids.map((id) => action({ id })),
    // Descending frecency, so the first SUGGESTION_LIMIT ids win the slots.
    { scores: scores(Object.fromEntries(ids.map((id, i) => [id, 10 - i]))) },
  );

  const suggestions = out.filter((a) => a.group === "Suggestions");
  assert.equal(suggestions.length, SUGGESTION_LIMIT);
  assert.deepEqual(
    suggestions.map((a) => a.id),
    ids.slice(0, SUGGESTION_LIMIT),
  );
  assert.deepEqual(
    out.filter((a) => a.group === "Commands").map((a) => a.id),
    ids.slice(SUGGESTION_LIMIT),
  );
});

test("`limit: 0` turns Suggestions off entirely", () => {
  const out = applySections([action({ id: "used" })], {
    scores: scores({ used: 5 }),
    limit: 0,
  });

  assert.deepEqual(shape(out), [["used", "Commands"]]);
});

test("a group the source set wins over the type default", () => {
  const out = applySections(
    [action({ id: "cmd" }), action({ id: "draft:1", group: "Drafts" })],
    { scores: scores({}) },
  );

  assert.deepEqual(shape(out), [
    ["draft:1", "Drafts"],
    ["cmd", "Commands"],
  ]);
});

test("a Draft is never lifted into Suggestions, however used it is", () => {
  const out = applySections([action({ id: "draft:1", group: "Drafts" })], {
    scores: scores({ "draft:1": 99 }),
  });

  assert.deepEqual(shape(out), [["draft:1", "Drafts"]]);
});

test("root list: pinned rows get their own section, ahead of Suggestions", () => {
  const out = applySections(
    [
      action({ id: "used" }),
      action({ id: "pin", pinned: true, type: "quicklink" }),
    ],
    { scores: scores({ used: 5, pin: 9 }), pinnedSection: true },
  );

  assert.deepEqual(shape(out), [
    ["pin", "Pinned"],
    ["used", "Suggestions"],
  ]);
});

test("typed search: pinning is not a section, so a pinned row can be suggested", () => {
  const out = applySections(
    [action({ id: "pin", pinned: true, type: "quicklink" })],
    { scores: scores({ pin: 9 }), pinnedSection: false },
  );

  assert.deepEqual(shape(out), [["pin", "Suggestions"]]);
});

test("does not mutate the actions it is given", () => {
  const input = [action({ id: "used" })];
  applySections(input, { scores: scores({ used: 5 }) });

  assert.equal(input[0].group, undefined);
});
