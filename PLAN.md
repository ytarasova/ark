# PLAN: Local folder picker for Repository field in web New Session modal

## 1. Summary

The web dashboard's "New Session" modal currently requires the user to type the
repository path as free-text into an `<Input>`. Add a "Browse…" button next to
the Repository field that opens a folder-picker modal backed by a new server-side
JSON-RPC `fs/list-dir` handler. Because `ark web` / Electron desktop always runs
on the same machine as the filesystem, a server-side directory listing + custom
picker UI works uniformly in both environments and avoids browser sandbox
limitations (`<input type=file webkitdirectory>` cannot return absolute paths).
The picker is gated to local (non-hosted) mode only to avoid exposing the host
filesystem in multi-tenant deployments.

## 2. Files to modify/create

### Create
- `packages/server/handlers/fs.ts` -- new `fs/list-dir` RPC handler: lists directories under an absolute path, returns entries + parent. Refuses to run in hosted mode (`app.config.databaseUrl` set).
- `packages/server/__tests__/fs-handler.test.ts` -- unit tests for the handler: happy path, home-dir default, non-existent path, hosted-mode refusal, `isGitRepo` flag.
- `packages/web/src/components/FolderPickerModal.tsx` -- modal component: breadcrumb, entry list (dirs only), "Select this folder" button, "Cancel".
- `packages/web/src/components/ui/modal.tsx` -- lightweight shared `Modal` wrapper (backdrop + centered panel). Currently no reusable modal primitive exists; NewSessionModal is rendered inside a side panel. The folder picker needs a true overlay so we extract a small primitive rather than duplicating styles.

### Modify
- `packages/server/register.ts` -- import and call `registerFsHandlers(router, app)`.
- `packages/web/src/hooks/useApi.ts` -- add `api.listDir(path?: string)` -> `{ cwd, parent, home, entries: { name, path, isGitRepo? }[] }`.
- `packages/web/src/components/NewSessionModal.tsx` -- add "Browse…" button next to the Repository `<Input>`; clicking it opens `<FolderPickerModal>`; selected path is written back into `form.repo`.
- `packages/web/__tests__/NewSessionModal.test.tsx` (or add new file if absent) -- verify clicking Browse opens the picker and that a selected path flows back into the input.

### No changes needed
- Electron `main.js` / `preload.js` -- server-side picker works inside the embedded BrowserWindow too; no native dialog IPC added in this iteration.

## 3. Implementation steps

### Step 1 -- Backend handler `packages/server/handlers/fs.ts`
1. Export `registerFsHandlers(router: Router, app: AppContext)`.
2. Register `fs/list-dir`:
   - Params: `{ path?: string }` (optional; defaults to `os.homedir()`).
   - Refuse with a clear error when `app.config.databaseUrl` is truthy (hosted mode) -- local FS must not be exposed to tenants.
   - Normalize the incoming path via `path.resolve()` to get an absolute canonical form.
   - Read entries via `fs.readdirSync(dir, { withFileTypes: true })`.
   - Filter to directories only (ignore files). Include hidden dirs (`.config`, etc.) -- users legitimately use them. Wrap per-entry access in try/catch so one unreadable dir does not break the listing.
   - Sort alphabetically, case-insensitive.
   - Return `{ cwd: string, parent: string | null, home: string, entries: Array<{ name: string; path: string; isGitRepo?: boolean }> }`. `isGitRepo` is set when `<entry>/.git` exists -- cheap `existsSync` check -- so the UI can badge likely repos. `parent` is `null` when `cwd === path.parse(cwd).root`.
   - Errors (ENOENT, EACCES) surface as the RPC error `{ code: -32602, message }`.
3. Wire into `packages/server/register.ts` alongside the other handler registrations.

Note: `fs/list-dir` is a READ method; do NOT add it to the `WRITE_METHODS` set in `packages/core/hosted/web.ts`. It is still allowed in readOnly mode because reading is fine there; the hosted-mode refusal lives inside the handler itself.

### Step 2 -- API client `packages/web/src/hooks/useApi.ts`
1. Add to the `api` object:
   ```ts
   listDir: (path?: string) => rpc<{
     cwd: string;
     parent: string | null;
     home: string;
     entries: { name: string; path: string; isGitRepo?: boolean }[];
   }>("fs/list-dir", { path }),
   ```

### Step 3 -- Modal primitive `packages/web/src/components/ui/modal.tsx`
1. Small wrapper: fixed backdrop (`bg-black/60`), centered panel, `onClose` handler on backdrop click + Escape key.
2. Signature: `<Modal open onClose title>{children}</Modal>`. Deliberately small -- enough for the folder picker; existing side-panel NewSessionModal stays untouched.

### Step 4 -- Folder picker `packages/web/src/components/FolderPickerModal.tsx`
1. Props: `{ initialPath?: string; onSelect: (absPath: string) => void; onClose: () => void }`.
2. State: `cwd`, `parent`, `entries`, `loading`, `error`.
3. On mount and whenever `cwd` changes, call `api.listDir(cwd)` and update state. When `initialPath` is undefined or ".", call `listDir()` with no arg so the server defaults to the user's home directory.
4. UI:
   - Header: current path as text + a text input for typing a path + Enter-to-jump.
   - Body: scrollable list; `..` row at the top when `parent` is non-null; one row per directory entry. Rows show folder icon + name; git repos show a small "git" badge.
   - Footer: "Select this folder" button (returns current `cwd` via `onSelect`) + "Cancel".
