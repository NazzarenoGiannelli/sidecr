# Architecture

How Sidecr is put together: the pieces, how a key press becomes a window, what the local server answers, and the security model. The user-facing summary is in the [README](../README.md); the safety rules for files and folders are in [privacy-and-safety.md](privacy-and-safety.md).

## Components

| Piece | Where | What it does |
|---|---|---|
| Plugin manifest | `herdr-plugin.toml` | Declares the plugin `nazz.sidecr`, its two build steps (`bun install`, `bun run build:ui`) and one action, `open`, which runs `bun src/open.ts`. |
| Open command | `src/open.ts` | Runs on every key press. Finds the focused pane, makes sure the server runs, asks it whether to open or close, and launches the window. Exits with a code (below). |
| Server | `src/server-main.ts`, `src/server.ts` | A Bun HTTP server on `127.0.0.1`. Serves the page, reads transcripts, talks to herdr, opens links and files. Exits after 10 minutes with no window. |
| herdr client | `src/herdr.ts` | Runs the `herdr` CLI (`HERDR_BIN_PATH`, else `herdr` on PATH) with an argv, never through a shell: `pane get`, `pane current`, `pane read`, `pane send-text`, `pane send-keys`, `agent list`, `workspace list`. |
| Transcript reader | `src/transcript/` | Finds the session's JSONL file under `~/.claude/projects/`, parses it into exchanges, and keeps a per-session index of where each exchange begins (history in blocks, Media & links). |
| Path tokenizer | `src/tokenize.ts`, `ui/markdown.ts` | Finds URLs, file paths and folder paths in text. The server reads assistant text with the window's own Markdown parser, so both sides agree on what is a link. |
| Window | `ui/` (bundled into `dist/` by `build:ui`) | Plain TypeScript and DOM, no framework, no `innerHTML`. The conversation, composer, switcher, settings, Media & links, lightbox. |
| Native shell (optional) | `shell/` | `sidecr-shell`, a Tauri 2 program that shows the same page in a frameless translucent window on Windows. See [native-shell.md](native-shell.md). |

Sidecr has no runtime dependencies: `bun install` only brings TypeScript and Bun's type definitions for development.

## A key press, step by step

1. herdr runs `bun src/open.ts` with `HERDR_PANE_ID` (or the focused pane in `HERDR_PLUGIN_CONTEXT_JSON`) and `HERDR_PLUGIN_STATE_DIR`.
2. On Linux, when neither `WAYLAND_DISPLAY` nor `DISPLAY` is set, the graphical session variables are recovered from `systemctl --user show-environment` ([linux.md](linux.md)).
3. It picks the launcher: the native shell when it is built (or named by `SIDECR_SHELL`), else Edge, Chrome or Chromium (fixed install folders on Windows, six command names on Linux, see [linux.md](linux.md)). With neither, it exits with code 3. With no `dist/app.js`, code 4.
4. It reads `server.json` in the state directory and checks the server at `/health` (the app marker, the pid, and the API version). A missing or dead server is started (one at a time, under a lock file); a server of another version is stopped and replaced, so an upgrade applies at the next press.
5. It asks the server `POST /api/toggle`. If a window is open or still starting, the server tells that window to close and the command exits without launching anything. A launch that failed still counts as starting for 6 seconds.
6. Otherwise it launches the window on `http://localhost:<port>/?t=<token>&pane=<pane>`. The shell is watched for 1.5 seconds and the browser is used if it fails; the browser is watched for 1.5 seconds and a non-zero exit becomes exit code 6.

Exit codes of the open command: 0 opened or closed, 1 anything unexpected, 2 no pane in focus, 3 nothing to launch, 4 the UI is not built, 5 no graphical session (Linux), 6 the browser exited early.

## The server

