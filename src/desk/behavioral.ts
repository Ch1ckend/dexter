/**
 * The Behavioral Guard — "identify problems with human emotions."
 *
 * A first-class committee member whose job is NOT to value the company but to audit
 * the reasoning for human cognitive and emotional bias before any capital is risked.
 * It reads the dossier (including recent price action) and the Bull/Bear theses, and
 * flags distortions like FOMO, loss aversion, recency, anchoring, herding,
 * confirmation bias, and overconfidence — then tells the Judge how to debias.
 */
import { z } from 'zod';
import { callLlm } from '@/model/llm';
import type { RoleArgument } from './roles.js';

export const BIAS_TAXONOMY = [
  'FOMO / chasing momentum',
  'Loss aversion / sunk cost',
  'Recency bias',
  'Anchoring',
  'Herding / social proof',
  'Confirmation bias',
  'Overconfidence',
  'Narrative fallacy',
] as const;

export const BehavioralReportSchema = z.object({
  biasesDetected: z
    .array(
      z.object({
        bias: z.string().describe('Which bias, from the known taxonomy.'),
        severity: z.enum(['low', 'medium', 'high']),
        evidence: z.string().describe('The specific reasoning or data pattern that triggered this flag.'),
      }),
    )
    .describe('Empty array if the reasoning looks disciplined.'),
  netEmotionalPressure: z
    .enum(['buy-side', 'sell-side', 'neutral'])
    .describe('Direction the detected emotional pressure pushes the decision, if any.'),
  recommendation: z.string().describe('One or two sentences on how the Judge should debias the decision.'),
});
export type BehavioralReport = z.infer<typeof BehavioralReportSchema>;

const BEHAVIORAL_SYSTEM_PROMPT = `You are the Behavioral Guard on an investment committee. You do
NOT value the company. Your sole job is to detect human cognitive and emotional biases in the
committee's reasoning and in the market context, so a disciplined, unemotional decision can be made.

Watch for these biases: ${BIAS_TAXONOMY.join('; ')}.

Heuristics:
- A large recent run-up paired with a glowing Bull case is a classic FOMO/recency setup.
- A sharp drawdown paired with a panicked Bear case can be loss aversion or recency to the downside.
- Theses that only cite confirming evidence and ignore the dossier's counter-signals = confirmation bias.
- Certainty language ("obviously", "can't lose", "guaranteed") = overconfidence.
- "Everyone is buying this" reasoning = herding.

Only flag a bias when there is concrete evidence for it in the dossier or the theses. Do not
manufacture flags; disciplined reasoning should return an empty list. Be specific in "evidence".`;

/**
 * Run the behavioral audit over the dossier and the opposing theses.
 */
export async function runBehavioralGuard(
  dossierText: string,
  bull: RoleArgument,
  bear: RoleArgument,
  model?: string,
): Promise<BehavioralReport> {
  const prompt = `## Company dossier
${dossierText}

## Bull thesis
stance: ${bull.stance}
points:
${bull.points.map((p) => `- ${p}`).join('\n')}

## Bear thesis
stance: ${bear.stance}
points:
${bear.points.map((p) => `- ${p}`).join('\n')}

Audit the reasoning and market context above for human cognitive/emotional bias.`;

  const { response } = await callLlm(prompt, {
    systemPrompt: BEHAVIORAL_SYSTEM_PROMPT,
    outputSchema: BehavioralReportSchema,
    model,
  });
  return response as unknown as BehavioralReport;
}
