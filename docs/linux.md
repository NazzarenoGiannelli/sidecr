# Sidecr on Linux

Sidecr is developed on Windows. On Linux the Chromium app window is the supported path, and it has been used on Omarchy (Hyprland, Wayland) with Chromium. Edge and Chrome on Linux, X11 sessions and other desktops should work the same way but have not been tried.

## Browser lookup

The first of these found on `PATH` is used:

1. `microsoft-edge-stable`
2. `microsoft-edge`
3. `google-chrome-stable`
4. `google-chrome`
5. `chromium`
6. `chromium-browser`

On Omarchy, `/usr/bin/chromium` is found and works. Nothing else is looked for: Brave, Vivaldi, Opera, or a Snap or Flatpak browser without one of these commands on `PATH`, give exit code 3. There is no setting to name another browser. Files and folders open through `xdg-open`, so in your desktop's default apps and file manager.

## Native shell

The Tauri shell is Windows-first and untested on Linux. Do not rely on it there: leave it unbuilt, or set `SIDECR_LAUNCHER=chromium` to be sure the Chromium window is used.

## No graphical session in the environment

When the herdr server was started over SSH (a machine respawned from another host), it has no `WAYLAND_DISPLAY`, `DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE` or `XDG_RUNTIME_DIR`, and Chromium would exit at once with "Failed to connect to Wayland display".

When both `WAYLAND_DISPLAY` and `DISPLAY` are missing, Sidecr asks the systemd user manager (`systemctl --user show-environment`, with a 2 second limit) for `WAYLAND_DISPLAY`, `DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE` and `DBUS_SESSION_BUS_ADDRESS`, and sets `XDG_RUNTIME_DIR` to `/run/user/<uid>` when it is missing and that directory exists. A variable that is already set is never overwritten, and nothing changes on Windows.

If there is still no display after that, the open command stops with

```
sidecr: no graphical session (no WAYLAND_DISPLAY or DISPLAY, and systemctl --user show-environment did not provide one)
```

and exit code 5. Start herdr from your desktop session instead.

## A browser that exits early

The open command watches the browser for 1.5 seconds. If it exits with a non-zero code in that time, you get

```
sidecr: the browser exited early (code N): <end of its stderr>
```

and exit code 6, instead of silence. A browser that exits with 0 (it handed the window to an instance already running) is normal, and one still running after 1.5 seconds is left alone. The open command therefore takes up to 1.5 seconds to return when the browser stays up (about 3 seconds if the native shell fails first and the browser is the fallback); the window itself appears at once.

## The window class (app id)

On Linux the Chromium window is started with `--profile-directory=Sidecr`. On Wayland Chromium builds the app id from the URL host and path and the profile directory name, so with the default profile it would be the generic `chrome-localhost__-Default`, shared by any other localhost web app. With the named profile it is `chrome-localhost__-Sidecr` (the URL path is `/` and the query is ignored), which a window rule can match. `--class` does not change the app id on Wayland.

The browser profile lives in `<state directory>/profile/`, with the data in `profile/Sidecr`.

## A floating window on Hyprland

On Omarchy (Lua config), add this to `~/.config/hypr/hyprland.lua`, the same `o.window(class, { ... })` helper Omarchy uses for its own floating apps:

```lua
o.window("chrome-localhost__-Sidecr", { float = true, pin = true, center = true })
```

`pin` keeps the window always on top: remove it if you do not want that. In the classic Hyprland syntax the equivalent is

```
windowrule = float, class:^(chrome-localhost__-Sidecr)$
```

If the window still tiles, run `hyprctl clients` with Sidecr open: it shows the real class, which could differ on another Chromium build.

## `bun` on herdr's PATH

The action starts as `bun src/open.ts` with the PATH of the herdr server process. If `herdr plugin log list` shows `No such file or directory`, the server was started with a bare PATH. Link `bun` somewhere on it, for example `ln -s ~/.bun/bin/bun ~/.local/bin/bun`, and restart herdr from a login shell.
