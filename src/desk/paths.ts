/**
 * Shared filesystem paths for "The Desk" — the multi-agent investment committee.
 *
 * Everything the Desk persists (trade journal, learned playbook) lives under the
 * PAI trading memory directory so it sits alongside the _ALPACA audit trail and a
 * future unified ledger can merge them. Paths are env-overridable; never hardcode
 * a home directory inline elsewhere — import from here.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** PAI root. Mirrors the resolution used by the _ALPACA CLI. */
export const PAI_DIR = process.env.PAI_DIR || join(homedir(), '.claude', 'PAI');

/** Where the Desk + Alpaca persist trading state. */
export const TRADING_DIR = join(PAI_DIR, 'MEMORY', 'TRADING');

/**
 * Append-only decision log written by the committee (one JSON line per decision).
 * Override with DESK_JOURNAL_PATH (used for isolated tests).
 */
export const JOURNAL_PATH = process.env.DESK_JOURNAL_PATH || join(TRADING_DIR, 'desk-journal.jsonl');

/**
 * Distilled "what works / what fails" methods, fed back into the committee.
 * Override with DESK_PLAYBOOK_PATH.
 */
export const PLAYBOOK_PATH = process.env.DESK_PLAYBOOK_PATH || join(TRADING_DIR, 'playbook.md');

/**
 * The guardrailed _ALPACA paper-trading CLI. The Desk shells this for execution
 * rather than re-implementing the order path — all caps/allowlist/paper-only
 * enforcement stays in one place. Override with ALPACA_CLI for tests.
 */
export const ALPACA_CLI =
  process.env.ALPACA_CLI || join(homedir(), '.claude', 'skills', '_ALPACA', 'Tools', 'Alpaca.ts');
