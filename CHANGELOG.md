# Changelog

All notable changes to **Sidecr** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-08

The first public release: a companion window for herdr that shows the Claude Code conversation of the focused pane.

### Added
- **The window.** One key bound to the `nazz.sidecr.open` action opens it on the focused Claude Code pane and closes it
  again; there is only ever one. Esc closes whatever is on top, then the window. It runs as a Chromium app window
  (Edge, Chrome or Chromium) on Windows and Linux.
- **The conversation.** The latest exchanges (3, 5 or 10), updating live, with Markdown answers, code blocks with a copy
  button and tool calls folded into an expandable list. Older exchanges load in blocks when you scroll up, back to the
  start of the session; the tests read the latest exchanges of a 100 MB transcript in under 300 ms.
- **Sending.** Your message goes into the same pane through herdr, with attachments pasted, dragged or picked with the
  paperclip (sent as `@path` mentions). Sending is refused while a menu is open in the terminal. A Stop button sends one
  Esc while Claude works, next to a row that shows what it is doing, for how long and the output tokens.
- **Links, files and folders.** URLs open in your browser; files of a short list of document types open in their app;
  folders open in the file manager; anything else, and any file with Shift+click, is shown in its folder. Paths with
  spaces are linked inside code spans, quotes and fenced lines.
- **Images.** Previews, a lightbox and fullscreen.
- **Media & links.** A panel with every image and link of the session, with "Go to message".
- **Following herdr.** The window follows the pane selected in herdr (when idle, always, or off), or stays pinned to one;
  `Ctrl+K` switches between Claude panes by name.
- **Drafts and recall.** A draft is kept per pane on the server; ArrowUp recalls earlier messages.
- **Settings** (`Ctrl+,`), a cheat sheet of every shortcut (`Ctrl+/`), and a silent notification when Claude finishes
  while the window is in the background.
- **The native shell (optional, Windows).** `bun run build:shell` builds `sidecr-shell`, a Tauri 2 window with no frame,
  rounded corners, a translucent Acrylic, Mica or Blur background, a choice of accent colour, always on top, and a
  fullscreen image window. The Chromium window stays the fallback.
- **Linux support** for the Chromium window: browser lookup on `PATH`, recovery of the graphical session for a herdr
  server started over SSH, a stable app id (`chrome-localhost__-Sidecr`) for window rules, and clear exit codes (5, 6).
- **Safety.** A local server on `127.0.0.1` with a per-start token, a Host allow-list and a cross-site refusal; files and
  folders open only when the conversation mentioned them; scripts and executables are never run from a click; no
  network requests and no telemetry.

### Known limits and unverified
- Local panes only: panes of remote herdr machines are not supported.
- Attachments need a folder path without spaces (Claude Code reads an `@path` mention only up to the first space): a
  send with attachments is refused when the attachments folder has one, and `SIDECR_ATTACHMENTS_DIR` moves it.
- Sidecr reads Claude Code's transcript files, whose format is not a public API.
- `herdr plugin install` from this repository had not been run before the release (only `herdr plugin link` was).
- Not verified: Windows 10 (only Windows 11 was tested), the native shell on Linux, Edge and Chrome on Linux (Chromium
  was used), X11 sessions.
- Only Edge, Chrome and Chromium are looked for; Brave and other browsers give exit code 3.
- On a machine shared with other users, the session token is visible on the browser's command line (see
  `docs/privacy-and-safety.md`).
- macOS is not supported yet.

[Unreleased]: https://github.com/NazzarenoGiannelli/sidecr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NazzarenoGiannelli/sidecr/releases/tag/v0.1.0
