#!/usr/bin/env bun
/**
 * The Desk bot — makes the research group interactive in Discord.
 *
 * @mention the bot (or reply to one of its decision posts) and ask anything in
 * plain English — "why are we still holding KO?", "what's the risk on NVDA?".
 * It resolves the ticker, pulls the desk's recorded research for that decision,
 * and answers AS the desk's analyst, grounded only in what was journaled
 * (see ask.ts). Read-only: it never trades and never fetches fresh data.
 *
 * Run as an always-on service (scripts/desk-bot.service). Requires:
 *   DESK_DISCORD_BOT_TOKEN  — a bot token with the Message Content intent enabled.
 */
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { askDesk } from './ask.js';

const token = process.env.DESK_DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DESK_DISCORD_BOT_TOKEN is not set — cannot start the Desk bot.');
  process.exit(1);
}

/** Split a reply into Discord's 2000-char messages on line boundaries. */
function chunk(message: string, limit = 1900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of message.split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (cur.length + piece.length + 1 > limit) {
      if (cur) out.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [message.slice(0, limit)];
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => console.log(`🟢 Desk bot online as ${c.user.tag}`));

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    const me = client.user;
    const mentioned = me ? msg.mentions.users.has(me.id) : false;

    // Also respond when someone replies directly to one of the bot's own posts.
    let isReplyToMe = false;
    let referenced = '';
    if (msg.reference?.messageId) {
      const ref = await msg.fetchReference().catch(() => null);
      if (ref) {
        isReplyToMe = ref.author.id === me?.id;
        referenced = ref.content;
      }
    }
    if (!mentioned && !isReplyToMe) return;

    const question = msg.content.replace(/<@!?\d+>/g, '').trim();
    if (!question) {
      await msg.reply('Ask me about a name on the watchlist — e.g. "why are we holding KO?" or "what\'s the risk on NVDA?"');
      return;
    }

    await msg.channel.sendTyping().catch(() => {});
    // The replied-to post (if any) is a ticker hint, so "why?" works without naming the symbol.
    const { answer } = await askDesk(question, { contextHint: referenced });
    const parts = chunk(answer);
    for (const part of parts) await msg.reply(part);
  } catch (e) {
    console.error('Desk bot error:', e instanceof Error ? e.stack : String(e));
    await msg.reply('The desk hit an error pulling that up — try again in a moment.').catch(() => {});
  }
});

client.login(token);
