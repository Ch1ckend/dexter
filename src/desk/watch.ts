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

const PULSE_URL = process.env.PULSE_URL || 'http://localhost:31337/notify';

/** Best-effort Pulse notification — never throws (the cycle must not depend on it). */
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

  const pushed = await notify(msg);
  console.log(pushed ? '🔔 Pulse notified.' : '🔕 Pulse unavailable (notification skipped).');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
