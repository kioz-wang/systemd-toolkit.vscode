# systemd Toolkit

Language support for editing systemd unit, network, and daemon configuration
files, plus `systemctl` / `journalctl` integration: a Units panel, CodeLens,
live logs, and unit-file deploy — locally and over SSH.

## Features

### Editing

- **Syntax highlighting** for unit files (`.service`, `.socket`, `.timer`,
  `.path`, `.mount`, `.swap`, `.automount`, `.target`, `.slice`, `.scope`,
  `.device`), network files (`.network`, `.netdev`, `.link`, `.nspawn`,
  `.dnssd`, `.dns-delegate`) and daemon config files (`journald.conf`,
  `logind.conf`, `resolved.conf`, `system.conf`, …).
- **Directive completion** — directives are inferred from the current
  `[Section]` and file type. Inside `[Service]` of a `.service` file you get
  `ExecStart`, `Type`, `Restart`, …, not socket or timer options.
- **Value completion** — for enumerable directives (`Type=`, `Restart=`,
  `KillMode=`, booleans, …) the allowed values are offered after `=`.
- **Section completion** — typing `[` lists the valid sections for the file.
- **Hover documentation** — hovering a directive shows a summary, allowed
  values, and a link to the upstream man page.
- **Ctrl+Click** — opens the online HTML man page (anchored at the directive),
  and jumps to dependency targets (`After=`, `Wants=`, `WantedBy=`, …) when
  they are deployed.
- **Snippets** — templates for service, oneshot, timer, socket, mount,
  automount, path, slice and target units (e.g. type `service`).

### Commands

| Command | Action |
| --- | --- |
| `systemd: Show Unit Status` | `systemctl status <unit>` |
| `systemd: Start / Stop / Restart / Reload Unit` | `systemctl <action> <unit>` |
| `systemd: Enable / Disable Unit` | `systemctl enable/disable <unit>` |
| `systemd: Reload Daemon` | `systemctl daemon-reload` |
| `systemd: Show Unit Logs` | live `journalctl -u <unit> --follow` |
| `systemd: Deploy Unit File` | write file + `daemon-reload` |

The unit name is inferred from the active editor (e.g. `sshd.service`), or you
are prompted. Commands run in an integrated **systemd** terminal. Diagnostics
(extension logs and a record of every command executed) go to the **systemd
Toolkit** output channel.

### Units panel

The **systemd** activity-bar container has three views:

- **Target** — the current host and unit scope (click either to switch). The
  **Refresh** button lives here and refreshes all three views.
- **Loaded** — units currently in memory (`systemctl list-units`), with a
  **list/tree toggle**, a **Show/Hide inactive** toggle, and a **name filter**.
  Both modes show each unit's state via icon and colour.
- **Installed** — units present in `list-unit-files` but *not* loaded
  (collapsed by default, fetched lazily when expanded), with its own
  list/tree toggle and filter. Freshly-deployed-but-inactive units surface here
  (systemd garbage-collects inactive units out of `list-units`).

Actions on a unit are **state-dependent** (same matrix as CodeLens):

| State | Actions |
| --- | --- |
| active | Stop, Restart, Logs |
| inactive | Start, Logs |
| failed | Restart, Logs |
| transitioning / masked | Logs only |
| enabled | + Disable |
| disabled | + Enable |

Every unit also offers Status, View Unit File, and Edit Unit File. In the
**Installed** tree, each group has a **New** button to create a unit of that
type.

### Editor CodeLens

For unit files the editor shows a state-dependent CodeLens:

- **not deployed** → a single **Deploy** action;
- **deployed** → live status (`active (running)`), then:
  - active → Stop + Restart; inactive → Start; failed → Restart;
  - enabled → Disable; disabled → Enable;
  - **Logs**, and **Edit** (read-only preview) / **Deploy** (editable copy).

**Deploy** writes the file and runs `systemctl daemon-reload`:

- an edited unit is written back to its `FragmentPath` (or to the unit dir if
  the fragment is a vendor file under `/usr/lib/systemd/` or `/lib/systemd/`);
- a new file goes to `/etc/systemd/system/<name>` (or
  `~/.config/systemd/user/<name>` for user scope);
- overwriting an existing file on the target asks for confirmation first.

Deploy does **not** start or enable the unit — those are separate steps
(`Start` / `Enable`).

### Live logs

**Show Unit Logs** opens a read-only tab streaming
`journalctl -u <unit> --follow -n 300` (locally or over SSH). It refreshes
continuously, throttled and capped, and stops its process when the tab closes.
Log views carry no CodeLens.

### Status bar

The status bar shows the current target (`host · scope · vNNN`); click it to
switch host or scope for the session.

### Remote (SSH) & scope

- `systemd-toolkit.host` — SSH alias (from `~/.ssh/config`) to operate on; empty =
  local. Remote commands reuse one multiplexed SSH connection.
- `systemd-toolkit.scope` — `system` (default) or `user` (`systemctl --user`). User
  scope deploys to `~/.config/systemd/user/` and never elevates.

The Target view and status bar switch these for the *session* without changing
the settings. The panel follows the session; the editor CodeLens follows the
*file's own* scope (a file under `/etc/systemd/system/` is always system).

## Supported systemd versions

Ships directive data for **systemd 258, 259, 260, 261** (latest stable patch
of each series). The extension automatically matches the target's systemd
version (`systemctl --version`, honouring `systemd-toolkit.host`) so language features
always use the right directive data. If the target has no systemd, or its
version has no matching data, a picker asks you to choose a version — the choice
applies to the current host connection only and is re-evaluated when you switch
hosts.

## Settings

- `systemd-toolkit.docSource` — `online` (default) or `man`.
- `systemd-toolkit.onlineDocBase` — base URL for `online`.
- `systemd-toolkit.systemctlPath` / `systemd-toolkit.journalctlPath` — binary paths.
- `systemd-toolkit.host` — SSH alias to operate on (empty = local).
- `systemd-toolkit.scope` — `system` | `user`.
- `systemd-toolkit.sshPath` — path to `ssh`.
- `systemd-toolkit.authMethod` — `sudo` (default) / `pkexec` / `none`.

## How the directive data is produced

Completion and hover data is generated from the systemd source tree's man pages
(DocBook XML) by `scripts/generate-data.py`. See `DEVELOPMENT.md` for details.

## Building

```sh
npm install
npm run compile
npm run package   # → systemd-toolkit-0.1.0.vsix
```

## License & attribution

The extension is licensed under **LGPL-2.1-or-later** (see `LICENSE`). The
systemd logo used for the icon is © Tobias Bernard (GNOME), licensed under
**CC BY-SA 4.0** — see `THIRD_PARTY_NOTICES.md` for details.

This extension is **not affiliated with, or endorsed by, the systemd
project**.

## Notes / limitations

- Boolean directives complete as `yes/no/true/false/on/off`.
- Time-span (`5min`, `1h 30min`) and size (`512M`) values are free-form, not
  auto-completed.
- Privileged commands run through `systemd-toolkit.authMethod` (default `sudo`) in a
  terminal for interactive auth.
