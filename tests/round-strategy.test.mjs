import test from "node:test";
import assert from "node:assert/strict";

import { RoundStrategyContext, roundMetrics } from "../src/round-strategy.mjs";

test("roundMetrics derives the blind deficit and required score pace", () => {
  assert.deepEqual(roundMetrics({ score: 92, target: 300, handsLeft: 2, discardsLeft: 3 }), {
    score: 92,
    target: 300,
    deficit: 208,
    handsLeft: 2,
    discardsLeft: 3,
    neededPerHand: 104,
  });
});

test("RoundStrategyContext carries one deck inspection across a blind", () => {
  const context = new RoundStrategyContext();
  context.observe({
    screen: "blind_select",
    state: { ante: 1, blind: "Small", score: 0, target: 300, handsLeft: 4, discardsLeft: 4 },
    actions: [{ type: "click", target: "select_blind" }],
  });
  assert.match(context.promptContext(), /need 300/);
  assert.match(context.promptContext(), /has not been inspected/);

  context.observe({
    screen: "hand",
    state: { ante: 1, blind: "Small", score: 92, target: 300, handsLeft: 2, discardsLeft: 3 },
    actions: [{ type: "click", target: "open_deck" }],
  });
  assert.match(context.promptContext(), /overlay was requested/);

  context.observe({
    screen: "overlay",
    state: { deckSnapshot: "remain39 A:2 J:2; S:10 H:9 C:10 D:10" },
    actions: [{ type: "key", key: "escape" }],
  });
  assert.match(context.promptContext(), /remain39 A:2 J:2/);
  assert.match(context.promptContext(), /Do not reopen/);
});

test("RoundStrategyContext resets deck knowledge after the blind", () => {
  const context = new RoundStrategyContext();
  context.observe({
    screen: "hand",
    state: { ante: 1, blind: "Small", score: 0, target: 300, handsLeft: 4, discardsLeft: 4 },
    actions: [{ type: "click", target: "open_deck" }],
  });
  context.observe({ screen: "round_result", state: {}, actions: [] });
  assert.match(context.promptContext(), /no prior blind state/);
});
