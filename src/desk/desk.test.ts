/**
 * Unit tests for the Desk's deterministic core — the outcome scorer and the
 * behavioral-bias parser. These hold the financial logic that must stay correct
 * independent of any LLM or network.
 */
import { describe, it, expect } from 'bun:test';
import { scoreDecision, dueCheckpoints } from './grade.js';
import { biasesOf, computeLearning, horizonStats } from './learn.js';
import { buyLimitPrice } from './research-run.js';
import { isLearningQuestion } from './ask.js';
import { recentLearning, type LearningRecord } from './learning-log.js';
import type { DeskDecision, Checkpoint } from './journal.js';

describe('scoreDecision', () => {
  it('grades a BUY that rose as good', () => {
    const r = scoreDecision('BUY', 100, 110);
    expect(r.grade).toBe('good');
    expect(r.signed).toBeCloseTo(0.1, 5);
  });

  it('grades a BUY that fell as bad', () => {
    const r = scoreDecision('BUY', 100, 90);
    expect(r.grade).toBe('bad');
    expect(r.signed).toBeCloseTo(-0.1, 5);
  });

  it('flips sign for a SELL — a subsequent rise counts AGAINST the sell', () => {
    const r = scoreDecision('SELL', 100, 110);
    expect(r.grade).toBe('bad');
    expect(r.signed).toBeCloseTo(-0.1, 5);
  });

  it('rewards a SELL that dodged a drop', () => {
    const r = scoreDecision('SELL', 100, 90);
    expect(r.grade).toBe('good');
    expect(r.signed).toBeCloseTo(0.1, 5);
  });

  it('treats a sub-threshold move as neutral', () => {
    expect(scoreDecision('BUY', 100, 101).grade).toBe('neutral'); // +1% < 3%
  });
});

describe('biasesOf', () => {
  const mk = (debateDigest: string): DeskDecision => ({
    id: 'x',
    ts: '2026-01-01T00:00:00.000Z',
    ticker: 'AAPL',
    action: 'BUY',
    sizeUsd: 0,
    confidence: 0.5,
    thesisDigest: '',
    debateDigest,
    priceAtDecision: null,
    executed: false,
    executionNote: '',
  });

  it('parses flagged biases out of the debate digest', () => {
    const biases = biasesOf(mk('Bull: x | Behavioral: buy-side pressure; biases: Overconfidence(high), FOMO(medium)'));
    expect(biases).toEqual(['Overconfidence(high)', 'FOMO(medium)']);
  });

  it('returns an empty list when none were flagged', () => {
    expect(biasesOf(mk('Behavioral: neutral pressure; biases: none'))).toEqual([]);
  });
});

describe('buyLimitPrice (marketable fill)', () => {
  it('lifts a below-market ideal entry to the current price so the order fills', () => {
    expect(buyLimitPrice(78, 80)).toBe(80);
  });
  it('honors an ideal entry at/above the current price', () => {
    expect(buyLimitPrice(82, 80)).toBe(82);
  });
  it('falls back to the ideal entry when there is no live price', () => {
    expect(buyLimitPrice(78, null)).toBe(78);
    expect(buyLimitPrice(78, 0)).toBe(78);
  });
  it('rounds a sub-penny price UP to a whole cent (Alpaca rejects sub-penny limits)', () => {
    expect(buyLimitPrice(0, 192.745)).toBe(192.75);
    expect(buyLimitPrice(192.741, null)).toBe(192.75);
  });
});

describe('isLearningQuestion', () => {
  it('matches questions about what the desk learned', () => {
    expect(isLearningQuestion('what did you learn today?')).toBe(true);
    expect(isLearningQuestion('how are we doing on the playbook?')).toBe(true);
    expect(isLearningQuestion("what's our win rate?")).toBe(true);
  });
  it('does not match a normal per-name question', () => {
    expect(isLearningQuestion('why are we holding KO?')).toBe(false);
    expect(isLearningQuestion("what's the risk on NVDA?")).toBe(false);
  });
});

