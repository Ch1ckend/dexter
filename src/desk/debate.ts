/**
 * The debate — orchestrates the committee and renders the Judge's decision.
 *
 * Flow (the "argue amongst itself"):
 *   1. Bull and Bear build opposing cases in parallel.
 *   2. Skeptic (red-teams both), Risk Manager (sizes/stress-tests), and Behavioral
 *      Guard (flags emotional bias) run in parallel over those theses.
 *   3. The Judge/PM synthesizes everything — plus the learned playbook — into one
 *      sized, confidence-scored BUY/HOLD/SELL decision.
 *
 * Every role reads the learned playbook, so the committee's own track record shapes
 * each new debate.
 */
import { z } from 'zod';
import { callLlm } from '@/model/llm';
import { ROLES, RoleArgumentSchema, type RoleArgument, type RoleDef } from './roles.js';
import { runBehavioralGuard, type BehavioralReport } from './behavioral.js';
import { loadPlaybook, playbookBlock } from './playbook.js';
import { renderDossier, type Dossier } from './dossier.js';

export const JudgeDecisionSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD']),
  sizeUsd: z
    .number()
    .describe('Intended dollar size of the trade. MUST be 0 for HOLD. Respect account equity and the guardrail caps.'),
  confidence: z.number().min(0).max(1).describe('Calibrated confidence in this decision, 0..1.'),
  rationale: z.string().describe('2–4 sentences: why this action and size, weighing the committee.'),
  risks: z.array(z.string()).describe('The key risks being accepted by this decision.'),
});
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;

export interface DebateResult {
  ticker: string;
  bull: RoleArgument;
  bear: RoleArgument;
  skeptic: RoleArgument;
  risk: RoleArgument;
  behavioral: BehavioralReport;
  decision: JudgeDecision;
}

export interface DebateOptions {
  /** Model for the Judge (and behavioral guard). Defaults to the library default. */
  judgeModel?: string;
  /** Model for the analyst roles. Defaults to judgeModel. */
  analystModel?: string;
  /** Free-text account/guardrail context for the Risk Manager and Judge. */
  accountContext?: string;
  /**
   * Run the committee's calls one at a time instead of in parallel. Needed for
   * rate-limited backends (e.g. OpenRouter ':free' models, which 429 on bursts).
   */
  serial?: boolean;
}

const JUDGE_SYSTEM_PROMPT = `You are the Portfolio Manager and final Judge of an investment committee
making a LONG-TERM (multi-year) decision on a single stock. You have the Bull case, the Bear case,
the Skeptic's red-team, the Risk Manager's sizing view, and the Behavioral Guard's bias audit.

Decide an action (BUY / SELL / HOLD), a dollar size, and a calibrated confidence (0..1).

Discipline:
- Default to HOLD. Only commit capital when the evidence and the risk/reward clearly justify it.
- Respect the Risk Manager on sizing and the hard guardrail caps in the account context. Never
  propose a size that exceeds them. sizeUsd MUST be 0 when action is HOLD.
- Treat the Behavioral Guard seriously: if it flags medium/high bias whose net pressure points the
  SAME way as your inclination, lower your confidence and/or your size — that is exactly when humans
  lose money to emotion.
- Be calibrated, not bold. Confidence near 0.5 means genuinely uncertain. Reserve >0.8 for cases with
  strong, corroborated evidence and acceptable downside.
- Weigh the learned playbook: repeat what has worked, avoid documented failure patterns.`;

function fmtRole(label: string, a: RoleArgument): string {
  return `### ${label}
stance: ${a.stance}
${a.points.map((p) => `- ${p}`).join('\n')}
top risk to this view: ${a.topRisk}`;
}

