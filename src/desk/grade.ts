#!/usr/bin/env bun
/**
 * The grading pass — the Desk scores its own past decisions against outcome.
 *
 *   bun run src/desk/grade.ts [--min-age-hours N] [--regrade]
 *
 * For every journaled BUY/SELL decision that has a reference price, compare it to
 * the current market price and assign good / bad / neutral with a one-line reason
 * and the realized in-favor return. Deterministic (no LLM needed) — it uses the
 * Alpaca quote feed only. The annotated journal is what the learning pass distills.
 */
import { quote, positions } from '@/tools/broker/alpaca-exec';
import { readJournal, overwriteJournal, type DeskDecision, type Grade, type Checkpoint } from './journal.js';

/**
 * Fixed learning horizons (calendar days after entry). Short ones are leading
 * diagnostics; 'close' is the verdict. Decoupled from the 6–12 month HOLDING
 * horizon on purpose: we measure fast without trading fast.
 */
export const CHECKPOINT_HORIZONS: { key: string; days: number }[] = [
  { key: 'd5', days: 5 },
  { key: 'd20', days: 20 },
  { key: 'd60', days: 60 },
];

/**
 * Pure: capture any horizon checkpoints whose window has elapsed and aren't yet
 * recorded. Captured once each (first pass after the horizon), so the mark is the
 * price ~N days after entry. Returns the (possibly extended) checkpoint map.
 */
export function dueCheckpoints(
  ageDays: number,
  existing: Record<string, Checkpoint> | undefined,
  action: DeskDecision['action'],
  priceAtDecision: number,
  current: number,
  capturedAt: string,
  closed = false,
): Record<string, Checkpoint> {
  const out: Record<string, Checkpoint> = { ...(existing ?? {}) };
  const mark = (): Checkpoint => {
    const { grade, signed } = scoreDecision(action, priceAtDecision, current);
    return { ageDays: Math.round(ageDays), price: current, returnPct: signed, grade, capturedAt };
  };
  for (const h of CHECKPOINT_HORIZONS) {
    if (ageDays >= h.days && !out[h.key]) out[h.key] = mark();
  }
  // The realized verdict at close, captured once.
  if (closed && !out.close) out.close = mark();
  return out;
}

/** Whether the desk currently holds each symbol — used to tell open trades from closed. */
interface HeldState {
  /** False if the positions fetch failed — then we must NOT finalize anything. */
  known: boolean;
  symbols: Set<string>;
}

const GOOD_THRESHOLD = 0.03; // +3% in favor → good
const BAD_THRESHOLD = -0.03; // -3% against → bad

/**
 * Pure outcome scorer (credential-free, unit-testable — mirrors the _ALPACA
 * pure-guardrail pattern). `signed` is the return measured IN FAVOR of the
 * decision: for a SELL, a subsequent price rise counts against us.
 */
export function scoreDecision(
  action: DeskDecision['action'],
  priceAtDecision: number,
  current: number,
): { grade: Grade; signed: number; reason: string } {
  const raw = (current - priceAtDecision) / priceAtDecision;
  const signed = action === 'SELL' ? -raw : raw;
  const grade: Grade = signed > GOOD_THRESHOLD ? 'good' : signed < BAD_THRESHOLD ? 'bad' : 'neutral';
  const reason = `${action} @ $${priceAtDecision.toFixed(2)} → $${current.toFixed(2)} (${(raw * 100).toFixed(1)}% move, ${(signed * 100).toFixed(1)}% in-favor)`;
  return { grade, signed, reason };
}

interface GradeArgs {
  minAgeHours: number;
  regrade: boolean;
}

function parseArgs(argv: string[]): GradeArgs {
  let minAgeHours = 0;
  let regrade = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-age-hours') minAgeHours = Number(argv[++i]);
    else if (argv[i] === '--regrade') regrade = true;
  }
  return { minAgeHours, regrade };
}

