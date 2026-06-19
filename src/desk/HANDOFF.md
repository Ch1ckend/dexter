# THE DESK — Handoff / Continuation Guide

> **Status: 2026-06-19.** Read this top-to-bottom to continue in a fresh session.
> Project: `~/Projects/dexter` (a fork of virattt/dexter, TypeScript + Bun).
> A short summary also lives in PAI auto-memory (`dexter-project.md`) and surfaces via recall.
> **No secrets are in this file** — API keys are referenced by env-var name only.

---

## 1. What this is

An autonomous **paper-trading** research system built on top of the Dexter fork. A **research
swarm** gathers multi-source intel on a stock, an **analyst** decides buy/sell/hold, a **strategist**
sets the ideal entry price, sell target, stop, and a **self-chosen growth timeline**, then it places a
**guardrailed limit order** on Alpaca paper. Every decision is journaled, graded against outcome, and
distilled into a playbook. **Paper-only by construction; live Robinhood is a deliberate future gate.**

It started as a debate "committee" (bull/bear/judge) on 2026-06-18, then was **redesigned 2026-06-19**
into the research swarm below (the user's explicit new direction). The committee is kept as legacy.

---

## 2. Architecture — the research swarm (PRIMARY, use this)

**Entry point:** `src/desk/research-run.ts`

Pipeline per ticker:
```
resolveCik (company name, EDGAR)
  → runResearchSwarm  (4 researchers, each: deterministic GATHER → 1 LLM synthesis → Zod report)
      • market-trends   (FRED macro + Finnhub metrics/recs/quote)
      • national-news   (Marketaux + Finnhub news + Perplexity)
      • local-news      (Brave geo-news + Perplexity local angle)
      • company-osint   (EDGAR filings + Form 4 + Finnhub insider + Perplexity OSINT)
  → decide      (analyst → BUY/SELL/HOLD + confidence + drivers + risks)
  → strategize  (entry price, target price, stop, self-chosen horizon, growth thesis, expected return %)
  → journal     (DeskDecision now carries a `strategy` object)
  → [if --execute && confidence≥threshold && not HOLD] guardrailed LIMIT order at the entry price
```

**Files (`src/desk/`):**
- `research-run.ts` — orchestrator + CLI (flags: `--execute`, `--watchlist`, `--confidence`, `--model`)
- `research/researchers.ts` — the 4 researchers + `runResearchSwarm()` + `renderReports()`
- `research/gather.ts` — deterministic per-domain data gathering (no LLM; code before prompts)
- `research/types.ts` — `ResearchReportSchema`, `SignalSchema`, shared types
- `decide.ts` — analyst (`DecisionSchema`)
- `strategy.ts` — strategist (`StrategySchema`: entry/target/stop/horizon/growthThesis/expectedReturnPct)
- `journal.ts` — `DeskDecision` (+ optional `strategy`), append/read/overwrite
- `grade.ts` — `scoreDecision()` (pure, tested) scores past BUY/SELL vs current price; `runGrade()`
- `learn.ts` — distills graded journal → `playbook.md`; `runLearn()`, `biasesOf()`
- `playbook.ts` — load/save/inject the playbook
- `watch.ts` — cron heartbeat (grade + portfolio summary + Pulse notify; `--learn` weekly)
- `paths.ts` — PAI_DIR, journal/playbook paths (overridable via `DESK_JOURNAL_PATH`/`DESK_PLAYBOOK_PATH`)
- `llmRetry.ts` — `withRateLimitRetry()` (5/12/25s backoff for free-tier 429s)

**Execution seam:** `src/tools/broker/alpaca-exec.ts` — shells the guardrailed `_ALPACA` paper CLI;
also registered as agent tool `alpaca_paper` in `src/tools/registry.ts`. **All guardrails live in the
CLI**, not here — a refusal is surfaced as a refusal, never worked around.

**Protective exits (added 2026-06-19):** every conviction BUY is placed as an Alpaca **bracket**
order — `placeOrder(..., {takeProfit, stop})` → CLI `buy … --take-profit --stop` — so the
take-profit + stop-loss legs auto-activate the instant the entry fills (GTC, broker-enforced).
`src/desk/monitor.ts` is the **backstop**: it sweeps open longs and attaches a protective **OCO**
(CLI `protect <sym> --take-profit --stop`) to any position lacking a working sell exit, using the
journaled target/stop. **The `_ALPACA` CLI was extended** for this (bracket on buy, `protect` OCO,
`orders --status`, `clock`) — the Mac source is `~/.claude/skills/_ALPACA/Tools/Alpaca.ts`; the VPS
copy at `/root/alpaca-skill/` was updated via `scp`. Bracket order acceptance verified on the VPS
2026-06-19 (place non-filling bracket → accepted → cancel); live fill→exit activates on the first
real BUY ≥0.7.

**Legacy committee (kept, NOT primary):** `run.ts`, `debate.ts`, `roles.ts`, `behavioral.ts`,
`dossier.ts`. The bull/bear/skeptic/risk/behavioral/judge debate. `src/desk/README.md` documents this
era and is **stale** re: architecture — reconcile it to the research swarm when convenient.

---

## 3. Data sources (6 live) — `src/tools/datasources/`

| Client | Source | Key (env var) | Notes |
|---|---|---|---|
| `edgar.ts` | SEC EDGAR | **none** (UA only) | 10-K/10-Q/8-K + Form 4 insider; `SEC_EDGAR_UA` overrides contact |
| `finnhub.ts` | Finnhub | `FINNHUB_API_KEY` | news, metrics, insider, analyst recs, quote (~60/min free) |
| `fred.ts` | FRED (St. Louis Fed) | `FRED_API_KEY` | macro snapshot (rates, yield curve, CPI, unemployment, VIX) |
| `marketaux.ts` | Marketaux | `MARKETAUX_API_KEY` | ticker-tagged news + sentiment score (~100/day free) |
| `brave.ts` | Brave Search | `BRAVE_API_KEY` | news + web search, geo-targeting for local (~free $5/mo) |
| (Dexter's) | Perplexity | `PERPLEXITY_API_KEY` | synthesis / OSINT (`perplexitySearch` tool) |
| `congress.ts` | FMP congress trades | `FMP_API_KEY` (free tier) | **opt-in alt-data:** U.S. Senate/House stock disclosures, surfaced in `company-osint`. Degrades gracefully — no key → throws, recorded in `errors`, Perplexity OSINT still carries the congress/options/gov signal |

`index.ts` exposes `sourceStatus()` → which sources have working creds. The **6 core sources
verified live 2026-06-19** (`{edgar,perplexity,finnhub,fred,marketaux,brave}` all true).
`congress` (FMP) is **off until `FMP_API_KEY` is set** — see §4.

> **Free congress-data reality (verified 2026-06-19):** the dedicated free *structured* sources
> are degraded — Capitol Trades API 503 (broken Lambda), House/Senate Stock Watcher S3 403
> (locked), Finnhub congress endpoint premium-only. FMP (free key) is the structured path; if its
> senate data turns out paywalled even on the free tier, the swarm no-ops it and Perplexity OSINT
> covers the signal. Paid Quiver ($30/mo) was deliberately declined.

---

## 4. Credentials — all wired (values NOT here)

- **`~/Projects/dexter/.env`** (gitignored): `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`,
  `FINNHUB_API_KEY`, `FRED_API_KEY`, `MARKETAUX_API_KEY`, `BRAVE_API_KEY` are all set with real keys.
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FINANCIAL_DATASETS_API_KEY`, etc. are still placeholders.)
  Bun auto-loads this `.env` — **run commands from `~/Projects/dexter`.**
- **`FMP_API_KEY` (optional, not set):** get a **free** key at financialmodelingprep.com and add
  `FMP_API_KEY=...` to `.env` to switch on structured congressional-trade data in `congress.ts`.
  Without it the source no-ops gracefully (Perplexity OSINT covers the signal).
- **Alpaca paper creds:** `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` live in **`~/.zshenv`** (moved
  there 2026-06-19 from `PAI_CONFIG.yaml` so non-login automation shells can read them — `~/.zprofile`
  is login-only and broke cron/Bash-tool runs). Memory: `alpaca-creds-zprofile`.
- **Alpaca guardrails:** `~/.claude/skills/_ALPACA/guardrails.yaml`.

---

## 5. Models (read this — it caused most of the friction)

- **Use paid `openrouter:openai/gpt-4o-mini`** as the default: ~**$0.004/run**, runs parallel, no
  rate caps. OpenRouter balance was ~**$4.82** ≈ 1,000+ runs.
- **Free models work** (`openrouter:openai/gpt-oss-20b:free`, `google/gemma-4-31b-it:free` — both do
  structured output) **but** OpenRouter caps free models at **~50 requests/UTC-day** until you've
  **purchased $10 total** (only $5 purchased so far → 50/day). Cap resets at UTC midnight. The swarm is
  ~6 LLM calls/run, so iteration exhausts the 50 fast → falls back to paid.
- Free `:free` models also throw sporadic per-minute 429s ("Provider returned error"). Handled by
  `withRateLimitRetry` (long backoff) + **serial mode auto-enabled when the model id contains `:free`**.
- Bad model ids seen: `qwen/qwen3.5-flash:free`, `mistralai/magistral-medium-2509:free` (400 invalid);
  `meta-llama/llama-3.3-70b-instruct:free` (too slow / hangs). Don't use these.

---

## 6. How to run

```sh
cd ~/Projects/dexter

# Research swarm (PRIMARY) — research + decide + plan, NO order (default dry-run):
bun run src/desk/research-run.ts AAPL --model openrouter:openai/gpt-4o-mini

# Actually place the guardrailed LIMIT buy at the strategist's entry price:
bun run src/desk/research-run.ts AAPL --model openrouter:openai/gpt-4o-mini --execute

# Whole allowlist:
bun run src/desk/research-run.ts --watchlist --model openrouter:openai/gpt-4o-mini

# Self-rating + learning loop (deterministic, no LLM key needed):
bun run src/desk/grade.ts          # score past BUY/SELL vs current price
bun run src/desk/learn.ts          # distill graded journal → playbook.md

# Watcher cycle (grade + portfolio summary + Pulse notify):
bun run src/desk/watch.ts [--learn]

# Health:
bun run typecheck    # 0 errors
bun test             # 86 pass
```

### Autonomous nightly run — PRIMARY: Hostinger VPS (deployed 2026-06-19)
**The Desk now runs 24/7 on a Hostinger VPS, not the Mac.** The Mac launchd job is **disarmed**
(plist removed from `~/Library/LaunchAgents/`; template kept at `scripts/com.dexter.desk-nightly.plist`).
Run exactly one runner at a time — two share the same paper account + 25/day cap.

- **VPS:** `srv1764032.hstgr.cloud` (`2.24.193.163`), Debian 13, root via SSH key. Local alias
  `ssh dexter` (key `~/.ssh/dexter`, config `~/.ssh/config`). TZ set to **America/New_York**.
- **Code:** `/root/dexter` (the `Ch1ckend/dexter` clone). Update with `ssh dexter 'cd /root/dexter && git pull'`.
- **Guardrail CLI:** `_ALPACA` copied to `/root/alpaca-skill/` (`Tools/Alpaca.ts` + `guardrails.yaml`);
  pointed to via `ALPACA_CLI` in `/root/dexter/.env`.
- **Creds:** all in `/root/dexter/.env` (bun auto-loads): the 4 data keys + `APCA_*` paper creds +
  `DESK_DISCORD_WEBHOOK` + `ALPACA_CLI` + `PAI_DIR=/root/.pai`. (No `~/.zshenv` needed on Linux.)
- **Schedules (two systemd timers, both weekday-only, box on ET):**
  - `desk-nightly.timer` → `scripts/desk-nightly-linux.sh` — **Mon–Fri 08:30 ET**: research +
    `--execute` over the watchlist (the trader).
  - `desk-review.timer` → `scripts/desk-review-linux.sh` — **Mon–Fri 16:30 ET** (after close):
    `watch.ts` = grade past BUY/SELL vs price + portfolio summary + notify; **Fridays add `--learn`**
    (playbook re-distill). The self-review heartbeat.
  - `desk-monitor.timer` → `scripts/desk-monitor-linux.sh` — **every 15 min, Mon–Fri**:
    `monitor.ts` = reconcile open positions, attach a protective OCO to any unprotected long.
    Self-gates on market hours (skips when closed). The exit backstop.
  - Manage: `systemctl status|start desk-{nightly,review,monitor}.service`, `systemctl list-timers`,
    `journalctl -u desk-{nightly,review,monitor}.service`.
  - **Sync note:** `desk-review-linux.sh` was `scp`'d to the VPS ahead of a push. Next time you
    `git pull` on the VPS, run it as `cd /root/dexter && git stash -u && git pull --ff-only &&
    git stash drop` so the untracked copy doesn't block the merge (contents are identical).
- **Notifications:** Discord webhook (`src/desk/notify.ts` fires Pulse + Discord; on the VPS Pulse
  no-ops, Discord carries the morning summary).
- **State on VPS:** `/root/.pai/MEMORY/TRADING/` (journal + alpaca audit/state). Separate from the Mac.
- **Verified 2026-06-19:** Alpaca paper reachable ($100k), guardrails load, Discord 204, full
  watchlist `--execute` via `systemctl start` succeeded (all HOLD, Discord notified). Next auto-run
  Mon 2026-06-22 08:30 ET.
- **Pending hardening (manual):** disable SSH password auth (a cloud-init drop-in still enables it).
  Drop `PasswordAuthentication no` into `/etc/ssh/sshd_config.d/00-hardening.conf`, `sshd -t`,
  `systemctl reload ssh`. Key auth already works, so this is safe.
- **Proxmox later:** identical Linux setup ports 1:1 (clone repo, copy `_ALPACA`, `.env`, the bash
  wrapper + systemd units, set TZ). Carry `/root/.pai/MEMORY/TRADING/` to keep journal history.

### macOS launchd (legacy, now disarmed)
- **Wrapper:** `scripts/desk-nightly.sh` (zsh, sources `~/.zshenv` for creds). Template plist
  `scripts/com.dexter.desk-nightly.plist`. Re-arm only if retiring the VPS:
  `cp scripts/com.dexter.desk-nightly.plist ~/Library/LaunchAgents/ && launchctl load …`
  (and disarm the VPS timer first).

---

## 7. Safety / guardrails

- **PAPER ONLY** — `_ALPACA` CLI hard-pins the Alpaca paper endpoint; refuses to start against live.
- **Allowlist:** `AAPL MSFT SPY QQQ NVDA GOOGL AMZN`. Off-allowlist orders are refused pre-flight.
- **Caps:** $5k/symbol, $20k total exposure, 25 orders/UTC-day, **no shorting**.
- `--execute` lets it place real paper orders **autonomously within those rails**; default is dry-run.
- **Live Robinhood** (real money) is intentionally NOT wired for autonomous trading. The
  `robinhood-trading` MCP exists (read + order capable) but going live is a deliberate, separate gate
  needing its own tighter guardrails + explicit human sign-off.

---

## 8. State files (under `$PAI_DIR/MEMORY/TRADING/`, `$PAI_DIR` = `~/.claude/PAI`)

- `desk-journal.jsonl` — one line per decision (incl. `strategy` object + research digest)
- `playbook.md` — self-authored "what works / fails" methods, injected into the (legacy) debate
- `alpaca-audit.jsonl`, `alpaca-state.json` — broker-level order audit + daily counter
- Override journal/playbook locations with `DESK_JOURNAL_PATH` / `DESK_PLAYBOOK_PATH` (used by tests)
- Nightly launchd run logs → `~/.dexter/logs/desk-nightly.{out,err}` (not under `$PAI_DIR`)

---

## 9. Verified working (2026-06-19)

- All 6 data sources live; full gather tested on AAPL (macro, sentiment, local signals, filings/insider).
- **Full research pipeline ran end-to-end on AAPL** (paid gpt-4o-mini): `HOLD · conf 0.65`,
  entry **$290 → target $350** (stop $275), **6–12 mo** horizon, **+20%** expected; journaled with plan.
- 78 tests pass, typecheck 0 errors.
- Alpaca account ($100k paper) reachable from a non-login automation shell after the `~/.zshenv` fix.
- Guardrail refusal verified (off-allowlist TSLA → refused).

---

## 10. Open items / where we left off (next-session backlog)

1. **Position sizing is code-based** (confidence-scaled, guardrail-capped in `research-run.ts`
   `executeAndJournal`). The user may want an **agent that reasons over size** — easy add.
2. ~~**No open-position management**~~ — **DONE 2026-06-19.** Conviction buys are bracket orders
   (target/stop attached at fill); `monitor.ts` (every 15 min) is the OCO backstop for any
   unprotected long. See §2 "Protective exits". (Live fill→exit verifies on the first real BUY ≥0.7.)
3. ~~**Cron not wired for `--execute`**~~ — **DONE 2026-06-19.** launchd job runs the full
   watchlist with `--execute` nightly at 08:30 ET (see §6, "Autonomous nightly run"). `watch.ts`
   remains the separate grade+notify heartbeat.
4. **Alt-data edge sources** — **partial (2026-06-19):** `congress.ts` (FMP, free key) added for
   congressional trades, surfaced in `company-osint`; needs `FMP_API_KEY` to activate. Still open:
   Unusual Whales (options flow), Quiver (paid, declined), Apify (Glassdoor/LinkedIn).
5. **`src/desk/README.md` is committee-era** — reconcile to the research swarm.
6. **Fully-free model path** needs $5 more on OpenRouter ($10 total → 1,000 free/day).
7. **Going live (real money)** — deliberately gated; design tighter guardrails + sign-off first.

---

## 11. Gotchas (will bite again)

- **This machine's system timezone is `America/New_York` (ET)** — despite PAI identity files
  saying America/Los_Angeles. `launchd` schedules in *system-local* time, so the nightly plist uses
  `Hour=8` for 08:30 ET. Verify with `readlink /etc/localtime` before trusting any schedule math.
- Alpaca creds must be in `~/.zshenv` (not `~/.zprofile`) for any non-login automation (cron, Bash tool).
- Run from `~/Projects/dexter` so Bun loads the right `.env`.
- macOS has **no `timeout`** command — use the tool's own timeout, or background + poll.
- Free OpenRouter daily cap (50/day) is the main limiter — prefer paid `gpt-4o-mini` for iteration.
- SEC EDGAR requires a `User-Agent` with a contact email (set; `SEC_EDGAR_UA` overrides).
- bun/TypeScript only in this project (never npm/python). `bun typecheck` + `bun test` before claiming done.
