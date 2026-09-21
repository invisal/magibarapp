import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reduceTour,
  tourStepIndex,
  TOUR_IDLE,
  TOUR_START,
  type TourEvent,
  type TourProgress,
} from "./tour.ts";

function run(events: TourEvent[], from: TourProgress = TOUR_START) {
  return events.reduce(reduceTour, from);
}

const TO_SEARCH: TourEvent[] = ["settings-opened", "advance", "launcher-shown"];

test("the happy path walks tray → hotkey → launch → search → actions → done → idle", () => {
  assert.deepEqual(run(["menu-opened"]), { step: "tray", menuOpen: true });
  assert.equal(run(["menu-opened", "settings-opened"]).step, "hotkey");
  assert.equal(
    run(["menu-opened", "settings-opened", "hotkey-confirmed"]).step,
    "launch",
  );
  assert.equal(
    run([
      "settings-opened",
      "advance",
      "launcher-shown",
      "search-answered",
      "actions-opened",
      "actions-used",
    ]).step,
    "done",
  );
  assert.deepEqual(
    run([
      "settings-opened",
      "advance",
      "launcher-shown",
      "search-answered",
      "actions-opened",
      "actions-used",
      "advance",
    ]),
    TOUR_IDLE,
  );
});

test("opening Settings clears the tray menu highlight", () => {
  assert.equal(run(["menu-opened", "settings-opened"]).menuOpen, false);
});

test("dismissing the tray menu returns the callout to the icon", () => {
  assert.equal(run(["menu-opened", "menu-closed"]).menuOpen, false);
});

test("closing Settings during the hotkey step sends the user back to the tray step", () => {
  assert.deepEqual(run(["settings-opened", "settings-closed"]), TOUR_START);
});

test("events that don't apply to the current step are ignored", () => {
  assert.deepEqual(
    run(["launcher-shown", "search-answered", "advance"]),
    TOUR_START,
  );
  const search = run(["settings-opened", "advance", "launcher-shown"]);
  assert.equal(search.step, "search");
  assert.deepEqual(
    run(["settings-opened", "settings-closed", "menu-opened"], search),
    search,
  );
});

test("an idle tour never wakes up", () => {
  assert.deepEqual(
    run(
      ["menu-opened", "settings-opened", "advance", "launcher-shown"],
      TOUR_IDLE,
    ),
    TOUR_IDLE,
  );
});

test("answering the search asks the user to open the Actions menu, which then asks them to pick something", () => {
  assert.equal(run([...TO_SEARCH, "search-answered"]).step, "actions");
  assert.equal(
    run([...TO_SEARCH, "search-answered", "actions-opened"]).step,
    "actions-use",
  );
});

test("closing the Actions menu without picking anything asks again", () => {
  assert.equal(
    run([...TO_SEARCH, "search-answered", "actions-opened", "actions-closed"])
      .step,
    "actions",
  );
});

test("the Actions menu events are ignored outside the actions steps", () => {
  const search = run(TO_SEARCH);
  assert.deepEqual(run(["actions-opened", "actions-used"], search), search);
});

test("both actions steps share one step number", () => {
  assert.equal(tourStepIndex("actions"), tourStepIndex("actions-use"));
  assert.equal(tourStepIndex("done"), -1);
});
