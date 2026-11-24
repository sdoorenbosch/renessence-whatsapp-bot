/**
 * Checks on a reply the model wants to send, run by the agent loop right
 * before executeRespond.
 *
 * Shanta, 1 Nov 2026: two hours before her appointment she wrote that she
 * could not come. The bot answered "Geen zorgen, we kunnen je afspraak
 * verschuiven … zullen we er flexibel mee omgaan" — a plain reply with no tool
 * call, so no tool guard could stop it. The prompt now has a section for a
 * guest who cannot come, but prompt text alone does not hold; the words that
 * reach the guest are checked here.
 *
 * How the loop uses it: a reply a check objects to is NOT sent the first time —
 * the model gets the objection as the respond result and writes a new reply.
 * If the same kind of objection comes back in the same turn the reply is sent
 * as written (a guest must never be left without an answer) and the check's
 * onRepeat tells the team.
 *
 * A check can also put a reply right in code (`correct`): the loop sends what
 * that returns, in every case — after a bounce, for a payment link, at the end
 * of the turn. The weekday check below works that way: a wrong weekday is
 * never "sent as written".
 *
 * A net for known phrasings, not a guarantee. Never throws: any error in here
 * means "no objection" and "send as written".
 */

const db = require('../data/database');
const logger = require('../utils/logger');
const conversationService = require('../services/conversation.service');
const { EN_DAYS, toYmd, localDay, dayLabel, shortDayLabel, weekdaysAround, findWeekdayDates, correctWeekdays } = require('../utils/calendar');

// ---- Promise check: a late arrival, cancellation or move that is "fine" ----

// The reply has to be about an appointment at all ("our memberships are
// flexible" is not a promise about one).
const APPOINTMENT_WORDS = /\b(?:appointments?|bookings?|treatments?|sessions?|afspraak|afspraken|boeking(?:en)?|behandeling(?:en)?|sessies?)\b/i;

const CLAUSE = '[^.!?\\n,;:—–]';     // stay inside one clause
const WORD = "[\\w'’-]+";
// Who grants it. A promise in the team's name is a promise too ("ons team zal
// een uitzondering maken").
const SUBJECT = '(?:we|wij|i|ik|(?:the|our|het|ons)\\s+team)';
// From that subject to the promise itself: inside one clause and never across
// another subject, so the match starts at the subject the promise belongs to
// ("I'll ask the team to make an exception" starts at "the team").
const upTo = (chars, alsoNot = '') => `(?:(?!\\b(?:we|wij|i|ik|team${alsoNot})\\b)${CLAUSE}){0,${chars}}?`;
// Moving is only a promise about the guest's OWN appointment: "we can move the
// sauna session to 15:45" is planning a journey that is not booked yet.
const EN_OBJECT = `(?:it\\b|your\\s+(?:${WORD}\\s+){0,2}?(?:appointments?|bookings?|treatments?|sessions?)\\b|(?:the|this|that)\\s+(?:appointments?|bookings?)\\b)`;
const NL_OBJECT = `(?:(?:je|jouw|uw)\\s+(?:${WORD}\\s+)?(?:afspraak|afspraken|boeking|behandeling|sessie)|(?:de|deze|die)\\s+(?:afspraak|boeking))\\b`;

/**
 * What the bot may not grant on its own, as a table — run over Dutch and
 * English replies in tests/shanta-late-cancel.test.js. Every match starts at
 * who grants it ("we", "I", "ik", the team) or is a passive ("an exception
 * will be made"): "you can ask the team for an exception" and "rescheduling is
 * free up to 24 hours before" are the policy, not a promise.
 * `core` is where the promise itself starts inside the match (see notAPromise).
 */
