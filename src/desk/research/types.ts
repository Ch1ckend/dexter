/**
 * Shared types + schemas for the research swarm.
 *
 * The pipeline is: each researcher deterministically GATHERS raw intel from its
 * data sources, then SYNTHESIZES it into one structured ResearchReport via a
 * single LLM call. The analyst turns the reports into a decision; the strategist
 * sets entry/exit prices and a self-chosen timeline.
 */
import { z } from 'zod';

/** A single extracted signal with direction + weight + the evidence behind it. */
export const SignalSchema = z.object({
  label: z.string().describe('Short name of the signal, e.g. "insider selling" or "inverted yield curve".'),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  weight: z.enum(['low', 'medium', 'high']).describe('How strongly this should move the decision.'),
  evidence: z.string().describe('The specific data point/number/quote this signal rests on.'),
});

/** What a researcher returns after synthesizing its domain's raw intel. */
export const ResearchReportSchema = z.object({
  summary: z.string().describe('2–4 sentences: what the gathered data actually shows for this domain.'),
  signals: z.array(SignalSchema).describe('Discrete, evidence-backed signals pulled from the data.'),
  keyFacts: z.array(z.string()).describe('Specific numbers/facts worth carrying into the decision.'),
});
export type ResearchReportBody = z.infer<typeof ResearchReportSchema>;

/** A report plus the domain + source URLs attached in code (not by the LLM). */
export interface ResearchReport extends ResearchReportBody {
  domain: string;
  sources: string[];
}

/** Raw intel assembled deterministically before synthesis. */
export interface GatheredIntel {
  domain: string;
  text: string; // token-bounded, prompt-ready
  sources: string[];
  errors: string[];
}
