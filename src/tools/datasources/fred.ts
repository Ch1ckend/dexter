/**
 * FRED client (St. Louis Fed) — the macro backbone for "market trends." Free key,
 * effectively unlimited. Reads FRED_API_KEY from env.
 *
 * A handful of series carry most of the macro signal; MACRO_SERIES names them.
 */
const BASE = 'https://api.stlouisfed.org/fred';

function key(): string {
  const k = process.env.FRED_API_KEY;
  if (!k || k.startsWith('your-')) throw new Error('FRED_API_KEY not set');
  return k;
}

/** High-signal macro series → human label. */
export const MACRO_SERIES: Record<string, string> = {
  DFF: 'Effective Fed Funds Rate',
  DGS10: '10-Year Treasury Yield',
  T10Y2Y: '10Y–2Y Yield Spread (recession signal)',
  CPIAUCSL: 'CPI (inflation)',
  UNRATE: 'Unemployment Rate',
  VIXCLS: 'VIX (volatility)',
  UMCSENT: 'Consumer Sentiment',
};

export interface FredObservation {
  date: string;
  value: string;
}

/** Latest `limit` observations for a series, newest first. */
export async function fredSeries(seriesId: string, limit = 6): Promise<FredObservation[]> {
  const qs = new URLSearchParams({
    series_id: seriesId,
    api_key: key(),
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  }).toString();
  const res = await fetch(`${BASE}/series/observations?${qs}`);
  if (!res.ok) throw new Error(`FRED ${res.status} for ${seriesId}`);
  const data = (await res.json()) as { observations?: FredObservation[] };
  return (data.observations ?? []).filter((o) => o.value !== '.');
}

/** One-shot macro snapshot: latest value of each high-signal series. */
export async function fredMacroSnapshot(): Promise<Array<{ id: string; label: string; latest: FredObservation | null }>> {
  const ids = Object.keys(MACRO_SERIES);
  const results = await Promise.allSettled(ids.map((id) => fredSeries(id, 1)));
  return ids.map((id, i) => {
    const r = results[i];
    return {
      id,
      label: MACRO_SERIES[id],
      latest: r.status === 'fulfilled' ? (r.value[0] ?? null) : null,
    };
  });
}
