import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentState } from "@devlet/shared";
import { diagnosticText, retainTermination, provisioningError } from "./termination.js";
import { exitDetails } from "../platforms/exit-details.js";

const state = () => ({ config: { env: { LITELLM_API_KEY: "secret-value" } }, platformRef: "komodo:server:agent", logs: [] } as unknown as AgentState);
test("capture saves redacted output and OOM details before cleanup", async () => {
  const s=state(); const calls:string[]=[];
  await retainTermination(s, {logs:async()=>["Bearer abc", "secret-value"], details:async()=>exitDetails({ExitCode:137,OOMKilled:true}), save:async()=>{calls.push("save");assert.equal(s.status,"terminated");},cleanup:async()=>{calls.push("cleanup");}});
  assert.deepEqual(calls,["save","cleanup"]);
  assert.ok(s.logs.join("\n").includes('"exitCode":137'));
  assert.ok(!s.logs.join("\n").includes("secret-value"));
  assert.ok(!s.logs.join("\n").includes("Bearer abc"));
});
test("failed state write prevents destructive cleanup", async()=>{
  let cleaned=false;
  await assert.rejects(retainTermination(state(),{logs:async()=>[],details:async()=>({}),save:async()=>{throw Error("disk full");},cleanup:async()=>{cleaned=true;}}));
  assert.equal(cleaned,false);
});
test("capture failure is visible and retains runtime",async()=>{
  const s=state();let cleaned=false;
  await retainTermination(s,{logs:async()=>{throw Error("offline");},details:async()=>({}),save:async()=>{},cleanup:async()=>{cleaned=true;}});
  assert.equal(cleaned,false); assert.ok(s.logs.some(l=>l.includes("unavailable")));
});
test("large output is bounded and secrets are scrubbed",async()=>{
  const s=state();await retainTermination(s,{logs:async()=>Array(1000).fill("x".repeat(1000)),details:async()=>({}),save:async()=>{},cleanup:async()=>{}});
  assert.ok(s.logs.join("\n").length<66000);
  assert.equal(diagnosticText("password=abc",{}),"password=[redacted]");
  assert.ok(!diagnosticText('{"token":"unlisted-secret"}',{}).includes("unlisted-secret"));
});

test("provisioning object errors preserve detail and redact agent credentials",()=>{
  assert.ok(provisioningError({message:"permission denied",key:"secret-value"},{API_KEY:"secret-value"}).includes("permission denied"));
  assert.ok(!provisioningError({message:"secret-value"},{API_KEY:"secret-value"}).includes("secret-value"));
});

test("hung diagnostic capture cannot block reconciliation indefinitely",async()=>{
  const s=state();let cleaned=false;
  await retainTermination(s,{logs:()=>new Promise(()=>{}),details:async()=>({}),save:async()=>{},cleanup:async()=>{cleaned=true;},captureTimeoutMs:5});
  assert.equal(s.status,"terminated");assert.equal(cleaned,false);
});
