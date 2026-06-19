/**
 * The strategist — given the decision + intel + current price, sets the ideal
 * entry (buy) price, the target (sell) price, a stop, and CHOOSES ITS OWN
 * timeline for the trade to play out, with the growth thesis and expected return.
 */
import { z } from 'zod';
import { callLlm } from '@/model/llm';
import { withRateLimitRetry } from './llmRetry.js';
import { renderReports } from './research/researchers.js';
import type { ResearchReport } from './research/types.js';
import type { Decision } from './decide.js';

export const StrategySchema = z.object({
  entryPrice: z.number().describe('Ideal price to BUY at (limit). For a HOLD, the accumulation level to wait for.'),
  targetPrice: z.number().describe('Price to SELL / take profit at.'),
  stopPrice: z.number().describe('Risk-exit price if the thesis breaks.'),
  horizon: z.string().describe('The holding timeline YOU choose for this to play out, e.g. "9–18 months".'),
  horizonRationale: z.string().describe('Why this timeline fits the thesis.'),
  growthThesis: z.string().describe('How capital compounds from entry to target over the horizon.'),
  expectedReturnPct: z.number().describe('Expected total return % from entry to target over the horizon.'),
});
export type Strategy = z.infer<typeof StrategySchema>;

const STRATEGIST_PROMPT = `You are the desk's strategist. You set the trade plan around an already-made
decision. Using the research intel and the current price, produce:
- entryPrice: the ideal price to BUY at (a disciplined limit, not just the current price — where is the
  risk/reward best?). For HOLD, this is the level you'd start accumulating.
- targetPrice: where you SELL / take profit, justified by valuation or catalyst.
- stopPrice: where you exit if the thesis is wrong.
- horizon: YOU choose the holding timeline for this to play out (be specific, e.g. "6–12 months").
- horizonRationale + growthThesis + expectedReturnPct: how the money grows over that horizon.

Be realistic and internally consistent: entry < target for longs, stop below entry, expectedReturnPct
must match (target/entry − 1). Anchor prices to the actual current price and the stock's 52-week range.`;

export async function strategize(
  ticker: string,
  decision: Decision,
  reports: ResearchReport[],
  currentPrice: number | null,
  opts: { model?: string } = {},
): Promise<Strategy> {
  const prompt = `Ticker: ${ticker}
Current price: ${currentPrice != null ? `$${currentPrice}` : 'unknown'}
Decision: ${decision.action} (confidence ${decision.confidence})
Decision rationale: ${decision.rationale}

## Research reports
${renderReports(reports)}

Produce the trade plan (entry, target, stop, horizon, growth thesis, expected return) now.`;
  const { response } = await withRateLimitRetry(() =>
    callLlm(prompt, { systemPrompt: STRATEGIST_PROMPT, outputSchema: StrategySchema, model: opts.model }),
  );
  return response as unknown as Strategy;
}
