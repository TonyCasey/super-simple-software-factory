#!/usr/bin/env bash
# provision.sh — turn a blank exe.dev VM (exeuntu / Ubuntu 24.04) into a box
# that can run the SSSF factory. Piped over ssh by sandbox_dispatch.ts:
#
#   ssh <vm> bash -s -- [--claude] [--codex] [--postgres <ver> <db> <user> <pass>] < provision.sh
#
# Idempotent by construction: every install is skip-if-present, the postgres
# role/db creation is guarded, and re-running is cheap (~1s warm). Measured cold
# timings from the lon region (2026-08-13): bun 1s, just 1s, each CLI 1s,
# apt update 9s, postgres install 13s.
#
# The caller polls for the READY sentinel — it must stay the last line.
set -euo pipefail

STEP="startup"
# shellcheck disable=SC2154   # rc is assigned by the trap body itself
trap 'rc=$?; echo "" >&2; echo "[provision] FAILED during: ${STEP} (exit ${rc})" >&2; exit "$rc"' ERR

step() { STEP="$1"; echo ""; echo "── $1 ──────────────────────────────────"; }
say()  { echo "   $*"; }

WANT_CLAUDE=0; WANT_CODEX=0; WANT_PG=0; WANT_GH=0
PG_VERSION=16; PG_DB=app; PG_USER=app; PG_PASSWORD=app
while [ $# -gt 0 ]; do
  case "$1" in
    --claude) WANT_CLAUDE=1; shift ;;
    --codex)  WANT_CODEX=1; shift ;;
    --gh)     WANT_GH=1; shift ;;
    --postgres)
      WANT_PG=1
      PG_VERSION="${2:?--postgres needs <version> <db> <user> <password>}"
      PG_DB="${3:?}"; PG_USER="${4:?}"; PG_PASSWORD="${5:?}"
      shift 5 ;;
    *) echo "[provision] unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ── bun ──────────────────────────────────────────────────────────────────────
# Symlink into /usr/local/bin: every later `ssh vm cmd` is a fresh
# non-interactive shell that reads no rc file, so a PATH export dies here.
step "bun"
if command -v bun >/dev/null 2>&1; then
  say "already installed: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash > /tmp/bun-install.log 2>&1
  say "installed"
fi
if [[ -x "$HOME/.bun/bin/bun" && ! -e /usr/local/bin/bun ]]; then
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  sudo ln -sf "$HOME/.bun/bin/bunx" /usr/local/bin/bunx 2>/dev/null || true
fi
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || { echo "[provision] bun not on PATH after install" >&2; exit 1; }

# ── just ─────────────────────────────────────────────────────────────────────
step "just"
if command -v just >/dev/null 2>&1; then
  say "already installed: $(just --version)"
else
  curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
    | sudo bash -s -- --to /usr/local/bin > /tmp/just-install.log 2>&1
  say "installed"
fi

# ── sqlite3 ──────────────────────────────────────────────────────────────────
# The host's monitor loop and the harvest receipts read the trace db over ssh.
step "sqlite3"
if command -v sqlite3 >/dev/null 2>&1; then
  say "already installed: $(sqlite3 --version | cut -d' ' -f1)"
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq > /tmp/apt-update.log 2>&1
  sudo apt-get install -y -qq sqlite3 > /tmp/apt-sqlite.log 2>&1
  say "installed"
fi

# ── coding agent CLIs (only the interfaces the roster names) ─────────────────
if [ "$WANT_CLAUDE" = 1 ]; then
  step "claude"
  if command -v claude >/dev/null 2>&1; then
    say "already installed: $(claude --version 2>&1)"
  else
    bun install -g @anthropic-ai/claude-code > /tmp/cc-install.log 2>&1
    sudo ln -sf "$HOME/.bun/bin/claude" /usr/local/bin/claude
    say "installed: $(claude --version 2>&1)"
  fi
  # Pre-answer interactive onboarding (theme picker + custom-key approval), so
  # an engineer attaching later with `claude --resume` never blocks on a prompt
  # a headless box cannot answer. Idempotent: rewrites three keys, keeps the rest.
  python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude.json")
d = json.load(open(p)) if os.path.exists(p) else {}
d["hasCompletedOnboarding"] = True
d["theme"] = "dark"
r = d.setdefault("customApiKeyResponses", {})
r["approved"] = sorted(set(r.get("approved", [])) | {"implicit"})
r["rejected"] = [x for x in r.get("rejected", []) if x != "implicit"]
json.dump(d, open(p, "w"))
PY
  say "onboarding pre-answered"
fi

if [ "$WANT_CODEX" = 1 ]; then
  step "codex"
  if command -v codex >/dev/null 2>&1; then
    say "already installed: $(codex --version 2>&1)"
  else
    bun install -g @openai/codex > /tmp/codex-install.log 2>&1
    sudo ln -sf "$HOME/.bun/bin/codex" /usr/local/bin/codex
    # codex's launcher wants `node`; bun standing in works (spike-verified).
    [ -e /usr/local/bin/node ] || sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/node
    say "installed: $(codex --version 2>&1)"
  fi
fi

# ── gh (PR-enabled dispatches: push + PR through the exe.dev integration) ────
if [ "$WANT_GH" = 1 ]; then
  step "gh"
  if command -v gh >/dev/null 2>&1; then
    say "already installed: $(gh --version | head -1)"
  else
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update -qq > /tmp/apt-update.log 2>&1
    sudo apt-get install -y -qq gh > /tmp/apt-gh.log 2>&1
    say "installed: $(gh --version | head -1)"
  fi
fi

# ── postgres ─────────────────────────────────────────────────────────────────
if [ "$WANT_PG" = 1 ]; then
  step "postgres ${PG_VERSION}"
  if command -v psql >/dev/null 2>&1 && systemctl is-active --quiet postgresql; then
    say "already running: $(psql --version)"
  else
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update -qq > /tmp/apt-update.log 2>&1
    sudo apt-get install -y -qq "postgresql-${PG_VERSION}" > /tmp/apt-pg.log 2>&1 \
      || sudo apt-get install -y -qq postgresql > /tmp/apt-pg.log 2>&1
    sudo systemctl enable --now postgresql
    say "installed: $(psql --version)"
  fi
  # Role + db, idempotent. The password is VM-local plumbing, but psql -c puts
  # argv in ps, so feed the DO block over stdin.
  sudo -u postgres psql -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASSWORD}';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 \
    || sudo -u postgres createdb -O "${PG_USER}" "${PG_DB}"
  PGPASSWORD="${PG_PASSWORD}" psql -h 127.0.0.1 -U "${PG_USER}" -d "${PG_DB}" -qtAc 'select 1' > /dev/null
  say "role '${PG_USER}' + db '${PG_DB}' ready, password auth verified"
fi

# ── summary ──────────────────────────────────────────────────────────────────
step "summary"
say "bun     $(bun --version)"
say "just    $(just --version)"
say "sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
[ "$WANT_CLAUDE" = 1 ] && say "claude  $(claude --version 2>&1)"
[ "$WANT_CODEX" = 1 ]  && say "codex   $(codex --version 2>&1)"
[ "$WANT_PG" = 1 ]     && say "psql    $(psql --version)"
echo ""
echo "[provision] READY"

# The caller polls for this file — no other reliable completion signal exists.
# It must stay the last line.
touch /tmp/SSSF_PROVISION_READY
