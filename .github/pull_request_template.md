## What changes

<!-- What a user would notice, in a sentence or two. Link the issue if there is one. -->

## How it was tested

<!-- The tests you added or changed, and anything you tried by hand (OS, herdr version, window). -->

## Checklist

- [ ] `bun test`, `bun run typecheck` and `bun run build:ui` pass
- [ ] `cargo check` and `cargo test` in `shell/src-tauri` pass (only if `shell/` changed)
- [ ] A test covers the change (written first where possible)
- [ ] No `innerHTML`-style calls in `ui/`, no `windowsHide` on GUI spawns, English-only UI strings
- [ ] Manual tests used a throwaway `HERDR_PLUGIN_STATE_DIR` and `SIDECR_PORT`, and `SIDECR_LAUNCHER=chromium` or a test shell build
- [ ] A line under `## [Unreleased]` in `CHANGELOG.md`
