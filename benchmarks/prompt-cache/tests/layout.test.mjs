import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRequest,
  commonPrefixBytes,
  runSyntheticSession,
} from "../lib/prompt-layout.mjs";

const legacy = {
  id: "legacy",
  stablePlacement: "after-volatile",
  dynamicPlacement: "prepend",
  persistRecall: false,
};
const optimized = {
  ...legacy,
  id: "optimized",
  stablePlacement: "before-volatile",
};

test("stable block appears before volatile runtime only in optimized layout", () => {
  const legacySystem = buildRequest({
    variant: legacy,
    turn: 1,
    experimentId: "same",
  }).body.messages[0].content;
  const optimizedSystem = buildRequest({
    variant: optimized,
    turn: 1,
    experimentId: "same",
  }).body.messages[0].content;

  assert.ok(legacySystem.indexOf("# Runtime") < legacySystem.indexOf("<user-persona>"));
  assert.ok(optimizedSystem.indexOf("<user-persona>") < optimizedSystem.indexOf("# Runtime"));
});

test("stable-before layout has a longer synthetic cross-turn prefix", () => {
  const firstLegacy = JSON.stringify(buildRequest({
    variant: legacy,
    turn: 1,
    experimentId: "legacy",
  }).body);
  const secondLegacy = JSON.stringify(buildRequest({
    variant: legacy,
    turn: 2,
    experimentId: "legacy",
  }).body);
  const firstOptimized = JSON.stringify(buildRequest({
    variant: optimized,
    turn: 1,
    experimentId: "optimized",
  }).body);
  const secondOptimized = JSON.stringify(buildRequest({
    variant: optimized,
    turn: 2,
    experimentId: "optimized",
  }).body);

  assert.ok(
    commonPrefixBytes(firstOptimized, secondOptimized)
      > commonPrefixBytes(firstLegacy, secondLegacy),
  );
});

test("preserve grows persisted recall while strip does not", () => {
  const strip = runSyntheticSession(optimized, 6);
  const preserve = runSyntheticSession({ ...optimized, persistRecall: true }, 6);

  assert.equal(strip.finalPersistedRecallBlocks, 0);
  assert.equal(preserve.finalPersistedRecallBlocks, 6);
  assert.ok(preserve.finalHistoryBytes > strip.finalHistoryBytes);
});
