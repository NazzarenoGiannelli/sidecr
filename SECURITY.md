# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's security advisories: on the repository page, open **Security**, then **Report a vulnerability**. Do not open a public issue for them.

Include what you did, what happened, the Sidecr version (the settings' About section, or `package.json`), herdr version and OS. A proof of concept helps, but is not required. This is a one-person project; the aim is to answer within a week. A fix for a confirmed problem goes into a patch release, and the advisory credits you unless you prefer otherwise.

## Scope

In scope:

- **The local server** (`src/server.ts`): anything that lets another program, another user on the machine, or a web page in your browser read a conversation, read a file, send text to a pane, or get past the Host check, the token or the cross-site refusal.
- **File and folder opening** (`/api/open`, `src/dirs.ts`, `src/os.ts`): anything that makes a click run a script or an executable, open a file or folder the conversation did not mention, or reach a network share or a device path.
- **The native shell** (`shell/`): anything that makes it load a page that is not the local Sidecr page.
- **Rendering**: model output or file content that runs script in the window.

Out of scope: what Claude Code or herdr themselves do, what a file does once you open it in its own app (an HTML page runs in your browser by design, see [docs/privacy-and-safety.md](docs/privacy-and-safety.md)), and attacks that need an account that can already read your files.

## Supported versions

Only the latest release gets security fixes.
