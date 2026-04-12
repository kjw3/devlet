# Task: Server Bootstrap & tRPC Adapter

**Owner:** Codex  
**Status:** pending  
**Priority:** P0 — blocks everything

## Objective
Stand up the `@devlet/server` package with a working HTTP server that serves the tRPC router defined in `@devlet/shared`.

## What to implement

### 1. HTTP server with tRPC adapter
- Use `@hapi/h2o2` or `fastify` (preferred) or Node `http` with `@trpc/server/adapters/fetch`
- Serve tRPC at `POST /trpc` and `GET /trpc`
- Enable CORS for `http://localhost:3000` (the Vite dev server)
- Listen on port `3001`

### 2. Router implementation
- Create `packages/server/src/routers/index.ts` implementing `AppRouter` from `@devlet/shared`
- Stub all procedures with placeholder responses initially:
  - `agents.list` → return `[]`
  - `agents.get` → throw `NOT_FOUND`
  - etc.

### 3. Dev dependencies to add to `packages/server/package.json`
```
fastify, @fastify/cors, @trpc/server (already present)
```

## Reference
- Router contract: `packages/shared/src/router.ts`
- Type definitions: `packages/shared/src/types/`
- Schemas: `packages/shared/src/schemas/`

## Expected output
Running `pnpm --filter @devlet/server dev` starts a server at `http://localhost:3001` that responds to tRPC batch requests.
