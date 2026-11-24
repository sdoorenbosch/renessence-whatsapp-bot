/**
 * The guest's appointments as the booking system shows them: named, complete,
 * compared with what the guest says they booked, and written out by the
 * server. Pure: no I/O.
 *
 * Tara, 19 Nov 2026: the evening before her visit she asked the bot to confirm
 * "two lymphatic drainage followed by two facials for me and my husband".
 * get_appointments gave the model two rows named "Treatment" (the name was
 * read from apt.SessionType.Name, which Mindbody's appointments endpoint does
 * not return), and the model filled the gap with her own description. Naming,
 * comparing and wording are code now; the model only passes on her words.
 *
 * Dates are naive Amsterdam-local strings as Mindbody returns them
 * ("2026-11-20T09:00:00") — never UTC. Day labels come from utils/calendar.js,
 * so the text passes the weekday check (reply-guards.js) by construction.
 */

const { SERVICE_NAMES } = require('../config/prices');
const { dayLabel, toYmd } = require('../utils/calendar');

const MAX_UPCOMING = 10;

// Same rule as mindbody.service isCancelEffectiveStatus (kept here so this
// module stays pure): Cancelled, LateCancelled, EarlyCancelled and NoShow —
// how this site records a cancel — are not appointments.
function isCancelled(status) {
  if (!status) return false;
  const s = String(status).trim();
  return /cancel/i.test(s) || /^no[\s-]?show$/i.test(s);
}

/**
 * The treatment's name: the bot's own catalog, then Mindbody's session-type
 * list, then a nested SessionType.Name. null when nobody knows — never
 * "Treatment".
 */
function resolveServiceName(apt, mindbodyNames = {}) {
  const raw = apt?.SessionTypeId ?? apt?.SessionType?.Id;
  const id = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  return SERVICE_NAMES[id] || (mindbodyNames || {})[id] || apt?.SessionType?.Name || null;
}

