/**
 * alpaca-exec — the Desk's execution seam.
 *
 * A thin wrapper that shells the guardrailed _ALPACA paper-trading CLI
 * (`bun .../Alpaca.ts <cmd>`) and parses its JSON output. We deliberately do NOT
 * re-implement any guardrail here: the allowlist, notional caps, daily limit,
 * no-naked-shorts rule, and the paper-only hard-pin all live in that CLI's order
 * path. This module's only job is to invoke it and surface a refusal AS a
 * refusal — never to work around one.
 *
 * Exposes both:
 *   - typed direct functions (account/positions/quote/placeOrder) for the Desk
 *     orchestrator, and
 *   - a `createAlpacaExecTool()` DynamicStructuredTool registered with the agent
 *     so the conversational Dexter can also read the account and place paper
 *     orders, bounded by the same code-enforced rails.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '@/utils';
import { ALPACA_CLI, PAI_DIR } from '@/desk/paths';

// --- Result discriminated union ---------------------------------------------

export interface ExecOk<T> {
  ok: true;
  data: T;
}
/** A guardrail tripped (off-allowlist, over-cap, daily limit, naked short, …). */
export interface ExecRefused {
  ok: false;
  refused: true;
  reason: string;
}
/** Anything else — missing creds, network, bad output. */
export interface ExecError {
  ok: false;
  refused: false;
  error: string;
}
export type ExecResult<T> = ExecOk<T> | ExecRefused | ExecError;

// --- Parsed shapes (mirror Alpaca.ts `out()` payloads) ----------------------

export interface AccountInfo {
  equity: string;
  buying_power: string;
  cash: string;
  status: string;
}
export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}
export interface Quote {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
}
export interface OrderResult {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  type: string;
  status: string;
  order_class?: string;
}
/** A row from the `orders` listing (id/symbol/side/type/order_class/status). */
export interface OrderInfo {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  type: string;
  order_class: string;
  status: string;
}
export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}
export interface GuardrailInfo {
  paper_only: boolean;
  allowlist: string[];
  max_position_notional: number;
  max_total_notional: number;
  max_daily_orders: number;
  allow_short: boolean;
  audit_log: string;
}

// --- Core runner ------------------------------------------------------------

/**
 * Run the Alpaca CLI with the given args. Resolves to a discriminated result;
 * never throws for an expected refusal so callers can journal it.
 */
