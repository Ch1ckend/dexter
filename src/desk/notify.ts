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

async function postDiscord(message: string): Promise<boolean> {
  const url = process.env.DESK_DISCORD_WEBHOOK;
  if (!url) return false;
  try {
    // Discord webhooks expect { content }, capped at 2000 chars.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message.slice(0, 1900) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fire all configured channels concurrently. Returns which ones accepted. */
export async function notify(message: string): Promise<{ pulse: boolean; discord: boolean }> {
  const [pulse, discord] = await Promise.all([postPulse(message), postDiscord(message)]);
  return { pulse, discord };
}
