# Contributing to Sidecr

Thanks for taking a look. Bug reports, testing on a setup that has not been tried (Linux desktops, Windows 10, macOS), docs and fixes are all welcome. For anything larger than a fix, open an issue first so we can agree on the shape.

## Setup

You need [Bun](https://bun.sh) 1.3 or newer. herdr is not needed to run the tests.

```bash
git clone https://github.com/NazzarenoGiannelli/sidecr.git
cd sidecr
bun install
```

## Checks (run these before opening a pull request)

```bash
bun test            # the whole suite
bun run typecheck   # tsc --noEmit, strict
bun run build:ui    # the window's bundle in dist/
```

If you touch `shell/`, also run `cargo check` and `cargo test` in `shell/src-tauri` (needs Rust). CI runs all of this on Windows and Linux.

The suite needs no herdr, display, browser, Explorer or file manager: the herdr CLI, process spawns, timers and the file opener are injected. A test that would need one of them is a bug in the test.

Some tests check that parsing hostile input stays fast, with wall-clock budgets set on a developer machine. On a slow machine, set `SIDECR_TEST_TIME_SCALE` (1 to 10) to multiply them; CI uses 3.

## Conventions

- **Tests first.** Write the failing test, then the change. Bugs get a test that reproduces them.
- **No `innerHTML`** (or `outerHTML`, `insertAdjacentHTML`, `document.write`) in `ui/`: the window renders model output and file contents, so nodes are built with `createElement` and `textContent`. `test/no-inner-html.test.ts` guards it.
- **English in the UI.** Every string the user sees is English. `test/english-only.test.ts` fails on Italian accented letters and common Italian words in the code.
- **No `windowsHide` on GUI spawns.** On Windows it passes a hidden show state to the program that starts (the browser, the shell, an editor opened through `rundll32`), whose first window then never shows. Only console children (the herdr CLI, the server) are hidden. `test/ui-close-guard.test.ts` guards `src/os.ts`, `src/browser.ts` and `src/shell.ts`.
- **No shell.** Every process is started with an argv, never through `sh -c` or `cmd /c`.
- **Allow-lists for anything that opens or serves a file,** checked on the server. See [docs/privacy-and-safety.md](docs/privacy-and-safety.md).
- **No personal data in the repository.** Fixtures use invented names and paths (`C:\Users\alice\...`, `/home/alice/...`, workspaces like `docs`, `api`, `web`). `test/public-hygiene.test.ts` fails on credential shapes and on the maintainer's own names.
- Plain, short English in docs and comments, without em dashes.

## Testing with a real window

Tests never open one. When you try a change by hand, keep it away from a Sidecr you are using:

- Set `HERDR_PLUGIN_STATE_DIR` to a throwaway folder and `SIDECR_PORT` to a throwaway port, so a stray `bun src/open.ts` does not talk to your live server.
- Set `SIDECR_LAUNCHER=chromium`, or point `SIDECR_SHELL` at a test build of the shell (`bun run build:shell:test`, identifier `dev.nazz.sidecr.test`). A shell build with the normal identifier hands its address to your open window and exits.
- Give a test shell its own `WEBVIEW2_USER_DATA_FOLDER`.

More in [docs/native-shell.md](docs/native-shell.md#testing-a-shell-build).

## Pull requests

Keep a pull request to one change, describe what a user would notice, and add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). By contributing you agree that your work is released under the [MIT licence](LICENSE).