const PROMISE_PATTERNS = [
  // The team found the term confusing (Lin, 8 Nov 2026); the bot never needs it.
  { name: 'grace period', re: /\bgrace[\s-]?period\b/i, always: true },
  // "we'll be flexible", "zullen we er flexibel mee omgaan", "zijn we coulant",
  // "we will show some flexibility". Not a flexible pass or layout, not the
  // flexibility a class builds, and not the GUEST being flexible ("als je
  // flexibel bent", "when you're flexible on the day").
  {
    name: 'flexible',
    re: new RegExp(`\\b${SUBJECT}\\b${upTo(60, '|you|je|jij|u')}(?:(?:\\b(?:be|am|are|is|being)|['’](?:re|m))\\s+(?:${WORD}\\s+){0,2}?flexible\\b|\\b(?:flexibel|coulant)\\b|\\b(?:show|offer|give)\\s+(?:you\\s+)?(?:(?:some|more|extra)\\s+)?flexibility\\b|\\b(?:tonen|bieden|geven)\\s+(?:je\\s+)?(?:(?:graag|wat|meer|extra)\\s+){0,2}flexibiliteit\\b)`, 'i'),
    core: /flexib|coulant/i,
  },
  {
    name: 'exception (EN)',
    re: new RegExp(`\\b${SUBJECT}\\b${upTo(40)}\\bma(?:ke|kes|king)\\s+an\\s+exception\\b|\\ban\\s+exception\\s+(?:will|can)\\s+be\\s+made\\b`, 'i'),
    core: /\bma(?:ke|kes|king)\s+an\s+exception|\ban\s+exception/i,
  },
  {
    name: 'exception (NL)',
    re: new RegExp(`\\b${SUBJECT}\\b${upTo(40)}\\buitzondering\\s+(?:${WORD}\\s+){0,3}?maken\\b|\\b(?:(?:we|wij|ik)\\s+(?:maken|maak)|(?:maken|maak)\\s+(?:we|wij|ik)|(?:het|ons)\\s+team\\s+maakt)\\b${upTo(30)}\\buitzondering\\b|\\bwordt\\s+(?:${WORD}\\s+){0,3}?uitzondering\\s+gemaakt\\b|\\bbij\\s+wijze\\s+van\\s+uitzondering\\b`, 'i'),
    core: /uitzondering/i,
  },
  { name: 'move (EN)', re: new RegExp(`\\b(?:we|i|(?:the|our)\\s+team)(?:['’](?:ll|d|re|m)|\\s+(?:will|can|could|would|shall|are|am|is))\\b(?:\\s+${WORD}){0,3}?\\s+(?:move|reschedule|shift)\\s+${EN_OBJECT}`, 'i') },
  // Both Dutch word orders ("we kunnen je afspraak verzetten", "dan kunnen we
  // je afspraak verzetten"). "…om je afspraak TE verzetten" is passing a
  // request on, not a promise.
  { name: 'move (NL)', re: new RegExp(`\\b(?:(?:we|wij|ik|(?:het|ons)\\s+team)\\s+(?:kunnen|zullen|kan|zal)|(?:kunnen|zullen|kan|zal)\\s+(?:we|wij|ik))\\b(?:\\s+${WORD}){0,3}?\\s+${NL_OBJECT}(?:\\s+(?!te\\b)${WORD}){0,3}?\\s+(?:verzetten|verplaatsen|verschuiven|omboeken)\\b`, 'i') },
];

