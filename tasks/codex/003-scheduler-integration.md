# Task: Scheduler Integration in `agents.hire`

**Owner:** Codex  
**Status:** pending  
**Priority:** P1 — required before hire works end-to-end  
**Depends on:** 001-server-setup, 002-docker-lifecycle

## Background
The frontend no longer asks users to pick a platform. Instead, agent requirements
(GPU, persistence, resources, type) drive an automatic placement decision.

The scheduler lives in `@devlet/shared/src/scheduler.ts` as a **pure function**.
The server must call it at hire time with live platform status.

## What to implement

### In `agents.hire` resolver

```typescript
import { scheduleAgent } from "@devlet/shared";
import type { SchedulerContext, PlatformTarget } from "@devlet/shared";

// 1. Build SchedulerContext from live platform probes
async function buildSchedulerContext(): Promise<SchedulerContext> {
  return {
    docker: await probeDocker(),       // your DockerStatus probe
    portainer: await probePortainer(), // your PortainerStatus probe  
    proxmox: await probeProxmox(),     // your ProxmoxStatus probe
  };
}

// 2. In hire resolver
const input = HireAgentInputSchema.parse(rawInput);

// Honor user override if present, else run scheduler
let platform: PlatformTarget;
if (input.platformOverride) {
  platform = input.platformOverride;
} else {
  const ctx = await buildSchedulerContext();
  const decision = scheduleAgent(
    {
      type: input.type,
      resources: input.resources,
      persistent: input.persistent,
      ...(input.gpu ? { gpu: input.gpu } : {}),
    },
    ctx
  );

  if (decision.outcome !== "scheduled" || !decision.placement) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: decision.summary,
    });
  }

  platform = decision.placement;
}

// 3. Provision with resolved platform
const agentConfig: AgentConfig = {
  ...input,
  id: generateId(),
  platform,           // ← scheduler's resolved placement
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
};
```

## Key types
```typescript
// What the UI sends (no platform field):
type HireAgentInput = {
  name: string;
  type: AgentType;
  role: string;
  mission: Mission;
  resources: ResourceLimits;
  gpu?: GpuRequirements;
  env: Record<string, string>;
  persistent: boolean;
  platformOverride?: PlatformTarget;  // power-user override
}

// What the scheduler returns:
type PlacementDecision = {
  outcome: "scheduled" | "queued" | "no-platforms";
  placement?: PlatformTarget;          // use this for provisioning
  winner?: PlatformScore;              // with score + reasons
  scores: PlatformScore[];             // all platforms evaluated
  summary: string;
}
```

## Platform probe implementations needed
Each probe must return the matching status type from `@devlet/shared`:
- `probeDocker()` → `DockerStatus` — include `gpuAvailable` (check for nvidia-container-runtime)
- `probePortainer()` → `PortainerStatus` — include `gpuAvailable` per endpoint
- `probeProxmox()` → `ProxmoxStatus` — include `gpuCount` per node (from PVE API)

## Notes
- If outcome is `"queued"`, return a pending AgentState with `status: "provisioning"`
  and retry scheduling when a GPU platform comes online (future feature)
- The scheduler is deterministic and fast — safe to call on every hire, no caching needed
- See `packages/shared/src/scheduler.ts` for full scoring logic
