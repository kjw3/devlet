import "./localstorage-shim.js"; // MUST be first — komodo-deploy pulls in komodo_client
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOrphanedKomodoDeployments } from "./komodo-deploy.js";

type State = { config: { id: string }; platformRef: string };

test("flags devlet-agent-* deployments with no matching state", () => {
  const states: State[] = [
    { config: { id: "agent-5v77" }, platformRef: "komodo:sbx3:devlet-agent-5v77" },
    { config: { id: "agent-xcvm" }, platformRef: "komodo:sbx1:devlet-agent-xcvm" },
  ];
  const deployments = [
    "devlet-agent-5v77", // tracked (config.id + platformRef)
    "devlet-agent-xcvm", // tracked
    "devlet-agent-eikq", // ORPHAN — no state
    "devlet-probe-abc", // not an agent deployment — ignored
  ];
  assert.deepEqual(filterOrphanedKomodoDeployments(deployments, states), ["devlet-agent-eikq"]);
});

test("treats empty state as all agent deployments orphaned", () => {
  const deployments = ["devlet-agent-eikq", "devlet-agent-2kk4", "other"];
  assert.deepEqual(filterOrphanedKomodoDeployments(deployments, []), [
    "devlet-agent-eikq",
    "devlet-agent-2kk4",
  ]);
});

test("matches by derived deployment name even when platformRef is pending (provisioning window)", () => {
  // Deployment is created before platformRef is persisted — must NOT be an orphan.
  const states: State[] = [{ config: { id: "agent-1gub" }, platformRef: "pending" }];
  const deployments = ["devlet-agent-1gub", "devlet-agent-other"];
  assert.deepEqual(filterOrphanedKomodoDeployments(deployments, states), ["devlet-agent-other"]);
});

test("ignores non-agent deployments regardless of state", () => {
  const states: State[] = [];
  const deployments = ["devlet-probe-mv6301t9", "devlet-server", "devlet-web"];
  assert.deepEqual(filterOrphanedKomodoDeployments(deployments, states), []);
});

test("returns empty when there are no deployments", () => {
  const states: State[] = [{ config: { id: "agent-a" }, platformRef: "komodo:s:devlet-agent-a" }];
  assert.deepEqual(filterOrphanedKomodoDeployments([], states), []);
});
