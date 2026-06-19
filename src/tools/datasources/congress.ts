/**
 * Congressional & government trading client — U.S. Senate + House stock
 * disclosures (STOCK Act filings) by ticker. Free alt-data edge signal.
 *
 * Backed by Financial Modeling Prep's `stable` congress endpoints. Reads
 * FMP_API_KEY from env (free tier — get one at financialmodelingprep.com).
 *
 * Degrades gracefully on purpose: a missing key throws a clear error (so the
 * research swarm records it as a failed source, not a silent success), but a
 * paywalled / unavailable endpoint just yields no rows for that chamber so the
 * rest of the signal still flows. The dedicated free structured sources
 * (Capitol Trades, House/Senate Stock Watcher) are degraded as of 2026-06, so
 * FMP is the structured path; Perplexity carries the signal when FMP is absent.
 */
const BASE = 'https://financialmodelingprep.com/stable';

function key(): string {
  const k = process.env.FMP_API_KEY;
  if (!k || k.startsWith('your-')) throw new Error('FMP_API_KEY not set');
  return k;
}

/** A congressional trade normalized to one shape across chambers. */
export interface CongressTrade {
  date: string; // transaction date (falls back to disclosure date)
  chamber: 'senate' | 'house';
  politician: string; // "First Last"
  txType: 'buy' | 'sell' | 'other';
  amountRange: string; // e.g. "$1,001 - $15,000"
  ticker: string;
}

/** Raw FMP row shape (fields are best-effort — FMP varies them slightly per endpoint). */
interface FmpCongressRow {
  symbol?: string;
  transactionDate?: string;
  disclosureDate?: string;
  firstName?: string;
  lastName?: string;
  office?: string;
  representative?: string;
  owner?: string;
  type?: string; // "Purchase" | "Sale" | "Sale (Partial)" | "Sale (Full)" | "Exchange" ...
  amount?: string;
  link?: string;
}

/** Map FMP's free-text transaction type onto a buy/sell/other class. Pure. */
export function classifyTxType(type: string | undefined): CongressTrade['txType'] {
  const t = (type ?? '').toLowerCase();
  if (/purchase|buy|acquisition/.test(t)) return 'buy';
  if (/sale|sell|sold|dispose/.test(t)) return 'sell';
  return 'other';
}

/** Normalize one raw FMP row into a CongressTrade. Pure (no network) — unit-tested. */
export function normalizeRow(row: FmpCongressRow, chamber: CongressTrade['chamber'], ticker: string): CongressTrade {
  const politician =
    row.representative?.trim() ||
    `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() ||
    row.office?.trim() ||
    'Unknown';
  return {
    date: row.transactionDate || row.disclosureDate || 'n/a',
    chamber,
    politician,
    txType: classifyTxType(row.type),
    amountRange: row.amount?.trim() || 'n/a',
    ticker: (row.symbol || ticker).toUpperCase(),
  };
}

/**
 * Render a clustered, prompt-ready summary of congressional trades. Pure —
 * unit-tested. Empty input reads as a clean "no recent trades", not an error.
 */
export function summarizeTrades(trades: CongressTrade[], ticker: string): string {
  if (trades.length === 0) return `No recent congressional/Senate trades found for ${ticker.toUpperCase()}.`;
  const buys = trades.filter((t) => t.txType === 'buy').length;
  const sells = trades.filter((t) => t.txType === 'sell').length;
  const dates = trades.map((t) => t.date).filter((d) => d !== 'n/a').sort();
  const span = dates.length ? `${dates[0]}…${dates[dates.length - 1]}` : 'n/a';
  const lines = trades
    .slice(0, 10)
    .map((t) => `- ${t.date} ${t.politician} (${t.chamber}) ${t.txType.toUpperCase()} ${t.amountRange}`)
    .join('\n');
  return `${trades.length} disclosed trade(s) [${buys} buy / ${sells} sell] over ${span}:\n${lines}`;
}

/** Fetch + normalize one chamber. Graceful: a paywalled/unavailable endpoint yields []. */
async function fetchChamber(endpoint: 'senate-trades' | 'house-trades', ticker: string): Promise<CongressTrade[]> {
  const chamber: CongressTrade['chamber'] = endpoint === 'senate-trades' ? 'senate' : 'house';
  const qs = new URLSearchParams({ symbol: ticker.toUpperCase(), apikey: key() }).toString();
  const res = await fetch(`${BASE}/${endpoint}?${qs}`);
  if (!res.ok) return []; // premium/paywalled/unavailable → no rows for this chamber, not a hard failure
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return []; // FMP returns an { "Error Message": ... } object on paywall
  return (body as FmpCongressRow[]).map((row) => normalizeRow(row, chamber, ticker));
}

/**
 * Recent congressional trades for a ticker across both chambers, newest first.
 * Throws only when FMP_API_KEY is unset (so the swarm flags a missing source);
 * an empty array means "key present, no disclosed trades / endpoint gated".
 */
export async function getCongressionalTrades(ticker: string, limit = 15): Promise<CongressTrade[]> {
  key(); // fail fast + clearly when the key is missing
  const [senate, house] = await Promise.all([fetchChamber('senate-trades', ticker), fetchChamber('house-trades', ticker)]);
  return [...senate, ...house].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}
