# Privacy and safety

Sidecr shows a conversation that can contain anything a model wrote or a tool printed, and it can open files on your machine. This page says what it reads, what it serves, what it can do, and every rule the server applies before it opens something. The server enforces these rules; the window only asks.

## What it reads

- **The transcript of the pane shown.** Claude Code writes each session to `~/.claude/projects/<encoded working directory>/<session id>.jsonl`. Sidecr finds the session id and working directory through herdr (`herdr pane get`) and reads that file. If the file is not where the working directory says, it looks for `<session id>.jsonl` in every project folder.
- **The pane's screen text,** through `herdr pane read`: before sending (to refuse while a menu or prompt is open) and while Claude works (the spinner line: what it is doing, for how long).
- **herdr's lists** of agent panes and workspaces, for the switcher and the header, and the focused pane (`herdr pane current`) while a window is open and following herdr is on.
- **Image files the conversation mentions,** only to show their previews.
- **Its own state:** settings, drafts, the window position and the optional machine name, in the plugin's state directory.

Nothing of this leaves your machine. There is no telemetry, no crash reporting and no update check.

## What it serves

- A server on `127.0.0.1` only. Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, and everything except `/health` (which answers the app name, its pid and an API version) needs the token.
- The token is a random UUID made when the server starts. It is passed to the window once in the URL, then kept in an `HttpOnly`, `SameSite=Strict` cookie. It is stored in `server.json` in the state directory (mode 0600 on POSIX).
- **On a machine shared with other users,** the URL with the token is on the browser's command line, and on Linux any local user can read a process's command line (`ps`, `/proc/<pid>/cmdline`) while it runs. With it, and since the server listens on loopback, which every local user can reach, another user could talk to your server as you while it runs: read the conversations of your panes and type into them. The token changes at every server start (the server exits 10 minutes after the last window). Use Sidecr only on a machine where the other accounts are trusted.
- A POST or PUT from another site (`Sec-Fetch-Site: cross-site` or `same-site`) is refused, and the JSON endpoints require a JSON content type.
- Images and files are served with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
- The server exits after 10 minutes without a window.

The page loads nothing from the network. A link reaches the network only when you click it, and then it is your browser that opens it.

## What it can do

- **Type into the pane shown:** your text and, for each attachment, an `@<absolute path>` mention, then Enter (`herdr pane send-text`, `herdr pane send-keys`). Before sending, the server checks again that the pane is a Claude Code pane and that no menu is open. A message is at most 30,000 characters and an attachment at most 25 MB.
- **Stop Claude:** one Esc to the pane (`herdr pane send-keys <pane> esc`), only while herdr reports the pane as working, and at most once every 1.5 seconds per pane.
- **Save attachments** under `attachments/` in the state directory, or in `SIDECR_ATTACHMENTS_DIR` when it is set; they are deleted after 7 days. Only files Sidecr saved (its `yyyymmdd-hhmmss-name` pattern, directly in that folder) count as attachments: they are the only ones previewed, opened or deleted on that ground, whatever else the folder holds. A send with attachments is refused when the folder's path has a space (Claude Code would read a broken `@path`).
- **Open links, files and folders** the conversation mentioned, with the rules below.

## Opening things

Every open goes through the server, which hands the target to the system's own opener without a shell: `rundll32 url.dll,FileProtocolHandler` on Windows, `xdg-open` on Linux. Folders and "show in folder" use the file manager (`explorer.exe` on Windows, `xdg-open` on Linux).

### Links

Only `http://` and `https://` links open, in your default browser.

### Files

A file opens from a click only when all of these hold:

1. **The conversation mentioned it.** The allow-list is the set of paths in the exchanges the server has handed out in this session (the latest ones and every older block the window loaded, plus image paths listed in Media & links). It only grows within a session, up to 20,000 paths, and starts empty with every new session. Sidecr's own attachments are allowed too.
2. **Its type is on a short list:** images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`), `pdf`, `md`, `txt`, `json`, `csv`, `log`, `docx`, `xlsx`, `pptx`, `html`, `htm`. This is an allow-list, not a deny-list: anything else is only shown in its folder.
3. **The path is clean:** no control or invisible formatting characters (bidi controls, zero-width characters, the soft hyphen), no alternate data streams, no network shares (`\\server\share`, `//server/share`), no device or extended prefixes (`\\?\`, `\\.\`), no trailing dot or space, no double quote, at most 4,096 characters. The real path, after links are followed, is checked again.
4. **It exists.**

**HTML files open in your browser.** A click on a `.html` or `.htm` file opens it with the default app, which is normally the browser, and that runs the page: it is the same as double-clicking the file. It only applies to files the conversation mentioned, that exist, and whose name really ends in `.html` or `.htm` (`page.html.exe` is an executable and is only shown in its folder). `.svg` can run script in a browser too.

### Show in folder

A file link of a type that is not opened from a click (`zip`, `exe`, `bat`, `cmd`, `com`, `ps1`, `sh`, `msi`, `js`, `vbs`, `hta`, `jar`, `lnk`, `url`, `reg`, `scr`, `dll`, `AppImage`, `desktop`, anything outside the list above) is shown in its folder instead, with a note saying so. Shift+click does the same for any file link. This never runs the file: Explorer gets `/select,"<path>"` (the file selected); Linux has no portable "select", so the folder that holds the file is opened. The same checks apply as for opening a file, without the type list.

### Folders

A path with no file extension, or one that ends in a separator, is linked as a folder (with a folder icon and the tooltip "Open folder"): `C:\Users\x\out`, `C:/Users/x/out`, `/home/x/out`, `~/out`, in plain text, in backticks or in Markdown. A click, or Enter or Space on the focused link, opens it in the file manager. The rules:

- Only a folder the conversation mentions, or the folder that directly holds a file it shows (one level up, never higher), and never a drive or filesystem root just because it is the parent of a file.
- It must exist. A folder that is gone gives "That folder no longer exists"; a path that turns out to be a regular file (`/etc/hosts`, `Makefile`) is shown in its folder instead, with a note.
- The same path checks as for files.
- The file manager is started without a shell, and nothing inside the folder is run. On Windows Sidecr writes the Explorer command line itself, with the path always in double quotes (`explorer.exe "C:\a,b"`): Explorer reads a comma as a separator, and an unquoted comma would turn the rest of the name into another target.

A single word such as `/api` or `/tmp` is not linked (two segments are needed, except after `~/`). A folder whose name has a dot and a letter after it (`my.project`) looks like a file unless it is written with a trailing slash.

### Paths with spaces

A path is linked up to its first space unless something says where it ends: an inline code span, a quoted string (double, single or typographic quotes), or a line of its own inside a fenced code block whose whole content is one absolute path. Then the whole span is one link, spaces, commas, parentheses and accents included: `` `C:\Users\x\My Documents` ``. Anything in the span counts as part of the path, because Sidecr does not guess: `` `C:\a b and more` `` is one path, and when no such file exists the link is dead. A path in plain prose with spaces is not guessed.

## What it never does

- Run a script or an executable from a click.
- Open a file or folder the conversation did not mention. The one widening is the folder that directly holds a file the conversation shows, as described under Folders.
- Send anything to a pane other than the one the window shows, or anything other than your message, its attachment mentions, Enter and (for Stop) one Esc.
- Talk to the network, or keep conversations or drafts in the browser's storage (drafts are saved by the server; the window caches only a copy of the settings there, so it opens in the right look).

## Reporting a problem

See [SECURITY.md](../SECURITY.md).
