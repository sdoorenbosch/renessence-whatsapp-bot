/**
 * Renessence AI Agent
 * Uses OpenAI function calling to handle the entire conversation.
 * The AI decides what to do, which tools to call, and generates all responses.
 */

const OpenAI = require('openai');
const config = require('../config');
const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const { TOOLS } = require('./tool-definitions');
const { buildSystemPrompt } = require('./system-prompt');
const payFirst = require('../services/pay-first.service');
const paymentService = require('../services/payment.service');
const {
  toolCheckAvailability,
  toolLookupClient,
  toolBookAppointment,
  toolSendPayment,
  toolGetAppointments,
  toolCancelAppointments,
  toolCheckClassSchedule,
  toolBookClass,
  toolHumanHandoff,
  toolForwardGiftCard,
  toolCheckGiftCard,
  toolForwardReschedule,
  executeRespond,
  sendPendingLookup,
  emailQuestion,
  webCallbacks,
  closeUsedConfirmation,
  firstNameOf,
  sameGuestName,
} = require('./tool-implementations');
const { decodeInput } = require('./input-decoder');
const { toHistory } = require('./team-context');
const replyGuards = require('./reply-guards');
const { rangeDays } = require('../utils/calendar');
const db = require('../data/database');
const outageAlert = require('../services/outage-alert.service');
const introPromo = require('../services/intro-promo.service');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ---- Main agent runner ----

/**
 * @param {object} [opts]
 * @param {{hoursAgo:number}} [opts.catchUp] Replay of a message the assistant
 *   missed while it was down. The message is already stored (it was saved when
 *   it arrived), so it is not logged again, and the model is told to open with
 *   one short apology before answering it normally.
 */
/**
 * Send a pay-first payment link created in this turn that no reply carried —
 * but only if its booking row is still open (a link closed later in the same
 * turn must never go out).
 */
/**
 * Who a book_appointment call is for: first name + email. Two guests sharing
 * one email ("use mine for her too") are still two people.
 */
function personKey(a) {
  return `${firstNameOf(a?.client_name || '')}|${String(a?.client_email || '').trim().toLowerCase()}`;
}

async function deliverPendingPayFirstLink(from) {
  const pending = conversationService.get(from)?.payFirstLinkPending;
  if (!pending || String(from).startsWith('web_')) return false;
  conversationService.update(from, { payFirstLinkPending: null });
  let row = await db.getBookingEventById(pending.rowId).catch(() => null);
  if (!row) row = await db.getBookingEventById(pending.rowId).catch(() => null);
  // Rows are never deleted: unreadable = DB hiccup → still send. Only a row
  // that was read and is no longer open is withheld.
  if (row && row.status !== 'awaiting_payment') return false;
  conversationService.update(from, { payFirstLinkSentAt: Date.now() });
  await payFirst.sendGuestMessage(from, pending.text, { ctaLabel: pending.ctaLabel, ctaUrl: pending.url });
  return true;
}

