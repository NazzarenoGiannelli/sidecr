# The native shell (Windows, optional)

`shell/` holds `sidecr-shell`, a small Tauri 2 program that opens the same page as the Chromium app window in a frameless, always-on-top window with rounded corners and a translucent, blurred background. The server and the page are the same; only the window around them changes. Without the shell, Sidecr uses the Chromium app window, which also stays the fallback.

Tested on Windows 11 only; Windows 10 has not been tried. On Linux the shell is untested: expect a plain dark rounded window, and blur is not guaranteed (it needs a compositor). Use the Chromium window there ([linux.md](linux.md)).

## What it adds

- No title bar: the header drags the window and carries a minimise and a close button.
- A translucent background: Acrylic, Mica (Windows 11) or Blur (from Windows 10), with a strength from 0 (most see-through) to 100 (nearly opaque). Where the tint shows, as with Blur, the low end keeps a floor so text stays readable over a bright window.
- An accent colour of your choice and an always-on-top switch (Settings, or `Ctrl+Shift+T` and the arrow button next to the gear).
- An image opened fullscreen (Shift+click, `F` or the fullscreen button) gets its own black window covering the monitor Sidecr is on: Esc, `F` or a click closes it, Left and Right step through the conversation's images.
- WebView2's right-click menu in English whatever the system language is (`--lang=en-US`).

The shell starts with the saved appearance and always-on-top settings, so the window does not flash the defaults.

## Build

In the plugin directory:

```bash
bun run build:shell
```

That runs `cargo tauri build --no-bundle` in `shell/src-tauri` and produces `shell/src-tauri/target/release/sidecr-shell.exe`. It needs:

- Rust (`cargo`), from [rustup](https://rustup.rs).
- The Tauri CLI: `cargo install tauri-cli --version "^2"`.
- The WebView2 runtime, which Windows 11 already has.

`bun run check:shell` only type-checks it (`cargo check`). The binary stays in the plugin directory and nothing is registered system-wide, but the build folder `shell/src-tauri/target/` grows to several GB. The shell keeps its WebView2 data in `%LOCALAPPDATA%\dev.nazz.sidecr`. Run the build again after an update that changes `shell/`.

## How the open key picks the window

1. `SIDECR_LAUNCHER=chromium` always uses the Chromium app window.
2. Otherwise `SIDECR_SHELL` (a path to a shell binary) is used when it exists. A path that does not exist falls back to Chromium rather than running anything else.
3. Otherwise the release build above, when it has been built.
4. Otherwise, or when the shell fails to start (it cannot be spawned, or it exits with an error within 1.5 seconds, for example without the WebView2 runtime), the Chromium app window.

An older shell binary ignores flags it does not know, so it keeps working with a newer plugin.

## Behaviour

- The open key (pressed in the terminal), Esc, Alt+S or Ctrl+Shift+J in the window, Alt+F4 and the taskbar's Close all close it the same way: the draft, the window position and the goodbye to the server go out first.
- A second start of the binary never closes the open window: it brings it forward, and if it carries another page address (the server restarted with a new token) it loads that page in it first. Opening and closing stay with the open key.
- The shell only opens `http://localhost` or `http://127.0.0.1` addresses and never navigates away from the page it was started with. Its Tauri capabilities are scoped to that origin.
- Position and size are kept in the same `window.json` as the Chromium window. With monitors at mixed display scales (for example 100 % and 150 %) a remembered position can land off by the ratio of the scales.

## Testing a shell build

A second `sidecr-shell` with the same identifier does not open a window: it hands its address to the one already open (single instance) and exits. A test build must therefore never share the identifier of the shell you use:

```bash
bun run build:shell:test
```

builds with `shell/src-tauri/tauri.test.conf.json` (identifier `dev.nazz.sidecr.test`) into `shell/src-tauri/target-test/`, so it runs next to your shell and never overwrites `target/release/sidecr-shell.exe`. Point `SIDECR_SHELL` at `shell/src-tauri/target-test/release/sidecr-shell.exe`, and give it its own `WEBVIEW2_USER_DATA_FOLDER`, state directory (`HERDR_PLUGIN_STATE_DIR`) and port (`SIDECR_PORT`).

A stray `bun src/open.ts` run outside the tests (from a herdr pane, where `HERDR_PANE_ID` is set) toggles your live server and, with `SIDECR_SHELL` unset, starts `target/release/sidecr-shell.exe`, which hands its address to your open shell. Always set `HERDR_PLUGIN_STATE_DIR` to a throwaway folder, `SIDECR_PORT` to a throwaway port, and either `SIDECR_LAUNCHER=chromium` or `SIDECR_SHELL` pointing at the test build. Test scripts should set all three by default.

The Rust code has its own unit tests (`cargo test` in `shell/src-tauri`): command line parsing, the URL checks, window placement and the WebView2 arguments.
