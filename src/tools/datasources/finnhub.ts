/**
 * Finnhub client — the best free all-rounder: company news, fundamentals/metrics,
 * insider transactions, and analyst recommendation trends. Free key, ~60 req/min.
 * Reads FINNHUB_API_KEY from env.
 */
const BASE = 'https://finnhub.io/api/v1';

function key(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k || k.startsWith('your-')) throw new Error('FINNHUB_API_KEY not set');
  return k;
}

async function fh<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, token: key() }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export interface FinnhubArticle {
  datetime: number;
  headline: string;
  source: string;
  summary: string;
  url: string;
}

/** Company news over the last `days` (default 7). */
export async function finnhubCompanyNews(symbol: string, days = 7, limit = 15): Promise<FinnhubArticle[]> {
  const all = await fh<FinnhubArticle[]>('/company-news', {
    symbol: symbol.toUpperCase(),
    from: isoDaysAgo(days),
    to: isoDaysAgo(0),
  });
  return all.slice(0, limit);
}

/** All key fundamental metrics (valuation, margins, growth, per-share). */
export function finnhubMetrics(symbol: string): Promise<{ metric: Record<string, number> }> {
  return fh('/stock/metric', { symbol: symbol.toUpperCase(), metric: 'all' });
}

/** Recent insider transactions (complements EDGAR Form 4 with parsed amounts). */
export function finnhubInsider(symbol: string): Promise<{ data: unknown[] }> {
  return fh('/stock/insider-transactions', { symbol: symbol.toUpperCase() });
}

/** Analyst buy/hold/sell recommendation trend over recent months. */
export function finnhubRecommendations(symbol: string): Promise<unknown[]> {
  return fh('/stock/recommendation', { symbol: symbol.toUpperCase() });
}

/** Real-time quote: current, open, high, low, prev close. */
export function finnhubQuote(symbol: string): Promise<{ c: number; o: number; h: number; l: number; pc: number }> {
  return fh('/quote', { symbol: symbol.toUpperCase() });
}
