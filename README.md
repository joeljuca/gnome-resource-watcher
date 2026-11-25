# Resource Watcher

A GNOME Shell extension that shows **CPU, RAM, and disk usage** in the top
bar, with a detailed popup menu.

```
CPU   6%   RAM  64%   DISK  66%
```

- **Panel label** — three padded segments that don't jitter while updating.
  Toggle any of them off and the rest reflow.
- **Popup menu** — per-metric rows with detail lines:
  - `CPU` — usage since the previous sample
  - `RAM` — `9.4 GiB of 14.9 GiB`
  - `Disk` — `298.5 GiB of 461.2 GiB at /`
  - Values turn amber at 75% and red at 90% (Adwaita palette).
- **Preferences** — update interval (1–300 s), per-metric visibility, and
  which filesystem to watch.

## How the numbers are read

| Metric | Source |
| ------ | ------ |
| CPU %  | Delta of the aggregate `cpu` line in `/proc/stat` between samples (idle + iowait counted as idle) |
| RAM %  | `(MemTotal − MemAvailable) / MemTotal` from `/proc/meminfo` (falls back to `MemFree + Buffers + Cached` on old kernels) |
| Disk % | `df -PB1` on the configured path — the same figure `df` prints, run asynchronously so the shell's main loop never blocks |

CPU needs two samples to produce a reading: one is taken at enable time and
a second after 1 second, so the value appears without waiting a full update
interval. Until then the panel shows `—`.

## Requirements

- GNOME Shell 45–51 (tested on 51.1)
- `dconf`/`glib` user tools (`df` comes from coreutils)

## Install

```sh
make install     # copies to ~/.local/share/gnome-shell/extensions/ and compiles the schema
make enable      # installs and enables the extension
```

GNOME Shell scans the extensions directory once at startup, so **log out and
back in** (Wayland has no shell reload) to load a freshly installed
extension. After that:

```sh
gnome-extensions prefs gnome-resource-watcher@joel
```

Other targets:

```sh
make pack        # build gnome-resource-watcher@joel.shell-extension.zip
make uninstall   # remove from this user
make clean
```

## Files

| File | Purpose |
| ---- | ------- |
| `extension.js` | Panel indicator, popup menu, sampling logic, timers |
| `prefs.js` | Adwaita preferences window |
| `stylesheet.css` | Panel label, menu rows, warning colors |
| `schemas/*.gschema.xml` | GSettings keys: `update-interval`, `show-cpu`, `show-ram`, `show-disk`, `disk-path` |

## Notes for development

- The extension is fully functional in a nested/headless shell, which makes
  it easy to test without touching your session:

  ```sh
  make install
  dbus-run-session -- gnome-shell --headless --wayland-display=test &
  sleep 5 && gnome-extensions enable gnome-resource-watcher@joel
  ```

- If your `PATH` resolves `gsettings` to a non-system glib (e.g. Homebrew),
  its writes may not reach the session's dconf service — use
  `/usr/bin/gsettings` when changing extension settings from the terminal.