// "📱 WhatsApp Bot | For: Sam (sam@…)" — a booking the bot made for someone else.
function forPersonOf(notes) {
  const m = /(?:^|\|)\s*For:\s*([^(|\n]+)/.exec(String(notes || ''));
  return m ? m[1].trim() || null : null;
}

const hhmm = (dt) => String(dt || '').slice(11, 16);
const ymd = (dt) => String(dt || '').slice(0, 10);

// Pay-first bookings (config/pay-first.js) are not in Mindbody until Stripe
// confirms the payment. Found in review: a guest asking "is my massage
// tomorrow at 10 booked?" while its link was still open was told the booking
// system showed nothing and to wait for the team — instead of to pay.
const PAY_FIRST_PENDING = new Set(['awaiting_payment', 'booking']);

/**
 * @param {object[]} rows Mindbody appointments (flat or nested layout)
 * @param {object} [opts]
 * @param {object[]} [opts.payFirstRows] this guest's pay-first rows
 *   (db.getPayFirstRowsForPhone): the ones still waiting for payment or being
 *   booked come back as `pending`.
 * @returns {{ upcoming: object[], allUpcoming: object[], totalUpcoming: number, pending: object[], lastPast: object|null, cancelledCount: number, now: Date }}
 *   upcoming: today and later, in order, at most 10 (allUpcoming: every one);
 *   lastPast: the most recent appointment before today.
 */
function buildOverview(rows, { names = {}, now = new Date(), lang = 'en', payFirstRows = [] } = {}) {
  const all = Array.isArray(rows) ? rows.filter(r => r && r.StartDateTime) : [];
  const live = all.filter(r => !isCancelled(r.Status))
    .sort((a, b) => String(a.StartDateTime).localeCompare(String(b.StartDateTime)) || (Number(a.Id) || 0) - (Number(b.Id) || 0));
  const today = toYmd(now);
  const item = (apt) => {
    const serviceName = resolveServiceName(apt, names);
    return {
      apt,
      id: apt.Id,
      serviceName,
      date: ymd(apt.StartDateTime),
      startTime: hhmm(apt.StartDateTime),
      endTime: hhmm(apt.EndDateTime) || null,
      dateLabel: dayLabel(apt.StartDateTime, lang, { now }),
      dateTime: apt.StartDateTime,
      forPerson: forPersonOf(apt.Notes),
      people: Number((/(\d+) people/.exec(serviceName || '') || [])[1]) || 1,
    };
  };
  // Every upcoming one is compared and counted; the guest's list shows the
  // first 10 and says so (found in review: "That is 10 appointments in total"
  // with 12 booked, and the 11th day read as "nothing on that date").
  const allUpcoming = live.filter(r => ymd(r.StartDateTime) >= today).map(item);
  const past = live.filter(r => ymd(r.StartDateTime) < today);
  const pending = (Array.isArray(payFirstRows) ? payFirstRows : [])
    .filter(r => r && PAY_FIRST_PENDING.has(r.status) && r.pay_first?.startDateTime && ymd(r.pay_first.startDateTime) >= today)
    .map(r => {
      const dt = r.pay_first.startDateTime;
      const serviceName = r.service_name || null;
      return {
        payFirstId: r.id, status: r.status, serviceName, date: ymd(dt), startTime: hhmm(dt), dateTime: dt,
        people: Number((/(\d+) people/.exec(serviceName || '') || [])[1]) || 1,
      };
    })
    .sort((a, b) => String(a.dateTime).localeCompare(String(b.dateTime)));
  return {
    upcoming: allUpcoming.slice(0, MAX_UPCOMING),
    allUpcoming,
    totalUpcoming: allUpcoming.length,
    pending,
    lastPast: past.length ? item(past[past.length - 1]) : null,
    cancelledCount: all.length - live.length,
    now,
  };
}

// Anything the guest says that involves another person: one profile can never
// confirm a claim about two people.
const OTHER_PEOPLE = new RegExp('(?<![\\p{L}\\p{N}])(?:'
  + 'husband|hubby|wife|wifey|partner|boyfriend|girlfriend|fianc[eé]e?|friends?|mother|mom|mum|father|dad|sister|brother|daughter|son|kids|children|colleague'
  + '|both of us|the two of us|for two|together|we|us|our|ours|both|me and|and me'
  + '|mijn man|mijn vrouw|vriend(?:in)?|vrienden|moeder|mama|vader|papa|zus|broer|dochter|zoon|kinderen|collega|samen|allebei|wij|ons|onze|beide|beiden|met z\'?n twee[eë]n|voor twee|mij en|en mij|ik en'
  + ')(?![\\p{L}\\p{N}])', 'iu');

// Review: "our two treatments", "onze afspraken", "both", "for me and Sam"
// came back 'shown' when the model left expected_other_people unset.
const mentionsOtherPeople = (text) => OTHER_PEOPLE.test(String(text || ''));

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());

/**
 * The guest's own words (and what the model read in them) against the list.
 * Two verdicts: 'needs_team' (the list cannot confirm it) or 'shown'. There is
 * no "matches": a count that happens to agree says nothing about who, what or
 * when. 'not_requested' when the guest described nothing.
 */
function checkExpectation(exp, upcomingRows, pending = []) {
  const words = String(exp?.customer_expects || '').trim();
  if (!words) return { verdict: 'not_requested', reasons: [] };
  const reasons = [];
  // A pay-first booking still waiting for payment (or being booked) covers
  // its day too: the guest's list says so in its own lines.
  const upcoming = [...(upcomingRows || []), ...(pending || [])];
  const date = validDate(exp.expected_date) ? exp.expected_date : null;
  const count = Number.isInteger(exp.expected_count) && exp.expected_count > 0 ? exp.expected_count : null;
  const onDate = date ? upcoming.filter(a => a.date === date) : upcoming;

  if (upcoming.length === 0) reasons.push('no upcoming appointments under this profile');
  else if (date && onDate.length === 0) reasons.push(`nothing on ${date}`);
  if (date && count !== null && onDate.length > 0) {
    const people = onDate.reduce((sum, a) => sum + a.people, 0);
    if (count !== onDate.length && count !== people) reasons.push(`guest expects ${count}, system shows ${onDate.length}`);
  }
  if (exp.expected_other_people === true || mentionsOtherPeople(words)) {
    reasons.push('mentions another person — one profile cannot confirm that');
  }
  if (onDate.some(a => !a.serviceName)) reasons.push('a treatment name is not visible');
  return { verdict: reasons.length ? 'needs_team' : 'shown', reasons };
}