/**
 * Retry on rate-limit / transient-provider errors with LONG backoff. Free
 * OpenRouter models return sporadic 429s ("Provider returned error") that
 * Dexter's built-in retry (0.5–2s) backs off too briefly to clear. Waiting
 * 5/12/25s lets the per-minute window reset, which makes a 6-call committee
 * reliable on the free tier. Non-rate-limit errors propagate immediately.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  const backoffMs = [5000, 12000, 25000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const rateLimited = /429|rate.?limit|provider returned error|temporarily/i.test(msg);
      if (!rateLimited || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, backoffMs[i] ?? 25000));
    }
  }
  throw lastErr;
}

async function runAnalyst(
  role: RoleDef,
  body: string,
  model: string | undefined,
): Promise<RoleArgument> {
  const { response } = await withRateLimitRetry(() =>
    callLlm(body, {
      systemPrompt: role.systemPrompt,
      outputSchema: RoleArgumentSchema,
      model,
    }),
  );
  return response as unknown as RoleArgument;
}

/** Run the full committee debate and return all role outputs + the decision. */
export async function runDebate(dossier: Dossier, opts: DebateOptions = {}): Promise<DebateResult> {
  const judgeModel = opts.judgeModel;
  const analystModel = opts.analystModel ?? opts.judgeModel;
  const accountContext = opts.accountContext ?? 'Account context unavailable.';

  const serial = opts.serial ?? false;
  const dossierText = renderDossier(dossier);
  const playbook = playbookBlock(await loadPlaybook());
  const base = `${playbook}\n${dossierText}`.trim();

  // Phase 1 — opposing theses (parallel, or serial on rate-limited backends).
  let bull: RoleArgument;
  let bear: RoleArgument;
  if (serial) {
    bull = await runAnalyst(ROLES.bull, base, analystModel);
    bear = await runAnalyst(ROLES.bear, base, analystModel);
  } else {
    [bull, bear] = await Promise.all([
      runAnalyst(ROLES.bull, base, analystModel),
      runAnalyst(ROLES.bear, base, analystModel),
    ]);
  }

  const thesesBlock = `${fmtRole('Bull', bull)}\n\n${fmtRole('Bear', bear)}`;
  const skepticBody = `${base}\n\n## Theses to attack\n${thesesBlock}`;
  const riskBody = `${base}\n\n## Account & guardrails\n${accountContext}\n\n## Theses\n${thesesBlock}`;

  // Phase 2 — red-team, sizing, and bias audit over the theses.
  let skeptic: RoleArgument;
  let risk: RoleArgument;
  let behavioral: BehavioralReport;
  if (serial) {
    skeptic = await runAnalyst(ROLES.skeptic, skepticBody, analystModel);
    risk = await runAnalyst(ROLES.risk, riskBody, analystModel);
    behavioral = await withRateLimitRetry(() => runBehavioralGuard(dossierText, bull, bear, judgeModel));
  } else {
    [skeptic, risk, behavioral] = await Promise.all([
      runAnalyst(ROLES.skeptic, skepticBody, analystModel),
      runAnalyst(ROLES.risk, riskBody, analystModel),
      withRateLimitRetry(() => runBehavioralGuard(dossierText, bull, bear, judgeModel)),
    ]);
  }

  // Phase 3 — the Judge synthesizes everything.
  const judgePrompt = `${base}

## Committee
${fmtRole('Bull', bull)}

${fmtRole('Bear', bear)}

${fmtRole('Skeptic / Red Team', skeptic)}

${fmtRole('Risk Manager', risk)}

### Behavioral Guard
net emotional pressure: ${behavioral.netEmotionalPressure}
biases: ${behavioral.biasesDetected.length
    ? behavioral.biasesDetected.map((b) => `${b.bias} (${b.severity}) — ${b.evidence}`).join('; ')
    : 'none flagged'}
recommendation: ${behavioral.recommendation}

## Account & guardrails
${accountContext}

Render the committee's final decision now.`;

  const { response } = await withRateLimitRetry(() =>
    callLlm(judgePrompt, {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      outputSchema: JudgeDecisionSchema,
      model: judgeModel,
    }),
  );
  const decision = response as unknown as JudgeDecision;

  return { ticker: dossier.ticker, bull, bear, skeptic, risk, behavioral, decision };
}

/** Compact, human/journal-friendly digest of a debate. */
export function summarizeDebate(r: DebateResult): string {
  const biases = r.behavioral.biasesDetected.length
    ? r.behavioral.biasesDetected.map((b) => `${b.bias}(${b.severity})`).join(', ')
    : 'none';
  return [
    `Bull: ${r.bull.stance}`,
    `Bear: ${r.bear.stance}`,
    `Skeptic: ${r.skeptic.stance}`,
    `Risk: ${r.risk.stance}`,
    `Behavioral: ${r.behavioral.netEmotionalPressure} pressure; biases: ${biases}`,
  ].join(' | ');
}
