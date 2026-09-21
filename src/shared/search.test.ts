import assert from "node:assert/strict";
import { test } from "node:test";

import { fuzzyMatch, matchAction } from "./search.ts";

/**
 * The scoring model has too many interacting rules (word starts, camelCase
 * humps, consecutive runs, leading gap, trailing length) to give every case a
 * good name. Instead the interesting behaviour is written down as a table of
 * concrete examples:
 *
 *  - `matchCases`   – does `query` match `title` at all?
 *  - `scoreCases`   – exact score for the few inputs that have a defined one.
 *  - `rankingCases` – `titles` listed best-first; we score them all and assert
 *                     the sort comes out in that order.
 *
 * Add a row whenever real usage turns up an ordering that feels wrong.
 */

const matchCases: ReadonlyArray<{
  query: string;
  title: string;
  match: boolean;
}> = [
  { query: "", title: "Visual Studio Code", match: true },
  { query: "code", title: "Visual Studio Code", match: true },
  { query: "vsc", title: "Visual Studio Code", match: true },
  { query: "cat", title: "car", match: false }, // same length, not a subsequence
  { query: "abcd", title: "abc", match: false }, // query longer than title
  { query: "xyz", title: "abc", match: false }, // no shared characters
  { query: "cba", title: "abc", match: false }, // right characters, wrong order
];

for (const { query, title, match } of matchCases) {
  test(`match(${JSON.stringify(query)}, ${JSON.stringify(title)}) === ${match}`, () => {
    const result = fuzzyMatch(query, title);
    assert.equal(result.match, match);
    if (!match) assert.equal(result.score, -Infinity);
  });
}

const scoreCases: ReadonlyArray<{
  query: string;
  title: string;
  score: number;
}> = [
  { query: "", title: "Visual Studio Code", score: 0 }, // empty query is neutral
  { query: "Code", title: "code", score: Infinity }, // exact, case-insensitive
  { query: "abc", title: "abc", score: Infinity }, // exact
];

for (const { query, title, score } of scoreCases) {
  test(`score(${JSON.stringify(query)}, ${JSON.stringify(title)}) === ${score}`, () => {
    const result = fuzzyMatch(query, title);
    assert.equal(result.match, true);
    assert.equal(result.score, score);
  });
}

const rankingCases: ReadonlyArray<{ query: string; titles: string[] }> = [
  // A consecutive run beats the same characters scattered.
  { query: "abc", titles: ["abcxyz", "axbxcx"] },
  // A word-boundary match beats a mid-word one.
  { query: "st", titles: ["Sublime Text", "Fastest"] },
  // A camelCase hump counts as a word start.
  { query: "hw", titles: ["HelloWorld", "Hardware"] },
  // An earlier match beats a later one (leading-gap penalty).
  { query: "z", titles: ["zxxxxx", "xxxxxz"] },
  // Start-of-string bonus beats a start-of-later-word bonus.
  { query: "v", titles: ["Vim", "Event Viewer"] },
  // "vi": a literal prefix, then split across two words, then on a later word.
  {
    query: "vi",
    titles: ["Vim", "Visual Studio", "Voom Intel", "Event Viewer"],
  },
  // Among equally-good prefixes, the shorter title wins (length tiebreak).
  { query: "vi", titles: ["Visual Studio", "Visual Studio Code"] },
  { query: "chr", titles: ["Chrome", "Chromium", "Google Chrome"] },
  // A single letter at the start of the string beats the same letter mid-word.
  { query: "o", titles: ["Outlook", "Google Chrome"] },
  { query: "note", titles: ["Notepad", "Notepad++", "Keep Notes"] },
  // All match "Code" as a whole word; rank by how much unmatched tail follows.
  {
    query: "code",
    titles: ["VS Code", "QR Code Generator", "Visual Studio Code"],
  },
];

for (const { query, titles } of rankingCases) {
  test(`rank(${JSON.stringify(query)}): ${titles.join(" > ")}`, () => {
    const ranked = [...titles]
      .reverse() // start from the worst order so a no-op sort can't pass
      .map((title) => ({ title, ...fuzzyMatch(query, title) }))
      .sort((a, b) => b.score - a.score);

    for (const r of ranked) {
      assert.equal(
        r.match,
        true,
        `${JSON.stringify(query)} should match ${JSON.stringify(r.title)}`,
      );
    }
    assert.deepEqual(
      ranked.map((r) => r.title),
      titles,
      `scores: ${ranked.map((r) => `${r.title}=${r.score.toFixed(4)}`).join(", ")}`,
    );
  });
}

test("no-match results are fresh objects, not a shared singleton", () => {
  assert.notEqual(fuzzyMatch("zzz", "abc"), fuzzyMatch("zzz", "abc"));
});

// --- matchAction: title + keyword-alias matching ---------------------------

test("matchAction with no keyword is just a title match", () => {
  assert.deepEqual(
    matchAction("code", { title: "Visual Studio Code" }),
    fuzzyMatch("code", "Visual Studio Code"),
  );
});

