/**
 * Dossier builder — the committee's research input.
 *
 * Assembles a structured, token-bounded company dossier by invoking Dexter's
 * existing finance tools (price snapshot, key ratios, income statements, insider
 * trades) plus a Perplexity research pass for current/qualitative/OSINT context.
 * Resilient by design: any single source can fail without sinking the dossier —
 * failures are recorded so the committee knows what it is missing.
 */
import {
  getStockPrice,
  getKeyRatios,
  getIncomeStatements,
  getInsiderTrades,
} from '@/tools/finance';
import { perplexitySearch } from '@/tools/search';

export interface Dossier {
  ticker: string;
  asOf: string;
  price: unknown;
  keyRatios: unknown;
  incomeStatements: unknown;
  insiderTrades: unknown;
  research: string;
  sources: string[];
  errors: string[];
}

const SECTION_CAP = 3500; // chars per structured section, to bound prompt tokens

/** Invoke a DynamicStructuredTool and return its parsed `.data`, or throw. */
async function invokeData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: { invoke: (input: any) => Promise<unknown> },
  input: Record<string, unknown>,
): Promise<{ data: unknown; sources: string[] }> {
  const raw = (await tool.invoke(input)) as string;
  const parsed = JSON.parse(raw) as { data?: unknown; sourceUrls?: string[] };
  return { data: parsed.data ?? parsed, sources: parsed.sourceUrls ?? [] };
}

function cap(value: unknown): unknown {
  const s = JSON.stringify(value);
  if (s.length <= SECTION_CAP) return value;
  return { _truncated: true, preview: s.slice(0, SECTION_CAP) };
}

/**
 * Build a dossier for a single ticker. Never rejects for a partial data source;
 * collects what it can and lists what failed in `errors`.
 */
export async function buildDossier(tickerRaw: string): Promise<Dossier> {
  const ticker = tickerRaw.trim().toUpperCase();
  const asOf = new Date().toISOString();
  const errors: string[] = [];
  const sources: string[] = [];

  const researchQuery =
    `${ticker} stock: latest business developments, competitive position, management quality, ` +
    `risks, analyst sentiment, and any controversies or red flags in the last 12 months.`;

  const [priceR, ratiosR, incomeR, insiderR, researchR] = await Promise.allSettled([
    invokeData(getStockPrice, { ticker }),
    invokeData(getKeyRatios, { ticker }),
    invokeData(getIncomeStatements, { ticker, period: 'annual', limit: 3 }),
    invokeData(getInsiderTrades, { ticker, limit: 8 }),
    invokeData(perplexitySearch, { query: researchQuery }),
  ]);

  const take = (
    r: PromiseSettledResult<{ data: unknown; sources: string[] }>,
    label: string,
  ): unknown => {
    if (r.status === 'fulfilled') {
      sources.push(...r.value.sources);
      return cap(r.value.data);
    }
    errors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    return null;
  };

  const price = take(priceR, 'price');
  const keyRatios = take(ratiosR, 'keyRatios');
  const incomeStatements = take(incomeR, 'incomeStatements');
  const insiderTrades = take(insiderR, 'insiderTrades');

  let research = '';
  if (researchR.status === 'fulfilled') {
    sources.push(...researchR.value.sources);
    const d = researchR.value.data as { answer?: string } | string;
    research = typeof d === 'string' ? d : (d.answer ?? '');
  } else {
    errors.push(`research: ${researchR.reason instanceof Error ? researchR.reason.message : String(researchR.reason)}`);
  }

  return {
    ticker,
    asOf,
    price,
    keyRatios,
    incomeStatements,
    insiderTrades,
    research,
    sources: [...new Set(sources)],
    errors,
  };
}

/** Render a dossier as a compact markdown block for role prompts. */
export function renderDossier(d: Dossier): string {
  const j = (v: unknown) => (v == null ? '_unavailable_' : '```json\n' + JSON.stringify(v, null, 2) + '\n```');
  return `# Dossier: ${d.ticker}  (as of ${d.asOf})

## Price snapshot
${j(d.price)}

## Key ratios / metrics
${j(d.keyRatios)}

## Income statements (annual, last 3)
${j(d.incomeStatements)}

## Insider trades (recent)
${j(d.insiderTrades)}

## Research (Perplexity)
${d.research || '_unavailable_'}
${d.errors.length ? `\n## Data gaps\n${d.errors.map((e) => `- ${e}`).join('\n')}` : ''}`;
}
