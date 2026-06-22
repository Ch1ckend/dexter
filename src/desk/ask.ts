/**
 * "Ask the Desk" — the grounded Q&A engine behind the interactive Discord bot.
 *
 * Given a free-form question ("why are we still holding KO?"), it resolves the
 * ticker, loads the most recent journaled decision for it, and has a cheap model
 * answer AS the desk's lead analyst — grounded ONLY in what the research swarm
 * actually recorded (verdict, rationale, the four research domains, drivers,
 * risks, strategy). It never fetches fresh data and never invents facts.
 *
 *   bun run src/desk/ask.ts KO "why are we holding?"
 *   bun run src/desk/ask.ts "what's the risk on nvidia?"
 */
import { callLlm } from '@/model/llm';
import { withRateLimitRetry } from './llmRetry.js';
import { readJournal, type DeskDecision } from './journal.js';

const DEFAULT_MODEL = 'openrouter:openai/gpt-4o-mini';

/** Common company names → ticker, so questions don't have to use the symbol. */
const NAME_TO_TICKER: Record<string, string> = {
  apple: 'AAPL',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  nvidia: 'NVDA',
  amazon: 'AMZN',
  jpmorgan: 'JPM',
  'jp morgan': 'JPM',
  'eli lilly': 'LLY',
  lilly: 'LLY',
  exxon: 'XOM',
  caterpillar: 'CAT',
  coke: 'KO',
  'coca-cola': 'KO',
  'coca cola': 'KO',
};

const etDate = (ts: string): string =>
  new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Resolve a ticker from free text against the symbols the desk has actually decided on. */
export function extractTicker(question: string, knownTickers: string[]): string | null {
  const upper = question.toUpperCase();
  for (const t of knownTickers) {
    if (new RegExp(`\\b${t}\\b`).test(upper)) return t;
  }
  const lower = question.toLowerCase();
  for (const [name, t] of Object.entries(NAME_TO_TICKER)) {
    if (lower.includes(name)) return t;
  }
  const m = upper.match(/\b[A-Z]{2,5}\b/);
  return m ? m[0] : null;
}

/** The latest journaled decision for a ticker (or null if the desk hasn't covered it). */
export function latestDecisionFor(journal: DeskDecision[], ticker: string): DeskDecision | null {
  const hits = journal.filter((d) => d.ticker === ticker);
  if (!hits.length) return null;
  return hits.reduce((a, b) => (a.ts > b.ts ? a : b));
}

/** Assemble everything the desk recorded for this decision into a grounding block. */
function buildGrounding(e: DeskDecision): string {
  const lines = [
    `Ticker: ${e.ticker}`,
    `Decision date: ${etDate(e.ts)}`,
    `Verdict: ${e.action} (confidence ${Math.round(e.confidence * 100)}%)`,
    e.priceAtDecision != null ? `Reference price at decision: $${e.priceAtDecision}` : '',
    e.oneLiner ? `One-line summary: ${e.oneLiner}` : '',
    '',
    `Analyst rationale:\n${e.thesisDigest}`,
  ];
  if (e.keyDrivers?.length) lines.push('', `Key drivers:\n- ${e.keyDrivers.join('\n- ')}`);
  if (e.risks?.length) lines.push('', `Risks being accepted:\n- ${e.risks.join('\n- ')}`);
  if (e.debateDigest) lines.push('', `Research by domain:\n${e.debateDigest}`);
  if (e.strategy) {
    const s = e.strategy;
    lines.push(
      '',
      `Trade plan: entry $${s.entryPrice} → target $${s.targetPrice} (stop $${s.stopPrice}), ` +
        `horizon ${s.horizon}, expected return ${s.expectedReturnPct}%. Thesis: ${s.growthThesis}`,
    );
  }
  lines.push('', `Order status: ${e.executionNote}`);
  return lines.filter((l) => l !== '').join('\n');
}

const DESK_PERSONA = `You are the lead analyst of "The Desk" — an autonomous paper-trading research group.
A teammate is asking you to explain a decision the desk already made. Answer conversationally and
concisely (a short paragraph, plain prose — this is a Discord chat), as the analyst who made the call.

Hard rules:
- Ground EVERY claim in the desk's recorded research provided below. Do NOT invent facts, prices, or news.
- If the answer isn't in the recorded research, say so plainly ("the desk didn't capture that") rather than guessing.
- You may interpret and connect the recorded signals, but no live/current market data — these are the notes from the decision.
- This is paper trading; speak as a research desk, not as financial advice.`;

export interface AskResult {
  ticker: string | null;
  found: boolean;
  answer: string;
}

/** Answer a free-form question about a desk decision, grounded in the journal. */
export async function askDesk(
  question: string,
  opts: { model?: string; contextHint?: string } = {},
): Promise<AskResult> {
  const journal = await readJournal().catch(() => [] as DeskDecision[]);
  const known = [...new Set(journal.map((d) => d.ticker))];
  // Resolve the ticker from the question; fall back to context (e.g. the post being replied to).
  const ticker = extractTicker(question, known) ?? (opts.contextHint ? extractTicker(opts.contextHint, known) : null);

  if (!ticker) {
    return {
      ticker: null,
      found: false,
      answer:
        "I couldn't tell which company you're asking about. Name a ticker or company — e.g. \"why are we holding KO?\" or \"what's the risk on NVDA?\".",
    };
  }

  const entry = latestDecisionFor(journal, ticker);
  if (!entry) {
    return {
      ticker,
      found: false,
      answer: `The desk hasn't logged a decision on ${ticker} yet, so there's no reasoning to explain. It only covers the current watchlist.`,
    };
  }

  const prompt = `Recorded research for the desk's most recent ${ticker} decision:\n\n${buildGrounding(entry)}\n\n---\nTeammate's question: ${question}\n\nAnswer as the desk's analyst, grounded only in the research above.`;
  const { response } = await withRateLimitRetry(() =>
    callLlm(prompt, { systemPrompt: DESK_PERSONA, model: opts.model ?? DEFAULT_MODEL }),
  );
  const text = typeof response === 'string' ? response : String((response as { content?: string })?.content ?? '');
  return { ticker, found: true, answer: text.trim() };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Either: ask.ts TICKER "question..."  or  ask.ts "free-form question..."
  const question = argv.length > 1 && /^[A-Za-z]{1,5}$/.test(argv[0]) ? `${argv[0].toUpperCase()} — ${argv.slice(1).join(' ')}` : argv.join(' ');
  if (!question) {
    console.error('usage: bun run src/desk/ask.ts [TICKER] "your question"');
    process.exit(1);
  }
  askDesk(question)
    .then((r) => console.log(r.answer))
    .catch((e) => {
      console.error(e instanceof Error ? e.stack : String(e));
      process.exit(1);
    });
}
