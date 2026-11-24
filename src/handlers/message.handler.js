const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const agent = require('../agents/renessence.agent');
const logger = require('../utils/logger');
const db = require('../data/database');
const introPromoService = require('../services/intro-promo.service');
const teamQueue = require('../services/team-queue.service');
const { isBotPaused } = require('../routes/dashboard.routes');
const { TEXT_ONLY_ACK } = require('../config/non-text');
const teamContext = require('../agents/team-context');

// H5: per-user lock — prevents concurrent agent.run() for the same phone number
const { withUserLock } = require('../utils/user-lock');

// ---- Staying out of a colleague's conversation ----
// Tara, 4 Nov 2026: the chat was handed back to the bot six minutes after a
// colleague's message; the guest's reaction was answered by the bot, which
// contradicted the colleague, and she was never told the AI was answering
// again. A guest message that arrives within TEAM_REPLY_HOLD_MIN minutes of a
// colleague's last message stays with the team (0 = off).
function teamReplyHoldMin() {
  const n = parseInt(process.env.TEAM_REPLY_HOLD_MIN ?? '30', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/**
 * The colleague's message this guest is writing after, or null — when the bot
 * or nobody wrote last, on the website chat, and on any database error (the
 * bot then behaves exactly as before).
 */
async function colleagueThreadFor(from) {
  if (String(from).startsWith('web_')) return null;
  try {
    return teamContext.colleagueThread(await db.getLastOutboundMessage?.(from), new Date());
  } catch (err) {
    logger.warn(`[${from}] colleague check failed (ignored):`, err.message);
    return null;
  }
}

const withinHold = (thread) => {
  const hold = teamReplyHoldMin();
  return !!thread && hold > 0 && thread.minutesAgo < hold;
};

/** The bot answers after a colleague: the team checks when their message is recent or holds an open question. */
function flagColleagueThread(from, thread, what) {
  if (!(thread.recent || thread.question)) return;
  const of = teamContext.stamp(thread.question ? thread.question.at : thread.at);
  db.setNeedsReply(from, `${what} after a colleague's message of ${of} — the bot answered, please check`);
}

/** Back to the team: paused again (no takeover notice — they were already told), flagged. */
async function holdForTeam(from, name, thread) {
  await db.pauseConversation(from, name);
  db.setNeedsReply(from, `Guest replied ${Math.max(0, Math.round(thread.minutesAgo))} min after your message — bot paused again`);
  logger.info(`[${from}] Reply ${Math.round(thread.minutesAgo)} min after a colleague — kept for the team, bot paused again`);
}

async function handle(incomingMessage) {
  const { from, name, text, buttonReply, listReply } = incomingMessage;

  // Determine what the user said
  let userMessage;
  if (text) {
    userMessage = text;
  } else if (buttonReply?.id || listReply?.id) {
    userMessage = agent.decodeInput(buttonReply, listReply);
  } else {
    const lang = conversationService.get(from)?.lang || 'en';
    return handleNonText({
      from, name, type: incomingMessage.type || 'unsupported',
      ack: lang === 'nl' ? TEXT_ONLY_ACK.nl : TEXT_ONLY_ACK.en,
    });
  }

  // Record an explicit booking-confirmation tap so book_appointment can verify
  // the customer actually confirmed (hard gate against skipping the confirmation).
  if (buttonReply?.id === 'confirm_booking') {
    // A fresh tap opens a fresh gate: reset the per-confirmation usage so the
    // agent's "close a used gate at the next turn" sweep doesn't eat this tap.
    conversationService.set(from, { bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
  }

  // Remember whether the guest picked a specific therapist ("staff_<id>") or
  // "any" — a paid booking may only switch therapist when they didn't choose.
  const tappedId = buttonReply?.id || listReply?.id || '';
  if (tappedId.startsWith('staff_')) {
    conversationService.set(from, { therapistChoice: tappedId === 'staff_any' ? 'any' : Number(tappedId.slice(6)) || 'any' });
  }

  // Same hard gate for CANCELLING — the destructive one. Without this the model
  // could cancel a real booking off an ambiguous message (a customer asking
  // "did anyone cancel? is a later time possible?" had her booking destroyed).
  // cancel_appointments refuses to run unless this tap was recorded.
  if (buttonReply?.id === 'confirm_cancel') {
    conversationService.set(from, { cancelConfirmedAt: Date.now() });
  }

  // H1: block __RESUME__ from external WhatsApp users — only the dashboard may send it
  if (userMessage.startsWith('__RESUME__')) {
    logger.warn(`[${from}] External __RESUME__ attempt blocked`);
    return;
  }

  logger.info(`[${from}] ${name}: ${userMessage}`);

  // Always update the conversation record (upsert)
  db.logConversation(from, name, null, null);

  // Blocked number (fraud): record the incoming message so the team can still
  // see it in the dashboard, but do NOT run the bot and do NOT reply. Silent —
  // the sender gets no response and cannot book. Takes precedence over pause.
  if (await db.isBlocked(from)) {
    db.logMessage(from, 'user', userMessage);
    logger.info(`[${from}] Blocked number — message saved, bot silent`);
    return;
  }

  // Auto-unarchive: if this conversation was archived, move it back to the active inbox
  db.unarchiveConversation(from).catch(err =>
    logger.warn('Auto-unarchive error:', err.message)
  );

  // H11: global kill-switch check
  if (isBotPaused()) {
    logger.info(`[${from}] Bot globally paused — message dropped`);
    return;
  }

  // Per-customer pause check
  const paused = await db.isPaused(from);
  if (paused) {
    // Agent won't run, so we log the message here — and the team is the only
    // one who will answer, so the guest now needs a reply from us.
    await db.logMessage(from, 'user', userMessage);
    db.setNeedsReply(from, 'New message — bot is paused');
    // Their message re-opened WhatsApp's 24h window: deliver any team reply
    // that was waiting for exactly that.
    await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
    logger.info(`[${from}] Bot paused — message saved, agent skipped`);
    return;
  }

  // A colleague wrote last. Within the hold the message is theirs to answer,
  // although the bot was switched back on. Later the bot answers, and its
  // first reply says the AI is answering again — with the colleague's
  // question, if the guest never answered it — and the team is flagged.
  const thread = await colleagueThreadFor(from);
  if (withinHold(thread)) {
    await db.logMessage(from, 'user', userMessage);
    await holdForTeam(from, name, thread);
    await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
    return;
  }
  if (thread) {
    // Not again for the same colleague message: a second guest message can
    // arrive while the first reply (which carried the line) is being sent,
    // before that reply is logged (found in review).
    if (conversationService.get(from)?.replyPrefixShownFor !== thread.at.getTime()) {
      conversationService.set(from, { replyPrefix: teamContext.replyPrefix(thread), replyPrefixFor: thread.at.getTime() });
    }
    flagColleagueThread(from, thread, 'Guest wrote');
  } else if (conversationService.get(from)?.replyPrefix) {
    // One a reply never used (a payment link went out instead) is stale now.
    conversationService.update(from, { replyPrefix: null });
  }

  // Campaign intro (the PT promotion, 19 Oct – 1 Nov 2026): once per guest,
  // only at the start of a fresh conversation, sent BEFORE the agent's answer
  // so it reads as "before we help you". Inside the guest's lock, so a quick
  // second message can't be answered before the first; before the agent logs
  // this inbound (the fresh-conversation check relies on that); never on a
  // button/list tap (that always answers an earlier bot message); and its
  // failure must never block normal handling.
  const isTap = !!(buttonReply?.id || listReply?.id);
  const promoThenAgent = async () => {
    try {
      await introPromoService.maybeSendIntroPromo(from, { text: userMessage, isTap });
    } catch (err) {
      logger.warn('Intro promo error (ignored):', err.message);
    }
    return agent.run(from, name, userMessage);
  };

  // When not paused, the agent logs the message itself (after its DB restore,
  // so the restore doesn't incorrectly treat new customers as returning ones)
  try {
    await withUserLock(from, promoThenAgent);
    // A team reply parked for this guest (24h window) goes out now too.
    await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
  } catch (err) {
    logger.error('Agent unhandled error:', err.message, err.stack);
    // A payment link created before the crash still reaches the guest.
    try { if (await agent.deliverPendingPayFirstLink?.(from)) return; } catch (_) { /* fall through */ }
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl'
      ? 'Er ging iets mis. Probeer het opnieuw of stuur een bericht naar welcome@renessence.com.'
      : 'Something went wrong. Please try again or reach us at welcome@renessence.com.');
  }
}

/**
 * A guest message the bot can't answer as text (a photo without caption, a
 * sticker, a video…). It still counts as the guest writing: it re-opens
 * WhatsApp's 24h window (so parked team replies go out), and on a paused chat
 * it is the team's to answer — no automatic reply then.
 * @param {{from:string,name?:string,type:string,alreadyLogged?:boolean,ack?:string}} m
 */
async function handleNonText({ from, name, type, alreadyLogged = false, ack = null }) {
  db.logConversation(from, name, null, null);
  if (!alreadyLogged) await db.logMessage(from, 'user', `[${type} message]`);
  if (await db.isBlocked(from)) return;
  db.unarchiveConversation(from).catch(err => logger.warn('Auto-unarchive error:', err.message));

  const paused = await db.isPaused(from);
  // A photo or sticker in reply to a colleague stays with them too (Tara, 4
  // Nov 2026). Not checked while the bot is paused globally — as for text, so
  // that pause never leaves this one chat paused afterwards (found in review).
  const thread = paused || isBotPaused() ? null : await colleagueThreadFor(from);
  if (paused) {
    db.setNeedsReply(from, `New ${type} — bot is paused`);
  } else if (withinHold(thread)) {
    await holdForTeam(from, name, thread);
  } else if (ack && !isBotPaused()) {
    // Later than the hold: often the answer the colleague asked for (a photo
    // of a gift card). The team is told; the automatic ack is not a reply,
    // so the colleague's message stays the last one (getLastOutboundMessage).
    if (thread) flagColleagueThread(from, thread, `Guest sent a ${type}`);
    try {
      await whatsappService.sendText(from, ack);
      // Logged so the chat reads as answered (the outage catch-up replays
      // unanswered guest messages — it must not "answer" a sticker).
      await db.logMessage(from, 'assistant', ack);
    } catch (err) {
      logger.warn('Non-text ack failed:', err.message);
    }
  }
  await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
}

module.exports = { handle, handleNonText };
