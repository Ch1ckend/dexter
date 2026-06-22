#!/usr/bin/env bun
/**
 * The watcher — the Desk's scheduled heartbeat.
 *
 *   bun run src/desk/watch.ts            # daily: grade open decisions + portfolio summary + notify
 *   bun run src/desk/watch.ts --learn    # also re-distill the playbook (run weekly)
 *
 * Designed to be driven by cron (see Workflows/Watcher.md). The core cycle —
 * grade past decisions, summarize the paper portfolio, and push a Pulse
 * notification — needs no LLM key. Fresh committee evaluations are run separately
 * via run.ts (they need research + model credentials).
 */
import { account, positions } from '@/tools/broker/alpaca-exec';
import { runGrade, type GradeSummary } from './grade.js';
import { runLearn } from './learn.js';
import { notify } from './notify.js';
import { readJournal } from './journal.js';

const etDate = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * Compose the after-close review as a readable paragraph for Discord/Pulse:
 * what the desk decided today, the state of the book, what was graded, the
 * (Friday) learning pass, and what's expected next. Deterministic — no LLM.
 */
function buildReviewParagraph(opts: {
  equity: string;
  cash: string;
  positionsText: string;
  hasPositions: boolean;
  today: DeskDecisionLite[];
  grade: GradeSummary;
  learnNote: string;
}): string {
  const { equity, cash, positionsText, hasPositions, today, grade, learnNote } = opts;
  const buys = today.filter((d) => d.action === 'BUY').map((d) => d.ticker);
  const sells = today.filter((d) => d.action === 'SELL').map((d) => d.ticker);
  const holds = today.filter((d) => d.action === 'HOLD').length;

  const stance =
    today.length === 0
      ? `No research decisions were logged today.`
      : buys.length || sells.length
        ? `Today the desk reviewed ${today.length} names — ${buys.length} BUY${buys.length ? ` (${buys.join(', ')})` : ''}, ${holds} HOLD, ${sells.length} SELL${sells.length ? ` (${sells.join(', ')})` : ''}.`
        : `Today the desk reviewed all ${today.length} names and the call was HOLD across the board — no orders went out.`;

  const book = hasPositions
    ? `The book holds ${positionsText}; equity ${equity}, cash ${cash}.`
    : `The book is still 100% cash — equity ${equity}, nothing at risk.`;

  const graded =
    grade.graded > 0
      ? `Graded ${grade.graded}/${grade.total} past trades against current prices.`
      : `With no executed BUY/SELL trades to score, there was nothing to grade (${grade.graded}/${grade.total}).`;

  const forward = `The desk only acts above its 0.70 conviction bar, so cash-and-patient is the expected state until a setup clears it. Next research run: 08:30 ET.`;

  return [
    `📈 The Desk — Daily Review · ${etDate()} (after close)`,
    '',
    `${stance} ${book} ${graded}${learnNote} ${forward}`,
  ].join('\n');
}

type DeskDecisionLite = { ts: string; ticker: string; action: string };

async function main(): Promise<void> {
  const doLearn = process.argv.includes('--learn');

  const [a, p] = await Promise.all([account(), positions()]);
  const equity = a.ok ? `$${a.data.equity}` : 'n/a';
  const cash = a.ok ? `$${a.data.cash}` : 'n/a';
  const hasPositions = p.ok && p.data.length > 0;
  const positionsText = hasPositions
    ? p.data.map((x) => `${x.symbol} ${x.qty}@$${x.avg_entry_price} (uPL ${x.unrealized_pl})`).join(', ')
    : 'flat';

  // Today's decisions, by ET calendar day, for the stance sentence.
  const today = etDate();
  const journal = await readJournal().catch(() => []);
  const todays: DeskDecisionLite[] = journal.filter(
    (d) => new Date(d.ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today,
  );

  const g = await runGrade({ minAgeHours: 0, regrade: false });

  let learnNote = '';
  if (doLearn) {
    const l = await runLearn();
    learnNote =
      l.graded > 0
        ? ` Playbook re-distilled from ${l.graded} graded trades.`
        : ` Weekly playbook pass ran, but with no closed trades there's nothing new to distill yet.`;
  }

  const msg = buildReviewParagraph({ equity, cash, positionsText, hasPositions, today: todays, grade: g, learnNote });
  console.log(msg);
  for (const line of g.lines) console.log('  ' + line);

  const sent = await notify(msg);
  const channels = [sent.pulse && 'Pulse', sent.discord && 'Discord'].filter(Boolean).join(' + ');
  console.log(channels ? `\n🔔 Notified: ${channels}.` : '\n🔕 No notification channel reachable.');
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