const TEXTS = {
  en: {
    head: (p) => `Here is everything our booking system shows under your ${p.plural ? 'profiles' : 'profile'} (${p.label}):`,
    headFirst: (p, k, n) => `Here are the first ${k} of the ${n} upcoming appointments our booking system shows under your ${p.plural ? 'profiles' : 'profile'} (${p.label}):`,
    none: (p) => `Our booking system shows no upcoming appointments under your ${p.plural ? 'profiles' : 'profile'} (${p.label}).`,
    unnamed: 'a treatment booked by our team (I can\'t see its name)',
    forWhom: (n) => ` (for ${n})`,
    total: (n) => `That is ${n} appointment${n === 1 ? '' : 's'} in total.`,
    totalFirst: (k, n) => `These are the first ${k} of your ${n} upcoming appointments.`,
    awaiting: 'Waiting for your payment, not booked yet:',
    awaitingEnd: 'Please use the payment link I sent to secure it.',
    booking: 'Paid, the booking is being made now (you\'ll get a confirmation here):',
    sameStart: (k, t) => ` ${k} of them start at the same time (${t}).`,
    oneProfile: (plural) => (plural
      ? ' I can only see these profiles, so I can\'t tell who each appointment is for.'
      : ' I can only see this one profile, so I can\'t tell who each appointment is for.'),
    needsTeam: (web) => `I can't confirm from this that everything you described is booked, so I've asked my colleagues to check. ${web ? 'They will email you at the address you gave.' : 'They\'ll reply here on WhatsApp.'} If you haven't heard from us before your visit, please check at reception when you arrive.`,
    shown: 'If that\'s not what you expected, tell me what is different and I\'ll ask my colleagues to check.',
  },
  nl: {
    head: (p) => `Dit is alles wat ons boekingssysteem laat zien onder ${p.plural ? 'jouw profielen' : 'jouw profiel'} (${p.label}):`,
    headFirst: (p, k, n) => `Dit zijn de eerste ${k} van de ${n} komende afspraken die ons boekingssysteem laat zien onder ${p.plural ? 'jouw profielen' : 'jouw profiel'} (${p.label}):`,
    none: (p) => `Ons boekingssysteem laat geen komende afspraken zien onder ${p.plural ? 'jouw profielen' : 'jouw profiel'} (${p.label}).`,
    unnamed: 'een behandeling die door ons team is geboekt (de naam kan ik niet zien)',
    forWhom: (n) => ` (voor ${n})`,
    total: (n) => (n === 1 ? 'Dat is 1 afspraak in totaal.' : `Dat zijn ${n} afspraken in totaal.`),
    totalFirst: (k, n) => `Dit zijn de eerste ${k} van je ${n} komende afspraken.`,
    awaiting: 'Wacht nog op je betaling, nog niet geboekt:',
    awaitingEnd: 'Gebruik de betaallink die ik je stuurde om de plek vast te leggen.',
    booking: 'Betaald, de boeking wordt nu gemaakt (je krijgt hier een bevestiging):',
    sameStart: (k, t) => ` ${k} daarvan beginnen op hetzelfde tijdstip (${t}).`,
    oneProfile: (plural) => (plural
      ? ' Ik zie alleen deze profielen en kan dus niet zien voor wie elke afspraak is.'
      : ' Ik zie alleen dit ene profiel en kan dus niet zien voor wie elke afspraak is.'),
    needsTeam: (web) => `Ik kan hiermee niet bevestigen dat alles wat je beschrijft geboekt is, dus ik heb mijn collega's gevraagd het na te kijken. ${web ? 'Zij mailen je op het adres dat je opgaf.' : 'Zij reageren hier via WhatsApp.'} Heb je vóór je bezoek nog niets gehoord, vraag het dan even na bij de receptie.`,
    shown: 'Klopt dit niet met wat je verwachtte? Laat me weten wat er anders is, dan vraag ik mijn collega\'s het na te kijken.',
  },
};

