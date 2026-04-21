# Temporal local dev

Step-by-step guide for running Ark against a local Temporal cluster during Phase 1--3 development. Production setup lives in the Helm sub-chart (Phase 4); this doc is developer-laptop-only.

> Design context: `docs/temporal.md`.

## Prerequisites

- Docker Desktop (or any Docker engine that supports Compose v2-style `docker compose` / v1 `docker-compose`).
- Ports 7233, 8088, 15432 free on localhost.
- ~1 GiB disk for the Postgres + Temporal container images.

## 1. Start the cluster

```
make dev-temporal
```

This brings up:

| Service | Host port | Purpose |
|---|---|---|
| `ark-temporal-postgres` | 15432 | Dedicated Postgres for Temporal. Deliberately NOT sharing the `postgres` container used by Ark's own dev compose -- cheap isolation. |
| `ark-temporal` | 7233 | Temporal frontend gRPC. Workers and clients connect here. |
| `ark-temporal-ui` | 8088 | Web UI. Open `http://localhost:8088`. |
| `ark-temporal-admin` | -- | Run-once container that creates the `ark-dev` namespace. |

The `make dev-temporal` target runs compose with `--wait`, so it blocks until healthchecks pass. If it fails, run `docker compose -f .infra/docker-compose.temporal.yaml -p ark-temporal logs` to see why.

Verification:

```
curl -fsS http://localhost:8088 >/dev/null && echo "UI up"

# frontend gRPC via the admin container's tctl:
docker exec ark-temporal-admin temporal operator cluster health --address temporal:7233
```

## 2. Point Ark at the cluster

Until Phase 2 wires a Temporal client into AppContext, nothing in Ark auto-connects. When it does, the env vars will be:

```
export ARK_TEMPORAL_ADDRESS=localhost:7233
export ARK_TEMPORAL_NAMESPACE=ark-dev
```

These will surface as `config.temporal.address` and `config.temporal.namespace` in `packages/core/config.ts` (Phase 2).

## 3. Hello-world workflow (manual smoke test)

While Phase 2 is in flight, the simplest way to verify the cluster works is the Phase 0 spike itself once a server is up:

```
make dev-temporal            # or confirm already up
bun .infra/spikes/temporal-bun/worker.ts
```

The spike's `Worker.create` step should now succeed end-to-end (no `TransportError`) because the server is reachable.

For an actual workflow round-trip, use the `temporal` CLI inside the admin container:

```
# Start the spike worker in one terminal (it polls `ark-phase0-spike`).
cd .infra/spikes/temporal-bun && bun run worker.ts

# In another terminal, run a workflow from the admin tools:
docker exec -it ark-temporal-admin \
  temporal workflow start \
  --address temporal:7233 \
  --namespace ark-dev \
  --task-queue ark-phase0-spike \
  --type pingWorkflow \
  --input '"world"' \
  --workflow-id ark-ping-$(date +%s)

# See it in the UI: http://localhost:8088
```

> This only works once Phase 2 lands the Ark worker. The spike above targets a task queue that its worker process polls; without the worker running, the workflow stays `Scheduled` forever (which is actually a nice smoke test for the UI).

## 4. Stop the cluster

```
make dev-temporal-down
```

Removes containers and the `ark-temporal-postgres-data` volume. Next `make dev-temporal` starts from empty.

## Troubleshooting

- **`ark-temporal` restarts in a loop** -- Check `docker logs ark-temporal`. Most common cause is dynamic-config path drift between Temporal minor versions; keep the `DYNAMIC_CONFIG_FILE_PATH` env unset and let the image use its bundled default.
- **Port 7233 already in use** -- Another local Temporal install. Stop it or edit `docker-compose.temporal.yaml` to rebind.
- **Port 15432 already in use** -- Shouldn't happen (non-standard port), but if it does, edit the compose file.
- **Namespace `ark-dev` missing** -- `docker logs ark-temporal-admin` will show the creation. If it failed, run the admin container manually: `docker compose -f .infra/docker-compose.temporal.yaml -p ark-temporal up --no-deps ark-temporal-admin`.
- **Webpack bundler errors during Phase 2 dev** -- Worker runs under Bun by default; if upstream changes break that, switch the worker process to Node. See the Bun-vs-Node section in `docs/temporal.md`.

## Clean slate

```
make dev-temporal-down                                # removes volume
docker image rm temporalio/auto-setup:1.27 \
  temporalio/admin-tools:1.27 \
  temporalio/ui:2.34.0 \
  postgres:16
```

Run `make dev-temporal` again to rebuild from scratch.
