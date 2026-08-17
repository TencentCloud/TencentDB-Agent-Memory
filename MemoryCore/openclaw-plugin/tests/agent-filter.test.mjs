import assert from "node:assert/strict";
import test from "node:test";

import { isAgentAllowed } from "../dist/src/agent-filter.js";

test("allows all runtime agents by default", () => {
  assert.equal(isAgentAllowed("main", {}), true);
  assert.equal(isAgentAllowed(undefined, {}), true);
});

test("allows only explicitly included runtime agents", () => {
  const filter = { include: ["coding-agent"] };

  assert.equal(isAgentAllowed("coding-agent", filter), true);
  assert.equal(isAgentAllowed("main", filter), false);
  assert.equal(isAgentAllowed(undefined, filter), false);
});

test("exclusions take precedence over inclusions", () => {
  const filter = {
    include: ["coding-agent", "main"],
    exclude: ["main"],
  };

  assert.equal(isAgentAllowed("coding-agent", filter), true);
  assert.equal(isAgentAllowed("main", filter), false);
});

test("ignores empty values in filter lists", () => {
  const filter = { include: ["", "  ", "coding-agent"] };

  assert.equal(isAgentAllowed("coding-agent", filter), true);
  assert.equal(isAgentAllowed("main", filter), false);
});
