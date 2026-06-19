/**
 * The research swarm — four elite domain researchers. Each GATHERS its intel
 * deterministically, then SYNTHESIZES one structured ResearchReport via a single
 * LLM call (rate-limit-retried for the free tier).
 */
import { callLlm } from '@/model/llm';
import { withRateLimitRetry } from '../llmRetry.js';
import { ResearchReportSchema, type ResearchReport, type ResearchReportBody, type GatheredIntel } from './types.js';
import { gatherMarketTrends, gatherNationalNews, gatherLocalNews, gatherCompanyOsint } from './gather.js';

const COMMON = `You are part of an elite equity research team — the best information analysts on the
planet. You are handed RAW, multi-source intel for one company. Your job is to turn it into a tight,
evidence-backed report: a short summary, a set of discrete signals (each bullish/bearish/neutral with
a weight and the exact data point behind it), and the key facts worth carrying forward. Cite specific
numbers. Never invent data not present in the intel. If the intel is thin, say so and weight low.`;

const PROMPTS: Record<string, string> = {
  'market-trends': `${COMMON}

DOMAIN: Market trends & macro. Read the macro regime (rates, yield curve, inflation, unemployment,
volatility, sentiment) and the company's valuation/fundamentals/analyst trend. Judge whether the
macro backdrop and the stock's valuation are tailwinds or headwinds for a multi-year holder.`,
  'national-news': `${COMMON}

DOMAIN: National & financial news. Identify the catalysts, narrative, and sentiment from the news
flow. Separate durable developments from noise. Note where ticker-tagged sentiment and the headlines
agree or diverge.`,
  'local-news': `${COMMON}

DOMAIN: Local & ground-level intelligence. Read regional developments around the company's HQ and
facilities — hiring/layoffs, expansions/closures, community and regional economic signals. These
often lead the national narrative. Translate ground-level facts into forward signals.`,
  'company-osint': `${COMMON}

DOMAIN: Company OSINT. Scrutinize SEC filings cadence, insider transactions (Form 4 — clustered
selling vs buying), management quality, controversies/litigation/regulatory risk, and red flags.
Insider behavior and filing patterns are high-signal; weight them accordingly.`,
};

async function synthesize(
  domain: string,
  intel: GatheredIntel,
  model: string | undefined,
): Promise<ResearchReport> {
  const prompt = `Raw intel gathered for the "${domain}" domain:

${intel.text || '(no data returned)'}
${intel.errors.length ? `\nData gaps (sources that failed): ${intel.errors.join('; ')}` : ''}

Synthesize this into your structured report now.`;
  const { response } = await withRateLimitRetry(() =>
    callLlm(prompt, { systemPrompt: PROMPTS[domain], outputSchema: ResearchReportSchema, model }),
  );
  const body = response as unknown as ResearchReportBody;
  return { ...body, domain, sources: intel.sources };
}

export interface SwarmOptions {
  model?: string;
  /** Synthesize one domain at a time (needed for rate-limited free models). */
  serial?: boolean;
}

/**
 * Run the full research swarm for a ticker. Gathering is parallel (plain HTTP);
 * synthesis is serial on rate-limited backends, parallel otherwise.
 */
export async function runResearchSwarm(
  ticker: string,
  company: string,
  opts: SwarmOptions = {},
): Promise<ResearchReport[]> {
  const intels = await Promise.all([
    gatherMarketTrends(ticker),
    gatherNationalNews(ticker, company),
    gatherLocalNews(ticker, company),
    gatherCompanyOsint(ticker, company),
  ]);

  if (opts.serial) {
    const reports: ResearchReport[] = [];
    for (const intel of intels) reports.push(await synthesize(intel.domain, intel, opts.model));
    return reports;
  }
  return Promise.all(intels.map((intel) => synthesize(intel.domain, intel, opts.model)));
}

/** Render the swarm's reports as a compact block for the analyst/strategist. */
export function renderReports(reports: ResearchReport[]): string {
  return reports
    .map((r) => {
      const signals = r.signals.map((s) => `  - [${s.direction}/${s.weight}] ${s.label}: ${s.evidence}`).join('\n');
      const facts = r.keyFacts.map((f) => `  - ${f}`).join('\n');
      return `## ${r.domain}\n${r.summary}\nSignals:\n${signals}\nKey facts:\n${facts}`;
    })
    .join('\n\n');
}
