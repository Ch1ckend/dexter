/**
 * Deterministic intel gathering — one function per research domain. Each calls
 * its data sources resiliently (a dead source never sinks the report) and
 * returns prompt-ready text + source URLs. No LLM here: code before prompts.
 */
import { perplexitySearch } from '@/tools/search';
import {
  fredMacroSnapshot,
  finnhubMetrics,
  finnhubRecommendations,
  finnhubQuote,
  finnhubCompanyNews,
  finnhubInsider,
  marketauxNews,
  marketauxSentiment,
  braveNews,
  getKeyFilings,
  getInsiderForm4,
  getCongressionalTrades,
  summarizeTrades,
} from '@/tools/datasources';
import type { GatheredIntel } from './types.js';

async function perplexity(query: string): Promise<{ answer: string; sources: string[] }> {
  const raw = await perplexitySearch.invoke({ query });
  const parsed = JSON.parse(raw) as { data?: { answer?: string }; sourceUrls?: string[] };
  return { answer: parsed.data?.answer ?? '', sources: parsed.sourceUrls ?? [] };
}

/** Run thunks, collect text lines + sources, record failures instead of throwing. */
async function collect(
  domain: string,
  parts: Array<{ label: string; run: () => Promise<{ text: string; sources?: string[] }> }>,
): Promise<GatheredIntel> {
  const results = await Promise.allSettled(parts.map((p) => p.run()));
  const sections: string[] = [];
  const sources: string[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sections.push(`### ${parts[i].label}\n${r.value.text}`);
      if (r.value.sources) sources.push(...r.value.sources);
    } else {
      errors.push(`${parts[i].label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  return { domain, text: sections.join('\n\n'), sources: [...new Set(sources)], errors };
}

// --- Market trends ----------------------------------------------------------

export function gatherMarketTrends(ticker: string): Promise<GatheredIntel> {
  return collect('market-trends', [
    {
      label: 'Macro (FRED)',
      run: async () => {
        const m = await fredMacroSnapshot();
        return { text: m.map((x) => `- ${x.label}: ${x.latest ? `${x.latest.value} (${x.latest.date})` : 'n/a'}`).join('\n') };
      },
    },
    {
      label: 'Valuation & fundamentals (Finnhub)',
      run: async () => {
        const { metric } = await finnhubMetrics(ticker);
        const pick = ['peTTM', 'psTTM', 'pbAnnual', 'roeTTM', 'netProfitMarginTTM', 'revenueGrowthTTMYoy', '52WeekHigh', '52WeekLow'];
        return { text: pick.map((k) => `- ${k}: ${metric[k] ?? 'n/a'}`).join('\n') };
      },
    },
    {
      label: 'Analyst recommendation trend (Finnhub)',
      run: async () => {
        const recs = (await finnhubRecommendations(ticker)) as Array<Record<string, number>>;
        const latest = recs[0];
        return { text: latest ? `- ${latest.period}: strongBuy ${latest.strongBuy}, buy ${latest.buy}, hold ${latest.hold}, sell ${latest.sell}, strongSell ${latest.strongSell}` : 'n/a' };
      },
    },
    {
      label: 'Current price (Finnhub)',
      run: async () => {
        const q = await finnhubQuote(ticker);
        return { text: `- current $${q.c}, prev close $${q.pc}, day range $${q.l}–$${q.h}` };
      },
    },
  ]);
}

// --- National / financial news ---------------------------------------------

export function gatherNationalNews(ticker: string, company: string): Promise<GatheredIntel> {
  return collect('national-news', [
    {
      label: 'Ticker news + sentiment (Marketaux)',
      run: async () => {
        const [news, sentiment] = await Promise.all([marketauxNews([ticker], 8), marketauxSentiment(ticker)]);
        const lines = news.map((n) => `- ${n.title} (${n.source})`).join('\n');
        return { text: `avg sentiment: ${sentiment ?? 'n/a'}\n${lines}`, sources: news.map((n) => n.url) };
      },
    },
    {
      label: 'Company news (Finnhub)',
      run: async () => {
        const news = await finnhubCompanyNews(ticker, 7, 10);
        return { text: news.map((n) => `- ${n.headline} (${n.source})`).join('\n'), sources: news.map((n) => n.url) };
      },
    },
    {
      label: 'National/financial synthesis (Perplexity)',
      run: async () => {
        const r = await perplexity(`${company} (${ticker}) — most important national and financial news, catalysts, earnings, and analyst views in the last 2 weeks. Be specific and cite.`);
        return { text: r.answer, sources: r.sources };
      },
    },
  ]);
}

// --- Local news -------------------------------------------------------------

export function gatherLocalNews(ticker: string, company: string): Promise<GatheredIntel> {
  return collect('local-news', [
    {
      label: 'Local/regional headlines (Brave)',
      run: async () => {
        const news = await braveNews(`${company} headquarters local news operations expansion layoffs facility`, { count: 8, country: 'us' });
        return { text: news.map((n) => `- ${n.title}${n.age ? ` (${n.age})` : ''}`).join('\n'), sources: news.map((n) => n.url) };
      },
    },
    {
      label: 'Local angle synthesis (Perplexity)',
      run: async () => {
        const r = await perplexity(`${company} — local and regional developments around its headquarters and major facilities: hiring/layoffs, plant or store openings/closings, local government/community relations, regional economic impact. Recent, specific, cited.`);
        return { text: r.answer, sources: r.sources };
      },
    },
  ]);
}

// --- Company OSINT ----------------------------------------------------------

export function gatherCompanyOsint(ticker: string, company: string): Promise<GatheredIntel> {
  return collect('company-osint', [
    {
      label: 'Recent SEC filings (EDGAR)',
      run: async () => {
        const f = await getKeyFilings(ticker, 6);
        return { text: f.filings.map((x) => `- ${x.filingDate} ${x.form} ${x.description ?? ''}`).join('\n'), sources: f.filings.map((x) => x.url) };
      },
    },
    {
      label: 'Insider transactions (EDGAR Form 4 + Finnhub)',
      run: async () => {
        const [form4, fin] = await Promise.all([getInsiderForm4(ticker, 8), finnhubInsider(ticker).catch(() => ({ data: [] }))]);
        const f4 = form4.filings.map((x) => `- ${x.filingDate} Form 4`).join('\n');
        const finCount = Array.isArray(fin.data) ? fin.data.length : 0;
        return { text: `EDGAR Form 4 filings:\n${f4}\nFinnhub parsed insider records: ${finCount}`, sources: form4.filings.map((x) => x.url) };
      },
    },
    {
      label: 'Congressional & government trades (FMP)',
      run: async () => {
        const trades = await getCongressionalTrades(ticker, 15);
        return { text: summarizeTrades(trades, ticker) };
      },
    },
    {
      label: 'OSINT synthesis (Perplexity)',
      run: async () => {
        const r = await perplexity(`${company} (${ticker}) OSINT for an investor: management quality and track record, active controversies/lawsuits/regulatory actions, competitive threats, customer/employee sentiment, and red flags. ALSO surface alternative-data edge signals: recent U.S. congressional/Senate stock trades in ${ticker}, unusual options flow, and any federal government contract awards. Specific, dated, and cited.`);
        return { text: r.answer, sources: r.sources };
      },
    },
  ]);
}