async function runAlpaca<T>(args: string[]): Promise<ExecResult<T>> {
  try {
    const proc = Bun.spawn(['bun', ALPACA_CLI, ...args], {
      env: { ...process.env, PAI_DIR },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    if (code === 0) {
      try {
        return { ok: true, data: JSON.parse(stdout) as T };
      } catch {
        return { ok: false, refused: false, error: `unparseable Alpaca output: ${stdout.slice(0, 300)}` };
      }
    }

    const msg = (stderr || stdout).trim();
    // The CLI exits 2 and prints "REFUSED: …" for every tripped guardrail.
    if (code === 2 || /^REFUSED:/.test(msg)) {
      return { ok: false, refused: true, reason: msg.replace(/^REFUSED:\s*/, '') };
    }
    return { ok: false, refused: false, error: msg || `alpaca exited with code ${code}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`[alpaca-exec] spawn failed: ${message}`);
    return { ok: false, refused: false, error: `failed to run Alpaca CLI: ${message}` };
  }
}

// --- Typed direct functions (used by the Desk orchestrator) -----------------

export const account = () => runAlpaca<AccountInfo>(['account']);
export const positions = () => runAlpaca<Position[]>(['positions']);
export const guardrails = () => runAlpaca<GuardrailInfo>(['guardrails']);
export const quote = (symbol: string) => runAlpaca<Quote>(['quote', symbol.toUpperCase()]);
export const clock = () => runAlpaca<Clock>(['clock']);
/** List orders, optionally filtered by status (e.g. 'open'). */
export const orders = (status?: string) =>
  runAlpaca<OrderInfo[]>(status ? ['orders', '--status', status] : ['orders']);

/** Find the current open position for a symbol, or null. Returns null on error. */
export async function positionFor(symbol: string): Promise<Position | null> {
  const res = await positions();
  if (!res.ok) return null;
  return res.data.find((p) => p.symbol === symbol.toUpperCase()) ?? null;
}

/** Protective bracket legs for a long entry: take-profit above, stop-loss below. */
export interface BracketLegs {
  takeProfit: number;
  stop: number;
}

export function placeOrder(
  side: 'buy' | 'sell',
  symbol: string,
  qty: number,
  limit?: number,
  bracket?: BracketLegs,
): Promise<ExecResult<OrderResult>> {
  const args = [side, symbol.toUpperCase(), String(qty)];
  if (limit !== undefined) args.push('--limit', String(limit));
  // Bracket exits are buy-only; the CLI rejects them on a sell.
  if (bracket && side === 'buy') {
    args.push('--take-profit', String(bracket.takeProfit), '--stop', String(bracket.stop));
  }
  return runAlpaca<OrderResult>(args);
}

/**
 * Attach a protective OCO exit (take-profit + stop-loss) to an already-held long.
 * Used by the reconcile monitor for positions not opened via a bracket buy.
 */
export function protect(symbol: string, takeProfit: number, stop: number): Promise<ExecResult<OrderResult>> {
  return runAlpaca<OrderResult>(['protect', symbol.toUpperCase(), '--take-profit', String(takeProfit), '--stop', String(stop)]);
}

// --- Agent-facing tool ------------------------------------------------------

export const ALPACA_EXEC_DESCRIPTION = `
Read the Alpaca PAPER trading account and place/cancel guardrailed paper orders.

This is PAPER trading (fake money, real market data). Every write is bounded by hard,
code-enforced guardrails: paper-only endpoint, a symbol allowlist, per-symbol and
portfolio notional caps, a daily order limit, and no naked shorts. An order that
violates a rail is REFUSED — report the refusal, never try to route around it.

## Actions
- account     → equity, buying power, cash
- positions   → open positions + unrealized P&L
- quote       → latest bid/ask/last (requires \`symbol\`)
- guardrails  → print the active limits/allowlist
- buy / sell  → place a guardrailed paper order (requires \`symbol\` and \`qty\`; optional \`limit\`)

## When NOT to use
- Live/real-money trading (this surface is paper-only by construction)
- Robinhood (use the robinhood-trading MCP)
`.trim();

const AlpacaExecInputSchema = z.object({
  action: z.enum(['account', 'positions', 'quote', 'guardrails', 'buy', 'sell']),
  symbol: z.string().optional().describe('Ticker symbol (required for quote/buy/sell).'),
  qty: z.number().optional().describe('Share quantity (required for buy/sell).'),
  limit: z.number().optional().describe('Optional limit price; omit for a market order.'),
});

export function createAlpacaExecTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'alpaca_paper',
    description: ALPACA_EXEC_DESCRIPTION,
    schema: AlpacaExecInputSchema,
    func: async (input) => {
      const { action, symbol, qty, limit } = input;
      const render = (res: ExecResult<unknown>): string => {
        if (res.ok) return formatToolResult(res.data);
        if (res.refused) return formatToolResult({ refused: true, reason: res.reason });
        return formatToolResult({ error: res.error });
      };
      switch (action) {
        case 'account':
          return render(await account());
        case 'positions':
          return render(await positions());
        case 'guardrails':
          return render(await guardrails());
        case 'quote':
          if (!symbol) return formatToolResult({ error: 'quote requires a symbol' });
          return render(await quote(symbol));
        case 'buy':
        case 'sell':
          if (!symbol || qty === undefined) {
            return formatToolResult({ error: `${action} requires symbol and qty` });
          }
          return render(await placeOrder(action, symbol, qty, limit));
        default:
          return formatToolResult({ error: `unknown action: ${String(action)}` });
      }
    },
  });
}
