#!/usr/bin/env bun
/**
 * The Desk — orchestrator entry point.
 *
 *   bun run src/desk/run.ts <TICKER...> [flags]
 *   bun run src/desk/run.ts --watchlist
 *
 * Flags:
 *   --dry-run            Research + debate + decide, but place NO orders.
 *   --watchlist          Evaluate every symbol on the Alpaca allowlist.
 *   --confidence <0..1>  Min judge confidence to act (default 0.6).
 *   --model <name>       Model for judge + analysts (default: library default).
 *   --analyst-model <n>  Override analyst model only.
 *
 * Per ticker: build dossier → run committee debate → gate on action/confidence →
 * execute on paper (guardrailed) → journal the decision.
 */
import { buildDossier, renderDossier } from './dossier.js';
import { runDebate, summarizeDebate, type DebateResult } from './debate.js';
import { account, guardrails, quote, placeOrder, positionFor } from '@/tools/broker/alpaca-exec';
import { appendDecision, makeId, type DeskDecision, type DeskAction } from './journal.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

interface CliArgs {
  tickers: string[];
  dryRun: boolean;
  watchlist: boolean;
  confidence: number;
  model?: string;
  analystModel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const tickers: string[] = [];
  let dryRun = false;
  let watchlist = false;
  let confidence = DEFAULT_CONFIDENCE_THRESHOLD;
  let model: string | undefined;
  let analystModel: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--watchlist') watchlist = true;
    else if (a === '--confidence') confidence = Number(argv[++i]);
    else if (a === '--model') model = argv[++i];
    else if (a === '--analyst-model') analystModel = argv[++i];
    else if (!a.startsWith('-')) tickers.push(a.toUpperCase());
  }
  return { tickers, dryRun, watchlist, confidence, model, analystModel };
}

/** Build the account + guardrail context string the committee reasons against. */
async function buildAccountContext(): Promise<{ text: string; allowlist: string[]; equity: number }> {
  // Sequential, not parallel — concurrent CLI spawns can transiently fail one.
  const acct = await account();
  const g = await guardrails();
  const allowlist = g.ok ? g.data.allowlist : [];
  const equity = acct.ok ? Number(acct.data.equity) : 0;
  const lines: string[] = [];
  if (acct.ok) {
    lines.push(
      `Account (PAPER): equity $${acct.data.equity}, buying power $${acct.data.buying_power}, cash $${acct.data.cash}.`,
    );
  } else {
    lines.push('Account: unavailable.');
  }
  if (g.ok) {
    lines.push(
      `HARD GUARDRAILS (paper): allowlist [${g.data.allowlist.join(', ')}]; ` +
        `max per-symbol position $${g.data.max_position_notional}; ` +
        `max total exposure $${g.data.max_total_notional}; ` +
        `max ${g.data.max_daily_orders} orders/day; ` +
        `shorting ${g.data.allow_short ? 'allowed' : 'NOT allowed'}. ` +
        `Only allowlisted symbols can be traded; anything else is refused.`,
    );
  }
  return { text: lines.join('\n'), allowlist, equity };
}

/** Reference price for sizing: ask on a buy, bid on a sell, last as fallback. */
async function refPrice(ticker: string, side: 'buy' | 'sell'): Promise<number | null> {
  const q = await quote(ticker);
  if (!q.ok) return null;
  const p = side === 'buy' ? q.data.ask : q.data.bid;
  const chosen = p ?? q.data.last;
  return chosen && isFinite(chosen) && chosen > 0 ? chosen : null;
}

function printReport(dossierText: string, r: DebateResult): void {
  const d = r.decision;
  console.log('\n' + '='.repeat(72));
  console.log(`THE DESK — ${r.ticker}`);
  console.log('='.repeat(72));
  console.log(dossierText);
  console.log('\n--- COMMITTEE ---');
  console.log(`🐂 Bull:    ${r.bull.stance}`);
  console.log(`🐻 Bear:    ${r.bear.stance}`);
  console.log(`🔍 Skeptic: ${r.skeptic.stance}`);
  console.log(`⚖️  Risk:    ${r.risk.stance}`);
  console.log(
    `🧠 Behavioral: ${r.behavioral.netEmotionalPressure} pressure | biases: ` +
      (r.behavioral.biasesDetected.length
        ? r.behavioral.biasesDetected.map((b) => `${b.bias}(${b.severity})`).join(', ')
        : 'none'),
  );
  console.log('\n--- DECISION ---');
  console.log(`Action: ${d.action}   Size: $${d.sizeUsd}   Confidence: ${d.confidence}`);
  console.log(`Rationale: ${d.rationale}`);
  if (d.risks.length) console.log(`Risks: ${d.risks.join('; ')}`);
}

