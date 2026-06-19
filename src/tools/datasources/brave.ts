/**
 * Brave Search client — web + news search with geo-targeting (good for LOCAL
 * news). Free key, ~2k queries/month. Reads BRAVE_API_KEY from env.
 */
const BASE = 'https://api.search.brave.com/res/v1';

function headers(): Record<string, string> {
  const k = process.env.BRAVE_API_KEY;
  if (!k || k.startsWith('your-')) throw new Error('BRAVE_API_KEY not set');
  return { Accept: 'application/json', 'X-Subscription-Token': k };
}

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

/**
 * News search. `country`/`q` can be used to bias toward local coverage, e.g.
 * braveNews("Cupertino California business news", { country: 'us' }).
 */
export async function braveNews(query: string, opts: { count?: number; country?: string } = {}): Promise<BraveResult[]> {
  const qs = new URLSearchParams({
    q: query,
    count: String(opts.count ?? 10),
    ...(opts.country ? { country: opts.country } : {}),
  }).toString();
  const res = await fetch(`${BASE}/news/search?${qs}`, { headers: headers() });
  if (!res.ok) throw new Error(`Brave news ${res.status}`);
  const data = (await res.json()) as { results?: BraveResult[] };
  return data.results ?? [];
}

/** General web search (broad coverage / fallback). */
export async function braveWeb(query: string, count = 10): Promise<BraveResult[]> {
  const qs = new URLSearchParams({ q: query, count: String(count) }).toString();
  const res = await fetch(`${BASE}/web/search?${qs}`, { headers: headers() });
  if (!res.ok) throw new Error(`Brave web ${res.status}`);
  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  return data.web?.results ?? [];
}