// ---- When a match is NOT a promise ----
// Found in review of the fix: "any negation earlier in the clause" let through
// exactly the replies a guest who wrote "ik ga het niet redden" gets back —
// "Omdat je niet kunt komen kunnen we je afspraak verzetten". A "can't / niet"
// only counts when it belongs to the promise ("No worries, we can move it" and
// "Dat is niet erg we kunnen je afspraak verzetten" are promises).
const NEG = /\b(?:not|never|no|cannot|unable|niet|geen|nooit)\b|n['’]t\b/i;
// …that is: in the promise itself, or at most two words before it ("we are
// not able to | make an exception", "ik kan zelf geen | uitzondering maken").
const NEG_JUST_BEFORE = new RegExp(`(?:\\b(?:not|never|no|cannot|unable|niet|geen|nooit)|n['’]t)(?:\\s+${WORD}){0,2}\\s*$`, 'i');
// Left open or handed on: "we may…", "perhaps we can…", "I wish I could…",
// "I'll ask the team to…", "ik zou graag…" — again only next to the promise:
// "we hope you feel better soon and will make an exception" is one.
// ("zo snel mogelijk" is "as soon as possible", not "possibly".)
const OPEN_WORDS = '\\b(?:may|might|maybe|perhaps|wish|hope(?:s|d)?|ask(?:s|ed|ing)?|misschien|(?<!\\bzo\\s+\\S+\\s+)mogelijk|wellicht|hopelijk|hoop|hopen|vraag|vragen|gevraagd|zou(?:den)?\\s+graag)\\b';
const OPEN = new RegExp(OPEN_WORDS, 'i');
const OPEN_JUST_BEFORE = new RegExp(`${OPEN_WORDS}(?:\\s+${WORD}){0,3}\\s*$`, 'i');
// A condition for it, not a grant: "we would need medical proof to…".
const NEEDED = /\b(?:need(?:s|ed)?|nodig)\b/i;
// "I can't promise that…", "ik kan niet toezeggen dat…"
const NOT_PROMISED = new RegExp(`(?:\\b(?:not|never|cannot|niet|nooit)|n['’]t)(?:\\s+${WORD}){0,2}?\\s+(?:promise|guarantee|say|confirm|sure|certain|beloven|toezeggen|garanderen|zeggen|bevestigen|zeker)\\b`, 'i');
// "whether we can…", "if we can…", "of we een uitzondering kunnen maken". The
// Dutch "of" is also "or": "of we kunnen je afspraak verzetten" (the verb
// straight after the subject) is a promise.
const WHETHER = /\b(?:whether|unless|tenzij)\b|\bif\s+(?:we|i|they|(?:the|our)\s+team)\b|\b(?:of|als)\s+(?:we|wij|ik|ze|zij|er|(?:het|ons)\s+team|het(?!\s+team\b))\s+(?!(?:kunnen|zullen|kan|zal|maken|maak|maakt|zijn|ben|is|gaan|ga|gaat)\b)/i;
// "only the team can…", "alleen ons team kan…" — and "only with medical proof".
// Not: "only this once we will make an exception".
const ONLY_THE_TEAM = /\b(?:only|alleen|uitsluitend)\s+(?:(?:the|our|het|ons)\s+)?team\b/i;
const ONLY_WITH_PROOF = new RegExp(`\\b(?:only|alleen|uitsluitend)\\b${CLAUSE}*?\\b(?:proof|bewijs)\\b`, 'i');
const CLAUSE_BREAK = /[.!?\n,;:—–]|\s(?:but|maar|and|en)\s/gi;
const CLAUSE_END = /[.!?\n;:—–]/;

/**
 * @param {string} before  the clause up to the match
 * @param {string} hit     the match (from who grants it to the promise)
 * @param {string} after   the rest of the clause
 * @param {RegExp} [core]  where the promise itself starts inside the match
 */
function notAPromise(before, hit, after, core) {
  const at = core ? hit.search(core) : 0;
  const lead = at > 0 ? hit.slice(0, at) : '';      // subject … up to the promise
  const promise = at > 0 ? hit.slice(at) : hit;
  const clause = `${before}${hit}`;
  return NEG.test(promise) || NEG_JUST_BEFORE.test(lead)
    || OPEN.test(promise) || OPEN_JUST_BEFORE.test(`${before}${lead}`)
    || NEEDED.test(hit) || NOT_PROMISED.test(clause)
    || WHETHER.test(clause) || ONLY_THE_TEAM.test(clause)
    || ONLY_WITH_PROOF.test(`${clause}${after}`);
}

/** The first promise in the text as { name, words }, or null. */
function findPromise(text) {
  // WhatsApp formatting marks are not words: "we kunnen je *afspraak* verzetten".
  const message = typeof text === 'string' ? text.replace(/[*_~`]/g, '') : '';
  if (!message || !APPOINTMENT_WORDS.test(message)) return null;
  for (const { name, re, always, core } of PROMISE_PATTERNS) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = scan.exec(message))) {
      const words = m[0].replace(/\s+/g, ' ').trim();
      if (always) return { name, words };
      // The clause the match sits in.
      let clauseStart = 0;
      const upToMatch = message.slice(0, m.index);
      CLAUSE_BREAK.lastIndex = 0;
      let b;
      while ((b = CLAUSE_BREAK.exec(upToMatch))) clauseStart = b.index + b[0].length;
      const rest = message.slice(m.index + m[0].length);
      const end = rest.search(CLAUSE_END);
      if (!notAPromise(message.slice(clauseStart, m.index), m[0], end < 0 ? rest : rest.slice(0, end), core)) return { name, words };
    }
  }
  return null;
}

const CHECK_REPLY_REASON = 'Check bot reply: possible promise about a late change';

const promiseGuard = {
  kind: 'promise',
  check(from, args) {
    const promise = findPromise(args?.message);
    if (!promise) return null;
    return {
      error: 'promise_not_allowed',
      // The words are quoted so the model can act on it: on a false alarm it
      // could not tell what was meant, and repeated the reply or called the team.
      message: `NOT sent. Your reply tells the customer that a late arrival, a cancellation or a move is fine, flexible, free or an exception. Only the team can grant that. If the customer cannot come, is ill, or wants to cancel or move an appointment that is today or starts within 24 hours: follow "Can't come, ill, or a change within 24 hours" — state the policy, call request_human_handoff, promise nothing. Otherwise rewrite the reply without that promise. Then call respond again. The words in question: "${promise.words.slice(0, 120)}".`,
    };
  },
  // The model insisted, so the guest got the reply as written: a human looks.
  async onRepeat(from, args) {
    const said = String(args?.message || '').slice(0, 500);
    logger.warn(`[${from}] reply sent although it still reads as a promise about a late change`);
    try {
      Promise.resolve(db.logError('promise_reply_sent', `The bot's reply to ${from} still read as a promise about a late arrival, cancellation or move after one rewrite, and was sent as written. Check what the guest was told.`, '', JSON.stringify({ pattern: findPromise(args?.message)?.name || null, reply: said }))).catch(() => {});
    } catch (_) { /* best-effort */ }
    // The dashboard keeps ONE reason per guest, the last one written. Found in
    // review: this flag replaced "Handoff: Can't come / late change: … today
    // 09:00, illness" from the same turn — the line the front desk needed. A
    // reason that is still standing is kept, and this one is added to it.
    let reason = CHECK_REPLY_REASON;
    try {
      const status = await db.getConversationStatus(from);
      const standing = status?.needs_reply ? String(status.needs_reply_reason || '').trim() : '';
      if (standing && !standing.includes(CHECK_REPLY_REASON)) reason = `${standing} · ${CHECK_REPLY_REASON}`;
    } catch (_) { /* unreadable: the plain reason */ }
    try { Promise.resolve(db.markConversationEscalated(from, reason)).catch(() => {}); } catch (_) { /* the reply is out either way */ }
  },
};

// ---- Weekday check: a weekday next to a date that is another weekday ----
//
// Melanie, 23 Nov 2026: she asked for "Saturday". The model took 25 November
// (a Saturday in 2023, a Wednesday in 2026), fetched Wednesday's times and
// showed them six times as "Saturday, 25th November"; she confirmed "Saturday
// 25 November at 12:00". The true day was in the tool result all along — the
// model wrote its own. So the words are checked where they leave for the
// guest, against the calendar (utils/calendar.js):
//  - a weekday that does not match its date, a date that does not exist, or a
//    list row that names another day than its own slot: handed back once;
//  - if it comes back, or cannot be handed back (a payment link, a reply sent
//    with a booking, the end of the turn): the weekday is put right in code;
//  - a confirmation summary has to name the day, and the day(s) it named are
//    remembered: book_appointment only books a day the guest confirmed.

const SLOT_ROW = /^slot_(\d{4}-\d{2}-\d{2})T/;
const replyLang = (from, args) => (['en', 'nl'].includes(args?.detected_language) ? args.detected_language : (conversationService.get(from)?.lang || 'en'));
/** The summary the guest confirms a booking with: Confirm / Cancel buttons, id "confirm_booking". */
const isSummary = (args) => args?.ui_type === 'buttons' && Array.isArray(args.buttons) && args.buttons.some(b => b?.id === 'confirm_booking');

/**
 * Every text of a reply that reaches the guest: the message, button titles,
 * the list button, section titles, row titles and row descriptions. `short`
 * marks the button and list fields (two-letter Dutch weekdays count only
 * there); `slotDay` is the day of the slot a list row stands for.
 */
function replyTexts(args) {
  const out = [];
  const add = (holder, key, extra) => {
    if (holder && typeof holder[key] === 'string' && holder[key]) out.push({ holder, key, ...extra });
  };
  add(args, 'message', { short: false });
  if (Array.isArray(args?.buttons)) args.buttons.forEach(b => add(b, 'title', { short: true }));
  add(args, 'list_button_label', { short: true });
  if (Array.isArray(args?.list_sections)) {
    for (const section of args.list_sections) {
      add(section, 'title', { short: true });
      if (!Array.isArray(section?.rows)) continue;
      for (const row of section.rows) {
        const slotDay = SLOT_ROW.exec(String(row?.id || ''))?.[1] || null;
        add(row, 'title', { short: true, slotDay });
        add(row, 'description', { short: true, slotDay });
      }
    }
  }
  return out;
}

/** The days this turn's availability checks fetched: a "the 25th" without its month is read as one of them. */
const knownDaysOf = (ctx) => (ctx?.checkedDays instanceof Set ? ctx.checkedDays : null);

/**
 * What a reply says about days: `wrong` = pairs to object to (with `slotDay`
 * when a row names another day than its slot), `named` = every date written
 * next to a weekday, `right` = the dates written as weekday + day + month
 * with the correct weekday ("Saturday the 28th" names no month: not counted),
 * `dayLinesWithoutDay` = 📅 lines of the message without such a pair.
 */
function scanReply(from, args, ctx) {
  const now = new Date();
  const lang = replyLang(from, args);
  const knownDays = knownDaysOf(ctx);
  const wrong = [];
  const named = new Set();
  const right = new Set();
  for (const t of replyTexts(args)) {
    for (const hit of findWeekdayDates(t.holder[t.key], now, { lang, shortField: t.short, knownDays })) {
      if (hit.date) named.add(hit.date);
      if (!hit.ok) wrong.push({ hit });
      else if (t.slotDay && hit.date !== t.slotDay) wrong.push({ hit, slotDay: t.slotDay });
      else if (hit.fix.hasMonth) right.add(hit.date);
    }
  }
  // A summary lists each booking on its own 📅 line. Found in review: with
  // "📅 Saturday 28 November at 14:15" and "📅 Sunday at 12:45" only Saturday
  // was remembered as confirmed, and the Sunday booking was then refused.
  const message = typeof args?.message === 'string' ? args.message : '';
  const dayLinesWithoutDay = message.split('\n').filter(line => line.includes('📅')
    && !findWeekdayDates(line, now, { lang, knownDays }).some(h => h.ok && h.fix.hasMonth)).length;
  return { now, lang, wrong, named: [...named], right: [...right].sort(), dayLinesWithoutDay };
}

/** Whether a reply offers times: a clock time in a text, or a slot row. A question about the day offers none. */
function offersTimes(args) {
  return replyTexts(args).some(t => t.slotDay || /(?<!\d)\d{1,2}[:.]\d{2}(?!\d)/.test(t.holder[t.key]));
}

/** The reply with its days put right, or the same object when there is nothing to put right. */
function fixReply(from, args, ctx) {
  const now = new Date();
  const lang = replyLang(from, args);
  const knownDays = knownDaysOf(ctx);
  let copy = null;
  let copyTexts = null;
  replyTexts(args).forEach((t, i) => {
    const before = t.holder[t.key];
    let after = before;
    if (t.slotDay) {
      // A row stands for one slot: whatever other day it names, it is that
      // slot's day. In a row title (24 characters, cut off by WhatsApp) the
      // short form, so the time next to it stays: "Wed 25 Nov · 09:00".
      const label = t.key === 'title' ? shortDayLabel(t.slotDay, lang) : dayLabel(t.slotDay, lang);
      const off = findWeekdayDates(after, now, { lang, shortField: true, knownDays }).filter(h => h.date !== t.slotDay).sort((a, b) => b.index - a.index);
      for (const h of off) {
        const { closer, closerFrom } = h.fix.cut;
        if (h.fix.pairFrom === h.index && closer > 0) after = after.slice(0, closerFrom) + after.slice(closer);   // "28 Nov (Sat)"
        after = after.slice(0, h.fix.pairFrom) + label + after.slice(h.fix.pairTo);
      }
    }
    after = correctWeekdays(after, now, { lang, shortField: t.short, knownDays });
    if (after === before) return;
    if (!copy) {
      // The model's arguments are left as they came; the same texts, in the same order, of a copy.
      copy = JSON.parse(JSON.stringify(args));
      copyTexts = replyTexts(copy);
    }
    copyTexts[i].holder[copyTexts[i].key] = after;
  });
  return copy || args;
}

const quoted = (hit) => `"${hit.text.trim().replace(/\s+/g, ' ')}"`;

function mismatchMessage(scan, ctx) {
  const full = (d) => dayLabel(d, 'en', { year: true });
  const lines = scan.wrong.map(({ hit, slotDay }) => {
    if (slotDay) return `${quoted(hit)} stands in the row of a slot on ${full(slotDay)} — a row names the day of its own slot.`;
    if (!hit.date) return `${quoted(hit)}: that date does not exist.`;
    const name = EN_DAYS[hit.weekday];
    const coming = weekdaysAround(hit.weekday, hit.date, scan.now).coming;
    return `${quoted(hit)}: ${full(hit.date).split(' ').slice(1).join(' ')} is a ${EN_DAYS[hit.actual]}, not a ${name}. The coming ${name} is ${full(coming)} (${coming}).`;
  });
  // "The times you have now belong to …" only when that is the one day this
  // turn fetched (found in review: said of Saturday 28 November while the
  // model also held Sunday's times).
  const dated = scan.wrong.find(w => !w.slotDay && w.hit.date);
  const fetched = knownDaysOf(ctx);
  const oneDay = !fetched || fetched.size === 0 || (fetched.size === 1 && fetched.has(dated?.hit.date));
  const yours = dated && oneDay ? ` — the times you have now belong to ${dayLabel(dated.hit.date, 'en')}` : '';
  return `NOT SENT — the weekday does not match the date. ${[...new Set(lines)].slice(0, 4).join(' ')} If the customer asked for the WEEKDAY, your date is wrong: call check_availability for the right date and show those times${yours}. If the customer asked for the DATE, write it with the weekday given here. If their own message mixes a weekday and a date that do not match, ask which one they mean and name both correct options. Then call respond again.`;
}

function summaryMessage(from, args, scan) {
  // The line to write, from the slots this guest was really offered: the one
  // day that has the time in the summary — else the placeholder.
  let line = '📅 <dateLabel> at [time]';
  try {
    const times = [...new Set((String(args.message || '').match(/(?<!\d)\d{1,2}[:.]\d{2}(?!\d)/g) || []).map(t => t.replace('.', ':').padStart(5, '0')))];
    const today = toYmd(localDay(scan.now));
    const days = [...new Set((conversationService.get(from)?.offeredSlots || [])
      .map(s => String(s.dateTime))
      .filter(dt => dt.slice(0, 10) >= today && times.includes(dt.slice(11, 16)))
      .map(dt => dt.slice(0, 10)))];
    if (days.length === 1) line = `📅 ${dayLabel(days[0], scan.lang)} ${scan.lang === 'nl' ? 'om' : 'at'} ${times.length === 1 ? times[0] : '[time]'}`;
  } catch (_) { /* the placeholder */ }
  return `NOT SENT — a confirmation summary must name each booking's day as weekday + day + month, copied from the slot's dateLabel. Write the line like this: "${line}". Call respond again with the same Confirm/Cancel buttons.`;
}

/** For the team: how often it happens (errors log). Best-effort. */
function logWeekday(type, message, context) {
  try {
    Promise.resolve(db.logError(type, message, '', JSON.stringify(context))).catch(() => {});
  } catch (_) { /* best-effort */ }
}

const weekdayGuard = {
  kind: 'weekday',
  check(from, args, ctx) {
    // A write tool did something in this turn (a booking, a cancellation, a
    // payment link, a forward to the team): the reply is not handed back. The
    // round after a bounce comes without that tool call — the second payment
    // message of a two-person booking was never asked for, and a handoff
    // could go out twice. The loop puts the text right in code instead.
    if (ctx?.wrote) return null;
    const scan = scanReply(from, args, ctx);
    if (scan.wrong.length > 0) return { error: 'weekday_mismatch', message: mismatchMessage(scan, ctx) };
    if (isSummary(args) && (scan.right.length === 0 || scan.dayLinesWithoutDay > 0)) return { error: 'summary_needs_day', message: summaryMessage(from, args, scan) };
    return null;
  },
  onBounce(from, args, objection, ctx) {
    if (objection?.error !== 'weekday_mismatch') return;
    logWeekday('weekday_mismatch_blocked', `A reply to ${from} named a weekday that does not match its date. It was not sent; the model was asked to write it again.`, {
      pairs: scanReply(from, args, ctx).wrong.map(w => w.hit.text.trim()),
      reply: String(args?.message || '').slice(0, 500),
    });
  },
  /** What goes out instead of the reply as written: never a weekday that does not match its date. */
  correct(from, args, ctx) {
    let reply = args;
    let renamed = false;
    // The reply that was handed back named a day that was fetched in this
    // turn, and the model now offers times under a day that this turn never
    // fetched: those are still the first day's times. (Found when the fix was
    // checked: Wednesday's times went out as "Saturday 28 November" — a pair
    // that is correct in itself.) The rewrite is dropped; the first reply goes
    // out with its weekday put right.
    // Decided on the days FETCHED, not on whether another check ran (found in
    // review): a second check of the same Wednesday let the rename through,
    // and a correct rewrite for a day of the same check ("Sunday 29
    // November" after fetching 28–29) was dropped. A rewrite that offers no
    // times — "do you mean Wednesday 25 or Saturday 28 November?", the
    // question the refusal itself suggests — cannot carry the wrong day's
    // times and goes out. Known limit: a range that was fetched including the
    // right day, with the wrong day's times written under it, is accepted.
    const held = ctx?.held?.weekday;
    if (held?.args && held.args !== args && !ctx.wrote && args?.ui_type !== 'cta_button') {
      const fetchedDays = knownDaysOf(ctx) || new Set();
      const first = scanReply(from, held.args, ctx);
      const rewrite = scanReply(from, args, ctx);
      const fetched = first.wrong.some(w => fetchedDays.has(w.slotDay || w.hit.date));
      if (fetched && offersTimes(args) && rewrite.named.some(d => !first.named.includes(d) && !fetchedDays.has(d))) {
        reply = held.args;
        renamed = true;
      }
    }
    const fixed = fixReply(from, reply, ctx);
    // (ctx.quiet: the model's text will not go out — a pay-first link is the reply.)
    if ((fixed !== reply || renamed) && !ctx?.quiet) {
      logger.warn(`[${from}] weekday put right in code before sending${renamed ? ' (a rewrite that renamed the day without checking it was dropped)' : ''}`);
      logWeekday('weekday_mismatch_autocorrected', `A reply to ${from} named a weekday that does not match its date${renamed ? ', and the rewrite named another day without checking it' : ''}. The weekday was corrected in code and the reply was sent.`, {
        pairs: scanReply(from, reply, ctx).wrong.map(w => w.hit.text.trim()),
        sent: String(fixed?.message || '').slice(0, 500),
      });
    }
    return fixed;
  },
  // A confirmation summary went out: remember which day(s) it named, with the
  // right weekday. book_appointment refuses any other day (confirmed_day_differs)
  // — an empty list when it named none. In memory only: after a restart or 30
  // minutes of silence nothing is remembered and a late Confirm books as before.
  onSent(from, args, ctx) {
    if (!isSummary(args)) return;
    conversationService.set(from, { confirmSummary: { dates: scanReply(from, args, ctx).right, at: Date.now() } });
  },
};

// Other checks on a reply are added here: { kind, check(from, args, ctx) →
// null | { error, message }, onRepeat?(from, args, ctx), onBounce?(from, args,
// objection, ctx), correct?(from, args, ctx) → args, onSent?(from, args, ctx) }.
const GUARDS = [promiseGuard, weekdayGuard];

/** A broken check must never cost the guest their answer: it counts as "no objection". */
function objectionOf(guard, from, args, ctx) {
  try {
    const hit = guard.check(from, args, ctx || {});
    return hit ? { kind: guard.kind, error: hit.error, message: hit.message } : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} from
 * @param {object} args  the respond call's arguments
 * @param {{bounced?: Set<string>}} [ctx]  kinds the loop already bounced this turn
 * @returns {null | {kind: string, error: string, message: string}} the first
 *   objection of a kind not bounced yet; else one that was (the loop then
 *   sends the reply and calls onRepeat); else null.
 */
function checkReply(from, args, ctx) {
  let repeated = null;
  for (const guard of GUARDS) {
    const objection = objectionOf(guard, from, args, ctx);
    if (!objection) continue;
    if (!ctx?.bounced?.has?.(guard.kind)) return objection;
    repeated = repeated || objection;
  }
  return repeated;
}

/**
 * The reply went out as written: every check that still objects to it tells
 * the team. Resolves when they have; never rejects.
 */
async function onRepeat(from, args, ctx) {
  for (const guard of GUARDS) {
    try {
      if (guard.onRepeat && objectionOf(guard, from, args, ctx)) await guard.onRepeat(from, args, ctx || {});
    } catch (err) {
      logger.warn(`[${from}] reply guard onRepeat failed:`, err.message);
    }
  }
}

/** A reply was handed back to the model: the check that objected may note it. Never throws. */
function onBounce(from, args, objection, ctx) {
  for (const guard of GUARDS) {
    try {
      if (guard.kind === objection?.kind && guard.onBounce) guard.onBounce(from, args, objection, ctx || {});
    } catch (err) {
      logger.warn(`[${from}] reply guard onBounce failed:`, err.message);
    }
  }
}

/**
 * What the loop sends: the reply after every check's own correction (the same
 * object when none applies). A broken correction means "send as written".
 */
function correctReply(from, args, ctx) {
  let reply = args;
  for (const guard of GUARDS) {
    if (!guard.correct) continue;
    try {
      reply = guard.correct(from, reply, ctx || {}) || reply;
    } catch (err) {
      logger.warn(`[${from}] reply guard correct failed:`, err.message);
    }
  }
  return reply;
}

/** A reply went out to the guest. Never throws. */
function onSent(from, args, ctx) {
  for (const guard of GUARDS) {
    try {
      if (guard.onSent) guard.onSent(from, args, ctx || {});
    } catch (err) {
      logger.warn(`[${from}] reply guard onSent failed:`, err.message);
    }
  }
}

module.exports = { checkReply, onRepeat, onBounce, correctReply, onSent, PROMISE_PATTERNS };