/** Mid/last current price for a symbol, or null. */
async function currentPrice(ticker: string): Promise<number | null> {
  const q = await quote(ticker);
  if (!q.ok) return null;
  const mid = q.data.bid && q.data.ask ? (q.data.bid + q.data.ask) / 2 : undefined;
  const p = q.data.last ?? mid ?? q.data.ask ?? q.data.bid;
  return p != null && isFinite(p) && p > 0 ? p : null;
}

function ageHours(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 3_600_000;
}

/**
 * Grade a single entry, returning the annotated copy (or the original if skipped).
 *
 * Only EXECUTED trades are scoreable (a HOLD or an unfilled signal is not a trade).
 * An open trade is re-graded every pass — its grade is provisional and tracks the
 * position as it matures. Once the position has CLOSED (no longer held) the grade
 * is the realized outcome and is locked (`gradeFinal`), so the long 6–12 month
 * horizon is judged on how the trade actually turned out, not on day-one noise.
 */
async function gradeEntry(
  e: DeskDecision,
  args: GradeArgs,
  held: HeldState,
): Promise<{ entry: DeskDecision; graded: boolean; note: string }> {
  if (!e.executed || e.priceAtDecision == null) {
    return { entry: e, graded: false, note: 'not a placed trade — skipped' };
  }
  if (e.gradeFinal && !args.regrade) return { entry: e, graded: false, note: 'final (position closed)' };
  if (ageHours(e.ts) < args.minAgeHours) return { entry: e, graded: false, note: 'too recent' };

  const now = await currentPrice(e.ticker);
  if (now == null) return { entry: e, graded: false, note: 'no current price' };

  const { grade, signed, reason } = scoreDecision(e.action, e.priceAtDecision, now);
  // Closed only when we positively know positions AND this symbol is absent — a
  // failed positions fetch must never finalize an open trade at a stale price.
  const closed = held.known && !held.symbols.has(e.ticker.toUpperCase());

  const capturedAt = new Date().toISOString();
  const checkpoints = dueCheckpoints(ageHours(e.ts) / 24, e.checkpoints, e.action, e.priceAtDecision, now, capturedAt, closed);
  const newMarks = Object.keys(checkpoints).filter((k) => !e.checkpoints?.[k]);

  return {
    entry: { ...e, grade, gradeReason: reason, gradedAt: capturedAt, priceAtGrade: now, returnPct: signed, gradeFinal: closed, checkpoints },
    graded: true,
    note: `${closed ? 'FINAL' : 'open'} ${grade}: ${reason}${newMarks.length ? ` [+${newMarks.join(',')}]` : ''}`,
  };
}

export interface GradeSummary {
  total: number;
  graded: number;
  lines: string[];
}

/** Grade all eligible journal entries and persist annotations. Importable. */
export async function runGrade(args: GradeArgs = { minAgeHours: 0, regrade: false }): Promise<GradeSummary> {
  const journal = await readJournal();
  const lines: string[] = [];
  if (journal.length === 0) return { total: 0, graded: 0, lines };

  // Snapshot current holdings ONCE so we can tell open trades from closed ones.
  const p = await positions();
  const held: HeldState = {
    known: p.ok,
    symbols: new Set(p.ok ? p.data.map((x) => String(x.symbol).toUpperCase()) : []),
  };

  const updated: DeskDecision[] = [];
  let gradedCount = 0;
  for (const e of journal) {
    const { entry, graded, note } = await gradeEntry(e, args, held);
    updated.push(entry);
    if (graded) gradedCount++;
    lines.push(`${e.ticker} ${e.ts}: ${note}`);
  }
  await overwriteJournal(updated);
  return { total: journal.length, graded: gradedCount, lines };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runGrade(args);
  if (summary.total === 0) {
    console.log('Journal is empty — nothing to grade.');
    return;
  }
  for (const l of summary.lines) console.log(l);
  console.log(`\nGraded ${summary.graded} of ${summary.total} entries.`);
}

if ((import.meta as unknown as { main: boolean }).main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
