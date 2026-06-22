/**
 * The analyst — turns the research swarm's reports into a buy/sell/hold decision.
 * Long-term value orientation; defaults to HOLD unless the intel and risk/reward
 * clearly justify acting.
 */
import { z } from 'zod';
import { callLlm } from '@/model/llm';
import { withRateLimitRetry } from './llmRetry.js';
import { renderReports } from './research/researchers.js';
import type { ResearchReport } from './research/types.js';

export const DecisionSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().min(0).max(1).describe('Calibrated confidence, 0..1. ~0.5 = genuinely uncertain.'),
  oneLiner: z
    .string()
    .describe(
      'ONE crisp sentence (≤30 words) that captures the whole call — the bull case, the offsetting risk, and the verdict. ' +
        'Style: "<what is true> but/and <the catch> — so we <action>." e.g. ' +
        '"Apple\'s business is strong but the stock looks pricey, with regulatory risk offsetting the upside — so we wait."',
    ),
  rationale: z.string().describe('2–4 sentences weighing the four research domains.'),
  keyDrivers: z.array(z.string()).describe('The specific findings that most drove this call.'),
  risks: z.array(z.string()).describe('The key risks being accepted.'),
});
export type Decision = z.infer<typeof DecisionSchema>;

const ANALYST_PROMPT = `You are the lead portfolio manager of an elite research desk making a LONG-TERM
(multi-year) decision on one stock. You are handed four independent research reports — market trends &
macro, national/financial news, local/ground-level intel, and company OSINT — each with weighted,
evidence-backed signals.

Weigh them into a single action: BUY, SELL, or HOLD.

Discipline:
- Default to HOLD. Only commit when the weight of evidence and the risk/reward clearly justify it.
- High-weight signals (especially insider selling, regulatory/litigation risk, valuation extremes,
  macro headwinds) should move you more than low-weight noise.
- Respect any hard guardrails in the account context.
- Be calibrated: reserve confidence > 0.8 for cases with strong, corroborated, multi-domain evidence.
- Always produce \`oneLiner\`: a single, punchy sentence a busy reader can act on — the thesis, the main risk, and the verdict in one breath.`;

export async function decide(
  ticker: string,
  reports: ResearchReport[],
  accountContext: string,
  opts: { model?: string } = {},
): Promise<Decision> {
  const prompt = `Ticker: ${ticker}

## Research reports
${renderReports(reports)}

## Account & guardrails
${accountContext}

Make the call now.`;
  const { response } = await withRateLimitRetry(() =>
    callLlm(prompt, { systemPrompt: ANALYST_PROMPT, outputSchema: DecisionSchema, model: opts.model }),
  );
  return response as unknown as Decision;
}
