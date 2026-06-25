/**
 * The learning log — the Desk's durable, day-by-day memory of what it learned.
 *
 * The playbook (playbook.md) is always the LATEST distilled snapshot; this log is
 * the history behind it: one JSON line per learning pass, stamped with the ET
 * trading day, the track-record numbers, and the methods in force that day. It is
 * what lets the desk RECALL what it learned on a given day ("what did you learn
 * today?") rather than only knowing its current state. Append-only; deterministic.
 */
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { LEARNING_LOG_PATH, TRADING_DIR } from './paths.js';

export interface LearningRecord {
  /** ET calendar day the pass ran (YYYY-MM-DD) — the key the bot recalls by. */
  date: string;
  /** Full ISO timestamp of the pass. */
  generatedAt: string;
  total: number;
  /** Closed (final) trades the record is built from. */
  graded: number;
  /** Trades still open and maturing (provisional, not in the win rate). */
  open: number;
  good: number;
  bad: number;
  neutral: number;
  /** Win rate over decided (good+bad) trades, 0..1. */
  winRate: number;
  /** Average in-favor return across graded decisions, 0..1. */
  avgReturnPct: number;
  /** The methods/lessons in force after this pass. */
  methods: string[];
}

/** Append one learning record. De-dupes by date: the last pass of a day wins. */
export async function appendLearning(rec: LearningRecord): Promise<void> {
  await mkdir(TRADING_DIR, { recursive: true }).catch(() => {});
  await appendFile(LEARNING_LOG_PATH, JSON.stringify(rec) + '\n', 'utf8');
}

/** Read every learning record (tolerates blank/corrupt lines). */
export async function readLearningLog(): Promise<LearningRecord[]> {
  let text: string;
  try {
    text = await readFile(LEARNING_LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const out: LearningRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LearningRecord);
    } catch {
      /* skip a malformed line rather than fail the whole read */
    }
  }
  return out;
}

/**
 * The most recent learning record per ET day, newest first, capped at `n`. One
 * day can have several passes (daily grade + Friday re-distill); we keep the last.
 */
export function recentLearning(records: LearningRecord[], n = 7): LearningRecord[] {
  const byDay = new Map<string, LearningRecord>();
  for (const r of records) byDay.set(r.date, r); // later line for a day overwrites
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
}

/** Render recent learning as a grounding block for the interactive bot. */
export function renderLearning(records: LearningRecord[]): string {
  if (!records.length) return 'The desk has no learning recorded yet.';
  return records
    .map((r) => {
      const head = `${r.date}: ${r.graded} closed (${r.open ?? 0} open) · ${r.good}W/${r.bad}L/${r.neutral}N · win rate ${(r.winRate * 100).toFixed(0)}% · avg in-favor ${(r.avgReturnPct * 100).toFixed(1)}%`;
      const methods = r.methods.length ? r.methods.map((m) => `  - ${m}`).join('\n') : '  - (no methods distilled)';
      return `${head}\n${methods}`;
    })
    .join('\n\n');
}
