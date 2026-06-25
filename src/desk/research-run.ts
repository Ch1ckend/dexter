#!/usr/bin/env bun
/**
 * The Desk — research-swarm orchestrator (supersedes the debate committee).
 *
 *   bun run src/desk/research-run.ts <TICKER...> [flags]
 *
 * Flags:
 *   --dry-run            Research + decide + plan, place NO orders (default).
 *   --execute            Actually place the guardrailed LIMIT order at the entry price.
 *   --watchlist          Evaluate every allowlisted symbol.
 *   --confidence <0..1>  Min decision confidence to act (default 0.6).
 *   --model <name>       LLM for the swarm/analyst/strategist.
 *
 * Pipeline: resolve company → research swarm (trends/national/local/OSINT) →
 * analyst decision (buy/sell/hold) → strategist plan (entry/target/stop/timeline)
 * → journal → optional guardrailed limit order at the ideal entry price.
 */
import { resolveCik } from '@/tools/datasources';
import { runResearchSwarm, type SwarmOptions } from './research/researchers.js';
import { decide } from './decide.js';
import { strategize } from './strategy.js';
import { account, guardrails, quote, positionFor, placeOrder } from '@/tools/broker/alpaca-exec';
import { appendDecision, makeId, type DeskDecision, type DeskAction } from './journal.js';
import { notify } from './notify.js';
import { loadPlaybook, playbookBlock } from './playbook.js';
import type { ResearchReport } from './research/types.js';
import type { Decision } from './decide.js';
import type { Strategy } from './strategy.js';

const DEFAULT_CONFIDENCE = 0.6;

/** Round UP to a whole cent — Alpaca rejects sub-penny limit prices on ≥$1 stocks. */
function ceilToPenny(n: number): number {
  return Math.ceil(n * 100) / 100;
}

/**
 * The limit price to actually fill a BUY. The strategist sets a disciplined ideal
 * entry that often sits BELOW the market — a plain limit there rests unfilled, so
 * the desk "decides" but never trades. We make the order MARKETABLE: if the ideal
 * entry is at/above the current price we honor it; if it's below, we lift to the
 * current price so the order fills now. The result is rounded UP to a whole cent
 * (Alpaca rejects sub-penny limits like 192.745). Falls back to the ideal entry
 * (penny-rounded) when we have no live price. Pure + exported for unit testing.
 */
export function buyLimitPrice(entryPrice: number, currentPrice: number | null): number {
  if (currentPrice == null || !isFinite(currentPrice) || currentPrice <= 0) return ceilToPenny(entryPrice);
  return ceilToPenny(Math.max(entryPrice, currentPrice));
}

interface Args {
  tickers: string[];
  model?: string;
  dryRun: boolean;
  watchlist: boolean;
  confidence: number;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { tickers: [], dryRun: true, watchlist: false, confidence: DEFAULT_CONFIDENCE, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--execute') { a.execute = true; a.dryRun = false; }
    else if (x === '--watchlist') a.watchlist = true;
    else if (x === '--confidence') a.confidence = Number(argv[++i]);
    else if (x === '--model') a.model = argv[++i];
    else if (!x.startsWith('-')) a.tickers.push(x.toUpperCase());
  }
  return a;
}

async function buildAccountContext(): Promise<{ text: string; allowlist: string[]; equity: number; maxPosition: number }> {
  const acct = await account();
  const g = await guardrails();
  const lines: string[] = [];
  lines.push(
    acct.ok
      ? `Account (PAPER): equity $${acct.data.equity}, buying power $${acct.data.buying_power}, cash $${acct.data.cash}.`
      : 'Account: unavailable.',
  );
  if (g.ok) {
    lines.push(
      `HARD GUARDRAILS (paper): allowlist [${g.data.allowlist.join(', ')}]; max per-symbol $${g.data.max_position_notional}; ` +
        `max total $${g.data.max_total_notional}; ${g.data.max_daily_orders} orders/day; shorting ${g.data.allow_short ? 'allowed' : 'NOT allowed'}.`,
    );
  }
  return {
    text: lines.join('\n'),
    allowlist: g.ok ? g.data.allowlist : [],
    equity: acct.ok ? Number(acct.data.equity) : 0,
    maxPosition: g.ok ? g.data.max_position_notional : 0,
  };
}

async function currentPrice(ticker: string): Promise<number | null> {
  const q = await quote(ticker);
  if (!q.ok) return null;
  const mid = q.data.bid && q.data.ask ? (q.data.bid + q.data.ask) / 2 : undefined;
  const p = q.data.last ?? mid ?? q.data.ask ?? q.data.bid;
  return p != null && isFinite(p) && p > 0 ? p : null;
}

