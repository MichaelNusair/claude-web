#!/bin/bash
#
# cc — open, or rejoin, a permanent Claude Code session for a project.
#
# Why this exists: the VS Code extension's Claude process is a child of the
# extension host, and code-server tears that down within seconds of the last
# browser WebSocket closing. Measured on this box: extension host and `claude`
# both dead 5 seconds after the tab closed, mid-turn, with the work lost.
#
# tmux moves the process into a server that is detached from every terminal, so:
#   * closing the editor, the browser, or the laptop lid changes nothing
#   * attaching from a second device joins the SAME live session — same screen,
#     same scrollback, both cursors — rather than starting a second Claude
#   * the session outlives code-server restarts and redeploys
#
# It runs the real CLI, so model switching (/model), permission modes, @file
# references, thinking and tool output are all the genuine Claude Code UX rather
# than a reimplementation of it.
set -euo pipefail

PROJECTS="${PROJECTS_ROOT:-/workspace/projects}"
name="${1:-}"

if [ -z "$name" ]; then
  printf '\033[1mLive Claude sessions\033[0m\n'
  if tmux ls 2>/dev/null | grep -q '^claude-'; then
    tmux ls 2>/dev/null | grep '^claude-' | sed 's/^claude-/  /'
  else
    printf '  (none running)\n'
  fi
  printf '\n\033[1mProjects\033[0m\n'
  ls -1 "$PROJECTS" 2>/dev/null | sed 's/^/  /'
  printf '\nUsage: cc <project>        # start or rejoin\n'
  printf '       cc <project> --kill  # end the session for good\n'
  exit 0
fi

dir="$PROJECTS/$name"
if [ ! -d "$dir" ]; then
  printf 'No such project: %s\n\nAvailable:\n' "$name" >&2
  ls -1 "$PROJECTS" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi

session="claude-$name"

if [ "${2:-}" = "--kill" ]; then
  tmux kill-session -t "$session" 2>/dev/null && echo "Ended $name." || echo "No session for $name."
  exit 0
fi

if tmux has-session -t "$session" 2>/dev/null; then
  printf '\033[1;32mRejoining\033[0m live session for %s — it never stopped.\n' "$name"
else
  printf '\033[1;36mStarting\033[0m a permanent session for %s.\n' "$name"
  # `bash -lc` so the session picks up /etc/profile.d: Bedrock config, region,
  # default model, and the GitHub token resolver. Without a login shell the CLI
  # starts without Bedrock credentials and fails on the first message.
  tmux new-session -d -s "$session" -c "$dir" 'bash -lc claude'
  # Don't let a crashed CLI silently leave an empty shell that looks alive.
  tmux set-option -t "$session" remain-on-exit off >/dev/null 2>&1 || true
fi

# Deliberately no `-d`: that would detach other clients. Allowing several means
# a phone and a laptop can watch the same run at once, which is the point.
# Trade-off worth knowing: tmux sizes the window to the smallest attached
# client, so a phone will constrain a desktop while both are attached.
exec tmux attach-session -t "$session"
