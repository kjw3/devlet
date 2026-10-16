import assert from "node:assert/strict";
import { test } from "node:test";
import { markPerf, recordRequest, resetPerf, getPerf } from "../src/lib/perf.js";

test("perf marks record only the first occurrence", () => {
  resetPerf();
  markPerf("app-shell");
  const first = getPerf().marks["app-shell"];
  markPerf("app-shell");
  const second = getPerf().marks["app-shell"];
  assert.equal(first, second);
  assert.equal(typeof first, "number");
});

test("perf requests strip query strings (no inputs in telemetry) and cap history", () => {
  resetPerf();
  for (let i = 0; i < 60; i++) {
    recordRequest(`/trpc/agents.list?input=secret-input-${i}`, 12, true);
  }
  const perf = getPerf();
  assert.equal(perf.requests.length, 50);
  // Most recent entries retained
  assert.equal(perf.requests[perf.requests.length - 1].path, "/trpc/agents.list");
  assert.ok(!JSON.stringify(perf).includes("secret-input"));
});
