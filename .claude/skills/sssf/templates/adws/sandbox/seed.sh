#!/usr/bin/env bash
# seed.sh — run the repo's own database seed command with DATABASE_URL set.
# Invoked in the clone root by the dispatch's db_seed phase:
#
#   ssh <vm> bash -s -- <database_url> <cmd> [args...] < seed.sh
#
# The seed command itself comes from sssf.config.yaml (remote.postgres.seed_cmd)
# — this wrapper only exports the connection string, runs it, and prints a
# row-count receipt so "seeded" is a measured fact rather than an exit code.
set -euo pipefail

DATABASE_URL="${1:?usage: seed.sh <database_url> <cmd> [args...]}"
shift
[ $# -gt 0 ] || { echo "[seed] no seed command given" >&2; exit 2; }

export DATABASE_URL
echo "[seed] running: $*"
"$@"

# Receipt: tables with rows, so an empty seed is visible in the phase log.
echo "[seed] user tables (name, live rows):"
psql "$DATABASE_URL" -qtA -F' ' \
  -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname" \
  | sed 's/^/[seed]   /' || echo "[seed]   (pg_stat receipt unavailable)"
echo "[seed] DONE"
