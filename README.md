# Dynamic Window Position

A GNOME Shell extension that keeps your windows where you put them — across
connecting and disconnecting an external monitor, and across reboots.

- **Per-setup layouts.** It remembers a window layout for each combination of
  monitors — the laptop screen alone, the laptop with your monitor at home, the
  laptop with the one at the office — and switches between them automatically
  when monitors are plugged in or out: each window goes back to its workspace,
  monitor, position, size and maximized state.
- **Session restore.** At login it reopens the apps from your last session and
  puts their windows back where they were.

Layouts are learned automatically from how you arrange your windows; there is
nothing to configure for that.

## Requirements

- GNOME Shell 50 (tested on Ubuntu 26.04, Wayland).
- Fixed workspaces, on the primary display only (Settings → Multitasking).
  With dynamic workspaces, GNOME removes empty workspaces when windows move
  between screens, which renumbers the rest. The settings window warns about
  this and can change it for you, and also warns about other extensions that
  move windows.

This is a **beta**: it has been used daily on one laptop with one external
monitor. Reports from other setups are very welcome — enable *Debug logging*
and include the log (see [Troubleshooting](#troubleshooting)).

## Install

```sh
git clone https://github.com/wranvaud/dynamic-window-position.git \
    ~/.local/share/gnome-shell/extensions/dynamic-window-position@wranvaud
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-window-position@wranvaud/schemas
```

Log out and back in (on Wayland GNOME Shell only discovers new extensions at
login), then enable it:

```sh
gnome-extensions enable dynamic-window-position@wranvaud
```

To update: `git pull` in that folder, run `glib-compile-schemas` again if
`schemas/` changed, and log out and back in.

## How it works

### Monitor hotplug

A setup is the set of connected monitors, each identified by its make, model
and serial number, so the same monitor is recognized whatever port, dock or
position it is on. Window positions are stored relative to the monitor the
window is on, and a restored window is always kept fully on screen, even if
the monitor's resolution or scaling changed since.

The extension keeps a snapshot of every window for the current setup, taken
one second after windows stop moving. When the monitors change it stops taking
snapshots, waits for Mutter to finish its own rearranging, and restores the
saved layout for the new setup in three passes (the last one catches slow apps
such as Electron apps, which apply moves asynchronously).

Docks often apply several monitor configurations in a row when plugged in —
for example first with the laptop as primary display, then the real one. The
extension:

- waits when the primary display differs from the one saved for that setup,
  and accepts it after 8 s if it doesn't change (you changed it on purpose);
- measures how long each monitor change takes to settle and doesn't save
  layouts until then, so an intermediate configuration is never saved. The
  wait can also be set by hand in the settings.

Windows with no saved position in the new setup keep their workspace and are
placed by rule: maximized when moving to the laptop screen alone, centered on
the primary monitor at 60 % of the screen when external
monitors are connected. This only happens when monitors are connected or
disconnected; windows you open are always placed by GNOME as usual.

### Session restore

The layouts are saved to `~/.local/state/dynamic-window-position/session.json`
as they change. At login the extension:

1. Waits 10 s (configurable) so autostart apps open on their own.
2. Launches each app from the last session that isn't running yet — once per
   app. Apps with several windows (browsers, editors, terminals with session
   restore) reopen the rest themselves.
3. For two minutes, matches each new window to a saved window of the same app,
   preferring the same title, and puts it back in place. Browsers start with a
   generic title, so a window matched on a guess is re-matched for a few
   seconds as its title changes.

Closed windows stay in the saved session for 15 s, so apps closing one by one
at logout don't erase it. A window closed right before a reboot therefore comes
back.

For best results, set your browser to reopen its previous session on startup
(e.g. Chrome: Settings → On startup → *Continue where you left off*).

## Settings

Open them from the Extensions app, or with
`gnome-extensions prefs dynamic-window-position@wranvaud`:

- Compatibility warnings, with one-click fixes for GNOME settings.
- Turn session restore on or off.
- Delay before reopening apps at login.
- Apps not reopened at login (their windows are still put back if they open).
- Monitor settle time: measured automatically, or set by hand.
- Debug logging.

## Limitations

- Several windows of the same app with similar titles (e.g. terminals) all come
  back, but may swap places with each other.
- Dialogs, the desktop icons and other special windows are left alone.
- Snapped (half-screen) windows come back at the right position and size, but
  not as snapped windows.
- Two identical monitors without serial numbers can only be told apart by the
  port they are plugged into.
- Window contents are up to each app: a terminal comes back, its SSH session
  doesn't.

## Troubleshooting

Enable *Debug logging* in the settings and watch the log while you plug or
unplug the monitor:

```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep dynamic-window-position
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
