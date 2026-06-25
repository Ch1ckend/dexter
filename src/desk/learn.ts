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
import { appendLearning, type LearningRecord } from './learning-log.js';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const etDate = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

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

export interface LearningStats {
  total: number;
  graded: number;
  good: number;
  bad: number;
  neutral: number;
  winRate: number;
  avgReturnPct: number;
  calibrated: boolean;
  confWin: number;
  confLoss: number;
  buy: { g: number; b: number; total: number; wr: number };
  sell: { g: number; b: number; total: number; wr: number };
  topLossBiases: [string, number][];
  methods: string[];
}

/**
 * The single source of truth for what the graded journal teaches: the track-record
 * numbers, the calibration check, the loss-preceding biases, and the derived
 * methods. Both the playbook (latest snapshot) and the learning log (daily history)
 * are rendered from this — so the desk's memory and its recall never disagree.
 */
export function computeLearning(journal: DeskDecision[]): LearningStats {
  const graded = journal.filter((e) => e.grade);
  const good = graded.filter((e) => e.grade === 'good');
  const bad = graded.filter((e) => e.grade === 'bad');
  const neutral = graded.filter((e) => e.grade === 'neutral');
  const decided = good.length + bad.length;
  const winRate = decided ? good.length / decided : 0;
  const avgReturnPct = avg(graded.map((e) => e.returnPct ?? 0));

  const byAction = (action: string) => {
    const g = good.filter((e) => e.action === action).length;
    const b = bad.filter((e) => e.action === action).length;
    return { g, b, total: graded.filter((e) => e.action === action).length, wr: g + b ? g / (g + b) : 0 };
  };
  const buy = byAction('BUY');
  const sell = byAction('SELL');

  const confWin = avg(good.map((e) => e.confidence));
  const confLoss = avg(bad.map((e) => e.confidence));
  const calibrated = confWin > confLoss;

  const lossBiasCounts = new Map<string, number>();
  for (const e of bad) for (const b of biasesOf(e)) lossBiasCounts.set(b, (lossBiasCounts.get(b) ?? 0) + 1);
  const topLossBiases = [...lossBiasCounts.entries()].sort((a, b) => b[1] - a[1]);

  const methods: string[] = [];
  if (decided === 0) {
    // No closed trades yet — stay disciplined but DON'T reflexively HOLD; the point
    // is to build a track record to learn from. Size small, require a clear edge.
    methods.push(
      'No closed trades to learn from yet — require a clear, corroborated edge and size small, but take real positions so a track record can form.',
    );
  } else {
    methods.push(
      decided >= 5
        ? `Overall win rate is ${pct(winRate)} across ${decided} decided trades — ${winRate >= 0.5 ? 'the process is net-positive; keep the discipline' : 'below 50%; raise the bar for new buys and cut losers faster'}.`
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
        : `Confidence is NOT predictive yet (winners avg ${confWin.toFixed(2)} vs losers ${confLoss.toFixed(2)}) — don't upsize on conviction alone.`,
    );
    if (topLossBiases.length) {
      methods.push(
        `Losses were preceded by these flagged biases: ${topLossBiases.map(([b, n]) => `${b} (${n}×)`).join(', ')}. ` +
          `When these show up, cut size or wait.`,
      );
    }
  }

  return {
    total: journal.length,
    graded: graded.length,
    good: good.length,
    bad: bad.length,
    neutral: neutral.length,
    winRate,
    avgReturnPct,
    calibrated,
    confWin,
    confLoss,
    buy,
    sell,
    topLossBiases,
    methods,
  };
}

function buildPlaybook(journal: DeskDecision[], stats: LearningStats): string {
  const now = new Date().toISOString();
  const graded = journal.filter((e) => e.grade);
  const good = graded.filter((e) => e.grade === 'good');
  const bad = graded.filter((e) => e.grade === 'bad');

  if (stats.graded === 0) {
    return `# The Desk — Learned Playbook

_Generated ${now}. No graded decisions yet — grade runs after positions have had time to move._

## Methods (apply these on the next decision)
${stats.methods.map((m) => `- ${m}`).join('\n')}
`;
  }

  const tradeLine = (e: DeskDecision) =>
    `- **${e.ticker}** ${e.action} (conf ${e.confidence.toFixed(2)}, ${e.returnPct != null ? pct(e.returnPct) : 'n/a'} in-favor) — ${e.thesisDigest.slice(0, 160)}`;

  return `# The Desk — Learned Playbook

_Generated ${now} from ${stats.graded} graded decisions (${stats.total} total)._

## Track record
- Record: ${stats.good} good / ${stats.bad} bad / ${stats.neutral} neutral → win rate **${pct(stats.winRate)}**
- Avg in-favor return: ${pct(stats.avgReturnPct)}
- BUY: ${stats.buy.total} (win ${pct(stats.buy.wr)}) · SELL: ${stats.sell.total} (win ${pct(stats.sell.wr)})

## Calibration
- Avg confidence — winners ${stats.confWin.toFixed(2)} vs losers ${stats.confLoss.toFixed(2)} → confidence is ${stats.calibrated ? 'predictive' : 'NOT yet predictive'}.

## What worked
${good.length ? good.slice(0, 8).map(tradeLine).join('\n') : '_none yet_'}

## What failed
${bad.length ? bad.slice(0, 8).map((e) => `${tradeLine(e)}${biasesOf(e).length ? ` [biases: ${biasesOf(e).join(', ')}]` : ''}`).join('\n') : '_none yet_'}

## Methods (apply these on the next decision)
${stats.methods.map((m) => `- ${m}`).join('\n')}
`;
}

export interface LearnSummary {
  total: number;
  graded: number;
  markdown: string;
  record: LearningRecord;
}

/**
 * Distill the graded journal into the playbook (latest snapshot) AND append today's
 * record to the durable learning log (day-by-day memory). Importable; deterministic.
 */
export async function runLearn(): Promise<LearnSummary> {
  const journal = await readJournal();
  const stats = computeLearning(journal);
  const markdown = buildPlaybook(journal, stats);
  await savePlaybook(markdown);

  const record: LearningRecord = {
    date: etDate(),
    generatedAt: new Date().toISOString(),
    total: stats.total,
    graded: stats.graded,
    good: stats.good,
    bad: stats.bad,
    neutral: stats.neutral,
    winRate: stats.winRate,
    avgReturnPct: stats.avgReturnPct,
    methods: stats.methods,
  };
  await appendLearning(record);

  return { total: stats.total, graded: stats.graded, markdown, record };
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
