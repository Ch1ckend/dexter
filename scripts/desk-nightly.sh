#!/bin/zsh
# The Desk — nightly autonomous paper-trading run (driven by launchd).
#
# zsh sources ~/.zshenv on EVERY invocation, and that is where the Alpaca paper
# creds (APCA_API_KEY_ID / APCA_API_SECRET_KEY) live — so this run reaches the
# broker even from a non-login automation shell. Run from the repo so Bun loads
# the project .env (OpenRouter / data-source keys).
#
# Schedule (via the launchd plist): 08:30 system-local. This machine is on
# America/New_York, so that is 08:30 ET pre-market (before the 09:30 open).
# Confidence gate 0.7 for unattended trading. PAPER endpoint is hard-pinned in
# the _ALPACA CLI; all guardrails live there. A refusal stays a refusal.
#
# Weekday guard: skip weekends (markets closed — Alpaca would just queue orders
# and we'd burn LLM spend for nothing). Market holidays still queue (minor).
set -u

[ "$(date +%u)" -gt 5 ] && exit 0

mkdir -p "$HOME/.dexter/logs"
cd "$HOME/Projects/dexter" || exit 1

echo "===== desk-nightly $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
bun run src/desk/research-run.ts --watchlist --execute \
  --confidence 0.7 --model openrouter:openai/gpt-4o-mini