- **Port.** It prefers 47631 (`SIDECR_PORT`, 1024 to 65535, sets another) and takes a free port only when that one is busy. A fixed port keeps the browser's per-origin storage and notification permission across restarts.
- **Windows.** Each window announces itself (`hello`), pings every 3 seconds and says goodbye when it closes. A window that goes quiet for 9 seconds is forgotten unless its event stream is still connected. The newest window wins: opening one closes any other.
- **Live updates.** An event stream (`/api/events`) checks the transcript size every half second and asks herdr for the pane status every 2 seconds, and tells the window when something changed; the window then fetches the conversation. Settings changes and focus changes go out on the same stream.
- **History.** Per session it keeps only where each exchange begins (at most 4 sessions, 20,000 exchanges each). It reads the end of the file first and indexes older parts only when asked, a chunk at a time, so a large transcript opens as fast as a small one. The last exchange, which may still be growing, is read on from where it was.
- **Idle exit.** With no event stream and no request for 10 minutes, the server exits and removes `server.json`.

### Endpoints

Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`. Everything except `/health` needs the token.

| Endpoint | Method | What |
|---|---|---|
| `/health` | GET | `{ app: "sidecr", pid, version }`, no token needed. |
| `/` | GET | The page. With `?t=<token>` it sets the token cookie. |
| `/app.js`, `/style.css`, `/lightbox.html`, `/lightbox.js`, `/favicon.svg` | GET | The window's files from `ui/` and `dist/`. |
| `/api/panes` | GET | The Claude panes herdr knows, with workspace labels (the switcher). |
| `/api/conversation` | GET | The latest exchanges of a pane, or with `before=<id>` a block of older ones (`n`, at most 50). |
| `/api/events` | GET | The event stream (`changed`, `close`, `gone`, settings and focus events). |
| `/api/window` | POST | A window's `hello`, `ping` and `bye`. |
| `/api/toggle` | POST | The open key: answers `open` or `close`. |
| `/api/send` | POST | A message and its attachments for a pane (multipart). |
| `/api/stop` | POST | One Esc to a pane, only while Claude is working there. |
| `/api/draft` | GET, PUT | The draft kept per pane. |
| `/api/settings` | GET, PUT | The settings, their schema and the About data. |
| `/api/image` | GET | An image pasted into the terminal, by exchange and block, as bytes. |
| `/api/media` | GET | A page of the session's images or links, newest first. |
| `/api/file` | GET | An image file the conversation mentioned (or an attachment), for previews. |
| `/api/open` | POST | Open a link, a file, a folder, or show a file in its folder. |
| `/api/window-bounds` | POST | The window's position and size, saved in `window.json`. |

## Security model

The threat Sidecr defends against is another program, or a web page in your browser, using the local server to read your conversations or to run something. The model:

- **Loopback only.** The server binds `127.0.0.1`. The page is opened on `localhost` (Chromium keys a window's saved placement by host, and a host with dots is never restored), and both names are on the Host allow-list. A request with any other `Host` header is refused, which defeats DNS rebinding.
- **A token per server start.** A random UUID, created when the server starts, written to `server.json` (mode 0600 in a 0700 directory on POSIX). The open command passes it in the page URL once; the server turns it into an `HttpOnly`, `SameSite=Strict` cookie and accepts the query form only on `/`. Comparisons are constant-time.
- **No cross-site writes.** A POST or PUT whose `Sec-Fetch-Site` is `cross-site` or `same-site` is refused, and the JSON endpoints require `Content-Type: application/json`, so a form on another site cannot post to them.
- **Allow-lists, not deny-lists.** A file is served or opened only if the conversation mentioned it (the paths of the exchanges the server has handed out in this session, up to 20,000 per session), or it is one of Sidecr's own attachments. Files are opened only for a short list of document types; folders and "show in folder" have their own checks. Details in [privacy-and-safety.md](privacy-and-safety.md).
- **Served files cannot run.** Images and files are sent with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
- **No shell anywhere.** herdr, the browser, the shell and the file manager are started with an argv. On Windows the Explorer command line is written by hand with the path always in double quotes.
- **No network.** The server makes no outbound requests and the page loads nothing from outside: images from the conversation come through `/api/image` and `/api/file`. A link leaves only when you click it, handed to your default browser.
- **The native shell** loads only `http://localhost` and `http://127.0.0.1` addresses and never navigates away from the page it was started with. Its Tauri capabilities are scoped to the loopback origin.

## State on disk