/** "Tara G." per profile the lookup read. */
function profileLabel(clients) {
  const labels = [...new Set((clients || []).map(c => {
    const first = String(c?.FirstName || '').trim();
    const last = String(c?.LastName || '').trim();
    return `${first}${last ? ` ${last[0]}.` : ''}`.trim();
  }).filter(Boolean))];
  return { label: labels.join(', ') || '?', plural: labels.length > 1 };
}

/**
 * What the guest is sent. verdict: 'needs_team' | 'shown' | 'not_requested'
 * (no closing sentence: the model's own reply follows the list).
 */
function renderOverview(overview, verdict, lang = 'en', { web = false, clients = [] } = {}) {
  const t = TEXTS[lang === 'nl' ? 'nl' : 'en'];
  const p = profileLabel(clients);
  const parts = [];
  const list = overview.upcoming;
  const total = Math.max(overview.totalUpcoming || 0, list.length);
  // Day labels in the language of the reply (it can change in the turn that
  // sends the list), always from utils/calendar (the weekday check).
  const day = (dt) => dayLabel(dt, lang, { now: overview.now });
  if (list.length === 0) {
    parts.push(t.none(p));
  } else {
    const lines = list.map(a => `• ${day(a.dateTime)}, ${a.startTime} — ${a.serviceName || t.unnamed}${a.forPerson ? t.forWhom(a.forPerson) : ''}`);
    parts.push([total > list.length ? t.headFirst(p, list.length, total) : t.head(p), ...lines].join('\n'));
    let count = total > list.length ? t.totalFirst(list.length, total) : t.total(list.length);
    const byStart = new Map();
    for (const a of list) byStart.set(a.dateTime, (byStart.get(a.dateTime) || 0) + 1);
    for (const [dt, k] of byStart) if (k > 1) count += t.sameStart(k, hhmm(dt));
    count += t.oneProfile(p.plural);
    parts.push(count);
  }
  for (const status of ['awaiting_payment', 'booking']) {
    const rows = (overview.pending || []).filter(a => a.status === status);
    if (!rows.length) continue;
    const lines = rows.map(a => `• ${day(a.dateTime)}, ${a.startTime} — ${a.serviceName || t.unnamed}`);
    parts.push([status === 'booking' ? t.booking : t.awaiting, ...lines, ...(status === 'booking' ? [] : [t.awaitingEnd])].join('\n'));
  }
  if (verdict === 'needs_team') parts.push(t.needsTeam(web));
  else if (verdict === 'shown') parts.push(t.shown);
  return parts.join('\n\n');
}

/** The team's note: what the guest wrote, everything Mindbody shows, and why it was flagged. */
function teamNote({ words, clients, overview, reasons, within24h, web }) {
  const profiles = (clients || []).map(c => `${[c?.FirstName, c?.LastName].filter(Boolean).join(' ')} (ID ${c?.Id})`).join(', ');
  const rows = (overview.allUpcoming || overview.upcoming).map(a => `#${a.id} ${a.date} ${a.startTime}${a.endTime ? `–${a.endTime}` : ''} ${a.serviceName || `session type ${a.apt?.SessionTypeId ?? a.apt?.SessionType?.Id ?? '?'} (name not visible)`}${a.forPerson ? ` (for ${a.forPerson})` : ''}`);
  const pending = (overview.pending || []).map(a => `${a.date} ${a.startTime} ${a.serviceName || '?'} (${a.status === 'booking' ? 'paid, booking in progress' : 'awaiting payment, link open'})`);
  return `BOOKING CHECK${within24h ? ' — VISIT WITHIN 24 HOURS' : ''}: guest wrote "${words}". `
    + `Mindbody, profile ${profiles || '?'}: ${rows.length ? rows.join('; ') : 'no upcoming appointments'}. `
    + (pending.length ? `Pay-first, not in Mindbody yet: ${pending.join('; ')}. ` : '')
    + `Why flagged: ${reasons.join('; ')}. `
    + `The guest was shown exactly this list and told ${web ? 'the team will email them' : 'a colleague will reply on WhatsApp'}.`;
}

module.exports = { resolveServiceName, buildOverview, checkExpectation, renderOverview, profileLabel, teamNote, isCancelled, mentionsOtherPeople };
