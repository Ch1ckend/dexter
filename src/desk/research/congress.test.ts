/**
 * Unit tests for the congressional-trades alt-data source — the pure normalizer,
 * the transaction-type classifier, and the clustering summary renderer. These
 * hold the deterministic logic that must stay correct independent of FMP/network.
 */
import { describe, it, expect } from 'bun:test';
import { classifyTxType, normalizeRow, summarizeTrades, type CongressTrade } from '@/tools/datasources/congress';

describe('classifyTxType', () => {
  it('maps purchase variants to buy', () => {
    expect(classifyTxType('Purchase')).toBe('buy');
    expect(classifyTxType('purchase')).toBe('buy');
    expect(classifyTxType('Acquisition')).toBe('buy');
  });

  it('maps sale variants to sell', () => {
    expect(classifyTxType('Sale')).toBe('sell');
    expect(classifyTxType('Sale (Partial)')).toBe('sell');
    expect(classifyTxType('Sale (Full)')).toBe('sell');
    expect(classifyTxType('Sold')).toBe('sell');
  });

  it('falls back to other for unknown/empty types', () => {
    expect(classifyTxType('Exchange')).toBe('other');
    expect(classifyTxType(undefined)).toBe('other');
    expect(classifyTxType('')).toBe('other');
  });
});

describe('normalizeRow', () => {
  it('normalizes a typical FMP senate row', () => {
    const t = normalizeRow(
      { symbol: 'aapl', transactionDate: '2026-05-01', firstName: 'Jane', lastName: 'Doe', type: 'Purchase', amount: '$1,001 - $15,000' },
      'senate',
      'AAPL',
    );
    expect(t).toEqual({
      date: '2026-05-01',
      chamber: 'senate',
      politician: 'Jane Doe',
      txType: 'buy',
      amountRange: '$1,001 - $15,000',
      ticker: 'AAPL',
    });
  });

  it('falls back to disclosure date, representative name, and the query ticker', () => {
    const t = normalizeRow({ representative: 'Rep. John Smith', disclosureDate: '2026-04-15', type: 'Sale' }, 'house', 'msft');
    expect(t.date).toBe('2026-04-15');
    expect(t.politician).toBe('Rep. John Smith');
    expect(t.txType).toBe('sell');
    expect(t.amountRange).toBe('n/a');
    expect(t.ticker).toBe('MSFT');
  });

  it('uses Unknown when no name fields are present', () => {
    expect(normalizeRow({ transactionDate: '2026-01-01', type: 'Purchase' }, 'senate', 'NVDA').politician).toBe('Unknown');
  });
});

describe('summarizeTrades', () => {
  const trades: CongressTrade[] = [
    { date: '2026-05-01', chamber: 'senate', politician: 'Jane Doe', txType: 'buy', amountRange: '$1,001 - $15,000', ticker: 'AAPL' },
    { date: '2026-04-10', chamber: 'house', politician: 'John Smith', txType: 'sell', amountRange: '$15,001 - $50,000', ticker: 'AAPL' },
    { date: '2026-03-20', chamber: 'house', politician: 'Pat Lee', txType: 'buy', amountRange: 'n/a', ticker: 'AAPL' },
  ];

  it('clusters buys vs sells and spans the date range', () => {
    const s = summarizeTrades(trades, 'AAPL');
    expect(s).toContain('3 disclosed trade(s)');
    expect(s).toContain('[2 buy / 1 sell]');
    expect(s).toContain('2026-03-20…2026-05-01');
    expect(s).toContain('Jane Doe');
  });

  it('reads cleanly as no-data for an empty set (not an error)', () => {
    const s = summarizeTrades([], 'tsla');
    expect(s).toBe('No recent congressional/Senate trades found for TSLA.');
  });
});