5. Keyboard: Enter on a focused row enters it; Backspace goes up when focus is in the list.
6. Error surface: if `api.listDir` rejects, show the error message inside the modal (do NOT close).

### Step 5 -- Integrate into `NewSessionModal.tsx`
1. Add state: `const [pickerOpen, setPickerOpen] = useState(false)`.
2. Replace the single `<Input>` for Repository with a flex row: `<Input ... />` + `<Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>Browse…</Button>`.
3. When picker calls `onSelect(path)`: `update("repo", path); setPickerOpen(false);`.
4. Render `{pickerOpen && <FolderPickerModal initialPath={form.repo === "." ? undefined : form.repo} onSelect={...} onClose={() => setPickerOpen(false)} />}`.
5. No change to form submission -- the picked path is written into the existing `form.repo` string, so the rest of the flow (RPC `session/start` with `repo`) is unchanged.

### Step 6 -- Tests
1. `packages/server/__tests__/fs-handler.test.ts` (bun:test):
   - Use the `AppContext.forTest()` pattern.
   - Create a temp dir, build a subdirectory tree (including a `.git/` child inside one sub-folder), assert listing, parent navigation, alphabetical order, `isGitRepo` flag, non-existent path error, and hosted-mode refusal by setting `app.config.databaseUrl = "postgres://fake"` before the call.
2. Web component test (`packages/web/__tests__`):
   - First check the directory for existing test infrastructure (vitest/bun:test + happy-dom). Reuse whatever pattern is already there rather than inventing a new harness.
   - Mount `<NewSessionModal>`, click "Browse…", mock `api.listDir` to return two entries, click one, click "Select this folder", assert the repo field now contains the selected absolute path.

## 4. Testing strategy

- **Unit -- handler (`bun:test`)**: cover
  1. Default to `os.homedir()` when no path passed.
  2. Listing returns only directories, sorted case-insensitively, with `parent` set correctly (and null at filesystem root).
  3. `isGitRepo` flag appears on dirs containing `.git`.
  4. Non-existent path -> RPC error with non-empty message.
  5. Hosted mode (`config.databaseUrl` set) -> refusal error, no filesystem access attempted.
- **Unit -- web API client**: not strictly needed -- `api.listDir` is a thin one-liner. Skip unless existing hooks file has tests.
- **Component -- NewSessionModal**: assert that Browse opens the picker and selection populates the input. Mock `api.listDir`.
- **Manual verification**:
  1. `make dev` then `make desktop` (Electron) -- open New Session, click Browse, navigate to a real repo, confirm path appears in Repository field, submit, session starts against that repo.
  2. `./ark web --port 8420` in a browser -- same flow, confirm picker works.
  3. Confirm the existing free-text typing path still works (regression).
- **Full suite**: `make test` before declaring done. Tests must run sequentially (ports collide -- see CLAUDE.md).

## 5. Risk assessment

- **Hosted mode exposure**: exposing a filesystem browser in a multi-tenant deployment would let any authenticated tenant enumerate the host filesystem. Mitigation: explicit refusal when `app.config.databaseUrl` is set, plus a unit test.
- **Path traversal / symlinks**: the handler always resolves via `path.resolve()` before listing, so relative `..` input is normalized. Because hosted mode is blocked and local mode already gives the agent shell access, further sandboxing (chroot) is not warranted.
- **Permission errors on sub-entries**: one unreadable dir must not break the whole listing -- wrap per-entry `statSync` / `.git` check in try/catch.
- **Large directories**: listing directories only (skipping files) keeps payload small even in e.g. `/usr/local`. No pagination needed for v1.
- **Breaking change**: none. The Repository field still accepts typed input; Browse is additive.
- **Electron native dialog parity**: users familiar with native macOS open dialogs may expect one. This plan intentionally does NOT add an Electron IPC bridge -- the server-side picker is uniform across browser and desktop and avoids bridge code that would diverge from `ark web`. Listed in Open questions below.
- **Modal primitive**: introducing `ui/modal.tsx` is a small new abstraction, but it's justified -- the existing `NewSessionModal` is rendered in a side panel, not a true overlay, and the folder picker requires an overlay. Keeping the primitive minimal (backdrop + Escape to close) avoids scope creep.

## 6. Open questions

1. **Electron native dialog**: should we also wire `dialog.showOpenDialog({ properties: ["openDirectory"] })` through `preload.js` and prefer it when `window.arkDesktop?.isElectron` is true? Nicer UX for desktop users but adds an IPC surface. Default: NO for this iteration.
2. **Git repo validation**: should the picker refuse to return a path that is not a git repo, or just badge it and let the user decide? Default: badge only (some Ark flows are fine on non-git dirs).
3. **Starting directory**: when the user clicks Browse with `form.repo === "."`, should we open at `process.cwd()` (the ark server's cwd, not necessarily what the user intuits) or `os.homedir()`? Default: `os.homedir()` -- more predictable across how the server was launched. Confirm with reviewer.
4. **Recent repos**: should the picker show a "Recent" section pulled from recent sessions' `repo` values? Nice-to-have, not in scope.
5. **Hidden directories**: include `.config`, `.ssh`, etc. in the listing? Default: YES -- users legitimately use hidden dirs; hiding them would surprise power users.
