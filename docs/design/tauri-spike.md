# Tauri shell for Sidecr: feasibility spike

Date: 2026-10-02. Status: spike only. No spike code lives in this repo; the useful parts are in the appendix.

## Question

Can a thin Tauri 2 shell give the companion window the look the Chromium `--app` window cannot: no frame, rounded corners, an acrylic (translucent, blurred) background over the terminal, always on top, one instance toggled by the key, position remembered, while the existing local Bun server and plain TypeScript UI stay as they are?

## Answer

Yes, on Windows 11. The shell is about 60 lines of Rust that open a window on the URL the existing `open.ts` already builds. Nothing in the server or the UI has to be rewritten. Three small changes in the UI are needed (below). Linux is untested.

## What was proven (Windows 11, tauri 2.12.1, cargo-tauri 2.11.2)

| Capability | Result |
|---|---|
| Builds with the installed toolchain | Yes |
| Frameless, transparent, always on top, native shadow | Yes (`decorations(false)`, `transparent(true)`, `always_on_top(true)`, `shadow(true)`); topmost confirmed |
| Rounded corners | Yes, applied by DWM on Windows 11 (about 8 to 12 px). The radius is not adjustable |
| Acrylic / Mica / Blur | Acrylic works: the page background must be translucent (a CSS class for translucent surfaces) or nothing shows through |
| One instance, the key toggles | `tauri-plugin-single-instance`: a second launch closes the first window and the process exits |
| Position and size memory | `tauri-plugin-window-state`: restored to the exact moved position |
| Page closes its own window | `window.close()` does NOT close a Tauri window. With `withGlobalTauri: true` and a capability for the local origin the page sees `window.__TAURI__` and `window.__TAURI__.window.getCurrentWindow().close()` closes it and the process exits |

## Not tested

- Linux (WebKitGTK): transparency needs a compositor, blur is not guaranteed on any desktop. Treat the Linux look as "plain dark rounded window" until tried.
- A real mouse drag of the header (the capability is granted, the drag was not exercised).
- A custom corner radius over acrylic (clipping the window with a region gives jagged edges; DWM corners are the safe choice).
- Release build size, signing, installer, autostart.
- WebView2 behaviour with the file and image previews of the real UI (the spike loaded the real UI from a throwaway server, but only for smoke checks).

## Changes the real shell would need

1. Closing: the UI's close paths (Alt+S in the window, the X button, the pending-close answer of the ping) must call `window.__TAURI__.window.getCurrentWindow().close()` when it exists, and `window.close()` otherwise.
2. Dragging: with no frame the header needs `data-tauri-drag-region`, and the capability needs `core:window:allow-start-dragging`. Buttons inside the header must stay clickable (the attribute only applies to the element itself, not its children).
3. Translucent surfaces: a `.shell` class on `<html>` (set when `__TAURI__` is present) makes the page and bubbles use semi-transparent backgrounds so the acrylic shows; the Chromium window keeps the opaque theme.
4. `open.ts` launches the shell binary instead of Chromium when it is installed, and keeps Chromium as the fallback. The toggle already works through the server (`/api/toggle`), so the single-instance plugin is a bonus, not a requirement.
5. The capability is scoped to the loopback origin only and grants just `core:window:allow-close` and `core:window:allow-start-dragging`. Do not widen it: the page is local but renders model output and file contents.

## Recommendation

Do it after the wave 3 toggle is verified live, as its own small branch (`feat/sidecr-shell`): a `shell/` folder with the Tauri project, the four UI changes above behind a `__TAURI__` check, and a README section. Keep Chromium as the default until the shell has run a week. Effort: one session for Windows, a second one for Linux checks.

Risk to know about: the shell adds a Rust toolchain to the build for anyone who wants it. Keep it optional, so the plain Bun plus Chromium path stays the baseline.

## Appendix: spike code (throwaway)

`Cargo.toml` dependencies: `tauri = "2"`, `tauri-plugin-window-state = "2"`, `tauri-plugin-single-instance = "2"`.

`tauri.conf.json` (relevant part):

```json
{
  "identifier": "dev.nazz.sidecr-spike",
  "app": { "withGlobalTauri": true, "windows": [], "security": { "csp": null } },
  "bundle": { "active": false, "icon": ["icons/icon.ico"] }
}
```

`capabilities/default.json`:

```json
{
  "identifier": "default",
  "windows": ["main"],
  "remote": { "urls": ["http://localhost:*/*", "http://127.0.0.1:*/*"] },
  "permissions": ["core:window:allow-close", "core:window:allow-start-dragging"]
}
```

`src/main.rs` (essence):

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::utils::config::{Color, WindowEffectsConfig};
use tauri::window::Effect;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") { let _ = w.close(); }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let url = std::env::var("SIDECR_URL").unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Sidecr")
                .inner_size(520.0, 760.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .shadow(true)
                .effects(WindowEffectsConfig {
                    effects: vec![Effect::Acrylic],
                    state: None,
                    radius: None,
                    color: Some(Color(20, 20, 20, 150)),
                    interactive: false,
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the shell");
}
```