function printReport(ticker: string, reports: ResearchReport[], decision: Decision, strategy: Strategy, price: number | null): void {
  console.log('\n' + '='.repeat(72));
  console.log(`THE DESK — ${ticker}${price != null ? `  ($${price})` : ''}`);
  console.log('='.repeat(72));
  for (const r of reports) {
    console.log(`\n🔬 ${r.domain}`);
    console.log(`   ${r.summary}`);
    for (const s of r.signals) console.log(`   • [${s.direction}/${s.weight}] ${s.label}`);
  }
  console.log('\n--- DECISION ---');
  console.log(`Action: ${decision.action}   Confidence: ${decision.confidence}`);
  console.log(`Rationale: ${decision.rationale}`);
  if (decision.keyDrivers.length) console.log(`Drivers: ${decision.keyDrivers.join('; ')}`);
  if (decision.risks.length) console.log(`Risks: ${decision.risks.join('; ')}`);
  console.log('\n--- STRATEGY ---');
  console.log(`Entry $${strategy.entryPrice}  →  Target $${strategy.targetPrice}  (stop $${strategy.stopPrice})`);
  console.log(`Horizon: ${strategy.horizon} — ${strategy.horizonRationale}`);
  console.log(`Growth thesis: ${strategy.growthThesis}`);
  console.log(`Expected return: ${strategy.expectedReturnPct}%`);
}

async function executeAndJournal(
  ticker: string,
  reports: ResearchReport[],
  decision: Decision,
  strategy: Strategy,
  price: number | null,
  ctx: { equity: number; maxPosition: number },
  args: Args,
): Promise<DeskDecision> {
  const ts = new Date().toISOString();
  const pos = await positionFor(ticker);

  // Confidence-scaled size, capped by the per-symbol guardrail.
  const sizeUsd = Math.min(ctx.maxPosition || 5000, ctx.equity * 0.05 * decision.confidence);

  let executed = false;
  let executionNote = '';
  let orderId: string | null = null;
  let qty: number | undefined;

  const shouldAct = decision.action !== 'HOLD' && decision.confidence >= args.confidence;

  if (decision.action === 'HOLD') {
    executionNote = 'HOLD — no order';
  } else if (decision.confidence < args.confidence) {
    executionNote = `below confidence threshold (${decision.confidence} < ${args.confidence})`;
  } else if (!args.execute) {
    executionNote = 'dry-run — limit order suppressed';
  } else if (decision.action === 'BUY') {
    // Marketable limit: lift a below-market ideal entry to the current price so the
    // order actually FILLS (a resting limit below market is why the desk never traded).
    const limit = buyLimitPrice(strategy.entryPrice, price);
    qty = Math.floor(sizeUsd / limit);
    if (qty < 1) {
      executionNote = `size $${sizeUsd.toFixed(0)} < 1 share at $${limit.toFixed(2)} — skipped`;
    } else {
      // Attach the strategist's target/stop as a protective bracket so the exit
      // activates the moment the entry fills — but only if the legs are sane
      // relative to the ACTUAL fill price (target > limit > stop); else plain limit buy.
      const bracket =
        strategy.targetPrice > limit && strategy.stopPrice > 0 && strategy.stopPrice < limit
          ? { takeProfit: strategy.targetPrice, stop: strategy.stopPrice }
          : undefined;
      const res = await placeOrder('buy', ticker, qty, limit, bracket); // marketable LIMIT
      executed = res.ok;
      orderId = res.ok ? res.data.id : null;
      const exitNote = bracket ? ` + bracket TP $${strategy.targetPrice}/SL $${strategy.stopPrice}` : ' (no bracket — bad legs)';
      executionNote = res.ok ? `LIMIT buy ${qty} @ $${limit.toFixed(2)}${exitNote}` : res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`;
    }
  } else {
    // SELL — only trim an existing long (no shorting), as a limit at the target.
    const held = pos ? Math.floor(Number(pos.qty)) : 0;
    if (held < 1) {
      executionNote = 'no long position to sell (no shorting) — skipped';
    } else {
      qty = held;
      const res = await placeOrder('sell', ticker, qty, strategy.targetPrice);
      executed = res.ok;
      orderId = res.ok ? res.data.id : null;
      executionNote = res.ok ? `LIMIT sell ${qty} @ $${strategy.targetPrice}` : res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`;
    }
  }

  const researchDigest = reports.map((r) => `${r.domain}: ${r.summary}`).join(' | ');
  const entry: DeskDecision = {
    id: makeId(ts, ticker),
    ts,
    ticker,
    action: decision.action as DeskAction,
    sizeUsd: shouldAct ? sizeUsd : 0,
    qty,
    confidence: decision.confidence,
    oneLiner: decision.oneLiner,
    keyDrivers: decision.keyDrivers,
    risks: decision.risks,
    thesisDigest: decision.rationale,
    debateDigest: researchDigest,
    priceAtDecision: price,
    executed,
    executionNote,
    orderId,
    positionSnapshot: pos,
    strategy: {
      entryPrice: strategy.entryPrice,
      targetPrice: strategy.targetPrice,
      stopPrice: strategy.stopPrice,
      horizon: strategy.horizon,
      growthThesis: strategy.growthThesis,
      expectedReturnPct: strategy.expectedReturnPct,
    },
  };
  await appendDecision(entry);
  return entry;
}

