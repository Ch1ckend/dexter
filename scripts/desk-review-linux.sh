#!/usr/bin/env bash
# The Desk — scheduled review heartbeat (Linux / systemd).
#
# Runs watch.ts: grade past BUY/SELL decisions against current price, summarize
# the paper portfolio, and notify (Pulse + Discord). On Fridays it also
# re-distills the playbook (--learn). Companion to desk-nightly-linux.sh.
#
# Schedule for ~16:30 in a box on America/New_York (ET) — after the 16:00 close,
# so grading uses end-of-day prices. Weekdays only.
set -u

[ "$(date +%u)" -gt 5 ] && exit 0

REPO="${DESK_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || exit 1

# Weekly playbook re-distill on Fridays (day 5).
LEARN=""
[ "$(date +%u)" -eq 5 ] && LEARN="--learn"

echo "===== desk-review $(date '+%F %T %Z') ${LEARN} ====="
exec bun run src/desk/watch.ts ${LEARN}
