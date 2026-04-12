# Task: Docker Platform Integration

**Owner:** Codex  
**Status:** pending  
**Priority:** P1 — first platform to implement  
**Depends on:** 001-server-setup

## Objective
Implement Docker platform support: container lifecycle management and status reporting.

## tRPC procedures to implement

### `platforms.docker.status` → `DockerStatus`
- Connect to Docker via `dockerode`
- Return version, running/stopped/total container counts
- If Docker is unavailable, return `{ connected: false, error: "..." }`

### `platforms.docker.images` → `DockerImage[]`
- List available images on the Docker host
- Map to `DockerImage` shape from `@devlet/shared`

### `agents.hire` (Docker path) → `AgentState`
Input: `HireAgentInput` with `platform.type === "docker"`

Steps:
1. Pull the agent image (from `agent-templates/{type}/`) or use existing
2. Create and start container with:
   - CPU/memory limits from `config.resources`
   - Env vars from `config.env`
   - Label `devlet.agent.id={id}` for tracking
3. Persist agent state to `~/.devlet/agents/{id}.yaml`
4. Return initial `AgentState` with status `provisioning`

### `agents.fire` (Docker path)
1. Stop container
2. Remove container
3. Update YAML state to `terminated`

### `agents.restart` (Docker path)
1. Stop container
2. Start container
3. Update YAML state

### `agents.logs` (Docker path)
- Fetch last 100 lines of container stdout/stderr via Docker API

## Shared types used
```typescript
import type { DockerStatus, DockerImage, AgentState, AgentConfig } from "@devlet/shared";
import { AgentStateSchema } from "@devlet/shared";
```

## Dependencies to add
```
dockerode, @types/dockerode, js-yaml, @types/js-yaml
```

## State file example
See `README` section "Agent State Persistence" — YAML format at `~/.devlet/agents/{id}.yaml`.

## Notes
- Docker socket path: default `unix:///var/run/docker.sock`, override via `config.platform.socketPath`
- Agent image naming convention: `devlet/{type}:latest`
