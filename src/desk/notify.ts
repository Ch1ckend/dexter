/**
 * Best-effort notifications for the Desk's unattended runs. Fires any channel
 * that's configured and never throws — a missing/unreachable channel must not
 * fail a trading run.
 *
 *   - Pulse (local DA dashboard):  PULSE_URL (default http://localhost:31337/notify)
 *   - Discord (headless/VPS):      DESK_DISCORD_WEBHOOK (a channel webhook URL)
 *
 * On the Mac, Pulse is reachable and Discord usually isn't set. On the VPS,
 * Pulse's localhost won't exist (it no-ops) and Discord carries the summary.
 */
const PULSE_URL = process.env.PULSE_URL || 'http://localhost:31337/notify';

async function postPulse(message: string): Promise<boolean> {
  try {
    const res = await fetch(PULSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, voice_enabled: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Split on line boundaries into chunks that fit Discord's 2000-char content cap. */
function chunkForDiscord(message: string, limit = 1900): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of message.split('\n')) {
    // A single over-long line is hard-sliced; normal lines pack greedily.
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (cur.length + piece.length + 1 > limit) {
      if (cur) chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

async function postDiscord(message: string): Promise<boolean> {
  const url = process.env.DESK_DISCORD_WEBHOOK;
  if (!url) return false;
  try {
    // Discord webhooks expect { content }, capped at 2000 chars — post in order,
    // splitting long summaries so the full per-name reasoning always lands.
    let allOk = true;
    for (const content of chunkForDiscord(message)) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      allOk = allOk && res.ok;
    }
    return allOk;
  } catch {
    return false;
  }
}

/** Fire all configured channels concurrently. Returns which ones accepted. */
export async function notify(message: string): Promise<{ pulse: boolean; discord: boolean }> {
  const [pulse, discord] = await Promise.all([postPulse(message), postDiscord(message)]);
  return { pulse, discord };
}