describe('computeLearning', () => {
  const mk = (over: Partial<DeskDecision>): DeskDecision => ({
    id: 'x', ts: '2026-01-01T00:00:00.000Z', ticker: 'AAPL', action: 'BUY', sizeUsd: 0,
    confidence: 0.7, thesisDigest: '', debateDigest: '', priceAtDecision: 100,
    executed: true, executionNote: '', ...over,
  });

  it('reports zero closed trades and a build-a-record method on an all-HOLD journal', () => {
    const s = computeLearning([mk({ action: 'HOLD', executed: false, grade: undefined })]);
    expect(s.graded).toBe(0);
    expect(s.methods.join(' ')).toMatch(/track record|size small|real positions/i);
  });

  it('does NOT count an OPEN trade in the win rate — it only tracks it', () => {
    const s = computeLearning([mk({ grade: 'good', returnPct: 0.1, gradeFinal: false })]);
    expect(s.graded).toBe(0); // no closed trades
    expect(s.open).toBe(1);
    expect(s.methods.join(' ')).toMatch(/open|maturing/i);
  });

  it('builds win rate and calibration from CLOSED (final) trades only', () => {
    const s = computeLearning([
      mk({ grade: 'good', confidence: 0.8, returnPct: 0.1, gradeFinal: true }),
      mk({ grade: 'bad', confidence: 0.6, returnPct: -0.1, gradeFinal: true }),
      mk({ grade: 'good', confidence: 0.9, returnPct: 0.2, gradeFinal: false }), // open — ignored
    ]);
    expect(s.graded).toBe(2);
    expect(s.open).toBe(1);
    expect(s.winRate).toBeCloseTo(0.5, 5);
    expect(s.calibrated).toBe(true); // winners (0.8) more confident than losers (0.6)
  });
});

describe('dueCheckpoints (multi-horizon marks)', () => {
  const at = '2026-01-10T00:00:00.000Z';

  it('captures no checkpoint before the first horizon elapses', () => {
    const cps = dueCheckpoints(2, undefined, 'BUY', 100, 105, at);
    expect(Object.keys(cps)).toEqual([]);
  });

  it('captures d5 once 5 days have passed, with the in-favor return', () => {
    const cps = dueCheckpoints(6, undefined, 'BUY', 100, 110, at);
    expect(cps.d5).toBeDefined();
    expect(cps.d5.grade).toBe('good');
    expect(cps.d5.returnPct).toBeCloseTo(0.1, 5);
    expect(cps.d20).toBeUndefined();
  });

  it('does not overwrite an existing checkpoint (captured once)', () => {
    const existing: Record<string, Checkpoint> = {
      d5: { ageDays: 5, price: 110, returnPct: 0.1, grade: 'good', capturedAt: at },
    };
    const cps = dueCheckpoints(25, existing, 'BUY', 100, 90, at);
    expect(cps.d5.price).toBe(110); // untouched
    expect(cps.d20).toBeDefined(); // newly due
    expect(cps.d20.grade).toBe('bad');
  });

  it('captures a close mark when the position has closed', () => {
    const cps = dueCheckpoints(40, undefined, 'BUY', 100, 130, at, true);
    expect(cps.close).toBeDefined();
    expect(cps.close.grade).toBe('good');
  });
});

describe('horizonStats', () => {
  const mk = (cp: Record<string, Checkpoint>): DeskDecision => ({
    id: 'x', ts: '2026-01-01T00:00:00.000Z', ticker: 'AAPL', action: 'BUY', sizeUsd: 0,
    confidence: 0.7, thesisDigest: '', debateDigest: '', priceAtDecision: 100,
    executed: true, executionNote: '', checkpoints: cp,
  });
  const cp = (grade: 'good' | 'bad' | 'neutral', r: number): Checkpoint => ({ ageDays: 20, price: 0, returnPct: r, grade, capturedAt: 'x' });

  it('aggregates win rate and avg return at a horizon across trades', () => {
    const s = horizonStats(
      [mk({ d20: cp('good', 0.1) }), mk({ d20: cp('bad', -0.05) }), mk({ d20: cp('neutral', 0.01) })],
      'd20',
    );
    expect(s.n).toBe(3);
    expect(s.winRate).toBeCloseTo(0.5, 5); // 1 good / 2 decided (neutral excluded)
    expect(s.avgReturnPct).toBeCloseTo(0.02, 5); // (0.1 - 0.05 + 0.01)/3
  });
});

describe('recentLearning', () => {
  const rec = (date: string): LearningRecord => ({
    date, generatedAt: `${date}T20:00:00.000Z`, total: 1, graded: 0, open: 0, good: 0, bad: 0,
    neutral: 0, winRate: 0, avgReturnPct: 0, methods: [],
  });

  it('keeps the last record per day, newest first, capped at n', () => {
    const out = recentLearning([rec('2026-06-23'), rec('2026-06-24'), rec('2026-06-24'), rec('2026-06-25')], 2);
    expect(out.map((r) => r.date)).toEqual(['2026-06-25', '2026-06-24']);
  });
});
