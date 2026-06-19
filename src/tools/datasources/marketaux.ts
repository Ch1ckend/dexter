/**
 * Marketaux client — financial news tagged by ticker WITH per-entity sentiment
 * scores. Free key, ~100 req/day. Reads MARKETAUX_API_KEY from env.
 */
const BASE = 'https://api.marketaux.com/v1';

function key(): string {
  const k = process.env.MARKETAUX_API_KEY;
  if (!k || k.startsWith('your-')) throw new Error('MARKETAUX_API_KEY not set');
  return k;
}

export interface MarketauxEntity {
  symbol: string;
  name: string;
  sentiment_score: number; // -1..1
}
export interface MarketauxArticle {
  title: string;
  description: string;
  url: string;
  published_at: string;
  source: string;
  entities: MarketauxEntity[];
}

/**
 * Latest news for the given symbols, entity-filtered so each article carries a
 * sentiment score for the ticker(s) it mentions.
 */
export async function marketauxNews(symbols: string[], limit = 12): Promise<MarketauxArticle[]> {
  const qs = new URLSearchParams({
    symbols: symbols.map((s) => s.toUpperCase()).join(','),
    filter_entities: 'true',
    language: 'en',
    limit: String(limit),
    api_token: key(),
  }).toString();
  const res = await fetch(`${BASE}/news/all?${qs}`);
  if (!res.ok) throw new Error(`Marketaux ${res.status}`);
  const data = (await res.json()) as { data?: MarketauxArticle[] };
  return data.data ?? [];
}

/** Average sentiment for a symbol across its recent tagged articles (-1..1), or null. */
export async function marketauxSentiment(symbol: string): Promise<number | null> {
  const arts = await marketauxNews([symbol], 20);
  const scores: number[] = [];
  for (const a of arts) {
    for (const e of a.entities) {
      if (e.symbol.toUpperCase() === symbol.toUpperCase() && typeof e.sentiment_score === 'number') {
        scores.push(e.sentiment_score);
      }
    }
  }
  return scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
}
