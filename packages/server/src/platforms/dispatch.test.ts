import "./localstorage-shim.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startAgent } from "./dispatch.js";

test("starting a pending agent requires provisioning rather than reporting success", async () => {
  await assert.rejects(startAgent("pending"), /provisioning required/);
});
