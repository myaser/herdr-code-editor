#!/bin/sh
# Install these Herdr mods/layout/keys into ~/.config/herdr-app.
# Existing files are backed up to <file>.bak-<timestamp>. Herdr hot-reloads.
# Usage: ./install.sh [--with-keys] [--with-settings] [--with-claude-hook]
set -e
here=$(cd "$(dirname "$0")" && pwd)
dest="${HERDR_APP_DIR:-$HOME/.config/herdr-app}"
ts=$(date +%Y%m%d%H%M%S)
[ -d "$dest" ] || { echo "Herdr app dir not found: $dest (start herdr-app once first)"; exit 1; }

backup() { [ -e "$1" ] && mv "$1" "$1.bak-$ts" && echo "backed up $1"; return 0; }

for m in "$here"/mods/*/; do
  n=$(basename "$m"); backup "$dest/mods/$n"; mkdir -p "$dest/mods"; cp -r "$m" "$dest/mods/$n"; echo "installed mod $n"
done
mkdir -p "$dest/layouts"
for l in "$here"/layouts/*.json; do
  backup "$dest/layouts/$(basename "$l")"; cp "$l" "$dest/layouts/"; echo "installed layout $(basename "$l")"
done
for a in "$@"; do case "$a" in
  --with-keys) backup "$dest/keys.json"; cp "$here/keys.json" "$dest/"; echo "installed keys.json" ;;
  --with-settings) backup "$dest/settings.json"; cp "$here/settings.json" "$dest/"; echo "installed settings.json" ;;
  --with-claude-hook)
    mkdir -p "$HOME/.claude/hooks"; backup "$HOME/.claude/hooks/herdr-status.sh"
    cp "$here/claude/hooks/herdr-status.sh" "$HOME/.claude/hooks/"; chmod +x "$HOME/.claude/hooks/herdr-status.sh"
    echo "installed Claude hook script. Merge claude/settings-hooks.json into ~/.claude/settings.json manually." ;;
  *) echo "unknown option $a"; exit 1 ;;
esac; done
echo "Done. To use the split layout, select 'main-split' via the layout switcher (ctrl-shift-l)."
