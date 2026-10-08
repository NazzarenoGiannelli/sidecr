# Release images

```bash
bun run demo:hero        # everything: fixture, UI build, real-window shots, composition
bun run demo:compose     # only the composition (after a logo change: docs/brand/sidecr-icon.svg)
```

Out come, in `docs/media/`:

| File | Size | What |
| --- | --- | --- |
| `hero.png` | 2400x1350 | the composition: the user's terminal running herdr (drawn as a character grid, cropped by the frame), the real Sidecr window floating over its right part, logo, tagline, install line |
| `hero-annotated.png` | 2400x1350 | the same with two labels: "your terminal, as always" and "Sidecr, the chat on the side" |
| `social-preview.png` | 1280x640 | GitHub social preview: logo, name, tagline, a crop of the composition |
| `shot-conversation.png` | 1600 wide | the conversation (markdown, code block, tool calls, links, a folder link, a draft) |
| `shot-media.png` | 1600 wide | Media & links, Images tab |
| `shot-settings.png` | 1600 wide | the settings panel (Appearance: Acrylic) |
| `shot-shortcuts.png` | 1600 wide | the keyboard shortcuts |
| `shot-lightbox.png` | 1600 wide | an image opened in the lightbox |
| `preview-sheet.png` | 2400x1830 | all of the above on one page, with file sizes, for review |

Nothing here is real. The session is invented (`fixture.py`: an orders API in `C:\Users\alice\code\api`, pictures
drawn with PIL, `example.com` links and two public docs pages), so are the herdr workspaces and agents
(`stub-herdr.ts`) and the terminal in the hero, which is drawn (`terminal.ts`), never captured. The terminal is a
fixed cell grid: every row has the same number of cells, and any character outside ASCII sits in a box exactly one
cell wide, so box drawing and status dots stay in their columns whatever font draws them. It follows herdr's layout
(workspace numbers on top, the machines tree and the agents panel in the sidebar) with Claude Code in the pane, and it
has no window chrome on purpose: Sidecr is only the small window on the side of the user's own terminal.
Generating the images needs no network.

## How it works

1. **`fixture.py`** writes `fixture/session.jsonl`, a Claude Code transcript with seven exchanges, six pasted images
   (inline, so no file paths are needed on disk), tool calls, a code block, links, a folder path and a file path.
   Fixed ids and timestamps: the same bytes every time.
2. **`capture.ts`** starts a throwaway Sidecr server in-process (`createServer`) with the stub herdr and
   `projectsRoot` pointing at a copy of the fixture, then launches the **test build** of the native shell on it and
   drives the page over the WebView2 debug port: conversation, the last reply's tool calls unfolded, the pointer over
   the folder link, Media & links (both tabs), settings, shortcuts, lightbox. Each state is a `Page.captureScreenshot`
   of the page itself (never the screen), at 2x, with a transparent page background, so the window's acrylic can be
   emulated later. Time zone and locale are fixed. Before each capture the page text and attributes are checked for
   the machine's user name, computer name and temp paths; a hit stops the run. The About section's state folder is
   replaced by an invented one on its way to the page.
3. **`compose.ts`** lays the images out in HTML and renders them in a headless Chromium with a throwaway profile:
   the acrylic is the drawn backdrop under the window blurred and tinted with `backdrop-filter`; the window image
   itself is never blurred. **`optimize.py`** then shrinks the PNGs (pngquant and oxipng when installed, otherwise the
   smaller of an ffmpeg and a PIL 256-colour palette that stays above 44 dB PSNR, else truecolour).

Shots land in `demo/out/shots/` (git-ignored), intermediate pages in `demo/out/compose/`.

## Safety (capture.ts)

- Test shell only: `SIDECR_SHELL` defaults to `shell/src-tauri/target-test/release/sidecr-shell.exe` (build it with
  `bun run build:shell:test`) and anything outside a `target-test` folder is refused. The run stops if a test shell
  is already running (a second one would hand its address to it).
- Throwaway state: `SIDECR_DEMO_STATE` (default `demo/out/state`), never the live plugin folder; port
  `SIDECR_DEMO_PORT` (default 47796, never 47631); WebView2 debug port `SIDECR_DEMO_DEBUG_PORT` (default 9370).
- The window appears on screen for about ten seconds. The shell and its WebView2 processes are killed by process id
  at the end and the state folder is deleted. The server's opener only records: nothing is ever opened.

## Requirements

Bun, Python 3 with Pillow and NumPy, Edge, Chrome or Chromium (`SIDECR_DEMO_BROWSER` to pick one), the WebView2
runtime and a Rust toolchain for the test shell (Windows). Fonts: Inter (headline), Segoe UI (the app's own UI font on
Windows), JetBrains Mono (the drawn terminal); missing ones fall back to the next in the CSS stacks.

## Changing things

- Logo: replace `docs/brand/sidecr-icon.svg`, run `bun run demo:compose`.
- Tagline or install line: `TAGLINE` and `INSTALL` at the top of `compose.ts`.
- The conversation: edit `EXCHANGES` in `fixture.py`, then `bun run demo:hero`.