test("matchAction: an exact keyword as the first word matches with an argument trailing", () => {
  // "google search" never fuzzy-matches "g cats", but the keyword does.
  assert.equal(fuzzyMatch("g cats", "Google Search").match, false);
  const m = matchAction("g cats", { title: "Google Search", keyword: "g" });
  assert.equal(m.match, true);
  assert.equal(m.score, 100);
});

test("matchAction: an exact keyword beats a fuzzy title match on a rival", () => {
  const quicklink = matchAction("g", { title: "Google Search", keyword: "g" });
  const app = matchAction("g", { title: "GIMP" });
  assert.ok(quicklink.score > app.score);
});

test("matchAction: a non-exact keyword prefix still matches, but ranks lower", () => {
  const exact = matchAction("gh", { title: "GitHub", keyword: "gh" });
  const prefix = matchAction("g", { title: "GitHub", keyword: "gh" });
  assert.equal(exact.score, 100);
  assert.equal(prefix.score, 10);
});

test("matchAction: a strong title match is kept when it beats the keyword score", () => {
  // Exact title match scores Infinity; the keyword's 100 must not lower it.
  const m = matchAction("code", { title: "Code", keyword: "code" });
  assert.equal(m.score, Infinity);
});

test("matchAction: an unrelated query matches neither title nor keyword", () => {
  assert.equal(
    matchAction("zzz", { title: "Google Search", keyword: "g" }).match,
    false,
  );
});

test("matchAction: a tag equal to the whole query is a strong match", () => {
  const m = matchAction("work", {
    title: "Internal Dashboard",
    tags: ["work", "ops"],
  });
  assert.equal(m.match, true);
  assert.equal(m.score, 20);
});

test("matchAction: every word must match (AND) — a tag alone doesn't carry a longer query", () => {
  assert.equal(
    matchAction("work stuff", { title: "Internal Dashboard", tags: ["work"] })
      .match,
    false,
  );
  const m = matchAction("work dash", {
    title: "Internal Dashboard",
    tags: ["work"],
  });
  assert.equal(m.match, true);
});

test("matchAction: words match in any order", () => {
  assert.equal(
    matchAction("code visual", { title: "Visual Studio Code" }).match,
    true,
  );
  assert.equal(
    matchAction("studio zzz", { title: "Visual Studio Code" }).match,
    false,
  );
});

// --- matchAction: alternative names -----------------------------------------

test("matchAction: an alt name surfaces the action (Kill Process → Quit Processes)", () => {
  const action = {
    title: "Quit Processes",
    altNames: ["Kill Process", "End Task"],
  };
  assert.equal(matchAction("kill", action).match, true);
  assert.equal(matchAction("kill proc", action).match, true);
  assert.equal(matchAction("end task", action).match, true);
  assert.equal(matchAction("zzz", action).match, false);
});

test("matchAction: an exact alt name scores high, a fuzzy one just under the title", () => {
  assert.equal(
    matchAction("vscode", { title: "Visual Studio Code", altNames: ["vscode"] })
      .score,
    30,
  );
  const viaTitle = matchAction("note", { title: "Notepad" });
  const viaAlt = matchAction("note", {
    title: "Editor",
    altNames: ["Notepad"],
  });
  assert.ok(viaAlt.score < viaTitle.score);
});

test("matchAction: a query word may come from the title and another from an alt name", () => {
  assert.equal(
    matchAction("kill quit", {
      title: "Quit Processes",
      altNames: ["Kill Process"],
    }).match,
    true,
  );
});

// --- matchAction: static subtitle -------------------------------------------

test("matchAction: a subtitle word prefix surfaces a row the title misses", () => {
  const m = matchAction("clipboard", {
    title: "Paste History",
    subtitle: "Browse your clipboard history",
  });
  assert.equal(m.match, true);
  assert.equal(m.score, 0.5);
});

test("matchAction: a subtitle hit ranks below a real title hit", () => {
  const viaTitle = matchAction("note", { title: "Notepad" });
  const viaSubtitle = matchAction("note", {
    title: "Editor",
    subtitle: "Quick notes",
  });
  assert.ok(viaTitle.score > viaSubtitle.score);
});

test("matchAction: the subtitle is matched strictly, not as a subsequence", () => {
  // p…d…f is a subsequence of this subtitle but not a word in it.
  assert.equal(
    matchAction("pdf", {
      title: "Zed",
      subtitle: "Open a project in the editor",
    }).match,
    false,
  );
});

test("matchAction: a single letter never matches a subtitle", () => {
  assert.equal(
    matchAction("q", { title: "Zed", subtitle: "quick editor" }).match,
    false,
  );
});

test("matchAction: a longer word may hit mid-word in the subtitle, weakly", () => {
  const m = matchAction("board", { title: "Zed", subtitle: "Clipboard tools" });
  assert.equal(m.match, true);
  assert.equal(m.score, 0.1);
});

test("matchAction: title words and subtitle words can split a query", () => {
  const m = matchAction("chrome work", {
    title: "Google Chrome",
    subtitle: "Work profile",
  });
  assert.equal(m.match, true);
});

test("matchAction: tags don't match a partial word", () => {
  assert.equal(matchAction("wor", { title: "X", tags: ["work"] }).match, false);
});
