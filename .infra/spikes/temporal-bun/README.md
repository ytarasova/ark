# Temporal / Bun compat spike

Phase 0 spike. Verifies whether `@temporalio/worker` can load and initialise
under Bun, or whether the Ark worker must run under Node.

Run it with:

```
./scripts/spike-temporal-bun.sh
```

The script writes a verdict + full transcript to
`.infra/spikes/temporal-bun/result.txt`. Summary is echoed in
`docs/temporal.md` under "Bun-vs-Node worker decision".

This directory is self-contained. Nothing here is imported by the rest of the
Ark tree. The spike is safe to delete once Phase 0 decisions land.