/** Apply the decision: gate, size, execute (unless dry-run), and journal. */
async function executeAndJournal(
  r: DebateResult,
  threshold: number,
  dryRun: boolean,
): Promise<DeskDecision> {
  const d = r.decision;
  const ts = new Date().toISOString();
  const side: 'buy' | 'sell' | null = d.action === 'BUY' ? 'buy' : d.action === 'SELL' ? 'sell' : null;
  const price = side ? await refPrice(r.ticker, side) : null;
  const pos = await positionFor(r.ticker);

  let executed = false;
  let executionNote = '';
  let orderId: string | null = null;
  let qty: number | undefined;

  const base: DeskDecision = {
    id: makeId(ts, r.ticker),
    ts,
    ticker: r.ticker,
    action: d.action as DeskAction,
    sizeUsd: d.sizeUsd,
    confidence: d.confidence,
    thesisDigest: d.rationale,
    debateDigest: summarizeDebate(r),
    priceAtDecision: price,
    executed: false,
    executionNote: '',
    orderId: null,
    positionSnapshot: pos,
  };

  if (d.action === 'HOLD') {
    executionNote = 'HOLD — no order';
  } else if (d.confidence < threshold) {
    executionNote = `below confidence threshold (${d.confidence} < ${threshold})`;
  } else if (dryRun) {
    executionNote = 'dry-run — order suppressed';
  } else if (price === null) {
    executionNote = 'no reference price — skipped';
  } else if (side === 'buy') {
    qty = Math.floor(d.sizeUsd / price);
    if (qty < 1) {
      executionNote = `size $${d.sizeUsd} < 1 share at $${price} — skipped`;
    } else {
      const res = await placeOrder('buy', r.ticker, qty);
      if (res.ok) {
        executed = true;
        orderId = res.data.id;
        executionNote = `bought ${qty} @ ~$${price}`;
      } else {
        executionNote = res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`;
      }
    }
  } else if (side === 'sell') {
    const heldQty = pos ? Math.floor(Number(pos.qty)) : 0;
    if (heldQty < 1) {
      executionNote = 'no long position to sell (no shorting) — skipped';
    } else {
      qty = Math.min(heldQty, Math.max(1, Math.floor(d.sizeUsd / price)));
      const res = await placeOrder('sell', r.ticker, qty);
      if (res.ok) {
        executed = true;
        orderId = res.data.id;
        executionNote = `sold ${qty} @ ~$${price}`;
      } else {
        executionNote = res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`;
      }
    }
  }

  const entry: DeskDecision = { ...base, executed, executionNote, orderId, qty };
  await appendDecision(entry);
  return entry;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await buildAccountContext();

  let tickers = args.tickers;
  if (args.watchlist) tickers = ctx.allowlist;
  if (tickers.length === 0) {
    console.error('usage: bun run src/desk/run.ts <TICKER...> [--dry-run] [--watchlist] [--confidence 0.6]');
    process.exit(1);
  }

  // Free OpenRouter models 429 on parallel bursts — run the committee serially for them.
  const serial = [args.model, args.analystModel].some((m) => (m ?? '').includes(':free'));

  console.log(`The Desk — evaluating ${tickers.join(', ')}${args.dryRun ? ' (dry-run)' : ''}${serial ? ' [serial/free-tier]' : ''}`);
  console.log(ctx.text + '\n');

  for (const ticker of tickers) {
    try {
      const dossier = await buildDossier(ticker);
      const result = await runDebate(dossier, {
        judgeModel: args.model,
        analystModel: args.analystModel ?? args.model,
        accountContext: ctx.text,
        serial,
      });
      printReport(renderDossier(dossier), result);
      const entry = await executeAndJournal(result, args.confidence, args.dryRun);
      console.log(`\n📓 Journaled: ${entry.executionNote}${entry.orderId ? ` (order ${entry.orderId})` : ''}`);
    } catch (e) {
      console.error(`\n[${ticker}] failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