async function run(from, name, userMessage, opts = {}) {
  const catchUp = opts.catchUp || null;
  // Ensure conversation state. Taps the handler records (Confirm, cancel,
  // therapist) and server-sent pay-first messages can create a bare in-memory
  // entry before this point — only run() marks a conversation as restored.
  const existing = conversationService.get(from);
  const isNew = !existing || !existing.hydrated;
  let restoredFromDb = false;
  let historyUnavailable = false;
  if (isNew) {
    // The handler may have just recorded a Confirm tap for this very message —
    // set() merges, so that gate survives this initialisation.
    conversationService.set(from, { userName: name, lang: existing?.lang || 'en', hydrated: true });

    // In-memory state lives 30 minutes, but WhatsApp customers routinely reply
    // hours or days later. Bring back what the server-side guards need — the
    // slots this customer was genuinely offered, and their language — so a
    // late "Confirm" books instead of bouncing through re-check/re-confirm
    // rounds (Maria incident). Staleness is safe: Mindbody re-verifies the
    // slot at booking time; the offer list only blocks INVENTED datetimes.
    try {
      const saved = await db.loadConversationState(from);
      if (saved) {
        const nowIso = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 16);
        const liveOffers = (saved.offeredSlots || []).filter(s => String(s.dateTime).slice(0, 16) >= nowIso);
        conversationService.set(from, {
          ...(liveOffers.length ? { offeredSlots: liveOffers } : {}),
          ...(saved.lang ? { lang: saved.lang } : {}),
        });
      }
    } catch (err) {
      logger.warn(`[${from}] conversation state restore failed:`, err.message);
    }

    // Restore last 10 messages from DB so the bot has context after a
    // server restart or 30-min TTL expiry — prevents random greetings mid-convo.
    // One retry: a swallowed transient DB error here once made the bot greet a
    // customer from scratch right after she tapped "Confirm".
    for (let attempt = 1; attempt <= 2 && !restoredFromDb; attempt++) {
      try {
        const rows = await db.getMessagesByPhone(from, 10, { strict: true });
        if (rows && rows.length > 0) {
          // The DB log is the truth and already holds any server message a
          // bare entry carries: replace instead of appending.
          conversationService.set(from, { messages: [] });
          // A colleague's messages ('team' / 'agent') come back as assistant
          // turns labelled as written by staff, with their date (Tara, 4 Nov
          // 2026: unlabelled, the bot took them for its own and contradicted
          // them). Dashboard notes are left out.
          for (const msg of toHistory(rows)) conversationService.addMessage(from, msg.role, msg.content);
          // A campaign intro sent right before this message is not an earlier
          // conversation: a brand-new guest must still get the AI welcome.
          restoredFromDb = rows.some(r => !introPromo.isPromoMessage(r.content, r.campaign_id));
        }
        break;
      } catch (err) {
        logger.warn(`[${from}] history restore attempt ${attempt} failed:`, err.message);
        if (attempt === 2) historyUnavailable = true;
      }
    }
  } else {
    conversationService.update(from, { userName: name });
  }

  // Close a confirmation gate that was used in a PREVIOUS turn. A fresh Confirm
  // tap resets bookingConfirmUsed in the handler, so this never eats a new tap.
  closeUsedConfirmation(from);
  // A pay-first link is only ever delivered in the turn that created it, and
  // a lookup's list only goes out in the turn that made it.
  // The guest's own words in this turn: get_appointments falls back on them
  // when the model leaves customer_expects empty (Tara, 19 Nov 2026).
  conversationService.update(from, { payFirstLinkPending: null, lookupReply: null, turnGuestText: userMessage });
  const turnStartedAt = Date.now();

  // The guest's pay-first bookings (awaiting payment / paid / booked) — the
  // model can't see the server's own payment messages otherwise.
  let payFirstStatus = null;
  try { payFirstStatus = await payFirst.statusLine(from); } catch (_) { payFirstStatus = null; }

  // Add user message to history
  // __RESUME__ is an internal trigger — don't log it to DB as a customer message
  const isResumeTrigger = userMessage.startsWith('__RESUME__');
  if (catchUp) {
    // Already in the DB; the restore above normally brought it back as the
    // last history entry. Only add it in memory if it is not there yet.
    const hist = conversationService.getMessages(from);
    const last = hist[hist.length - 1];
    if (!(last && last.role === 'user' && last.content === userMessage)) {
      conversationService.addMessage(from, 'user', userMessage);
    }
  } else {
    conversationService.addMessage(from, 'user', userMessage);
    if (!isResumeTrigger) {
      db.logMessage(from, 'user', userMessage);
    }
  }

  // Build message array for OpenAI.
  // H1: wrap user messages with delimiters so the model knows they are untrusted
  // customer input — the system prompt explains not to follow instructions inside them.
  const rawHistory = conversationService.getMessages(from);
  const history = rawHistory.map(msg =>
    msg.role === 'user'
      ? { ...msg, content: `[USER MESSAGE START]\n${msg.content}\n[USER MESSAGE END]` }
      : msg
  );
  const messages = [
    { role: 'system', content: buildSystemPrompt(from, name, restoredFromDb, historyUnavailable, { payFirstStatus }) },
    ...history,
  ];
  if (catchUp) {
    messages.push({
      role: 'system',
      content: `CATCH-UP: the customer's latest message above was never answered — the assistant was unavailable for about ${catchUp.hoursAgo} hour(s) when it arrived. Begin your reply with ONE short apology for the delay (e.g. "Sorry for the late reply — our assistant was temporarily unavailable."), then handle their message exactly as you normally would. Do NOT ask them to repeat anything you can already read above, and do NOT send the first-message welcome greeting.`,
    });
  }

  const MAX_ITERATIONS = 8;
  let terminated = false;
  // A book_appointment in this turn that did NOT produce a payment link (refused,
  // "replace or both?", payment received…): its explanation must reach the guest
  // next to any link created in the same turn.
  let bookingWithoutLinkThisTurn = false;
  let respondCount = 0;
  // Handoff / reschedule / gift-card forwards that reached the team in this
  // TURN. A bounced reply (below) gives the model another round, and it must
  // not alert the team a second time. Only a forward that went through
  // counts: after a refused one ("missing_details") the model has to be able
  // to try again, or it would report something nobody received.
  const TEAM_FORWARDS = new Set(['request_human_handoff', 'forward_gift_card_request', 'forward_reschedule_request']);
  const forwardedThisTurn = new Set();
  // Kinds of reply the guards already sent back once in this turn (reply-guards.js).
  const bouncedKinds = new Set();
  // The last reply sent back to the model. If the turn then ends without a
  // new one (rounds used up on tool calls), this is still the guest's answer.
  let bouncedReply = null;
  // Touriya, 27 Sep 2026: with no email address to pass, the model made one
  // up. That is refused now (email_required / companion_email_required), and
  // the way on is to ASK the guest — so after such a refusal the booking calls
  // of this turn are not run (each is told so), and if the turn ends without
  // a reply the guest gets the question itself.
  // One exception: in a LATER round, a call that names another name or
  // address than the refused ones runs once more. The guest may have typed
  // her address already and the model left it out; "no call at all" then
  // asked her for it again. The server checks every address either way, and
  // a second round of refusals closes the door for the rest of the turn.
  const BOOKING_TOOLS = new Set(['book_appointment', 'book_class']);
  let emailRefusal = null;        // the latest such refusal
  let emailRefusalRound = -1;     // the round it came in
  let emailRefusalRounds = 0;     // how many rounds had one
  const refusedGuests = new Set();
  const guestKey = (a) => `${String(a?.client_name || '').trim().toLowerCase()}|${String(a?.client_email || '').trim().toLowerCase()}`;
  // Melanie, 23 Nov 2026: Wednesday's times went out six times as "Saturday,
  // 25th November". What the weekday check (reply-guards.js) needs to know
  // about this turn:
  //  - did a write tool DO something (its result is not an error)? From then
  //    on a reply is put right in code and never handed back: the round after
  //    a bounce comes without that tool call, which broke the second payment
  //    message of a two-person booking and let a handoff go out twice;
  //  - which days this turn's check_availability calls fetched: a rewrite
  //    that offers times under a day never fetched still carries the first
  //    day's times;
  //  - the reply that was handed back, per kind.
  const WRITE_TOOLS = new Set(['book_appointment', 'book_class', 'cancel_appointments', 'send_payment', ...TEAM_FORWARDS]);
  let wroteThisTurn = false;
  // Tara, 19 Nov 2026: after a lookup the server's list replaces a plain
  // reply — but not the reply that explains a booking, cancel or payment made
  // in the same turn (any such call that ran, whatever its result).
  const CHANGES_BOOKINGS = new Set(['book_appointment', 'book_class', 'cancel_appointments', 'send_payment']);
  let changedBookingsThisTurn = false;
  const respondOpts = () => ({ wroteThisTurn: changedBookingsThisTurn });
  const checkedDays = new Set();
  const heldBack = {};
  const guardCtx = (extra) => ({ bounced: bouncedKinds, wrote: wroteThisTurn, checkedDays, held: heldBack, ...extra });

  for (let i = 0; i < MAX_ITERATIONS && !terminated; i++) {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: config.OPENAI_MODEL || 'gpt-4o',
        messages,
        tools: TOOLS,
        tool_choice: 'required',
        max_tokens: 1024,
      });
    } catch (err) {
      logger.error('OpenAI agent call error:', err.message);
      const lang = conversationService.get(from)?.lang || 'en';

      // A persistent failure (no credits / bad key) is an OUTAGE, not a
      // hiccup: alert the team, tell the customer the truth instead of
      // "please try again", and flag the conversation for a human follow-up.
      // Transient errors keep the plain retry hint.
      let failure = { kind: 'other', notifyCustomer: true, outage: false };
      try { failure = await outageAlert.recordAgentFailure(from, name, err); } catch (_) { /* never mask the real error */ }

      if (failure.outage) db.markConversationEscalated(from, 'Assistant was unavailable — reply by hand');
      // A payment link created earlier in this turn still goes out. On an
      // outage the once-an-hour notice was just claimed for this guest, so it
      // must follow the link (or their next messages go unexplained).
      const linkSent = await deliverPendingPayFirstLink(from);
      if (linkSent && !failure.outage) return; // transient error: the link is the whole reply
      // A reply this turn handed back for a rewrite still goes out — put right
      // in code — instead of "Something went wrong" (found in review: a
      // summary refused for its missing day, then a 429 on the next call, and
      // the guest got no summary at all).
      if (!linkSent && bouncedReply) {
        const held = replyGuards.correctReply(from, bouncedReply, guardCtx());
        bouncedReply = null;
        await executeRespond(from, held, respondOpts());
        await replyGuards.onRepeat(from, held, guardCtx());
        replyGuards.onSent(from, held, guardCtx());
        // On an outage the holding notice follows, as after a link — on
        // WhatsApp; the website visitor's one answer was the reply.
        if (!failure.outage || from.startsWith('web_')) return;
      }
      // A lookup's list from this turn still goes out, instead of "Something
      // went wrong": the team may already have been told she was sent it
      // (found in review: a 429 right after a needs_team lookup).
      if (!linkSent && sendPendingLookup && await sendPendingLookup(from)) {
        if (!failure.outage || from.startsWith('web_')) return;
      }
      if (failure.outage && !failure.notifyCustomer) return; // told them within the last hour — don't answer every retry
      const errMsg = failure.outage
        ? outageAlert.holdingMessage(lang)
        : (lang === 'nl' ? 'Er ging iets mis. Probeer het opnieuw.' : 'Something went wrong. Please try again.');

      if (from.startsWith('web_') && webCallbacks.has(from)) {
        const resolve = webCallbacks.get(from);
        webCallbacks.delete(from);
        resolve({ message: errMsg, ui_type: 'text' });
      } else {
        await whatsappService.sendText(from, errMsg);
        if (failure.outage) db.logMessage(from, 'assistant', errMsg);
      }
      return;
    }

    // The model answered: if an outage was open, it is over.
    outageAlert.recordAgentSuccess().catch(() => {});

    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // Shouldn't happen with tool_choice: required, but handle it
      if (assistantMsg.content) {
        // Plain text is put right like any reply (a wrong weekday, Melanie,
        // 23 Nov 2026) — in code only: there is no respond call to hand back.
        const text = replyGuards.correctReply(from, { message: assistantMsg.content, ui_type: 'none' }, { ...guardCtx(), held: {} }).message;
        await whatsappService.sendText(from, text);
        conversationService.addMessage(from, 'assistant', text);
        bouncedReply = null; // the guest has an answer: a reply held back earlier stays unsent
      }
      break;
    }

    // Split tool calls: data/action tools vs respond
    const respondCall = assistantMsg.tool_calls.find(tc => tc.function.name === 'respond');
    const otherCalls = assistantMsg.tool_calls.filter(tc => tc.function.name !== 'respond');

    // Execute data/action tools. Read-only tools run in parallel; MUTATING
    // tools (book/cancel/payment/handoff) run SEQUENTIALLY. The model sometimes
    // emits several book_appointment calls in one turn, and running them
    // concurrently against Mindbody produced duplicate bookings / slot races.
    // We also drop exact-duplicate book_appointment calls within the same turn.
    if (otherCalls.length > 0) {
      // get_appointments is not read-only any more: it can flag the chat,
      // alert the team and keep the guest's list for the reply (Tara, 19 Nov
      // 2026). Two lookups in parallel would race the "already notified" check.
      const READ_ONLY = new Set(['check_availability', 'lookup_client', 'check_class_schedule', 'check_gift_card']);

      const runOne = async (tc) => {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (parseErr) {
          logger.error(`Failed to parse tool arguments for ${tc.function.name}:`, tc.function.arguments);
          return { id: tc.id, result: { error: 'Invalid tool arguments — JSON parse failed' } };
        }
        logger.info(`Agent tool: ${tc.function.name}`, JSON.stringify(args).substring(0, 200));
        let result;
        try {
          switch (tc.function.name) {
            case 'check_availability':   result = await toolCheckAvailability(from, args); break;
            case 'lookup_client':        result = await toolLookupClient(from); break;
            case 'book_appointment':     result = await toolBookAppointment(from, args); break;
            case 'get_appointments':     result = await toolGetAppointments(from, args); break;
            case 'cancel_appointments':  result = await toolCancelAppointments(from, args); break;
            case 'check_class_schedule': result = await toolCheckClassSchedule(from, args); break;
            case 'book_class':           result = await toolBookClass(from, args); break;
            case 'send_payment':         result = await toolSendPayment(from, args); break;
            case 'request_human_handoff':result = await toolHumanHandoff(from, name, args); break;
            case 'check_gift_card':      result = toolCheckGiftCard(args); break;
            case 'forward_gift_card_request': result = await toolForwardGiftCard(from, name, args); break;
            case 'forward_reschedule_request': result = await toolForwardReschedule(from, name, args); break;
            default:                     result = { error: `Unknown tool: ${tc.function.name}` };
          }
        } catch (err) {
          logger.error(`Tool ${tc.function.name} threw:`, err.message);
          result = { error: err.message };
        }
        return { id: tc.id, result };
      };

      const readCalls = otherCalls.filter(tc => READ_ONLY.has(tc.function.name));
      const writeCalls = otherCalls.filter(tc => !READ_ONLY.has(tc.function.name));
      const collected = [];

      // Read-only tools: safe to parallelize.
      if (readCalls.length > 0) {
        collected.push(...await Promise.all(readCalls.map(runOne)));
        // The days these availability checks fetched (see guardCtx). A call
        // that was refused (its weekday), failed or stopped (repeated
        // failures) fetched nothing.
        for (const tc of readCalls) {
          if (tc.function.name !== 'check_availability') continue;
          const result = collected.find(c => c.id === tc.id)?.result;
          if (!result || result.error || result.repeated_failure) continue;
          let a;
          try { a = JSON.parse(tc.function.arguments); } catch (_) { continue; }
          const first = String(a?.start_date || '').slice(0, 10);
          for (const day of rangeDays(first, String(a?.end_date || '').slice(0, 10) || first)) checkedDays.add(day);
        }
      }

      // Mutating tools: sequential + de-duplicated.
      // Escalation/forward/payment tools only ever need to run ONCE per turn. The
      // model sometimes fires them in a tight loop (one customer generated 8
      // identical escalation emails in 4 seconds before the loop exhausted), so
      // collapse repeats by tool name — the args vary but the spam is the same.
      const ONCE_PER_TURN = new Set([
        'request_human_handoff',
        'forward_gift_card_request',
        'forward_reschedule_request',
        'send_payment',
      ]);
      const seenBookings = new Set();
      const seenOnce = new Set();
      // Orders of 2+ treatments worth €150 or more (people count separately)
      // are arranged by the team. When the model books a whole confirmed
      // order in one turn, decide on the WHOLE order before booking any of it
      // — otherwise the first items get booked and only the last one is
      // refused (or, as with Gina & Nathalie, the rule never fires).
      const turnOrderBlocked = await (async () => {
        const items = [];
        const days = new Set();
        const seen = new Set();
        let replacing = false;
        let pfRows = [];
        try { pfRows = (await db.getPayFirstRowsForPhone?.(from)) || []; } catch (_) { pfRows = []; }
        for (const tc of writeCalls) {
          if (tc.function.name !== 'book_appointment') continue;
          let a;
          try { a = JSON.parse(tc.function.arguments); } catch (_) { continue; }
          const k = `${a.session_type_id}|${a.start_date_time}|${personKey(a)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          // A re-sent booking that already exists is answered "already
          // booked" by the tool and is already in the cart: not a new item.
          try {
            const prev = await db.getRecentBooking?.(from, a.session_type_id, a.start_date_time,
              (row) => !row?.customer_name || !a.client_name || sameGuestName(row.customer_name, a.client_name));
            if (prev?.mindbody_appointment_id) continue;
          } catch (_) { /* counts as new */ }
          // A re-sent pay-first call whose own link is still open is already
          // counted in the day total (and the tool re-shares that link).
          if (pfRows.some(r => ['awaiting_payment', 'booking'].includes(r.status)
            && Number(r.session_type_id) === Number(a.session_type_id)
            && String(r.pay_first?.startDateTime || '').slice(0, 16) === String(a.start_date_time || '').slice(0, 16)
            && (!a.client_name || !r.customer_name || sameGuestName(r.customer_name, a.client_name)))) continue;
          items.push(paymentService.getPriceInCents(a.session_type_id) || 0);
          if (a.start_date_time) days.add(String(a.start_date_time).slice(0, 10));
          if (a.replace_pending_payment) replacing = true;
        }
        if (items.length < 2) return null; // one new item: the tool's own per-call check applies
        const cart = conversationService.get(from)?.pendingBookings || [];
        let priorCount = cart.length;
        let priorCents = cart.reduce((sum, b) => sum + (Number(b.amount_cents) || 0), 0);
        // Same rule as the per-call gate: the cart or this guest's open
        // bookings that day, whichever is larger (the cart lives 30 minutes).
        if (!replacing) {
          for (const d of days) {
            try {
              const day = (await db.getOpenJourneyForDay?.(from, `${d}T00:00:00`)) || {};
              priorCount = Math.max(priorCount, day.count || 0);
              priorCents = Math.max(priorCents, day.totalCents || 0);
            } catch (_) { /* fails open: the cart decides */ }
          }
        }
        const newCents = items.reduce((sum, c) => sum + c, 0);
        const total = newCents + priorCents;
        if (total < paymentService.JOURNEY_TEAM_THRESHOLD_CENTS) return null;
        const eurTotal = `€${total / 100}`;
        const threshold = `€${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100}`;
        logger.info(`Whole order of ${items.length + priorCount} treatments (${eurTotal}) for ${from} routed to the team before booking`);
        // when_label: the day in the chat language (date_time_label is the Stripe line item's).
        const cartList = cart.map(b => `${b.service_name || b.session_type_id}${(b.when_label || b.date_time_label) ? ` ${b.when_label || b.date_time_label}` : ''}`).join('; ');
        // Unpaid pay-first links are NOT bookings: the handoff cancels them.
        const unpaid = replacing ? [] : pfRows.filter(r => r.status === 'awaiting_payment' && days.has(String(r.pay_first?.startDateTime || '').slice(0, 10)));
        const heldCount = Math.max(0, priorCount - unpaid.length);
        const unpaidPart = unpaid.length ? ` The unpaid payment link(s) for ${unpaid.map(r => r.service_name).join(', ')} are NOT booked — the handoff cancels them, so tell the customer nothing is booked or charged for them and include them in the list for the team.` : '';
        const bookedPart = heldCount > 0
          ? `The ${items.length} new treatment(s) in this step were NOT booked. What was booked earlier in this chat${cartList ? ` (${cartList})` : ''} IS booked and stays booked — tell the customer so, and don't ask the team to book it again.${unpaidPart}`
          : `NOTHING from this order was booked.${unpaidPart}`;
        return {
          error: 'journey_needs_team',
          journey_total: eurTotal,
          message: `This order totals ${eurTotal} for ${items.length + priorCount} treatments (every person counts). Orders of ${threshold} or more are arranged personally by our team — ${bookedPart} Tell the customer warmly that our team arranges an order of this size personally, ask for their email if you don't have it, then call request_human_handoff ONCE with a reason that starts with "Order of ${threshold}+ — arrange personally" listing every person, treatment, date and time still to arrange${priorCount > 0 ? ', and what is already booked' : ''}.`,
        };
      })();
      for (const tc of writeCalls) {
        if (ONCE_PER_TURN.has(tc.function.name)) {
          if (seenOnce.has(tc.function.name) || forwardedThisTurn.has(tc.function.name)) {
            logger.warn(`Skipping repeated ${tc.function.name} in same turn`);
            collected.push({ id: tc.id, result: { skipped: true, message: `${tc.function.name} already ran in this turn — do NOT call it again. Reply to the customer instead.` } });
            continue;
          }
          seenOnce.add(tc.function.name);
        }
        if (tc.function.name === 'book_appointment') {
          let key = null;
          try {
            const a = JSON.parse(tc.function.arguments);
            // Per PERSON: two guests taking the same treatment at the same time
            // are two bookings (they used to collapse into one).
            key = `${a.session_type_id}|${a.start_date_time}|${personKey(a)}`;
          } catch (_) { /* fall through to normal handling */ }
          if (key && seenBookings.has(key)) {
            logger.warn('Skipping duplicate book_appointment in same turn:', key);
            collected.push({ id: tc.id, result: { error: 'duplicate_booking_skipped', message: 'Skipped: this exact call (same treatment, time and person) was already made in this turn. It is NOT an extra booking — report only bookings whose own result shows success.' } });
            continue;
          }
          if (key) seenBookings.add(key);
          if (turnOrderBlocked) {
            collected.push({ id: tc.id, result: turnOrderBlocked });
            continue;
          }
        }
        let bookingArgs = null;
        if (BOOKING_TOOLS.has(tc.function.name)) {
          try { bookingArgs = JSON.parse(tc.function.arguments); } catch (_) { bookingArgs = {}; }
        }
        if (emailRefusal && bookingArgs) {
          const corrected = (bookingArgs.client_name || bookingArgs.client_email) && !refusedGuests.has(guestKey(bookingArgs));
          if (emailRefusalRound === i || emailRefusalRounds >= 2 || !corrected) {
            // Not run — and it says so. The first refusal can be about another
            // person ("NOTHING was booked for Nadia") or the other tool; handed
            // on word for word, the owner's own call read as if only Nadia's
            // booking was missing.
            collected.push({ id: tc.id, result: { ...emailRefusal, not_run: true, message: `This call was NOT run: an earlier booking call in this turn was refused because a name or email address is missing. Nothing was booked by this call either. After the customer has answered, send every booking call again. The earlier refusal: ${emailRefusal.message}` } });
            continue;
          }
        }
        const ran = await runOne(tc);
        if (WRITE_TOOLS.has(tc.function.name) && ran.result && !ran.result.error) wroteThisTurn = true;
        if (CHANGES_BOOKINGS.has(tc.function.name)) changedBookingsThisTurn = true;
        if (TEAM_FORWARDS.has(tc.function.name) && ran.result?.sent === true) forwardedThisTurn.add(tc.function.name);
        if (bookingArgs && ['email_required', 'companion_email_required'].includes(ran.result?.error)) {
          if (emailRefusalRound !== i) emailRefusalRounds++;
          emailRefusal = ran.result;
          emailRefusalRound = i;
          refusedGuests.add(guestKey(bookingArgs));
        }
        collected.push(ran);
      }

      for (const { id, result } of collected) {
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
      }
      for (const tc of writeCalls) {
        if (tc.function.name !== 'book_appointment') continue;
        const r = collected.find(c => c.id === tc.id)?.result;
        if (r?.error === 'duplicate_booking_skipped') continue; // same booking as a call that ran
        if (!(r && r.success && r.payFirst)) bookingWithoutLinkThisTurn = true;
      }
    }

    // Execute respond
    if (respondCall) {
      let args;
      try {
        args = JSON.parse(respondCall.function.arguments);
      } catch (parseErr) {
        // Malformed reply: never let it swallow a payment link from this turn.
        if (conversationService.get(from)?.payFirstLinkPending) break;
        throw parseErr;
      }
      logger.info('Agent respond:', args.ui_type, args.message?.substring(0, 80));
      const pend = conversationService.get(from)?.payFirstLinkPending;
      // Shanta, 1 Nov 2026: "we kunnen je afspraak verschuiven … flexibel" went
      // out as a plain reply with no tool call. A reply a guard objects to is
      // sent back to the model once; if the same objection returns, or the
      // model writes no new reply before the turn ends (see after the loop),
      // it goes out as written and the guard tells the team. Payment links
      // are never held back: with a pay-first link pending the server's own
      // message is the reply, and a cta_button reply is a payment link itself
      // (WhatsApp and website chat alike).
      let objection = null;
      if (!pend && args.ui_type !== 'cta_button') {
        objection = replyGuards.checkReply(from, args, guardCtx());
        if (objection && !bouncedKinds.has(objection.kind)) {
          bouncedKinds.add(objection.kind);
          bouncedReply = args;
          heldBack[objection.kind] = { args };
          replyGuards.onBounce(from, args, objection, guardCtx());
          logger.warn(`[${from}] reply not sent (${objection.error}) — asking the model to rewrite it`);
          messages.push({ role: 'tool', tool_call_id: respondCall.id, content: JSON.stringify({ sent: false, error: objection.error, message: objection.message }) });
          // The turn goes on, so EVERY respond call of this model message
          // needs a result: the model API rejects the next request otherwise
          // and the guest would get "Something went wrong". (Only the first
          // respond call is ever sent; until the bounce existed the turn
          // ended there and the others never needed an answer.)
          for (const tc of assistantMsg.tool_calls) {
            if (tc.function.name !== 'respond' || tc.id === respondCall.id) continue;
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ sent: false, error: 'one_reply_per_message', message: 'Not sent: put the whole reply in ONE respond call.' }) });
          }
          continue;
        }
      }
      if (bookingWithoutLinkThisTurn && pend && !pend.alsoSendModelText) {
        conversationService.update(from, { payFirstLinkPending: { ...pend, alsoSendModelText: true } });
      }
      // Melanie, 23 Nov 2026: what goes out never carries a weekday that does
      // not match its date. A reply that is not handed back (a payment link, a
      // reply sent with a booking, one that was handed back already) is put
      // right in code — the text only: a link and its button stay as they are,
      // and the server's own pay-first message is not the model's text and is
      // never touched. What is sent here is also what is stored and logged.
      // (quiet: with a pay-first link pending only the server's message goes
      // out, so a correction of the model's text is not logged as sent.)
      const modelTextGoesOut = !pend || pend.alsoSendModelText || bookingWithoutLinkThisTurn || from.startsWith('web_');
      args = replyGuards.correctReply(from, args, guardCtx({ quiet: !modelTextGoesOut }));
      await executeRespond(from, args, respondOpts());
      respondCount++;
      bouncedReply = null;
      if (objection) await replyGuards.onRepeat(from, args, guardCtx());
      // (With a pay-first link pending the server's message is the reply; the
      // model's text only goes out next to it when another booking of this
      // turn made no link.)
      if (!pend || pend.alsoSendModelText || bookingWithoutLinkThisTurn) replyGuards.onSent(from, args, guardCtx());

      // Only allow a second payment CTA if a NEW book_appointment also happened
      // in this same turn. Without a new booking there is nothing to link to,
      // so chaining would just re-send the previous link.
      const hadNewBookingThisTurn = otherCalls.some(tc => tc.function.name === 'book_appointment' || tc.function.name === 'book_class');
      // A pay-first link ends the turn: nothing may follow it.
      const payFirstLinkSentThisTurn = (conversationService.get(from)?.payFirstLinkSentAt || 0) >= turnStartedAt;
      const isChainablePayment = args.ui_type === 'cta_button'
        && !from.startsWith('web_')
        && respondCount < 3
        && hadNewBookingThisTurn
        && !payFirstLinkSentThisTurn;

      const toolResult = { sent: true };

      messages.push({ role: 'tool', tool_call_id: respondCall.id, content: JSON.stringify(toolResult) });

      if (!isChainablePayment) {
        terminated = true;
      }
    }
  }

  // A payment link created this turn that no reply carried: send it anyway.
  if (await deliverPendingPayFirstLink(from)) terminated = true;

  // A reply was sent back for a rewrite and the model never wrote a new one
  // (found in review: handoff alone in the last round). The guest gets that
  // reply and the guard tells the team — not the "no availability" text
  // below, which answers a question nobody asked. A wrong weekday in it is
  // put right in code first (Melanie, 23 Nov 2026).
  if (!terminated && bouncedReply) {
    logger.warn(`[${from}] no rewritten reply before the turn ended — sending the reply that was held back`);
    const held = replyGuards.correctReply(from, bouncedReply, guardCtx());
    await executeRespond(from, held, respondOpts());
    await replyGuards.onRepeat(from, held, guardCtx());
    replyGuards.onSent(from, held, guardCtx());
    terminated = true;
  }

  // A booking was refused for a missing email address or name and the model
  // never asked for it: ask the guest ourselves — not the "no availability"
  // text below. Sent like any reply, so it is stored (memory and dashboard)
  // and the next turn sees what was asked.
  if (!terminated && emailRefusal) {
    logger.warn(`[${from}] turn ended after ${emailRefusal.error} without a reply — sending the question`);
    await executeRespond(from, { message: emailQuestion(conversationService.get(from)?.lang || 'en', emailRefusal), ui_type: 'none' }, respondOpts());
    terminated = true;
  }

  // A lookup ran and the model never replied (rounds used up): the guest
  // still gets the server's list — not the "no availability" text below
  // (Tara, 19 Nov 2026; the team may already have been told to check).
  if (!terminated && conversationService.get(from)?.lookupReply) {
    logger.warn(`[${from}] turn ended after a lookup without a reply — sending the list`);
    await sendPendingLookup(from);
    terminated = true;
  }

  if (!terminated) {
    logger.error('Agent loop exhausted without respond for', from);
    const lang = conversationService.get(from)?.lang || 'en';
    const fallbackMsg = lang === 'nl'
      ? 'Er is geen beschikbaarheid gevonden voor die datum. Probeer een andere dag, of neem contact op via welcome@renessence.com.'
      : 'No availability was found for that date. Try a different day, or reach out to us at welcome@renessence.com.';
    if (from.startsWith('web_') && webCallbacks.has(from)) {
      const resolve = webCallbacks.get(from);
      webCallbacks.delete(from);
      resolve({ message: fallbackMsg, ui_type: 'text' });
    } else {
      await whatsappService.sendText(from, fallbackMsg);
    }
  }
}

// ---- Web chat runner ----

async function runWeb(sessionId, userMessage) {
  const webFrom = `web_${sessionId}`;
  return new Promise(async (resolve) => {
    webCallbacks.set(webFrom, resolve);
    try {
      await run(webFrom, null, userMessage);
    } catch (err) {
      logger.error('runWeb error:', err.message);
    }
    // Safety fallback if callback was never resolved
    if (webCallbacks.has(webFrom)) {
      webCallbacks.delete(webFrom);
      resolve({ message: 'Something went wrong. Please try again.', ui_type: 'text' });
    }
  });
}

/** Cheapest possible model call — used by the outage heartbeat. */
async function pingModel() {
  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
}

module.exports = {
  deliverPendingPayFirstLink, run, runWeb, decodeInput, pingModel };
