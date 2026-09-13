# Changelog

## 0.2.0 — 2026-09-14

- Directive data version now **auto-matches** the target host's systemd
  version; a picker lets you choose when it can't be detected. The
  `systemd.versionOverride` setting is removed.
- Settings renamed to the `systemd-toolkit.*` namespace
  (**breaking change** — `systemd.host`, `systemd.scope`, etc. must be updated).
- Live logs: fixed remote host/scope routing and continuous refresh; log
  entries get the built-in log-language highlighting.
- Terminal commands reuse a single "systemd Toolkit" terminal; SSH
  connections are multiplexed.
- CodeLens and the panel refresh after terminal commands finish.
- Activity-bar and settings titles now read "systemd Toolkit".
- README now includes feature demos (GIFs).

## 0.1.0 — 2026-09-13

Initial release.

- Syntax highlighting for unit, network, and daemon configuration files.
- Directive / value / section completion backed by per-version data
  (systemd 258, 259, 260, 261).
- Hover documentation and Ctrl+Click links (online man pages + dependency
  jumps).
- Units panel with three views (Target / Loaded / Installed) and
  state-dependent actions.
- Editor CodeLens, live logs, and a status-bar target indicator.
- Local and SSH (remote) operation; system/user unit scope; unit-file
  view / edit / new / deploy.
