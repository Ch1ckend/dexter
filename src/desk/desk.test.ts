/**
 * Unit tests for the Desk's deterministic core — the outcome scorer and the
 * behavioral-bias parser. These hold the financial logic that must stay correct
 * independent of any LLM or network.
 */
import { describe, it, expect } from 'bun:test';
import { scoreDecision } from './grade.js';
import { biasesOf } from './learn.js';
import type { DeskDecision } from './journal.js';

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
