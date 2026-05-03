# Smoke Runs

Log of end-to-end smoke runs of the claude-agent runtime against real compute providers. Each entry records a single run that exercised: clone -> read -> write -> commit -> push -> open PR.

The point of keeping this file is to have a tangible artifact that a given runtime + compute combination was exercised at least once, and which commit/PR that run produced. It is append-only.

## Runs

| Date       | Runtime       | Compute | Version | Branch                       |
| ---------- | ------------- | ------- | ------- | ---------------------------- |
| 2026-05-03 | claude-agent  | ec2     | v3      | smoke/claude-agent-ec2-3     |
