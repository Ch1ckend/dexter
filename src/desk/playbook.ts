/**
 * The playbook — the committee's self-authored "what works / what fails" memory.
 *
 * Written by the learning pass (src/desk/learn.ts) from the graded journal, read
 * by the debate (src/desk/debate.ts) and injected into every role prompt. This is
 * the loop that lets the Desk learn from its own track record and form methods.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PLAYBOOK_PATH, TRADING_DIR } from './paths.js';

/** Load the current playbook markdown, or '' if none exists yet. */
export async function loadPlaybook(): Promise<string> {
  try {
    return await readFile(PLAYBOOK_PATH, 'utf8');
  } catch {
    return '';
  }
}

/** Persist the playbook markdown. */
export async function savePlaybook(markdown: string): Promise<void> {
  await mkdir(TRADING_DIR, { recursive: true }).catch(() => {});
  await writeFile(PLAYBOOK_PATH, markdown, 'utf8');
}

/** Render the playbook as an injectable prompt block (empty string if none). */
export function playbookBlock(playbook: string): string {
  const trimmed = playbook.trim();
  if (!trimmed) return '';
  return `## Learned playbook (methods distilled from our own past trades — weigh these)\n${trimmed}\n`;
}
