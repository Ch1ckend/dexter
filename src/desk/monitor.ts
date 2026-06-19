#!/usr/bin/env bun
/**
 * The reconcile monitor — the Desk's open-position safety net.
 *
 * Bracket buys attach protective exits (take-profit + stop-loss) at fill, so the
 * happy path needs no polling. This sweep is the BACKSTOP: it finds any open long
 * that has NO working sell exit — a position opened before brackets, a cancelled
 * leg, or a fill that slipped between runs — and attaches a protective OCO using
 * the target/stop the strategist recorded in the journal.
 *
 * Idempotent: a position that already has an open sell order is left alone, so
 * this is safe to run as often as you like during market hours.
 *
 *   bun run src/desk/monitor.ts
 */
import { positions, orders, protect, clock } from '@/tools/broker/alpaca-exec';
import { readJournal } from './journal.js';
import type { DeskDecision } from './journal.js';
import { notify } from './notify.js';

/** Most recent journaled target/stop for a symbol — the BUY that set it, else any. */
function strategyFor(journal: DeskDecision[], symbol: string): DeskDecision['strategy'] | null {
  const forSym = journal.filter((d) => d.ticker === symbol.toUpperCase() && d.strategy);
  if (forSym.length === 0) return null;
  const buy = [...forSym].reverse().find((d) => d.action === 'BUY');
  return (buy ?? forSym[forSym.length - 1]).strategy ?? null;
}

async function main(): Promise<void> {
  // Self-gate on market hours — the broker only acts on exits while open, and
  // there's no point sweeping off-hours. Fail open: if the clock read fails, proceed.
  const clk = await clock();
  if (clk.ok && !clk.data.is_open) {
    console.log('🛡️ Desk monitor: market closed — skip.');
    return;
  }

  const [posRes, ordRes] = await Promise.all([positions(), orders('open')]);

  if (!posRes.ok) {
    const why = posRes.refused ? posRes.reason : posRes.error;
    console.error(`monitor: cannot read positions — ${why}`);
    process.exit(1);
  }
  const held = posRes.data.filter((p) => Math.floor(Number(p.qty)) >= 1); // longs only
  if (held.length === 0) {
    console.log('🛡️ Desk monitor: flat — nothing to protect.');
    return;
  }

  // A symbol with any OPEN sell order already has a working exit (bracket leg,
  // a prior OCO, or an opportunistic research sell) — don't double-protect it.
  const openOrders = ordRes.ok ? ordRes.data : [];
  const hasExit = new Set(openOrders.filter((o) => o.side === 'sell').map((o) => o.symbol));

  const journal = await readJournal();
  const notes: string[] = [];
  let placed = 0;

  for (const p of held) {
    if (hasExit.has(p.symbol)) {
      notes.push(`${p.symbol} ✓ protected`);
      continue;
    }
    const strat = strategyFor(journal, p.symbol);
    if (!strat) {
      notes.push(`${p.symbol} ⚠ no journaled target/stop — skipped`);
      continue;
    }
    const entry = Number(p.avg_entry_price);
    if (!(strat.targetPrice > entry && strat.stopPrice > 0 && strat.stopPrice < entry)) {
      notes.push(`${p.symbol} ⚠ legs not sane vs entry $${entry.toFixed(2)} — skipped`);
      continue;
    }
    const res = await protect(p.symbol, strat.targetPrice, strat.stopPrice);
    if (res.ok) {
      placed++;
      notes.push(`${p.symbol} 🛡 OCO TP $${strat.targetPrice}/SL $${strat.stopPrice}`);
    } else {
      notes.push(`${p.symbol} ${res.refused ? `REFUSED: ${res.reason}` : `ERROR: ${res.error}`}`);
    }
  }

  const msg = `🛡️ Desk monitor: ${notes.join(' · ')}`;
  console.log(msg);
  // Only ping Discord when something actually needed attention (a protect was
  // attempted) — a sweep that finds everything already protected stays quiet.
  if (placed > 0 || notes.some((n) => n.includes('REFUSED') || n.includes('ERROR'))) {
    await notify(msg);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
