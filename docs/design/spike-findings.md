# Task 0 spike findings

Run 2026-10-01 on a Windows 11 machine, herdr 0.9.3, Claude Code 2.1.287, scratch workspace `pal-scratch` (`w8`).

| # | Question | Result | Observed |
|---|---|---|---|
| 1 | Does `herdr pane send-text` with an embedded newline arrive as two lines in Claude's input box? | PASS (mode A, `text-enter`) | Input box showed `line one` / `line two` as two lines, unsent. Mode B (send-text per line with `send-keys shift+enter` between) also works. Mode C (bracketed paste) not needed. |
| 2 | Does `@C:\path\image.png` sent through `send-text` make Claude read the image? | PASS | Claude printed `Read shot.png (148.3KB)` and described the screenshot correctly. |
| 3 | Does `send-keys <pane> enter` submit, and what are the key names? | PASS | `enter` submits; `down`, `esc`, `ctrl+c`, `shift+enter` are accepted key names. |
| 4 | What is `agent_status` while a menu is open? | PARTIAL | Trust-folder prompt: `blocked`. After startup: `idle`; while answering: `working`; after the answer: `done`. A user-opened `/model` menu leaves the status at `done`. Both menus end with an `Esc to cancel` footer, so the screen is read as well (see spec 5.4). |
| 5 | Does a key binding to a plugin action deliver the focused pane id, and which chord survives the terminal? | PASS for `ctrl+shift+j` | It reached herdr four times (including with a Claude Code pane focused), `HERDR_PANE_ID` and the focused pane in `HERDR_PLUGIN_CONTEXT_JSON` were correct. `alt+j` arrived once. `ctrl+alt+j` did not arrive. |
| 6 | Does Edge `--app` pass `Ctrl+Shift+J` / `Ctrl+Shift+K` to the page, and does `window.close()` work? | PARTIAL | `window.close()` from a button closed the app window. Whether the page receives the two chords with `preventDefault` was not confirmed; check in the install QA with the real app. |
| 7 | Does a plugin start `bun` from herdr's PATH on Windows? | PASS | The action ran (exit 0). Context fields seen: `focused_pane_id`, `focused_pane_agent`, `focused_pane_status`, `workspace_id`, `invocation_source`. |

## Decisions for src/config.ts
- DELIVERY_MODE = text-enter
- ENTER_KEY = enter
- NEWLINE_KEY = shift+enter
- BLOCKED_STATUSES = [blocked]
- MENU_MARKER = /esc to cancel/i, scanned over the last 20 non-empty screen lines
- Default open chord = ctrl+shift+j (probe 5)
- window.close() works in --app window: yes (probe 6, via a button)

## Other findings
- `Ctrl+Shift+K` is not bound by herdr itself; in Sidecr it only exists inside the window.
