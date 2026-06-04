#!/bin/sh
set -eu

export HOME="${HOME:-/root}"

write_secret_file() {
  path="$1"
  content="$2"
  install -d -m 0700 "$(dirname "$path")"
  printf '%s' "$content" > "$path"
  chmod 0600 "$path"
}

if [ -n "${CODEX_AUTH_JSON:-}" ]; then
  codex_home="${CODEX_HOME:-$HOME/.codex}"
  export CODEX_HOME="$codex_home"
  write_secret_file "$codex_home/auth.json" "$CODEX_AUTH_JSON"
fi

if [ -n "${OPENCODE_AUTH_JSON:-}" ]; then
  write_secret_file "$HOME/.local/share/opencode/auth.json" "$OPENCODE_AUTH_JSON"
fi

if [ -n "${PI_AUTH_JSON:-}" ]; then
  write_secret_file "$HOME/.pi/agent/auth.json" "$PI_AUTH_JSON"
fi

exec "$@"
