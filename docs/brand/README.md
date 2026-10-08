# Sidecr brand

The icon is a terminal with a wheel hooked to its side: a sidecar.

`sidecr-icon.svg` is the source (512 x 512, no background tile). `ui/favicon.svg` is a copy, and the Tauri icon set in `shell/src-tauri/icons/` is generated from it with `cargo tauri icon ../../docs/brand/sidecr-icon.svg` (delete the android and ios folders it also creates).

| Part | Colour |
| --- | --- |
| Terminal panel | `#4a36d6` (indigo, the Sidecr accent family) |
| Frame, prompt and cursor | `#ffffff` |
| Wheel face and hub | `#3a2aa8` |
| Wheel treads | `#1a1260` |
| Wheel outline and tarmac line | `#ffc247` (amber) |

The earlier all-grey version vanished on the dark Windows taskbar at 16 to 32 px; the indigo and amber pair is what keeps it readable on dark and light taskbars.
