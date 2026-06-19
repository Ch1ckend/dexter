#!/usr/bin/env bash
# The Desk — nightly autonomous paper-trading run (Linux / systemd or cron).
#
# Portable companion to desk-nightly.sh (the macOS/launchd version). Derives the
# repo path from its own location, so it works unchanged on any Linux host
# (Hostinger VPS now, Proxmox later). Credentials come from the repo .env (bun
# auto-loads it) — incl. the Alpaca paper creds, which pass through to the
# _ALPACA CLI. PAI_DIR / ALPACA_CLI are expected from the environment (set them
# in the systemd unit or cron line); they fall back to the Desk's own defaults.
#
# Schedule it for 08:30 in a box whose timezone is America/New_York (ET).
# Weekday guard: Mon–Fri only (markets closed weekends; holidays just queue).
set -u

[ "$(date +%u)" -gt 5 ] && exit 0

REPO="${DESK_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || exit 1

echo "===== desk-nightly $(date '+%F %T %Z') ====="
exec bun run src/desk/research-run.ts --watchlist --execute \
  --confidence "${DESK_CONFIDENCE:-0.7}" --model "${DESK_MODEL:-openrouter:openai/gpt-4o-mini}"
