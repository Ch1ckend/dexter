/**
 * The trade journal — the substrate for self-rating and learning.
 *
 * Every committee decision (executed or not, including guardrail-blocked ones) is
 * appended as one JSON line to MEMORY/TRADING/desk-journal.jsonl. The grading pass
 * later annotates entries in place with an outcome grade, and the learning pass
 * distills the graded history into the playbook. Append-only for writes; grading
 * rewrites the whole file (small, human-scale data).
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { JOURNAL_PATH, TRADING_DIR } from './paths.js';

export type DeskAction = 'BUY' | 'SELL' | 'HOLD';
export type Grade = 'good' | 'bad' | 'neutral';

export interface DeskDecision {
  /** Stable id: `${ts}:${ticker}`. */
  id: string;
  ts: string;
  ticker: string;
  action: DeskAction;
  /** Intended dollar size from the judge (0 for HOLD). */
  sizeUsd: number;
  /** Shares actually ordered (computed from sizeUsd / price), if executed. */
  qty?: number;
  /** Judge confidence 0..1. */
  confidence: number;
  /** One crisp sentence summarizing the call (thesis + risk + verdict), for notifications. */
  oneLiner?: string;
  /** The specific findings that most drove the call (grounds the interactive bot). */
  keyDrivers?: string[];
  /** The key risks the desk is accepting (grounds the interactive bot). */
  risks?: string[];
  /** One-paragraph thesis the judge committed to. */
  thesisDigest: string;
  /** Compressed record of the committee debate. */
  debateDigest: string;
  /** Reference price at decision time (for outcome scoring). */
  priceAtDecision: number | null;
  /** Whether an order was actually placed. */
  executed: boolean;
  /** Why not executed, or the refusal reason, or "ok". */
  executionNote: string;
  orderId?: string | null;
  /** Snapshot of the open position in this symbol at decision time (or null). */
  positionSnapshot?: unknown;
  /** Strategist trade plan (entry/target/stop/timeline), when produced. */
  strategy?: {
    entryPrice: number;
    targetPrice: number;
    stopPrice: number;
    horizon: string;
    growthThesis: string;
    expectedReturnPct: number;
  };

  // --- Appended by the grading pass (src/desk/grade.ts) ---
  grade?: Grade;
  gradeReason?: string;
  gradedAt?: string;
  priceAtGrade?: number | null;
  returnPct?: number | null;
  /**
   * True once the position has CLOSED (no longer held) — the grade is then the
   * realized outcome and is locked. While the position is still open the grade is
   * provisional and re-computed every grading pass as the trade matures toward its
   * 6–12 month target. The learning pass forms methods from FINAL grades only.
   */
  gradeFinal?: boolean;
}

export function makeId(ts: string, ticker: string): string {
  return `${ts}:${ticker.toUpperCase()}`;
}

async function ensureDir(): Promise<void> {
  await mkdir(TRADING_DIR, { recursive: true }).catch(() => {});
}

/** Append one decision to the journal (creates the file/dir on first write). */
export async function appendDecision(d: DeskDecision): Promise<void> {
  await ensureDir();
  await appendFile(JOURNAL_PATH, JSON.stringify(d) + '\n', 'utf8');
}

/** Read all journal entries. Tolerates blank/corrupt lines. */
export async function readJournal(): Promise<DeskDecision[]> {
  let text: string;
  try {
    text = await readFile(JOURNAL_PATH, 'utf8');
  } catch {
    return [];
  }
  const out: DeskDecision[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DeskDecision);
    } catch {
      /* skip a malformed line rather than fail the whole read */
    }
  }
  return out;
}

/** Rewrite the entire journal (used by the grading pass to annotate in place). */
export async function overwriteJournal(entries: DeskDecision[]): Promise<void> {
  await ensureDir();
  await mkdir(dirname(JOURNAL_PATH), { recursive: true }).catch(() => {});
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(JOURNAL_PATH, body ? body + '\n' : '', 'utf8');
}