const ACTION_DOT: Record<DeskAction, string> = { BUY: '🟢', SELL: '🔴', HOLD: '🟡' };

/**
 * Render a run as the "Investment Council" summary: a header with the BUY/HOLD/SELL
 * tally, then one block per name — colored dot, action, confidence, price, and the
 * analyst's one-sentence reasoning. Used for both Pulse and the Discord webhook.
 */
export function buildRunSummary(rows: DeskDecision[], placed: number): string {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const buys = rows.filter((r) => r.action === 'BUY').map((r) => r.ticker);
  const sells = rows.filter((r) => r.action === 'SELL').map((r) => r.ticker);
  const holds = rows.filter((r) => r.action === 'HOLD').length;
  const buyPart = `${buys.length} BUY${buys.length ? ` (${buys.join(', ')})` : ''}`;
  const sellPart = `${sells.length} SELL${sells.length ? ` (${sells.join(', ')})` : ''}`;
  const orderLine = placed > 0 ? `${placed} order(s) placed` : 'no orders placed';

  const head = [
    `📊 Investment Council — Full Run · ${date}`,
    `${rows.length} names · ${buyPart} · ${holds} HOLD · ${sellPart}`,
    `Paper desk · research/decisions only · ${orderLine}`,
    '',
  ];
  const body = rows.map((r) => {
    const dot = ACTION_DOT[r.action] ?? '⚪';
    const conf = `${Math.round(r.confidence * 100)}%`;
    const px = r.priceAtDecision != null ? ` @ $${r.priceAtDecision}` : '';
    // Prefer the crisp one-liner; fall back to the first sentence of the thesis.
    const reason = (r.oneLiner?.trim() || r.thesisDigest?.split('. ')[0] || '').trim();
    return `${dot} **${r.ticker}** — ${r.action} (${conf})${px}\n${reason}`;
  });
  return [...head, ...body].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await buildAccountContext();

  let tickers = args.tickers;
  if (args.watchlist) tickers = ctx.allowlist;
  if (tickers.length === 0) {
    console.error('usage: bun run src/desk/research-run.ts <TICKER...> [--execute] [--watchlist] [--confidence 0.6] [--model ...]');
    process.exit(1);
  }

  const serial = (args.model ?? '').includes(':free');
  const swarmOpts: SwarmOptions = { model: args.model, serial };

  // Load the self-authored playbook ONCE and inject it into every decision, so the
  // desk recalls what its own past trades taught it (the recall half of "learn").
  const playbook = playbookBlock(await loadPlaybook());
  if (playbook) console.log('📖 Recalling learned playbook into every decision.\n');

  console.log(`The Desk (research swarm) — ${tickers.join(', ')}${args.execute ? ' [EXECUTE]' : ' [dry-run]'}${serial ? ' [serial/free]' : ''}`);
  console.log(ctx.text + '\n');

  const results: DeskDecision[] = [];
  for (const ticker of tickers) {
    try {
      const { name } = await resolveCik(ticker).catch(() => ({ name: ticker }));
      const price = await currentPrice(ticker);
      const reports = await runResearchSwarm(ticker, name, swarmOpts);
      const decision = await decide(ticker, reports, ctx.text, { model: args.model, playbook });
      const strategy = await strategize(ticker, decision, reports, price, { model: args.model });
      printReport(ticker, reports, decision, strategy, price);
      const entry = await executeAndJournal(ticker, reports, decision, strategy, price, ctx, args);
      results.push(entry);
      console.log(`\n📓 Journaled: ${entry.executionNote}${entry.orderId ? ` (order ${entry.orderId})` : ''}`);
    } catch (e) {
      console.error(`\n[${ticker}] failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Unattended-run summary: ping Pulse with one line of what happened (nightly cron path).
  if (args.execute && results.length) {
    const placed = results.filter((e) => e.executed).length;
    const sent = await notify(buildRunSummary(results, placed));
    const channels = [sent.pulse && 'Pulse', sent.discord && 'Discord'].filter(Boolean).join(' + ');
    console.log(channels ? `\n🔔 Notified: ${channels}.` : '\n🔕 No notification channel reachable.');
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