All in the plugin's state directory (`HERDR_PLUGIN_STATE_DIR`, which herdr sets; on Windows `%LOCALAPPDATA%\herdr\plugins\nazz.sidecr`; without it `~/.config/sidecr`):

| File | What |
|---|---|
| `server.json`, `server.lock`, `server.log` | The running server's pid, port and token; the spawn lock; its log. |
| `settings.json` | The settings. Editable by hand: the server reads it again when it changes, and anything it does not understand falls back to the default. |
| `drafts.json` | The draft per pane (up to 50 panes, 20,000 characters each). |
| `window.json` | The window position and size. A window left off-screen is moved back on screen when it opens. |
| `machine-name` | Optional, one line (up to 40 characters): the name shown in the header. Without it, the hostname. |
| `attachments/` | Files you attached, deleted after 7 days. `SIDECR_ATTACHMENTS_DIR` puts them in another folder. Claude Code reads an `@path` mention only up to the first space, so when this folder's path has whitespace the server refuses a send with attachments (`422`, `attachments-path-spaces`, shown as "Attachments need a folder path without spaces. Set SIDECR_ATTACHMENTS_DIR to one."); text alone still goes. Only files named the way Sidecr names them, directly in the folder, are served, opened or pruned, so a shared folder is safe. |
| `profile/` | The Chromium app window's browser profile. |

The native shell keeps its WebView2 data in `%LOCALAPPDATA%\dev.nazz.sidecr`.

## Following herdr

With the setting "Follow the pane selected in herdr" (Settings, Behaviour):

- **When idle** (the default): Sidecr follows while the composer is empty and nothing is attached. While you are writing, a chip under the header says `herdr is on <name>: switch` instead; click it or press `Alt+.` to go there, or send first and Sidecr switches by itself. If you clear the composer by hand, it waits for a second without typing before it switches. Switching from the chip with attachments waiting drops them, so the first press only changes the chip to `Discard N attachments and switch`.
- **Always**: it follows at once, and what you typed stays as that pane's draft. With an attachment waiting it still shows the chip.
- **Off**: it never follows; the switcher and `Alt+Up`, `Alt+Down`, `Alt+1..9` still work.

Picking a pane yourself (`Ctrl+K`, `Alt+Up`/`Alt+Down`, `Alt+1..9`) pins the window to it until you press the pin button or `Ctrl+Shift+L`. Panes that are not running Claude Code, and Claude panes whose transcript does not exist yet, are ignored. Quick moves settle for 150 ms first, and nothing switches while a message is being sent. The server polls `herdr pane current` every 0.7 seconds, only while a window is open and the setting is not Off, and backs off up to 5 seconds when herdr does not answer.

A pane of another machine has no transcript on this one. Sidecr recognises it by a working directory of the other OS family, or by a machine label that differs from the local machine name (herdr 0.9 has no such label; a future label spelled differently from the local name would make local panes look remote).

## The window

- **Scrolling back.** The window opens on the latest exchanges (3, 5 or 10). Scroll to the top, or press "Load earlier", for the previous block (5, 10 or 20), with what you were reading kept in place, back to "Beginning of the session" (or "Older history not indexed" past 20,000 exchanges). The latest exchanges keep updating at the bottom; `Ctrl+End` or the round arrow button jumps back.
- **Media & links.** Two tabs. Images: every image pasted into the session and every image path it mentions, newest first. Links: every `http(s)` link from your messages, Claude's answers and the tool calls the window shows, once per address with a count. "Go to message" loads back to that exchange (at most 300 exchanges) and highlights it.
- **Drafts and recall.** A draft is kept per pane on the server, so closing the window does not lose it. With an empty composer, ArrowUp recalls your earlier messages and ArrowDown comes back to the draft.
- **Notifications.** When Claude finishes or needs you while the window is in the background, the window sends a silent system notification (herdr already plays a sound). The browser asks for permission once, on your first click.
- **English only.** The Chromium window is started with `--lang=en-US` and `--disable-features=Translate`; the native shell passes `--lang=en-US` to WebView2. A test fails if a string in the code has an Italian accented letter or a common Italian word.
