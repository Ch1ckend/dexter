/**
 * The Desk's research data-source layer. Plain typed clients (not LLM tools) —
 * the researcher modules call these deterministically to assemble raw intel,
 * then synthesize it with a single LLM call. Code before prompts.
 */
export * from './edgar.js';
export * from './finnhub.js';
export * from './fred.js';
export * from './marketaux.js';
export * from './brave.js';
export * from './congress.js';

const ready = (k?: string): boolean => !!k && !k.startsWith('your-');

/** Which research sources currently have working credentials. */
export function sourceStatus(): Record<string, boolean> {
  return {
    edgar: true, // keyless (UA only)
    perplexity: ready(process.env.PERPLEXITY_API_KEY),
    finnhub: ready(process.env.FINNHUB_API_KEY),
    fred: ready(process.env.FRED_API_KEY),
    marketaux: ready(process.env.MARKETAUX_API_KEY),
    brave: ready(process.env.BRAVE_API_KEY),
    congress: ready(process.env.FMP_API_KEY), // FMP-backed congressional trades (free tier)
  };
}
