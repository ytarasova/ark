# Plan: Update Changelog

## Summary

Add a v0.19.0 (2026-04-20) entry to CHANGELOG.md covering all commits since v0.18.0. This includes the code-intel foundation (Waves 1-2a), BlobStore, integrations framework, runtime MCP servers, gates rework, DI refactoring, security audit fixes, and several bug fixes.

## Files to modify/create

- `CHANGELOG.md` -- prepend new v0.19.0 section above the existing v0.18.0 entry

## Implementation steps

1. Insert a new `## v0.19.0 (2026-04-20)` section at line 3 of `CHANGELOG.md` (before the v0.18.0 heading)
2. Group commits into these categories:
   - **Code Intelligence** (Waves 1-2a): unified schema/store/interfaces (#514c0a7), deployment seam for local vs control-plane parity (#50e10cd), workspaces + from-sage-analysis flow (#3f733ca)
   - **Features**: BlobStore abstraction with local-disk + S3 backends (#257), unified trigger + connector framework, `--input/--param` on `ark exec` + autonomous goose-recipe flow, runtime-declared MCP servers + `--with-mcp` opt-in, approval-with-rework for review gates (#255), awilix DI container lifecycle (#248, #249)
   - **Refactoring**: eliminate getApp/setApp/clearApp service locator (#251), split stage-orchestrator.ts into focused modules (#247), TanStack Query + RHF/zod migrations + error boundaries (#244)
   - **Security**: 2026-04-19 defensive-security audit -- 11 findings fixed (#245)
   - **Fixes**: PTY sentinel-gated geometry handshake replaces 120x50 pin, unbreak CI after #251 (#254), route test imports to test-helpers singleton (#252), rename Send to Chat in ChatPanel, import useRef in HistoryView (#250), migrate event-store adapter stubs
   - **Testing**: migrate forTest -> forTestAsync + enable parallel suites (#241), coverage + TDD-hygiene audit (#243)
   - **Documentation**: roadmap 2026-04-20 update + unified code-intel overhaul plan, SOLID audit findings (#246), frontend DI assessment (#242)

3. Use the same markdown formatting style as v0.18.0 (bold labels, parenthetical PR numbers, bullet points)
4. Run `make format` to ensure Prettier compliance

## Testing strategy

- Run `make format` to verify the markdown passes Prettier
- Visual inspection: confirm no duplicate entries between v0.18.0 and v0.19.0
- Confirm all referenced PR numbers and commit hashes are accurate

## Risk assessment

- Low risk -- documentation-only change
- Ensure no em dashes slip in (project convention: use hyphens or double dashes)
- Verify the date is correct (2026-04-20 matches today)

## Open questions

- None -- proceeding with v0.19.0 as the version number based on the increment pattern (v0.17 -> v0.18 -> v0.19) and using today's date
