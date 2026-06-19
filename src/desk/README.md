# The Desk — autonomous multi-agent investment committee

A committee of adversarial agents researches a stock, argues it out, and a judge
renders a sized, confidence-scored decision that executes on the **guardrailed
Alpaca paper account**. Every decision is journaled, graded against outcome, and
distilled into a playbook the committee reads next time — so it learns from itself.

Paper-first by construction. Live Robinhood is a deliberate future gate, not a flag.

## Pipeline

```
run.ts ─▶ dossier.ts ─▶ debate.ts ─▶ (gate) ─▶ alpaca-exec ─▶ journal.ts
              │             │                    (paper)          │
       finance tools   Bull·Bear·Skeptic·                   grade.ts ─▶ learn.ts ─▶ playbook.md
       + Perplexity    Risk·Behavioral·Judge                          (fed back into debate)
```

- **dossier.ts** — pulls fundamentals, key ratios, income statements, insider trades
  (Dexter finance tools) + a Perplexity research/OSINT pass. Resilient to partial failures.
- **roles.ts / behavioral.ts / debate.ts** — the committee. Bull and Bear build opposing
  cases; the Skeptic red-teams both; the Risk Manager sizes; the Behavioral Guard flags
  human bias (FOMO, loss aversion, recency, anchoring, herding, overconfidence); the Judge
  synthesizes a `{action, sizeUsd, confidence, rationale, risks}` decision.
- **alpaca-exec.ts** (`src/tools/broker/`) — shells the `_ALPACA` CLI. All caps/allowlist/
  paper-only enforcement live there; this surface never works around a refusal.
- **journal.ts / grade.ts / learn.ts / playbook.ts** — the self-rating + learning loop.

## Commands

```sh
# Research + debate + decide; place NO order
bun run src/desk/run.ts AAPL --dry-run

# Full cycle: decide and execute on paper, then journal
bun run src/desk/run.ts AAPL MSFT
bun run src/desk/run.ts --watchlist            # every allowlisted symbol
bun run src/desk/run.ts AAPL --confidence 0.7  # raise the action gate

# Score past decisions against outcome (deterministic; no LLM key needed)
bun run src/desk/grade.ts [--min-age-hours 24] [--regrade]

# Distill the graded journal into the playbook (no LLM key needed)
bun run src/desk/learn.ts

# Watcher heartbeat: grade + portfolio summary + Pulse notify
bun run src/desk/watch.ts            # daily
bun run src/desk/watch.ts --learn    # weekly (also re-distills the playbook)
```

## Watcher (cron)

The watcher's grade+notify cycle needs no LLM key. Add to `crontab -e` (paths absolute):

```cron
# Daily at 4:15pm ET (after close) — grade + portfolio summary + Pulse notify
15 16 * * 1-5  cd $HOME/Projects/dexter && bun run src/desk/watch.ts >> $HOME/.claude/PAI/MEMORY/TRADING/desk-watch.log 2>&1
# Weekly Sunday 6pm — re-distill the playbook
0 18 * * 0     cd $HOME/Projects/dexter && bun run src/desk/watch.ts --learn >> $HOME/.claude/PAI/MEMORY/TRADING/desk-watch.log 2>&1
```

Fresh committee evaluations (`run.ts`) are scheduled separately once credentials are set.

## State (under `$PAI_DIR/MEMORY/TRADING/`)

- `desk-journal.jsonl` — one line per committee decision (+ grade annotations)
- `playbook.md` — the self-authored methods, injected into every debate
- `alpaca-audit.jsonl` / `alpaca-state.json` — the broker-level order audit + daily counter

Override journal/playbook locations with `DESK_JOURNAL_PATH` / `DESK_PLAYBOOK_PATH` (used by tests).

## Credentials

- **Trading (works):** Alpaca paper keys resolve from `PAI_CONFIG.yaml`.
- **Research + models (required for `run.ts`):** the committee needs `OPENAI_API_KEY`
  (or set `--model` to another provider) plus `FINANCIAL_DATASETS_API_KEY` and
  `PERPLEXITY_API_KEY`. Dexter's `.env` currently holds placeholders — populate it
  (or point `--model` at a configured provider) before running live debates.
