# Plan: Fix dead Documentation link in Settings

## Summary

The web Settings page (`SettingsView.tsx`) has a "Documentation" link that points to `https://github.com/anthropics/ark` -- a dead/incorrect URL. It should point to the project's GitHub Pages site at `https://ytarasova.github.io/ark/`, which is the documentation URL used consistently throughout the rest of the codebase (README, install script, quickstart, release workflow, etc.).

## Files to modify/create

| File | Change |
|------|--------|
| `packages/web/src/components/SettingsView.tsx` | Update the Documentation href from `https://github.com/anthropics/ark` to `https://ytarasova.github.io/ark/`, and change the link text from "GitHub" to "Docs" to accurately reflect the destination. |

## Implementation steps

1. **Edit `packages/web/src/components/SettingsView.tsx` line 137**: Change `href="https://github.com/anthropics/ark"` to `href="https://ytarasova.github.io/ark/"`.
2. **Update link text on line 142**: Change the display text from `GitHub` to `Docs` (since the link now points to the docs site, not GitHub).

## Testing strategy

- Start the web dev server (`make dev-web`) and navigate to Settings.
- Verify the "Documentation" row shows "Docs" as the link text.
- Click the link and confirm it opens `https://ytarasova.github.io/ark/` in a new tab (not a 404).
- Verify no other links or content in the Settings page are affected.

## Risk assessment

- **Breaking changes**: None. This is a one-line URL fix in a static link.
- **Edge cases**: None. The link is a plain `<a>` tag with `target="_blank"`.
- **Regression**: Zero risk -- no logic changes, only a URL string and label text swap.

## Open questions

None -- the correct URL (`https://ytarasova.github.io/ark/`) is already used in 15+ places across the codebase (README, install.sh, quickstart.html, index.html, release workflow, cloud-init).
