#!/usr/bin/env bash
# The Desk — open-position reconcile monitor (Linux / systemd).
#
# Runs monitor.ts: ensure every open long has a protective OCO exit (the backstop
# for anything bracket buys didn't already cover). The monitor self-gates on
# market hours, so it's safe to fire on a tight interval. Weekdays only.
set -u

[ "$(date +%u)" -gt 5 ] && exit 0

REPO="${DESK_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || exit 1

exec bun run src/desk/monitor.ts
