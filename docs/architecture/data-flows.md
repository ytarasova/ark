# Data Flows

> generated: 1970-01-01T00:00:00.000Z  -  regenerate with `make audit`.

One-hop traces for the top-N operations. Each row is module-level -- depth stops at the DB table.  If a hop says `-` the tracer could not resolve the layer statically.

## `session/start`

- **route**: `packages/server/handlers/session.ts`
- **service**: `packages/core/services/session-orchestration.ts`
- **repository**: `packages/core/repositories/session.ts`
- **table**: `sessions`

## `session/read`

- **route**: `packages/server/handlers/session.ts`
- **service**: `packages/core/services/session.ts`
- **repository**: `packages/core/repositories/session.ts`
- **table**: `sessions`

## `session/advance`

- **route**: `packages/server/handlers/session.ts`
- **service**: `packages/core/services/session.ts`
- **repository**: `packages/core/repositories/session.ts`
- **table**: `sessions`

## `compute/create`

- **route**: `packages/server/handlers/resource.ts`
- **service**: `packages/core/services/compute.ts`
- **repository**: `packages/core/repositories/compute.ts`
- **table**: `compute`

## `knowledge/stats`

- **route**: `packages/server/handlers/knowledge.ts`
- **repository**: `packages/core/repositories/artifact.ts`
- **table**: `knowledge`

## `schedule/create`

- **route**: `packages/server/handlers/schedule.ts`
- **service**: `packages/core/schedule.ts`
- **table**: `schedules`

## `memory/add`

- **route**: `packages/server/handlers/memory.ts`
- **table**: `memory`

