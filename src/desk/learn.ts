#!/usr/bin/env bun
/**
 * The learning pass — the Desk distills its graded track record into methods.
 *
 *   bun run src/desk/learn.ts
 *
 * Reads the graded journal and writes MEMORY/TRADING/playbook.md: the record, a
 * calibration check, what worked, what failed (with the biases that preceded
 * losses), and a derived "Methods" section of rules the committee applies on the
 * next debate. Deterministic — runs without any LLM key. This closes the loop:
 * the system learns from itself and forms methods from its own outcomes.
 */
import { readJournal, type DeskDecision } from './journal.js';
import { savePlaybook } from './playbook.js';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Pull the biases the Behavioral Guard flagged, parsed from the debate digest. */
export function biasesOf(e: DeskDecision): string[] {
  const m = /biases:\s*([^|]+)/i.exec(e.debateDigest);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || /^none/i.test(raw)) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function buildPlaybook(journal: DeskDecision[]): string {
  const graded = journal.filter((e) => e.grade);
  const good = graded.filter((e) => e.grade === 'good');
  const bad = graded.filter((e) => e.grade === 'bad');
  const neutral = graded.filter((e) => e.grade === 'neutral');
  const now = new Date().toISOString();

  if (graded.length === 0) {
    return `# The Desk — Learned Playbook

_Generated ${now}. No graded decisions yet — run \`grade.ts\` after positions have had time to move._

## Methods
- Insufficient track record. Stay disciplined: default to HOLD, respect guardrail caps, and trust the Behavioral Guard until data accumulates.
`;
  }

  const decided = good.length + bad.length;
  const winRate = decided ? good.length / decided : 0;
  const avgReturn = avg(graded.map((e) => e.returnPct ?? 0));

  // By action
  const byAction = (action: string) => {
    const g = good.filter((e) => e.action === action).length;
    const b = bad.filter((e) => e.action === action).length;
    return { g, b, total: graded.filter((e) => e.action === action).length, wr: g + b ? g / (g + b) : 0 };
  };
  const buy = byAction('BUY');
  const sell = byAction('SELL');

  // Calibration
  const confWin = avg(good.map((e) => e.confidence));
  const confLoss = avg(bad.map((e) => e.confidence));
  const calibrated = confWin > confLoss;

  // Biases that preceded losses
  const lossBiasCounts = new Map<string, number>();
  for (const e of bad) for (const b of biasesOf(e)) lossBiasCounts.set(b, (lossBiasCounts.get(b) ?? 0) + 1);
  const topLossBiases = [...lossBiasCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Derived methods
  const methods: string[] = [];
  methods.push(
    decided >= 5
      ? `Overall win rate is ${pct(winRate)} across ${decided} decided trades — ${winRate >= 0.5 ? 'the process is net-positive; keep the discipline' : 'below 50%; tighten the confidence gate and prefer HOLD'}.`
      : `Only ${decided} decided trades so far — treat all conclusions as provisional and size small.`,
  );
  if (buy.g + buy.b >= 3) {
    methods.push(`BUY decisions win ${pct(buy.wr)} of the time${buy.wr < 0.4 ? ' — be more selective on the long side' : ''}.`);
  }
  if (sell.g + sell.b >= 3) {
    methods.push(`SELL/trim decisions win ${pct(sell.wr)} of the time.`);
  }
  methods.push(
    calibrated
      ? `Confidence is predictive (winners avg ${confWin.toFixed(2)} vs losers ${confLoss.toFixed(2)}) — trust higher-confidence calls and raise size with confidence.`
      : `Confidence is NOT predictive yet (winners avg ${confWin.toFixed(2)} vs losers ${confLoss.toFixed(2)}) — the committee is over/under-confident; widen the confidence gate and don't upsize on conviction alone.`,
  );
  if (topLossBiases.length) {
    methods.push(
      `Losses were preceded by these flagged biases: ${topLossBiases.map(([b, n]) => `${b} (${n}×)`).join(', ')}. ` +
        `When the Behavioral Guard flags these, cut size or wait.`,
    );
  }

  const tradeLine = (e: DeskDecision) =>
    `- **${e.ticker}** ${e.action} (conf ${e.confidence.toFixed(2)}, ${e.returnPct != null ? pct(e.returnPct) : 'n/a'} in-favor) — ${e.thesisDigest.slice(0, 160)}`;

  return `# The Desk — Learned Playbook

_Generated ${now} from ${graded.length} graded decisions (${journal.length} total)._

## Track record
- Record: ${good.length} good / ${bad.length} bad / ${neutral.length} neutral → win rate **${pct(winRate)}**
- Avg in-favor return: ${pct(avgReturn)}
- BUY: ${buy.total} (win ${pct(buy.wr)}) · SELL: ${sell.total} (win ${pct(sell.wr)})

## Calibration
- Avg confidence — winners ${confWin.toFixed(2)} vs losers ${confLoss.toFixed(2)} → confidence is ${calibrated ? 'predictive' : 'NOT yet predictive'}.

## What worked
${good.length ? good.slice(0, 8).map(tradeLine).join('\n') : '_none yet_'}

## What failed
${bad.length ? bad.slice(0, 8).map((e) => `${tradeLine(e)}${biasesOf(e).length ? ` [biases: ${biasesOf(e).join(', ')}]` : ''}`).join('\n') : '_none yet_'}

## Methods (apply these on the next debate)
${methods.map((m) => `- ${m}`).join('\n')}
`;
}

export interface LearnSummary {
  total: number;
  graded: number;
  markdown: string;
}

/** Distill the graded journal into the playbook and persist it. Importable. */
export async function runLearn(): Promise<LearnSummary> {
  const journal = await readJournal();
  const markdown = buildPlaybook(journal);
  await savePlaybook(markdown);
  return { total: journal.length, graded: journal.filter((e) => e.grade).length, markdown };
}

async function main(): Promise<void> {
  const { graded, total, markdown } = await runLearn();
  console.log(`Playbook written from ${graded} graded / ${total} total decisions.`);
  console.log('\n' + markdown);
}

if ((import.meta as unknown as { main: boolean }).main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
