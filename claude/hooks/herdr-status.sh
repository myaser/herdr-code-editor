#!/bin/sh
# Report Claude Code's status to Herdr (OSC 7501) on the terminal Claude runs in,
# and remember which session runs in which Herdr terminal so it can be resumed.
# Usage: herdr-status.sh idle|working|done|blocked|end
[ -n "$HC_TERMINAL_ID" ] || exit 0
state=${1:-idle}
dir="$HOME/.claude/herdr-sessions"
file="$dir/$HC_TERMINAL_ID.json"
mkdir -p "$dir"
input=$(cat 2>/dev/null)
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([0-9A-Za-z-]*\)".*/\1/p' | head -n 1)
reason=$(printf '%s' "$input" | sed -n 's/.*"reason" *: *"\([^"]*\)".*/\1/p' | head -n 1)
printf '%s %s %s state=%s reason=%s\n' "$(date +%FT%T)" "$HC_TERMINAL_ID" "$sid" "$state" "$reason" >> "$dir/hook.log"
if [ "$state" = end ]; then
  # Only an explicit end (/exit, /clear, logout) clears the record. A shutdown or
  # crash keeps it, so the session can be resumed.
  case "$reason" in prompt_input_exit|clear|logout) rm -f "$file" ;; esac
  exit 0
fi
if [ -n "$sid" ]; then
  printf '{"session":"%s","cwd":"%s"}\n' "$sid" "$(printf '%s' "$PWD" | sed 's/["\\]/\\&/g')" > "$file"
fi
pid=$$
while [ "$pid" -gt 1 ]; do
  tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
  case "$tty" in pts/*) printf '\033]7501;state=%s:app=claude-code\033\\' "$state" > "/dev/$tty" 2>/dev/null; exit 0 ;; esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$pid" ] || exit 0
done
exit 0
