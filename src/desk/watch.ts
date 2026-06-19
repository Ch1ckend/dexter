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
import { runGrade } from './grade.js';
import { runLearn } from './learn.js';
import { notify } from './notify.js';

async function portfolioSummary(): Promise<string> {
  const [a, p] = await Promise.all([account(), positions()]);
  const eq = a.ok ? `$${a.data.equity}` : 'n/a';
  const pos =
    p.ok && p.data.length
      ? p.data.map((x) => `${x.symbol} ${x.qty}@$${x.avg_entry_price} (uPL ${x.unrealized_pl})`).join(', ')
      : 'flat';
  return `equity ${eq}; positions: ${pos}`;
}

async function main(): Promise<void> {
  const doLearn = process.argv.includes('--learn');

  const summary = await portfolioSummary();
  const g = await runGrade({ minAgeHours: 0, regrade: false });

  let learnNote = '';
  if (doLearn) {
    const l = await runLearn();
    learnNote = ` Playbook re-distilled (${l.graded} graded).`;
  }

  const msg = `📈 The Desk (paper) — ${summary}. Graded ${g.graded}/${g.total} decisions.${learnNote}`;
  console.log(msg);
  for (const line of g.lines) console.log('  ' + line);

  const sent = await notify(msg);
  const channels = [sent.pulse && 'Pulse', sent.discord && 'Discord'].filter(Boolean).join(' + ');
  console.log(channels ? `🔔 Notified: ${channels}.` : '🔕 No notification channel reachable.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
