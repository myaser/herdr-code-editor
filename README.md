# herdr-split-workspace-setup

A Herdr split-workspace setup: file tree + file viewer + spaces tree + tab bar mods, a layout using them, key bindings, and Claude Code status hooks.

## Contents

| Path | What it is |
|---|---|
| `mods/file-viewer` | File viewer/editor panel (save, find, wrap toggle) |
| `mods/files-split` | Files tree panel, cloned from `files` for the split layout |
| `mods/spaces-tree` | Spaces sidebar rendered as a tree (cloned from `spaces`) |
| `mods/tabs-split` | Tab bar with window controls (cloned from `tabs`) |
| `layouts/main-split.json` | Layout using the mods above (cloned from `main` 0.1.14) |
| `keys.json` | Key bindings (alt-hjkl pane nav, ctrl-N tabs, alt-N spaces, ...) |
| `settings.json` | App settings (zoom, sounds, telemetry off) |
| `claude/` | Claude Code hooks that report agent state (idle/working/blocked/done) to Herdr |

Mods were cloned from Herdr 0.1.14 shipped mods; re-check after big Herdr upgrades.
Generated files (`gpui-kit.d.ts`, `jsconfig.json`) are omitted; Herdr regenerates them.

## Install

```sh
git clone <this repo> && cd herdr-split-workspace-setup
./install.sh                      # mods + layout only
./install.sh --with-keys --with-settings --with-claude-hook
```

Existing files are backed up as `*.bak-<timestamp>`. Herdr hot-reloads; pick `main-split` with `ctrl-shift-l`.

### Claude Code hook
`--with-claude-hook` copies `herdr-status.sh`. Then merge `claude/settings-hooks.json` into
`~/.claude/settings.json` (the `hooks` key). The script is a no-op outside Herdr terminals.
