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
import type { ResearchReport } from './research/types.js';
import type { Decision } from './decide.js';
import type { Strategy } from './strategy.js';

const DEFAULT_CONFIDENCE = 0.6;
const PULSE_URL = process.env.PULSE_URL || 'http://localhost:31337/notify';

/** Best-effort Pulse notification — never throws (a missing Pulse must not fail an unattended run). */
async function notify(message: string): Promise<boolean> {
  try {
    const res = await fetch(PULSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice_enabled: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
    qty = Math.floor(sizeUsd / strategy.entryPrice);
    if (qty < 1) {
      executionNote = `size $${sizeUsd.toFixed(0)} < 1 share at entry $${strategy.entryPrice} — skipped`;
    } else {
      const res = await placeOrder('buy', ticker, qty, strategy.entryPrice); // LIMIT at ideal entry
      executed = res.ok;
      orderId = res.ok ? res.data.id : null;
      executionNote = res.ok ? `LIMIT buy ${qty} @ $${strategy.entryPrice}` : res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`;
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

  console.log(`The Desk (research swarm) — ${tickers.join(', ')}${args.execute ? ' [EXECUTE]' : ' [dry-run]'}${serial ? ' [serial/free]' : ''}`);
  console.log(ctx.text + '\n');

  const results: DeskDecision[] = [];
  for (const ticker of tickers) {
    try {
      const { name } = await resolveCik(ticker).catch(() => ({ name: ticker }));
      const price = await currentPrice(ticker);
      const reports = await runResearchSwarm(ticker, name, swarmOpts);
      const decision = await decide(ticker, reports, ctx.text, { model: args.model });
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
    const summary = results.map((e) => `${e.ticker} ${e.executionNote}`).join(' · ');
    const pushed = await notify(`🌅 Desk nightly (paper): ${placed} order(s) placed / ${results.length} evaluated. ${summary}`);
    console.log(pushed ? '\n🔔 Pulse notified.' : '\n🔕 Pulse unavailable (notification skipped).');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
