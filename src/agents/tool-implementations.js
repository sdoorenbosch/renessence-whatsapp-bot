/**
 * Tool implementations for the Renessence AI Agent.
 */

const conversationService = require('../services/conversation.service');
const mindbodyService = require('../services/mindbody.service');
const paymentService = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const emailService = require('../services/email.service');
const releaseNotice = require('../services/release-notice.service');
const giftCardCheck = require('../services/gift-card-check.service');
const db = require('../data/database');
const logger = require('../utils/logger');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const { SERVICE_DURATIONS, FIXED_GRID_SERVICES, fitMinutes, slotTimesFor } = require('../config/slot-times');
const dynamicCatalogService = require('../services/dynamic-catalog.service');
const payFirst = require('../services/pay-first.service');
const payFirstCfg = require('../config/pay-first');
const settings = require('../services/settings.service');
const guestEmail = require('../utils/guest-email');
const { longDate } = require('./business-facts');
const appointmentOverview = require('./appointment-overview');
const teamContext = require('./team-context');
const { EN_DAYS, dayLabel, weekdayOf, weekdayIndex, rangeDays, weekdaysAround, findWeekdayDates, loneWeekdays } = require('../utils/calendar');

// Static catalog (synchronous — loaded at startup)
const _catalog = dynamicCatalogService.getCatalog();

function getServiceName(sessionTypeId) {
  return dynamicCatalogService.getServiceName(sessionTypeId);
}

// Which days a treatment can be booked (Nervous System Reset: Fridays, Let It
// Go: Tuesdays) and whether it is paused are set by the team in the dashboard
// (settings.service.js, config/treatments.js) — no longer constants here.
const pausedResult = (t) => ({
  error: 'service_paused',
  message: `${t.name} is paused for now by the team — it cannot be checked or booked. Do NOT retry. Tell the customer it is temporarily unavailable and suggest another treatment.`,
});

// Treatments removed from the offer. Hard-blocked in check_availability and
// book_appointment so a prompt slip can never book one — the model is told to
// answer "no longer part of our treatment menu" and offer alternatives instead.
// (Their prices/durations/resource maps stay defined so OLD bookings still
// resolve names in the dashboard, cancel emails and billing.)
const DISCONTINUED_SESSION_TYPES = new Map([
  [43, { name: 'Acupuncture', kind: 'removed' }], // stopped Sep 2026
  [44, { name: 'Acupuncture', kind: 'removed' }],
  [52, { name: 'Acupuncture', kind: 'removed' }],
  // Gym combos ("Summer Specials") — PAUSED for now (team decision, Sep 2026)
  [99,  { name: 'Heat & Meet',     kind: 'paused' }],
  [100, { name: 'Lift & Drift',    kind: 'paused' }],
  [101, { name: 'Move & Massage',  kind: 'paused' }],
  [102, { name: 'Boost & Breathe', kind: 'paused' }],
  [103, { name: 'Sweat & Reset',   kind: 'paused' }],
  [104, { name: 'Glow & Go',       kind: 'paused' }],
  [105, { name: 'Sweat & Reset',   kind: 'paused' }],
]);

// A single Confirm tap may cover a multi-treatment summary; this bounds it.
// Matches the journey cap (too_many_treatments): a summary can never list more.
const MAX_BOOKINGS_PER_CONFIRM = 3;

const CONFIRMATION_REQUIRED = {
  error: 'confirmation_required',
  message: 'You have not received the customer\'s confirmation yet. This is NOT an error — do not tell the customer something went wrong. Before booking you MUST show the confirmation summary (every treatment for every person, date, time, name + the health and cancellation declaration) with Confirm/Cancel buttons (id "confirm_booking"), and only call book_appointment after the customer taps "Confirm". Show that confirmation now — do NOT book yet.',
};

/** Did the customer tap "Confirm" (id=confirm_booking) within the last 10 minutes? A look only — it uses nothing up. */
function confirmedRecently(from) {
  const conf = conversationService.get(from)?.bookingConfirmedAt;
  return !!conf && (Date.now() - conf) < 10 * 60 * 1000;
}

/**
 * Close a confirmation gate that was USED in a previous agent turn. Called by
 * agent.run at the start of every turn: a Confirm tap authorises the bookings
 * made in the turn that handles it (a multi-treatment summary needs several),
 * and nothing after. A fresh tap resets bookingConfirmUsed in the message
 * handler before the agent runs, so this never eats a new confirmation.
 */
function closeUsedConfirmation(from) {
  if (conversationService.get(from)?.bookingConfirmUsed) {
    conversationService.update(from, { bookingConfirmedAt: null, bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
  }
}

const discontinuedResult = ({ name, kind }) => ({
  error: 'service_discontinued',
  message: kind === 'paused'
    ? `${name} is one of the gym-combo "Summer Specials", which are PAUSED for now — it cannot be booked. Do NOT retry. Tell the customer the gym combos are currently paused; they can book the included treatment on its own, and for gym access point them to our passes and memberships via renessence.com/gym-and-members-club.`
    : `${name} is no longer offered at Renessence — it has been removed from the treatment menu. Do NOT retry or book it. Tell the customer: "At the moment, ${name} is no longer part of our treatment menu. Let us know if you'd like a recommendation for other treatments."`,
});

// Closed days and special opening hours, set by the team in the dashboard
// (settings.service.js). Before, a holiday only worked if someone emptied the
// Mindbody schedules — this keeps the bot from offering or booking it anyway.
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Why this start time can't be booked (closed day / outside special hours), or null. */
function closedFor(dateTime, blockMinutes) {
  const c = settings.closureFor(String(dateTime).slice(0, 10));
  if (!c) return null;
  if (c.closed) return c;
  const start = minutesOf(String(dateTime).slice(11, 16));
  return start >= minutesOf(c.open) && start + blockMinutes <= minutesOf(c.close) ? null : c;
}

function closedResult(c, dateTime) {
  // English, like the rest of these instructions; the model replies in the guest's language.
  const day = longDate(String(dateTime).slice(0, 10));
  const why = c.note ? ` (${c.note})` : '';
  return {
    error: 'closed',
    slots: [],
    closed: true,
    message: c.closed
      ? `Renessence is closed on ${day}${why}. Nothing can be booked that day. Tell the customer kindly and suggest another day.`
      : `On ${day} Renessence has special opening hours, ${c.open}–${c.close}${why}; this time falls outside them. Offer a time within those hours or another day.`,
  };
}

/**
 * Merge touching/overlapping Mindbody availability records that belong to the
 * same staff member, session type and calendar day. Preserves each group's
 * first record's Staff/SessionType objects; never bridges a genuine gap.
 */
function mergeAvailabilityWindows(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.Staff?.Id ?? 'none'}|${it.SessionType?.Id ?? 0}|${String(it.StartDateTime).slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const merged = [];
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.StartDateTime).localeCompare(String(b.StartDateTime)));
    let current = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      if (new Date(next.StartDateTime) <= new Date(current.EndDateTime)) {
        // Touching or overlapping → extend the current window.
        if (new Date(next.EndDateTime) > new Date(current.EndDateTime)) {
          current.EndDateTime = next.EndDateTime;
        }
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }
  return merged;
}

// Melanie, 23 Nov 2026: she asked for "Saturday", the model worked out
// 2026-11-25 by itself (a Wednesday) and Wednesday's times were shown as
// Saturday's. With the weekday the customer named, a date that falls on
// another day is refused before Mindbody is asked — so nothing of that day is
// offered, or remembered as offered.
function weekdayMismatch(named, days) {
  const name = EN_DAYS[named];
  const first = days[0];
  const full = (d) => `${dayLabel(d, 'en', { year: true })} (${d})`;
  const what = days.length === 1
    ? `${first} is a ${EN_DAYS[weekdayOf(first)]}, not a ${name}`
    : `there is no ${name} between ${first} and ${days[days.length - 1]}`;
  // That weekday around the date that was asked for (a request for late
  // December must not be pointed at this week), and separately the coming one.
  const around = weekdaysAround(named, first);
  const near = around.near.length ? ` ${name}s near ${days.length === 1 ? 'that date' : 'those dates'}: ${around.near.map(full).join(' and ')}.` : '';
  const today = around.today ? ` Today, ${full(around.today)}, is a ${name} too.` : '';
  return {
    error: 'weekday_mismatch',
    slots: [],
    staff: [],
    message: `Nothing was checked: ${what}.${near} The coming ${name} is ${full(around.coming)}.${today} If the customer named only the weekday, call check_availability again with the coming ${name}. If the customer gave the date and no weekday, call again with that date and leave weekday out. If they gave both and they do not match, ask which one they mean and name both options.`,
  };
}

/** The day(s) of a check_availability result in both languages: the model writes a day by copying one of these. */
const dayList = (dates) => dates.map(d => ({ date: d, label: dayLabel(d, 'en'), labelNl: dayLabel(d, 'nl') }));

async function toolCheckAvailability(from, { session_type_ids, start_date, end_date, part_of_day, weekday }) {
  // Discontinued treatments never reach Mindbody: drop their IDs, and if
  // nothing else was asked for, answer with the removed-from-menu message.
  const discontinued = session_type_ids.filter(id => DISCONTINUED_SESSION_TYPES.has(Number(id)));
  if (discontinued.length > 0) {
    session_type_ids = session_type_ids.filter(id => !DISCONTINUED_SESSION_TYPES.has(Number(id)));
    if (session_type_ids.length === 0) {
      return discontinuedResult(DISCONTINUED_SESSION_TYPES.get(Number(discontinued[0])));
    }
  }
  // Paused by the team: same, with their own message.
  const paused = session_type_ids.filter(id => settings.pausedTreatment(id));
  if (paused.length > 0) {
    session_type_ids = session_type_ids.filter(id => !settings.pausedTreatment(id));
    if (session_type_ids.length === 0) return pausedResult(settings.pausedTreatment(paused[0]));
  }

  // The weekday check (see weekdayMismatch). A range that does contain the
  // weekday is checked whole — "Saturday or Sunday" is a normal request. A
  // weekday or a date the server cannot read changes nothing.
  if (typeof start_date === 'string') start_date = start_date.slice(0, 10);
  if (typeof end_date === 'string') end_date = end_date.slice(0, 10);
  const askedDays = rangeDays(start_date, end_date || start_date);
  {
    const named = weekdayIndex(weekday);
    if (named !== null && askedDays.length > 0 && !askedDays.some(d => weekdayOf(d) === named)) {
      return weekdayMismatch(named, askedDays);
    }
  }
  // What the model is given to write a day with, and to name the day(s) that
  // were checked when nothing is free: on 23 Nov the only weekday in the
  // result was a Dutch label in an English chat, and "nothing free" named no
  // day at all — so "no availability on Friday" could be said of a Wednesday.
  const lang = conversationService.get(from)?.lang || 'en';
  const checkedDays = dayList(askedDays);
  const fullDay = (d) => dayLabel(d, 'en', { year: true });
  const checkedLabel = askedDays.length === 0
    ? 'the requested date(s)'
    : (askedDays.length === 1 ? fullDay(start_date) : `${fullDay(start_date)} – ${fullDay(end_date)}`);
  const nothingFree = () => ({
    slots: [],
    staff: [],
    no_availability: true,
    days: checkedDays,
    message: `No availability found for ${checkedLabel}. Respond to the customer with a friendly message and suggest they try a different date.`,
  });

  // C6: fetch all session types in parallel instead of sequentially
  let anySuccess = false;
  const results = await Promise.all(
    session_type_ids.map(id =>
      mindbodyService.getBookableItems(id, start_date, end_date)
        .then(items => {
          anySuccess = true;
          return items.filter(item => {
            const restriction = settings.daysFor(id);
            if (!restriction) return true;
            return restriction.includes(new Date(item.StartDateTime).getDay());
          });
        })
        .catch(err => { logger.warn(`check_availability failed for id ${id}:`, err.message); return []; })
    )
  );
  let allItems = results.flat();

  // M8: distinguish "no availability" from "all API calls failed"
  if (!anySuccess) return { error: 'availability_check_failed', slots: [], staff: [] };
  // Also where a treatment that only runs on certain days ends up when the
  // date is another day (the filter above): the day is named here too.
  if (allItems.length === 0) return nothingFree();

  // Mindbody returns ONE availability record per schedule-availability ROW the
  // team enters. A therapist afternoon entered as stacked 60-minute rows
  // (15:00–16:00 + 16:00–17:00) is contiguous free time, but no single record
  // fits an 80-minute session — so long treatments vanished from fragmented
  // schedules while the calendar looked wide open (the Jane Foo bug: only the
  // two ~90-min morning rows survived as 09:00/10:00, "no afternoon").
  // Merge touching/overlapping records per therapist+treatment+day; slot
  // generation then sees the real contiguous window. Different therapists
  // never merge — two people's adjacent hours are not one bookable stretch.
  allItems = mergeAvailabilityWindows(allItems);

  const now = new Date();
  const slots = [];
  const staffMap = {};

  for (const item of allItems) {
    const windowStart = new Date(item.StartDateTime);
    // Use EndDateTime as the hard end of the staff's shift.
    // A slot is only valid if the full session fits: slotTime + duration <= shiftEnd.
    const shiftEnd = new Date(item.EndDateTime);
    const staffId = item.Staff?.Id || 0;
    const staffName = item.Staff?.Name || null;
    const sessionTypeId = item.SessionType?.Id || 0;
    const windowDateStr = item.StartDateTime.split('T')[0];
    const validTimes = slotTimesFor(sessionTypeId, windowDateStr);
    // The whole Mindbody block must fit (an 85-minute float journey, not just
    // the 60-minute float) or the offer collides with the next booking.
    const durationMs = fitMinutes(sessionTypeId) * 60000;
    // Authoritative price for this treatment, so the confirmation summary can
    // show the correct amount (esp. for pay-on-location treatments paid at
    // reception). Same source as billing, so it always matches.
    const priceEur = paymentService.getPrice(sessionTypeId);
    const priceLabel = priceEur != null ? `€${priceEur}` : null;

    if (staffId && staffName) staffMap[staffId] = staffName;

    const pad = n => String(n).padStart(2, '0');

    // Helper to push a slot if it passes all validity checks
    const tryAddSlot = (slotTime, timeLabel) => {
      const slotEnd = new Date(slotTime.getTime() + durationMs);
      if (slotTime > now && slotTime >= windowStart && slotEnd <= shiftEnd) {
        const dateTime = `${windowDateStr}T${timeLabel}:00`;
        slots.push({
          id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
          dateTime,
          dateLabel: dayLabel(dateTime, lang),
          timeLabel,
          staffId,
          staffName,
          sessionTypeId,
          serviceName: getServiceName(sessionTypeId),
          price: priceLabel,
        });
      }
    };

    if (validTimes) {
      const windowDurationMs = shiftEnd - windowStart;
      // Narrow window = pre-scheduled specific slot (e.g. therapist booked 12:50-14:00 for a
      // 60-min session, ratio 1.17x). Only the exact StartDateTime is a valid Mindbody slot.
      // Wide window = open availability block (e.g. sauna room open 08:00-20:00 for 25-min
      // sessions, ratio 28.8x). Use fixed slot times within the window.
      const isNarrowWindow = windowDurationMs < durationMs * 2;

      // Room/resource services (Float, saunas, oxygen, etc.) must ONLY be offered
      // on their fixed grid — a window that starts off-grid (e.g. a 17:55
      // leftover gap) is not a real bookable slot and Mindbody rejects it at
      // booking, causing a ghost-slot retry loop. So force the grid path for
      // these, even for narrow windows. Per-therapist services keep the
      // narrow-window behaviour, where an off-grid window start IS bookable.
      const gridOnly = FIXED_GRID_SERVICES.has(sessionTypeId);

      if (isNarrowWindow && !gridOnly) {
        // Pre-scheduled therapist window: the exact windowStart is the valid slot
        const wsLabel = `${pad(windowStart.getHours())}:${pad(windowStart.getMinutes())}`;
        tryAddSlot(windowStart, wsLabel);
      } else {
        // Wide open block — generate from fixed slot times only.
        // Do NOT add windowStart if it falls outside the fixed times: arbitrary shift-start
        // times (e.g. 12:10 after a previous booking) would produce slots that Mindbody
        // rejects at booking time ("Resource is required" / invalid start time).
        for (const timeStr of validTimes) {
          const slotTime = new Date(`${windowDateStr}T${timeStr}:00`);
          tryAddSlot(slotTime, timeStr);
        }
      }
    } else {
      // Fallback: every 60 min rounded to half hour
      let t = new Date(windowStart);
      const m = t.getMinutes();
      if (m > 0 && m <= 30) t.setMinutes(30, 0, 0);
      else if (m > 30) t.setHours(t.getHours() + 1, 0, 0, 0);

      while (new Date(t.getTime() + durationMs) <= shiftEnd) {
        if (t > now) {
          const dateTime = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: dayLabel(dateTime, lang),
            timeLabel: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
            staffId,
            staffName,
            sessionTypeId,
            serviceName: getServiceName(sessionTypeId),
            price: priceLabel,
          });
        }
        t = new Date(t.getTime() + 60 * 60000);
      }
    }
  }

  // Deduplicate by dateTime + staffId + sessionTypeId
  const seen = new Set();
  let unique = slots.filter(s => {
    const key = `${s.dateTime}_${s.staffId}_${s.sessionTypeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  // Team-set closures and special hours (never offered, so never remembered
  // as offered either — book_appointment re-checks as well).
  const closedDays = new Map();
  unique = unique.filter(sl => {
    const c = closedFor(sl.dateTime, fitMinutes(sl.sessionTypeId));
    if (c) closedDays.set(sl.dateTime.slice(0, 10), c);
    return !c;
  });
  if (unique.length === 0 && closedDays.size > 0) {
    const [day, c] = [...closedDays.entries()][0];
    const res = closedResult(c, day);
    delete res.error;
    return { ...res, staff: [], days: checkedDays };
  }

  // Pay-first treatments (massages, facial, NSR, Let It Go): only offer a time
  // with enough notice, a free room (Mindbody's room occupancy — therapist
  // availability alone offered times whose rooms were taken) and no other
  // guest currently paying for that therapist/room.
  let payFirstHiddenByLead = 0;
  let payFirstEarliestHidden = null;
  if (unique.some(s => payFirstCfg.isPayFirst(s.sessionTypeId))) {
    const f = await payFirst.filterOfferedSlots(from, unique);
    unique = f.slots;
    payFirstHiddenByLead = f.hiddenByLead;
    payFirstEarliestHidden = f.earliestHidden;
  }

  // Unique staff available
  const staff = Object.entries(staffMap).map(([id, name]) => ({ id: Number(id), name }));

  // Loop-breaker: drop any slot the customer already tried to book that failed
  // in this conversation, so a ghost/just-taken slot can never be re-offered.
  const failedSlots = conversationService.get(from)?.failedSlots || [];
  const failedSet = new Set(failedSlots.map(f => `${f.dateTime}_${f.sessionTypeId}`));
  const usable = failedSet.size ? unique.filter(s => !failedSet.has(`${s.dateTime}_${s.sessionTypeId}`)) : unique;

  // If every requested treatment has already failed to book twice, stop the
  // loop: tell the model to escalate to the team instead of re-offering.
  const failCount = {};
  for (const f of failedSlots) failCount[f.sessionTypeId] = (failCount[f.sessionTypeId] || 0) + 1;
  const requested = session_type_ids || [];
  if (requested.length > 0 && requested.every(id => (failCount[id] || 0) >= 2)) {
    return {
      slots: [],
      staff: [],
      repeated_failure: true,
      message: 'Booking this treatment has failed repeatedly. Do NOT offer the same slot again. Apologise to the customer and call request_human_handoff (reason "repeated booking failure") so the team can help.',
    };
  }

  if (usable.length === 0) {
    if (payFirstHiddenByLead > 0) {
      return {
        slots: [],
        staff: [],
        no_availability: true,
        days: checkedDays,
        notice_required: `${payFirstCfg.PAY_FIRST_OFFER_LEAD_MINUTES} minutes`,
        message: `There are no times left with enough notice on ${checkedLabel}: massages, facials, Nervous System Reset and Let It Go are paid online before they are booked, so they need at least ${payFirstCfg.PAY_FIRST_OFFER_LEAD_MINUTES} minutes' notice. Tell the customer that kindly and suggest a later time or another day — do NOT say we are fully booked.`,
      };
    }
    return nothingFree();
  }

  // Remember every slot that is genuinely bookable per this check. book_appointment
  // verifies against this list: the model once transposed the DATE when a customer
  // typed a time in free text ("this morning ... 11.10" was confirmed and booked
  // for TOMORROW), and Mindbody happily accepted the wrong day. Recording the
  // real offer server-side lets us reject any invented date/time at booking.
  {
    const prior = conversationService.get(from)?.offeredSlots || [];
    const mergedOffers = [...prior, ...usable.map(s => ({ dateTime: s.dateTime, sessionTypeId: s.sessionTypeId }))];
    const offerSeen = new Set();
    const dedupedOffers = mergedOffers.filter(s => {
      const k = `${s.dateTime}_${s.sessionTypeId}`;
      if (offerSeen.has(k)) return false;
      offerSeen.add(k);
      return true;
    });
    conversationService.set(from, { offeredSlots: dedupedOffers.slice(-400) });
    persistGuardState(from);
  }

  // The WhatsApp list shows max 10 rows and the slots are sorted by time, so a
  // full-day treatment (e.g. Sweat & Reset every 35 min) would only ever show
  // the first 10 = MORNING, and an "afternoon" request still got morning slots.
  // Filter by the requested part of day so the customer sees the right times.
  const hourOf = (dt) => parseInt(dt.slice(11, 13), 10);
  let pool = usable;
  if (part_of_day) {
    const p = String(part_of_day).toLowerCase();
    pool = usable.filter(s => {
      const h = hourOf(s.dateTime);
      if (p === 'morning') return h < 12;
      if (p === 'afternoon') return h >= 12 && h < 17;
      if (p === 'evening') return h >= 17;
      return true;
    });
  }

  // One row per (date+time, treatment): a service with several rooms/therapists
  // free at the same time (e.g. two IR chambers) would otherwise show the same
  // time twice — "12:15, 12:15, ...". Keep the first (it carries a valid
  // resource/staff for booking; the exact room is picked at booking time).
  const seenTime = new Set();
  pool = pool.filter(s => {
    const k = `${s.dateTime}_${s.sessionTypeId}`;
    if (seenTime.has(k)) return false;
    seenTime.add(k);
    return true;
  });

  const range = { earliest: usable[0].timeLabel, latest: usable[usable.length - 1].timeLabel };

  if (pool.length === 0) {
    // The requested part of day is empty, but other times ARE free — don't imply
    // there's nothing; tell the model the real range so it can offer alternatives.
    return {
      slots: [],
      staff,
      no_slots_in_part: true,
      requested_part: part_of_day,
      available_range: range,
      days: checkedDays,
      message: `No ${part_of_day} slots for ${checkedLabel}, but there IS availability at other times (from ${range.earliest} to ${range.latest}). Tell the customer there are no ${part_of_day} slots, mention the times that ARE available, and offer another part of the day.`,
    };
  }

  // Deterministic safety net (does NOT depend on the model): with no part-of-day
  // preference and more slots than fit in the 10-row list, show an even SPREAD
  // across the whole day instead of the earliest 10. Otherwise a full-day
  // treatment always looked "mornings only" — the exact bug reported. When the
  // model DID pass part_of_day, pool is already the right window, so keep those
  // adjacent (slice).
  const pickSpread = (arr, n) => {
    if (arr.length <= n) return arr;
    const stepN = (arr.length - 1) / (n - 1);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = arr[Math.round(i * stepN)];
      if (s && !seen.has(s.dateTime)) { seen.add(s.dateTime); out.push(s); }
    }
    return out;
  };
  const spreadShown = !part_of_day && pool.length > 10;
  const shownSlots = spreadShown ? pickSpread(pool, 10) : pool.slice(0, 10);

  return {
    slots: shownSlots,
    staff,
    // The day(s) these times are on — they belong to no other day.
    days: dayList([...new Set(shownSlots.map(sl => sl.dateTime.slice(0, 10)))]),
    total_available: usable.length,
    shown: shownSlots.length,
    // When spread is true the times shown are sampled across the whole day (not
    // consecutive) — if the customer wants a specific part of day, call again
    // with part_of_day for the exact adjacent times there.
    spread: spreadShown,
    available_range: range, // full span of the day, so you never imply "morning only"
  };
}

// Tells the model what it still has to ask BEFORE the confirmation summary.
// Touriya, 27 Sep 2026: this returned the profile as it was — on a profile
// like hers that is a placeholder address presented as "her email" and the
// surname "WhatsApp" as her name — and a Mindbody error looked like "a new
// guest". The guarantee itself is in the booking tools (resolveBookingGuest).
async function toolLookupClient(from) {
  const newGuest = {
    found: false,
    needs_name_and_email: true,
    message: 'New guest. Before the confirmation summary, ask for their full name (first and last name) and email address (ui_type "none"). Only use what the customer types - never invent a name or an email address.',
  };
  if (isWebSession(from)) return newGuest;
  const stored = await storedContact(from);
  const storedEmail = usableEmail(stored?.email);
  let client = null;
  try {
    client = await mindbodyService.getClientByPhone(from, null);
  } catch (err) {
    logger.warn('lookup_client error:', err.message);
    return {
      found: false,
      lookup_failed: true,
      message: 'Our booking system did not answer, so we could not check whether this customer is already known. Do NOT tell the customer they are new or unknown. Continue with the confirmation summary using the name you have; book_appointment checks again and tells you (email_required) if a name or email address is still needed.',
    };
  }
  if (!client && stored?.mindbody_client_id) client = await clientByStoredId(stored);
  if (client) {
    const email = (await profileEmailOf(from, client, storedEmail)) || storedEmail;
    const known = { found: true, name: profileNameOf(client), email, clientId: String(client.Id) };
    if (email) return { ...known, email_on_file: true };
    return {
      ...known,
      needs_email: true,
      message: 'We know this guest but have no real email address for them. Before the confirmation summary, ask for their email address (ui_type "none"), e.g. "Could you share your email address? We use it for your booking confirmation and to reach you if anything changes." Only use an address the customer types - never invent one. When they have typed it, pass it as client_email to book_appointment / book_class, copied exactly: the server has no address for this guest, so do not leave client_email out.',
    };
  }
  // No profile by phone or by the stored id, but this number gave us an address
  // before (the team merged or removed the profile since — which is what our
  // notice asks them to do). The booking tool finds the profile by that
  // address, or makes a new one with it and asks for a full name itself if it
  // needs one; "a new guest, ask name and email" here contradicted it.
  if (storedEmail) {
    const name = stored?.full_name || null;
    return {
      found: true,
      name,
      email: storedEmail,
      email_on_file: true,
      message: isFullName(name) ? 'Returning guest - name and email are on file. Do NOT ask for them again.' : 'Returning guest - their email address is on file. Do NOT ask for it again.',
    };
  }
  return newGuest;
}

// Append a real booking to the per-conversation pending list so send_payment
// never has to trust AI-provided IDs. De-duplicates by booking_event_id so a
// reused/idempotent booking doesn't create a second Stripe line item.
function recordPendingBooking(from, booking) {
  const list = conversationService.get(from)?.pendingBookings || [];
  // De-dup by booking_event_id, falling back to appointment_id (the Mindbody id
  // is present even when logBookingEvent failed and booking_event_id is null),
  // so the same appointment never produces two Stripe line items.
  const dup = list.some(b =>
    (booking.booking_event_id && b.booking_event_id === booking.booking_event_id) ||
    (booking.appointment_id && b.appointment_id === booking.appointment_id)
  );
  if (dup) return;
  list.push(booking);
  conversationService.set(from, { pendingBookings: list });
}

// Save the guard state that must survive the 30-min memory TTL / a restart:
// the slots this customer was genuinely offered + their language. Fire and
// forget — see db.saveConversationState for why the cart and the confirmation
// gates are deliberately not part of it.
function persistGuardState(from) {
  if (String(from).startsWith('web_')) return;
  const conv = conversationService.get(from);
  if (!conv) return;
  // Strictly best-effort: persisting guard state must never break the tool
  // that triggered it (availability checks run with a mocked db in tests, and
  // a missing/failing writer only costs a re-check round later).
  try {
    const pending = db.saveConversationState?.(from, {
      offeredSlots: (conv.offeredSlots || []).slice(-400),
      lang: conv.lang || 'en',
    });
    pending?.catch?.(() => {});
  } catch (_) { /* best-effort */ }
}

// Record a slot that just failed to book so check_availability never re-offers
// it (loop-breaker). Uses set() — update() no-ops if the conversation TTL'd out.
function recordFailedSlot(from, sessionTypeId, dateTime) {
  const failed = conversationService.get(from)?.failedSlots || [];
  conversationService.set(from, { failedSlots: [...failed, { sessionTypeId, dateTime }] });
}

// Custom payment timeline after a link is sent (WhatsApp only). The customer is
// told they have 10 minutes; then:
//   T+5  → reminder: pay within 5 minutes
//   T+10 → tell the customer their payment time has expired
//   T+15 → if STILL unpaid, silently remove the booking from Mindbody (NO
//          message — they were already told at T+10). The 10→15 gap is a quiet
//          grace buffer so someone who pays a minute or two late is still
//          honoured.
// Stripe's own minimum auto-expiry is 30 min, so we drive the short window
// ourselves. In-memory timers; on restart it falls back to the 30-min Stripe
// expiry + the every-5-min safety cron.
function schedulePaymentTimeline(from, sessionId, paymentUrl, appointmentIds) {
  if (!sessionId || String(from).startsWith('web_')) return;
  const lang = conversationService.get(from)?.lang || 'en';

  const stillUnpaid = async () => {
    const info = await paymentService.getSessionStatus(sessionId);
    return !!info && info.status === 'open' && info.paymentStatus !== 'paid';
  };
  const sendLink = async (msg) => {
    if (paymentUrl) await whatsappService.sendCTAButton(from, msg, lang === 'nl' ? 'Betaal Nu' : 'Pay Now', paymentUrl);
    else await whatsappService.sendText(from, msg);
    db.logMessage(from, 'assistant', msg);
  };

  // T+5: reminder
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;
      if (await db.isHumanHandling(from)) return; // the team is talking to them — no automated pressure
      await sendLink(lang === 'nl'
        ? '⏳ Snelle herinnering: je boeking is nog niet bevestigd. Rond je betaling binnen 5 minuten af, anders wordt je plek vrijgegeven. Hier is je betaallink 👇'
        : '⏳ Quick reminder: your booking isn\'t confirmed yet. Please complete your payment within 5 minutes, otherwise your spot is released. Here\'s your payment link 👇');
    } catch (err) { logger.warn('Payment reminder (5m) failed:', err.message); }
  }, 5 * 60 * 1000);

  // T+10: tell them the payment time has expired (the link still quietly works
  // for a few more minutes so a slightly-late payment is honoured).
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;
      if (await db.isHumanHandling(from)) return; // held at T+15 instead — don't announce a release that won't happen
      await sendLink(lang === 'nl'
        ? '⌛ Je betaaltijd is verlopen en je boeking komt te vervallen. Als je net hebt betaald of nu nog betaalt, gaat je boeking gewoon door. 👇'
        : '⌛ Your payment time has expired and your booking will be released. If you have just paid, or pay right now, your booking will still go through. 👇');
    } catch (err) { logger.warn('Payment warning (10m) failed:', err.message); }
  }, 10 * 60 * 1000);

  // T+15: SILENTLY remove the booking from Mindbody if still unpaid. We cancel
  // the appointments first (so no second message), then expire the Stripe
  // session so a payment can no longer land on a released slot.
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;

      // Human-takeover hold: a team member is handling this customer (bot
      // paused, or "I'm on it") while this payment was open. Silently cancelling their
      // appointments mid-conversation with the team is the worst outcome — the
      // customer in the Maria incident was actively trying to pay and asking
      // for help when her sauna and float were released. Park the bookings for
      // the team instead: flagged + emailed, appointments left in Mindbody,
      // Stripe link left payable. needs_review keeps the cron off them; the
      // flip only happens on a confirmed flag write (same rule as elsewhere).
      if (await db.isHumanHandling(from)) {
        const held = [];
        for (const aptId of (appointmentIds || []).filter(Boolean)) {
          try {
            const row = await db.getBookingEventByAppointment(aptId);
            if (!row || row.status === 'paid') continue;
            const flagged = await db.logError('payment_timeout_held_human_takeover',
              `Payment window for apt ${aptId} (${from}) ran out while a human is handling the conversation — the booking was NOT released. Settle payment with the customer, or cancel it in Mindbody by hand.`,
              '', JSON.stringify({ from, aptId, sessionId }));
            if (flagged === true) {
              await db.updateBookingEvent(row.id, { status: 'needs_review' });
              held.push(aptId);
            }
          } catch (err) {
            logger.warn('Human-takeover hold failed for apt', aptId, err.message);
          }
        }
        if (held.length > 0) {
          db.markConversationEscalated(from, 'Payment on hold — settle or cancel');
          emailService.sendEscalationEmail({
            customerName: conversationService.get(from)?.userName || null,
            customerPhone: from,
            customerEmail: null,
            message: `⏸️ PAYMENT ON HOLD — this customer has an unpaid booking (appointment ID(s): ${held.join(', ')}) whose payment window expired while your team is handling the conversation. The bot did NOT release the booking and sent no deadline messages. Please settle the payment with the customer (the dashboard can send a payment link) or cancel the appointment(s) in Mindbody if they no longer want them.`,
          }).catch(err => logger.error('Hold escalation email error:', err.message));
          logger.info(`Payment timeout HELD for ${from} — human takeover, apts ${held.join(', ')} parked as needs_review`);
          return;
        }
        // Nothing could be parked (flag writes failed): fall through to the
        // normal release so no unflagged booking is left dangling.
      }

      for (const aptId of (appointmentIds || []).filter(Boolean)) {
        try {
          // Never cancel an appointment whose row reads PAID — this session
          // may be an orphaned duplicate while the customer paid another link
          // for the same booking (verify finding: refire). stillUnpaid() only
          // vouches for THIS session, so check the appointment itself.
          const row = await db.getBookingEventByAppointment(aptId);
          if (row?.status === 'paid') {
            logger.warn(`Payment timeout: apt ${aptId} reads PAID (another session) — refusing to cancel`);
            continue;
          }
          try {
            const released = await mindbodyService.cancelAppointment(aptId);
            releaseNotice.noticeIfReleasedAsNoShow(released, { appointmentId: aptId, row, reason: 'payment not completed within 15 minutes' });
          } catch (cancelErr) {
            if (!mindbodyService.isBenignCancelError(cancelErr)) {
              // Real release failure: do NOT mark the row expired — leaving it
              // 'payment_sent' keeps it inside the cron's retry and the
              // reconciliation sweep's reach. Flag it for the team.
              db.logError('appointment_release_failed', `T+15 timeout could not release apt ${aptId}: ${cancelErr.message}. Row left in-flight for the cron.`, '', JSON.stringify({ aptId }));
              logger.error('Payment-timeout cancel failed for apt', aptId, cancelErr.message);
              continue;
            }
            // Benign already-gone: fall through and mark expired.
          }
          db.query(
            `UPDATE booking_events SET status='expired', cancelled_at=NOW(), cancel_reason='payment_timeout' WHERE mindbody_appointment_id=$1 AND status <> 'paid'`,
            [aptId]
          ).catch(() => {});
        } catch (err) {
          logger.warn('Payment-timeout handling failed for apt', aptId, err.message);
        }
      }
      // Close the payment window — and CONFIRM it closed. A zombie session
      // that survives here stays payable until Stripe's own expiry while the
      // slots are already released; clearing lastBillingLink stops the
      // re-share path from surfacing it (the completed-webhook's dead-booking
      // escalation is the backstop if it does get paid).
      let expiredOk = await paymentService.expireSession(sessionId);
      if (!expiredOk) expiredOk = await paymentService.expireSession(sessionId);
      if (!expiredOk) {
        db.logError('zombie_session_after_timeout', `Session ${sessionId} for ${from} could not be expired after its bookings were released — a payment on it will need the team (dead-booking escalation covers it).`, '', JSON.stringify({ from }));
      }
      const convLink = conversationService.get(from)?.lastBillingLink;
      if (convLink?.sessionId === sessionId) {
        conversationService.update(from, { lastBillingLink: null });
      }
      logger.info('Payment timeout (silent): released booking, session', sessionId, 'for', from);

      // Turn the lost booking into a chance to improve: invite feedback with a
      // free treatment as a thank-you. (Only people who didn't pay get this.)
      try {
        const fbMsg = lang === 'nl'
          ? 'Je boeking is helaas niet afgerond. We maken het graag beter 🌿 Wil je ons kort vertellen hoe je onze boekings-assistent hebt ervaren? Als dank krijg je een GRATIS Red Light Therapy of Hydrowave massage 💚'
          : 'Your booking wasn\'t completed. We\'d love to do better 🌿 Would you share a little feedback on how our booking assistant worked for you? As a thank-you you\'ll get a FREE Red Light Therapy or Hydrowave massage 💚';
        await whatsappService.sendCTAButton(from, fbMsg, lang === 'nl' ? 'Geef feedback' : 'Give feedback', 'https://renessence.com/help-us-improve');
        db.logMessage(from, 'assistant', fbMsg);
      } catch (fbErr) { logger.warn('Feedback invite failed:', fbErr.message); }
    } catch (err) { logger.warn('Payment cancel (15m) failed:', err.message); }
  }, 15 * 60 * 1000);
}

/** Letters only, lower case, accents removed ("Daniëlle" → "danielle"). */
function lettersOf(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]/gu, '');
}
/** First name ("Gina van Spall" → "gina"). */
function firstNameOf(fullName) {
  return lettersOf(String(fullName || '').trim().split(/\s+/)[0]);
}
/**
 * Everything after the first name, letters only ("Gina van Spall" → "vanspall").
 * A surname the bot itself once wrote ("Touriya WhatsApp") is not a surname:
 * it says nothing about who someone is.
 */
function surnameOf(fullName) {
  const rest = String(fullName || '').trim().split(/\s+/).slice(1).join('');
  return isBotSurname(rest) ? '' : lettersOf(rest);
}
/** Same first name, or one is the initial of the other. */
function sameFirstName(a, b) {
  return a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));
}
/**
 * Could these two names be the same guest? Different first names → no; the
 * same first name with two clearly different surnames → no; otherwise yes
 * ("Gina" and "Gina van Spall" are the same guest).
 */
function sameGuestName(a, b) {
  const fa = firstNameOf(a);
  const fb = firstNameOf(b);
  if (!fa || !fb) return true;
  if (!sameFirstName(fa, fb)) return false;
  const la = surnameOf(a);
  const lb = surnameOf(b);
  if (!la || !lb) return true;
  return la.includes(lb) || lb.includes(la);
}
const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Is client_name someone else than the chat owner's profile?
 * - the owner's email → the owner (a different first name with the owner's
 *   email is handled by the caller as "shares the owner's email");
 * - the same first name → the owner, unless BOTH email and surname clearly
 *   differ (two people called Gina);
 * - a different first name → someone else, unless it is the name the owner
 *   uses on WhatsApp (profile "Georgina", chat name "Gina").
 */
function isOtherPerson(ownerClient, clientName, clientEmail, chatName = null) {
  const a = firstNameOf(clientName);
  const b = firstNameOf(ownerClient?.FirstName);
  if (!a || !b) return false;
  if (sameEmail(clientEmail, ownerClient?.Email)) return false;
  if (sameFirstName(a, b)) {
    const ls = surnameOf(clientName);
    // Touriya review, Nov 2026: on her profile "Touriya WhatsApp" the model
    // passed her real full name with the address she had just typed — "two
    // people called Touriya", so she got yet another profile (without her
    // number) and was asked for her address again at every visit.
    const lo = isBotSurname(ownerClient?.LastName) ? '' : lettersOf(ownerClient?.LastName);
    return !!(clientEmail && ownerClient?.Email && ls && lo && !ls.includes(lo) && !lo.includes(ls));
  }
  const c = firstNameOf(chatName);
  if (c && sameFirstName(a, c)) return false;
  return true;
}

// ---- The guest's real email address ----
// Touriya, 27 Sep 2026: book_appointment was called with only a first name and
// an address nobody had typed — the model made it up because the tool demanded
// one — and a Mindbody profile "Touriya WhatsApp" was created with it. When
// her payment failed the team could not email her. Since then the model's
// word is never enough: an address only counts when it is well-formed, not
// reserved, and typed by the guest in this chat, on their own Mindbody
// profile, or stored for their number from an earlier booking
// (guest_contacts). Every check here fails soft: a database error reads as
// "nothing stored / nothing typed" and the guest is simply asked.

const isWebSession = (from) => String(from).startsWith('web_');

/** Our own mailboxes — they are all over the prompt, so the first address a model grabs. */
function teamAddresses() {
  try {
    return [...Object.values(settings.contact()?.emails || {}), settings.teamInbox()].filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** The cleaned address when it is well-formed and not reserved, else null. */
function usableEmail(email) {
  return guestEmail.isUsable(email, teamAddresses()) ? guestEmail.clean(email) : null;
}

/** A surname the bot itself wrote when a guest gave one word ("Touriya WhatsApp"). */
function isBotSurname(lastName) {
  return ['whatsapp', 'web', '-'].includes(String(lastName || '').trim().toLowerCase());
}

/** A first AND a last name — and not a surname the bot once made up. */
function isFullName(name) {
  const rest = String(name || '').trim().split(/\s+/).slice(1).join(' ');
  return !!firstNameOf(name) && !!lettersOf(rest) && !isBotSurname(rest);
}

/** A profile's name as the guest would give it (without a made-up surname). */
function profileNameOf(client) {
  return `${client?.FirstName || ''} ${isBotSurname(client?.LastName) ? '' : (client?.LastName || '')}`.trim();
}

/**
 * What this number gave us at an earlier booking (guest_contacts), or null.
 * Never for the website chat: a session is not a person we can remember.
 */
async function storedContact(from) {
  if (isWebSession(from)) return null;
  try {
    return (await db.getGuestContact?.(from)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Did the guest type this address in this chat? Memory first (the message
 * being handled is written to the database without waiting for it), then
 * their stored messages — guests come back days after the 30-minute memory
 * is gone.
 */
async function typedInChat(from, email) {
  const inMemory = conversationService.getMessages(from)
    // "__RESUME__ …" is the team handing the chat back, not the guest's words.
    .filter(m => m.role === 'user' && !String(m.content).startsWith('__RESUME__'))
    .map(m => m.content);
  if (guestEmail.typedByGuest(email, inMemory)) return true;
  let stored = [];
  try {
    stored = (await db.getGuestTypedTexts?.(from)) || [];
  } catch (_) {
    stored = [];
  }
  return guestEmail.typedByGuest(email, stored);
}

/**
 * May the address the model passed be used for this guest? Only when the
 * guest typed it, or it equals an address we already trust (`trusted`: the one
 * on their profile, the one stored for their number).
 * @returns {Promise<{ok:true,email:string}|{ok:false,reason:'missing'|'invalid'|'placeholder'|'not_from_guest',given:string|null}>}
 */
async function vetGuestEmail(from, email, trusted = []) {
  const e = guestEmail.clean(email);
  if (!e) return { ok: false, reason: 'missing', given: null };
  if (!guestEmail.isWellFormed(e)) return { ok: false, reason: 'invalid', given: e };
  if (guestEmail.isReserved(e, teamAddresses())) return { ok: false, reason: 'placeholder', given: e };
  if (trusted.some(t => sameEmail(t, e))) return { ok: true, email: e };
  if (await typedInChat(from, e)) return { ok: true, email: e };
  return { ok: false, reason: 'not_from_guest', given: e };
}

/**
 * The email address on a Mindbody profile when it can be trusted, else null.
 * Search results can leave Email out, so the full profile is read before
 * anyone is asked. On a profile the bot once made from a one-word name
 * (surname WhatsApp / Web / -) an address only counts when the guest typed it
 * or it is the one stored for them: that is where invented addresses sit, and
 * no list of placeholders recognises "firstname@gmail.com".
 * `read.failed` is set when the full profile could not be read, or the answer
 * was not this profile: the guest is asked all the same (nothing is assumed),
 * but that is not "this profile has no address" — the team is not told so.
 */
async function profileEmailOf(from, client, storedEmail = null, read = {}) {
  let email = guestEmail.clean(client?.Email);
  if (!email && client?.Id != null) {
    let full = null;
    try {
      full = await mindbodyService.getClientById(client.Id);
    } catch (_) {
      full = null;
    }
    // Only this profile's own answer counts — never another client's address.
    if (full && String(full.Id) === String(client.Id)) email = guestEmail.clean(full.Email);
    else read.failed = true;
  }
  const usable = usableEmail(email);
  if (!usable) return null;
  if (isBotSurname(client.LastName) && !sameEmail(usable, storedEmail) && !(await typedInChat(from, usable))) return null;
  return usable;
}

/**
 * The profile this number booked on before — used only while it still exists,
 * is active and carries the same first name (profiles get merged and removed).
 */
async function clientByStoredId(stored) {
  try {
    const client = await mindbodyService.getClientById(stored.mindbody_client_id);
    if (!client || client.Active === false) return null;
    if (String(client.Id) !== String(stored.mindbody_client_id)) return null;
    if (stored.full_name && !sameFirstName(firstNameOf(stored.full_name), firstNameOf(client.FirstName))) return null;
    return client;
  } catch (_) {
    return null;
  }
}

/**
 * Website chat: the phone number the model passes counts only when the
 * visitor typed it (its last nine digits stand in a message of theirs) — the
 * same rule as for the email address. An invented number can match a
 * stranger's Mindbody profile. "web_<session>" itself is never a number.
 */
function typedPhone(from, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  const tail = digits.slice(-9);
  const typed = conversationService.getMessages(from)
    .some(m => m.role === 'user' && String(m.content).replace(/\D/g, '').includes(tail));
  return typed ? String(phone).trim() : null;
}

/** The last nine digits: "+31 6 1234 5678", "0612345678" and "31612345678" all give "612345678". */
function phoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Is this phone number on the profile? Security review, 24 Nov 2026: a typed
 * email address is not proof that the profile carrying it is the typer's —
 * anyone who knows a guest's address can type it. A profile found by email,
 * name or another number is only used when the number we trust (the WhatsApp
 * sender, or in the website chat a number the visitor typed) is on it.
 */
function profileHasPhone(client, phone) {
  const tail = phoneTail(phone);
  return !!tail && [client?.MobilePhone, client?.HomePhone, client?.WorkPhone].some(p => phoneTail(p) === tail);
}

/** The refusal when a profile exists for these details but is not this guest's to use. */
function profileNotLinked(from) {
  return {
    error: 'profile_not_linked',
    nothing_booked: true,
    message: isWebSession(from)
      ? 'NOTHING was booked. A profile with these details exists, but not with a phone number the visitor typed in this chat, so it cannot be used here. Say nothing about that profile. Ask once for the phone number they use at Renessence (only a number they type counts); if they already gave it, point them to renessence.com/booking or welcome@renessence.com.'
      : 'NOTHING was booked. A profile with these details exists in our system, but it is not linked to this WhatsApp number, so you may not book on it. Say nothing about that profile (no name, no details, not even that it exists under another number). Tell the customer our team will complete the booking here in the chat, and call request_human_handoff with a reason starting "Profile not linked to this number - book by hand:" followed by name, email, treatment, date and time.',
  };
}

// One word of a name: letters, with - ' . inside ("Jan-Willem", "O'Brien").
const NAME_WORD = /^\p{L}[\p{L}\p{M}'’.-]*$/u;

/**
 * The first and last name for a NEW profile, or null. The name the model
 * passed when it has both; a one-word name is completed only from what the
 * guest gave us themselves — the name stored for their number or their
 * WhatsApp name — and only when the first name matches.
 * A WhatsApp name is free text ("Touriya 🌸 Fixture", "Touriya | Coach",
 * "T Fixture"): it only supplies the SURNAME, and only when every word of it
 * reads as a name. Taken whole it wrote "🌸 Fixture" and "| Coach" into
 * Mindbody as surnames — the same family as "WhatsApp".
 */
function newProfileName(clientName, stored, chatName) {
  if (isFullName(clientName)) return String(clientName).trim();
  const first = firstNameOf(clientName);
  if (isFullName(stored?.full_name) && (!first || sameFirstName(first, firstNameOf(stored.full_name)))) return String(stored.full_name).trim();
  const chatWords = String(chatName || '').trim().split(/\s+/);
  if (first && isFullName(chatName) && sameFirstName(first, firstNameOf(chatName))
    && chatWords.every(w => NAME_WORD.test(w)) && lettersOf(chatWords[chatWords.length - 1]).length >= 2) {
    // The first name stays the one the guest gave, unless that is the initial.
    const given = String(clientName).trim().split(/\s+/)[0];
    const firstWord = lettersOf(given).length >= lettersOf(chatWords[0]).length ? given : chatWords[0];
    return `${firstWord} ${chatWords.slice(1).join(' ')}`;
  }
  return null;
}

const EMAIL_REFUSAL_WHY = {
  missing: () => 'We have no email address for this guest.',
  invalid: (given) => `"${given}" is not a complete email address.`,
  placeholder: (given) => `"${given}" is not a real address of this guest.`,
  not_from_guest: (given) => `"${given}" was not typed by the customer in this chat.`,
};
const NO_FULL_NAME = 'A new guest needs a first and last name, as the customer gives it - never make up a surname.';
const NO_SURNAME_HANDOFF = 'No full name - book by hand:';
// The agent loop lets ONE corrected booking call through after a refusal (see
// emailRefusal there) — for a guest who had typed it and the model left it out.
const RETRY_ONLY_IF_TYPED = ' — unless the customer has ALREADY typed it in this chat and you left it out or changed it: then call once more with it copied exactly.';

/**
 * The one refusal for a missing email address or name: nothing was booked,
 * nothing was created, and the model is told exactly what to ask — it has no
 * reason left to make something up or to keep trying.
 * No "asked before?" state: whether a guest declined is for the model to
 * judge, and a wrong call costs one extra question.
 */
function emailRequired(from, { tool, vetted, needEmail = true, needName = false }) {
  const given = String(vetted?.given || '').slice(0, 100);
  const again = `call ${tool} again with the same ${tool === 'book_class' ? 'class' : 'treatment and time'}`;
  if (!needEmail) {
    // Not a dead end either: some guests have one name, or keep their surname.
    const noSurname = isWebSession(from)
      ? 'If the visitor has only one name or does not want to give a surname, do not ask again and do not book: point them to renessence.com/booking.'
      : `If the customer was already asked in this chat and has only one name or does not want to give a surname, do not ask again and do not book: tell them our team will arrange the booking here in the chat and call request_human_handoff with a reason starting "${NO_SURNAME_HANDOFF}" followed by name, treatment, date and time.`;
    return {
      error: 'email_required',
      reason: 'name_missing',
      need_name: true,
      nothing_booked: true,
      message: `NOTHING was booked and no profile was created. ${NO_FULL_NAME} Ask them now, in their language (ui_type "none"), for their full name (first and last name). Do NOT call ${tool} again in this turn${RETRY_ONLY_IF_TYPED} When they have typed it, ${again} and that client_name. ${noSurname}`,
    };
  }
  const reason = vetted?.reason || 'missing';
  const declined = isWebSession(from)
    ? 'If the visitor does not want to share an email address, do not book: point them to renessence.com/booking.'
    : 'If the customer was already asked in this chat and does not want to share an email address, do not ask again and do not book: tell them our team will arrange the booking here in the chat and call request_human_handoff with a reason starting "No email - book by hand:" followed by name, treatment, date and time.';
  return {
    error: 'email_required',
    reason,
    ...(needName ? { need_name: true } : {}),
    nothing_booked: true,
    message: `NOTHING was booked and no profile was created. ${EMAIL_REFUSAL_WHY[reason](given)} We need this guest's own email address${needName ? ' and full name (first and last name)' : ''}, typed by the customer in this chat - never invent, guess, complete or correct one. Ask them now, in their language (ui_type "none"), for example: "Before I book this for you: could you type your ${needName ? 'full name and ' : ''}email address? We use it for your confirmation and to reach you if anything changes." Do NOT call ${tool} again in this turn${RETRY_ONLY_IF_TYPED} When they have typed it, ${again} and that address copied exactly. ${declined}`,
  };
}

/** The same refusal for a second person in the chat (a friend, a partner). */
function companionRequired(clientName, { vetted, needEmail = true }) {
  const given = String(vetted?.given || '').slice(0, 100);
  if (!needEmail) {
    return {
      error: 'companion_email_required',
      reason: 'name_missing',
      need_name: true,
      nothing_booked: true,
      message: `NOTHING was booked for ${clientName} and no profile was created. ${NO_FULL_NAME} Ask for ${clientName}'s full name (first and last name). Do NOT call book_appointment for ${clientName} again in this turn${RETRY_ONLY_IF_TYPED} When the customer has typed it, call book_appointment again with that client_name and the same client_email. If the customer was already asked and ${clientName} has only one name or they do not want to give the surname, do not ask again and do not book for ${clientName}: tell them our team will arrange it and call request_human_handoff with a reason starting "${NO_SURNAME_HANDOFF}" followed by both names, treatment, date and time.`,
    };
  }
  const reason = vetted?.reason || 'missing';
  return {
    error: 'companion_email_required',
    reason,
    nothing_booked: true,
    message: `NOTHING was booked for ${clientName}. ${EMAIL_REFUSAL_WHY[reason](given).replace('this guest', () => clientName)} Each guest gets their own booking and we need THEIR own email address, typed by the customer in this chat - never invent one. Ask for it (if the customer wants one address for both guests they can say so, and you pass the chat owner's own address). Do NOT call book_appointment for ${clientName} again in this turn${RETRY_ONLY_IF_TYPED} When the customer has typed it, call book_appointment again with client_name and client_email of ${clientName}.`,
  };
}

// What the guest is asked when a turn ends on that refusal without a reply
// (agent loop): the question the model should have asked — it used to be
// "No availability was found", which answers something nobody asked.
const EMAIL_QUESTIONS = {
  en: {
    email: 'Before I can book this for you, I need your email address — could you type it here? We use it for your confirmation and to reach you if anything changes.',
    nameAndEmail: 'Before I can book this for you, I need your full name and email address — could you type them here? We use them for your confirmation and to reach you if anything changes.',
    name: 'Before I can book this for you, I need your full name (first and last name) — could you type it here?',
    companion: 'Before I can book this for your guest, I need their full name and their own email address — could you type them here? Each guest gets their own booking.',
  },
  nl: {
    email: 'Voordat ik dit voor je kan boeken, heb ik je e-mailadres nodig — wil je het hier typen? We gebruiken het voor je bevestiging en om je te bereiken als er iets verandert.',
    nameAndEmail: 'Voordat ik dit voor je kan boeken, heb ik je volledige naam en e-mailadres nodig — wil je die hier typen? We gebruiken ze voor je bevestiging en om je te bereiken als er iets verandert.',
    name: 'Voordat ik dit voor je kan boeken, heb ik je volledige naam nodig (voor- en achternaam) — wil je die hier typen?',
    companion: 'Voordat ik dit voor je gast kan boeken, heb ik de volledige naam en het eigen e-mailadres van je gast nodig — wil je die hier typen? Elke gast krijgt een eigen boeking.',
  },
};
function emailQuestion(lang, refusal) {
  const texts = EMAIL_QUESTIONS[lang === 'nl' ? 'nl' : 'en'];
  if (refusal?.error === 'companion_email_required') return texts.companion;
  if (refusal?.reason === 'name_missing') return texts.name;
  return refusal?.need_name ? texts.nameAndEmail : texts.email;
}

/**
 * Who is this booking for, and on which Mindbody profile? Shared by
 * book_appointment and book_class. In order:
 *  1. the phone lookup — WITHOUT the model's email: an address nobody checked
 *     is not even searched in Mindbody (it can match a stranger's profile).
 *     Not in the website chat: there is no number to trust there;
 *  2. the profile this number booked on before (guest_contacts): a profile
 *     found by email does not carry the WhatsApp number, so at the next visit
 *     the phone lookup misses it (the likely origin of her second profile);
 *  3. the email search, only with a vetted or stored address;
 *  4. a NEW profile: only with a first and last name and such an address
 *     (else email_required), and for book_appointment only after the Confirm
 *     tap (else confirmation_required) — a profile used to be created before
 *     the Confirm gate was even looked at. book_class has no Confirm gate.
 * Returns { refusal }, or { client, email, vetted, profileEmail, profileUnread,
 * storedEmail, foundByPhone, forSomeoneElse }: `email` is the model's address
 * when it passed the check (else null), `profileEmail` the profile's own
 * usable one, `profileUnread` that the profile's address could not be read.
 */
async function resolveBookingGuest(from, { client_name, client_email, client_phone, tool, stored }) {
  const isWeb = isWebSession(from);
  const storedEmail = usableEmail(stored?.email);
  // Website chat: a visitor is found by the email they typed, never by a phone
  // number. A typed number can be anyone's — a class landed on that person's
  // profile and Stripe showed their address (review, Nov 2026). The number
  // only goes on a NEW profile.
  const newProfilePhone = isWeb ? typedPhone(from, client_phone) : from;

  let client = isWeb ? null : await mindbodyService.getClientByPhone(from, null);
  const foundByPhone = !!client;
  if (!client && stored?.mindbody_client_id) client = await clientByStoredId(stored);

  const read = {};
  let profileEmail = client ? await profileEmailOf(from, client, storedEmail, read) : null;
  const vetted = await vetGuestEmail(from, client_email, [profileEmail, storedEmail]);
  const email = vetted.ok ? vetted.email : null;

  // The number that proves a profile is theirs: the WhatsApp sender, or in
  // the website chat a number the visitor typed.
  const ownPhone = isWeb ? newProfilePhone : from;
  if (!client && (email || storedEmail)) {
    const found = await mindbodyService.searchClientByEmail(email || storedEmail);
    if (found) {
      if (!profileHasPhone(found, ownPhone)) return { refusal: profileNotLinked(from) };
      client = found;
      // The search only returns a profile that carries exactly this address.
      profileEmail = email || storedEmail;
    }
  }

  let forSomeoneElse = false;
  if (!client) {
    const chatOwnerName = conversationService.get(from)?.userName || null;
    const fullName = newProfileName(client_name, stored, chatOwnerName);
    // The stored address is the chat owner's. It goes on a new profile only
    // for the owner (no name given, or a first name that is theirs): a first
    // call for a friend used to make the friend's profile with it.
    const first = firstNameOf(client_name);
    const storedIsTheirs = !first || [stored?.full_name, chatOwnerName].some(n => !!firstNameOf(n) && sameFirstName(first, firstNameOf(n)));
    const newEmail = email || (storedIsTheirs ? storedEmail : null);
    if (!fullName || !newEmail) {
      return { refusal: emailRequired(from, { tool, vetted, needEmail: !newEmail, needName: !fullName }) };
    }
    if (isWeb && tool === 'book_appointment' && !newProfilePhone) {
      return { refusal: { error: 'client_phone_required', message: 'Need phone number to create account. Ask the visitor to type it - only a number they typed in this chat counts, never fill one in yourself.' } };
    }
    if (tool === 'book_appointment' && !confirmedRecently(from)) return { refusal: CONFIRMATION_REQUIRED };
    const parts = fullName.split(/\s+/);
    // A new number booking only for someone ELSE (the friend's call came
    // first, or a gift): their profile must not carry the chat owner's phone.
    // Only on a clear signal: the WhatsApp name has a surname and it differs
    // from the guest's surname. A nickname ("Liz" booking as "Elizabeth
    // Jansen") or a first-name-only WhatsApp name keeps the phone.
    // book_appointment only, as before: a class has no second person, and a
    // class profile without the number cannot be found by the unpaid-class
    // release or the reminders (both look guests up by phone).
    const ownerLast = surnameOf(chatOwnerName);
    const guestLast = surnameOf(fullName);
    forSomeoneElse = tool === 'book_appointment' && !isWeb && !!chatOwnerName && !!ownerLast && !!guestLast
      && !ownerLast.includes(guestLast) && !guestLast.includes(ownerLast)
      && isOtherPerson({ FirstName: chatOwnerName }, fullName, null);
    try {
      client = await mindbodyService.addClient({ firstName: parts[0], lastName: parts.slice(1).join(' '), email: newEmail, mobilePhone: forSomeoneElse ? null : newProfilePhone, city: 'Amsterdam' });
    } catch (addErr) {
      if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
        client = isWeb
          ? await mindbodyService.searchClientByEmail(newEmail)
          : await mindbodyService.getClientByPhone(from, newEmail);
        if (!client) throw addErr;
        // Found by the address only: the same rule as above.
        if (!profileHasPhone(client, ownPhone)) return { refusal: profileNotLinked(from) };
      } else throw addErr;
    }
    profileEmail = newEmail;
  }
  return { client, email, vetted, profileEmail, profileUnread: !!read.failed, storedEmail, foundByPhone, forSomeoneElse };
}

/**
 * After a booking for the chat owner went through: remember what this number
 * gave us, and tell the team when the Mindbody profile itself still has no
 * real address. Best-effort: it never throws, and only the small database
 * write is waited for (the team's mail is not) — it must never break or hold
 * up the guest's reply.
 */
async function afterOwnBooking(from, { client, clientName, guest, email }) {
  if (!email) return;
  // Only the chat owner's own booking. book_class has no second-person
  // handling: a class "for my friend Nadia" on the owner's profile stored
  // Nadia's name and address as the owner's, and mailed the team to put
  // Nadia's address on the owner's profile (review, Nov 2026).
  if (clientName && isOtherPerson(client, clientName, null, conversationService.get(from)?.userName || null)) return;
  // Written before the tool answers: the next booking call of the same turn (a
  // journey) reads it. Not waited for, that call asked for the address again.
  await rememberGuest(from, { client, clientName, guest, email });
  // A profile whose address could not be READ is not a profile without one.
  // The team's mail is not waited for.
  if (!guest.profileEmail && !guest.profileUnread) notifyProfileWithoutEmail(from, client, email);
}

/**
 * Store email, full name and Mindbody profile for this number. Only the chat
 * owner's own: the profile was found by this number, or the booking is under
 * the name they use on WhatsApp — a first booking made for a friend must not
 * become "the owner's" contact. Never for the website chat.
 */
async function rememberGuest(from, { client, clientName, guest, email }) {
  if (isWebSession(from)) return;
  const chatFirst = firstNameOf(conversationService.get(from)?.userName);
  const bookedFirst = firstNameOf(clientName || client.FirstName);
  if (!guest.foundByPhone && !(chatFirst && bookedFirst && sameFirstName(bookedFirst, chatFirst))) return;
  const fullName = (isFullName(clientName) ? String(clientName).trim() : profileNameOf(client)) || null;
  try {
    await db.saveGuestContact?.(from, { email, fullName, mindbodyClientId: String(client.Id) });
  } catch (_) { /* best-effort: the booking stands either way */ }
}

/**
 * Team decision (Touriya, 27 Sep 2026): the bot does not rewrite existing
 * Mindbody profiles — that call was never tried on this site and can leave
 * two profiles with one address. The address goes into the appointment note
 * and the team is told once a week per number, like duplicate profiles.
 */
async function notifyProfileWithoutEmail(from, client, email) {
  try {
    if (await db.hasRecentTeamNotification?.(from, 'profile_without_email', 7 * 24 * 60)) return;
    const name = `${client.FirstName || ''} ${client.LastName || ''}`.trim() || 'unnamed';
    const message = `Mindbody profile ${client.Id} (${name}) has no real email address. The guest gave: ${email}. Please update or merge the profile.`;
    await db.logEscalation?.(from, name, 'profile_without_email', message);
    await emailService.sendEscalationEmail({ customerName: name, customerPhone: from, customerEmail: email, message });
  } catch (err) {
    logger.warn('Profile-without-email notice failed:', err.message);
  }
}

/**
 * The address the team or Stripe may be given for this guest: the one the
 * model passed when the guest really typed it (or we already trust it), else
 * the one we have for them, else none. An invented address is dropped, never
 * forwarded — and never a reason to hold a WhatsApp handoff back.
 */
async function reachableEmail(from, given, alsoTrusted = null) {
  try {
    const trusted = [usableEmail(alsoTrusted), usableEmail((await storedContact(from))?.email)].filter(Boolean);
    const vetted = await vetGuestEmail(from, given, trusted);
    return vetted.ok ? vetted.email : (trusted[0] || null);
  } catch (_) {
    return null;
  }
}

// What resolveCompanionClient answers when a NEW profile would be needed but
// may not be created yet: only a first name is known (it used to get the
// surname "-"), or the customer has not tapped Confirm.
const NEEDS_FULL_NAME = Symbol('needs_full_name');
const NEEDS_CONFIRM = Symbol('needs_confirm');

/**
 * The second person's own Mindbody profile: found by email, or created with
 * their name and email (never with the chat owner's phone — that would tie
 * two people to one number). null when neither works. A profile that exists
 * is used as before; a NEW one is only created with a first and last name
 * (else NEEDS_FULL_NAME) and after the Confirm tap (else NEEDS_CONFIRM).
 */
async function resolveCompanionClient(clientName, clientEmail, { confirmed }) {
  try {
    const found = await mindbodyService.searchClientByEmail(clientEmail);
    // A shared/household email can belong to someone else (her mother's
    // profile): only use it when the name fits the person being booked.
    if (found?.Id && !isOtherPerson(found, clientName, null)) return found;
  } catch (err) {
    logger.warn('Companion lookup by email failed:', err.message);
  }
  if (!isFullName(clientName)) return NEEDS_FULL_NAME;
  if (!confirmed) return NEEDS_CONFIRM;
  const parts = String(clientName).trim().split(/\s+/);
  try {
    const created = await mindbodyService.addClient({ firstName: parts[0], lastName: parts.slice(1).join(' '), email: clientEmail, mobilePhone: null, city: 'Amsterdam' });
    if (created?.Id) return created;
  } catch (err) {
    logger.warn('Companion profile could not be created:', err.response?.data?.Error?.Message || err.message);
  }
  return null;
}

/**
 * A pay-first link was created earlier in this turn and another booking in the
 * same turn was refused: the model's explanation must reach the guest too, not
 * only the link message.
 */
function markPendingLinkWithReply(from) {
  const pending = conversationService.get(from)?.payFirstLinkPending;
  if (pending) conversationService.update(from, { payFirstLinkPending: { ...pending, alsoSendModelText: true } });
}

/**
 * Mindbody didn't confirm a booking (timeout / 5xx): it may or may not exist.
 * Never POST again — look it up. Found → use it. Otherwise flag it for the
 * team and tell the model the booking is unconfirmed (not "unavailable").
 */
const BOOKING_UNCONFIRMED = {
  error: 'booking_unconfirmed',
  message: 'Our booking system did not confirm this booking. Do NOT say the time is unavailable, do NOT book it again and do NOT offer another time for it. Tell the customer our team is checking it and will confirm shortly.',
};
async function settleUnknownBooking(from, clientId, sessionTypeId, startDateTime, staffId, err) {
  let found = null;
  let lookupFailed = false;
  try { found = await mindbodyService.findClientAppointmentAt(clientId, startDateTime, sessionTypeId); } catch (_) { lookupFailed = true; }
  if (found?.Id) {
    logger.warn(`Unclear Mindbody answer for ${from} — appointment ${found.Id} found and used`);
    return found;
  }
  await db.logError('booking_outcome_unknown', `Mindbody did not confirm ${getServiceName(sessionTypeId) || sessionTypeId} for ${from} at ${startDateTime}${lookupFailed ? ' and the lookup failed' : ' and it was not found'}. CHECK MINDBODY for an orphan appointment.`, '', JSON.stringify({ phone: from, clientId, sessionTypeId, startDateTime, staffId, error: err?.message }));
  db.markConversationEscalated(from, 'Booking not confirmed by Mindbody — check it');
  return null;
}

/**
 * Pay-first booking: nothing is booked in Mindbody yet. Check the time can
 * really be booked (notice, therapist free, a room free, nobody else paying
 * for it), then create the awaiting-payment row and its Stripe link. The
 * webhook books it once the payment is in.
 */
async function bookPayFirst(from, { client, session_type_id, start_date_time, staff_id, client_name, client_email, notes, emailNote = null, companionNote = null, replaceRows = null }) {
  const sessionTypeId = Number(session_type_id);
  const startMs = new Date(start_date_time).getTime();
  if (!(startMs >= Date.now() + payFirstCfg.PAY_FIRST_BOOK_LEAD_MINUTES * 60000)) {
    recordFailedSlot(from, sessionTypeId, start_date_time);
    return {
      error: 'slot_too_soon',
      message: `This time is too soon: these treatments are paid online before they are booked, so they need at least ${payFirstCfg.PAY_FIRST_BOOK_LEAD_MINUTES} minutes' notice. Apologise briefly and call check_availability again for a later time or another day.`,
    };
  }
  const amountCents = paymentService.getPriceInCents(sessionTypeId);
  if (!amountCents) {
    return { error: 'price_unknown', message: 'The price for this treatment is not configured. Apologise and call request_human_handoff so the team can book it.' };
  }

  // Who is free at this time right now (the offer may be minutes old)?
  const therapistChoice = conversationService.get(from)?.therapistChoice;
  const staffRequested = therapistChoice != null && therapistChoice !== 'any' && Number(therapistChoice) === Number(staff_id);
  let candidates;
  try {
    candidates = await mindbodyService.findAvailableStaffForTime(sessionTypeId, start_date_time, null, { throwOnError: true });
  } catch (_) {
    // Mindbody didn't answer — that says nothing about the slot.
    return { error: 'booking_temporarily_unavailable', message: 'Our booking system could not be checked just now. Apologise and ask the customer to try again in a few minutes. Do NOT create or promise a payment link.' };
  }
  let staffId = Number(staff_id) || 0;
  if (!staffId || !candidates.map(Number).includes(staffId)) {
    if (staffRequested) {
      recordFailedSlot(from, sessionTypeId, start_date_time);
      return { error: 'therapist_unavailable', message: 'The therapist the customer chose is no longer free at this time. Apologise, and offer other times with that therapist or another therapist (call check_availability again).' };
    }
    staffId = Number(candidates[0]) || 0;
  }
  if (!staffId) {
    recordFailedSlot(from, sessionTypeId, start_date_time);
    return { error: 'slot_unavailable', message: 'This time can no longer be booked — no therapist is free anymore. Apologise briefly (do NOT say someone "just" took it) and call check_availability again for the same treatment.' };
  }

  // A free room, per Mindbody's room occupancy and other guests' open links.
  const occupancy = await payFirst.occupancyFor(start_date_time);
  if (occupancy === null) {
    return { error: 'booking_temporarily_unavailable', message: 'Our booking system could not be checked just now. Apologise and ask the customer to try again in a few minutes. Do NOT create or promise a payment link.' };
  }
  const holds = await db.getActivePayFirstHolds(from);
  let pick = payFirst.pickRoom({ sessionTypeId, startDateTime: start_date_time, staffId, occupancy, holds });
  if (!pick.ok && pick.reason === 'therapist_on_hold' && !staffRequested) {
    // Another guest is paying for this therapist — any other free one will do.
    for (const c of candidates.map(Number)) {
      if (c === staffId) continue;
      const alt = payFirst.pickRoom({ sessionTypeId, startDateTime: start_date_time, staffId: c, occupancy, holds });
      if (alt.ok) { staffId = c; pick = alt; break; }
    }
  }
  if (!pick.ok) {
    recordFailedSlot(from, sessionTypeId, start_date_time);
    return { error: 'slot_unavailable', reason: pick.reason, message: 'This time can no longer be booked (the room or therapist is taken). Apologise briefly — do NOT say someone "just" took it — and call check_availability again for the same treatment.' };
  }

  const lang = conversationService.get(from)?.lang || 'en';
  const serviceName = payFirstCfg.PAY_FIRST_SERVICE_NAMES[sessionTypeId] || getServiceName(sessionTypeId);
  let staffName = null;
  try {
    const staff = await mindbodyService.getStaff();
    const s = (staff || []).find(m => Number(m.Id) === staffId);
    staffName = s ? (s.DisplayName || s.Name || [s.FirstName, s.LastName].filter(Boolean).join(' ') || null) : null;
  } catch (_) { /* name is cosmetic */ }
  // client_email is the address book_appointment settled on (typed by the
  // guest, on their profile, or stored for their number). The profile's own
  // address is not used blindly: it can be a placeholder (Touriya, 27 Sep 2026).
  const customerEmail = client_email || conversationService.get(from)?.customerEmail || null;
  const customerName = client_name || `${client.FirstName || ''} ${client.LastName || ''}`.trim() || null;

  // Replacing an earlier unpaid link: close it only now that the new time
  // passed every check — and only if Stripe confirms it closed.
  let replacedLabel = null;
  if (replaceRows?.length) {
    const blocked = await payFirst.closeReplacedCheckouts(replaceRows);
    if (blocked) return blocked;
    replacedLabel = replaceRows.map(o => `${o.service_name} (${payFirst.whenLabel(o.pay_first?.startDateTime, lang)})`).join(', ');
  }

  const started = await payFirst.startCheckout({
    from,
    clientId: client.Id,
    customerName,
    customerEmail,
    sessionTypeId,
    serviceName,
    startDateTime: start_date_time,
    staffId,
    staffName,
    staffRequested,
    roomId: pick.roomId,
    notes: notes || null,
    forNote: companionNote,
    emailNote,
    amountCents,
    lang,
  });
  if (started.error) return started;

  const row = { id: started.rowId, service_name: serviceName, amount_cents: amountCents, pay_first: { startDateTime: start_date_time, staffName } };
  conversationService.set(from, {
    customerEmail,
    customerName,
    payFirstLinkPending: { url: started.paymentUrl, text: payFirst.linkMessage(row, lang, started.expiresAt, { replaced: replacedLabel }), ctaLabel: payFirst.T.linkCta(lang), rowId: started.rowId },
  });
  // A successful step clears this treatment's failed-slot records.
  const priorFailed = conversationService.get(from)?.failedSlots;
  if (priorFailed?.length) conversationService.set(from, { failedSlots: priorFailed.filter(f => f.sessionTypeId !== sessionTypeId) });

  return {
    success: true,
    payFirst: true,
    requiresPayment: true,
    service_name: serviceName,
    date_time_label: payFirst.whenLabel(start_date_time, lang),
    therapist: staffName,
    amount: `€${amountCents / 100}`,
    link_valid_minutes: 30,
    ...(replacedLabel ? { previous_link_cancelled: replacedLabel } : {}),
    message: 'NOTHING IS BOOKED YET. A payment link was created; the appointment is booked automatically once the customer pays. Respond with ui_type "cta_button" — the server sends the standard payment message with the exact link (your text is replaced). Do NOT say "booked", "reserved" or "confirmed", and do NOT add any other buttons.',
  };
}

// The order of the checks (Touriya, 27 Sep 2026 — a Mindbody profile was
// created with an invented address, and before she had confirmed anything):
//   discontinued / paused / closed → skip_payment bounce
//   → pay-first: what does this guest already have (guardExisting)
//   → who is the guest (resolveBookingGuest): phone, then the profile stored
//     for this number, then a vetted email; a NEW profile needs a full name
//     and a vetted address (email_required), then the Confirm tap
//     (confirmation_required), and only then is it created
//   → a second person in the chat (their own vetted address; no profile
//     before the Confirm tap)
//   → a repeat of a booking that exists (already booked / already paid —
//     never held up by a missing address)
//   → an existing profile without a real address and none typed or stored
//     (email_required)
//   → journey size → Confirm gate → offered-slot gate → the day the guest
//     confirmed (Melanie, 23 Nov 2026: the summary she confirmed named another
//     day than the slot that was booked; confirmed_day_differs) → the booking.
// From the guest lookup on, client_email is the address that passed the check
// or null — never the model's word.
async function toolBookAppointment(from, { session_type_id, start_date_time, staff_id, client_name, client_email, notes, skip_payment, defer_payment, client_phone, replace_pending_payment, keep_pending_payment }) {
  // Discontinued treatments can never be booked, whatever the model was told.
  if (DISCONTINUED_SESSION_TYPES.has(Number(session_type_id))) {
    return discontinuedResult(DISCONTINUED_SESSION_TYPES.get(Number(session_type_id)));
  }
  {
    const p = settings.pausedTreatment(session_type_id);
    if (p) return pausedResult(p);
  }
  {
    const c = start_date_time ? closedFor(start_date_time, fitMinutes(Number(session_type_id))) : null;
    if (c) return closedResult(c, start_date_time);
  }

  // skip_payment is RETIRED. It was a blanket bypass of every money gate —
  // confirmation, idempotency, cart, billing — and its zero-fault failure mode
  // (round-8 verify finding) was brutal: the model "reschedules" a paid
  // booking by rebooking with skip_payment, the new row sits 'pending' with no
  // link, and the never-billed cron destroys it 36 minutes later — customer
  // paid, holds nothing, no refund, no flag. Reschedules are TEAM-handled
  // (forward_reschedule_request); the parameter is gone from the tool schema,
  // and a hallucinated straggler is bounced here rather than trusted.
  if (skip_payment) {
    return {
      error: 'reschedules_are_team_handled',
      message: 'skip_payment no longer exists. Reschedules are arranged by the team: state the reschedule policy, collect the new date, treatment and the customer\'s email, then call forward_reschedule_request. Do NOT book a replacement appointment yourself.',
    };
  }

  // What this number gave us at an earlier booking (never throws).
  const stored = await storedContact(from);

  // Pay-first treatments: what does this guest already have? Runs BEFORE the
  // journey and Confirm gates — re-sharing a link or answering "did my payment
  // go through?" must never need a new confirmation or go to the team, and a
  // guest must never be asked to pay twice for the same time.
  const isPayFirstType = payFirstCfg.isPayFirst(session_type_id);
  let payFirstReplaceRows = null;
  if (isPayFirstType) {
    if (String(from).startsWith('web_')) {
      return {
        error: 'whatsapp_only',
        message: 'Massages, facials, Nervous System Reset and Let It Go are paid online before booking, which works through our WhatsApp assistant or on our website — not in this chat. Point the customer to the booking page renessence.com/booking (or our WhatsApp, if they already have the number).',
      };
    }
    // The guard only compares the address with this guest's own open links;
    // it too gets one the guest typed or we already hold for them (stored for
    // the number, or settled by an earlier booking in this chat) — never the
    // model's word.
    const guardVetted = await vetGuestEmail(from, client_email, [usableEmail(stored?.email), usableEmail(conversationService.get(from)?.customerEmail)]);
    let guardEmail = guardVetted.ok ? guardVetted.email : null;
    if (!guardEmail && guestEmail.clean(client_email)) {
      // A link made or paid before addresses were checked (Nov 2026) has
      // nothing typed or stored behind it — but its own row carries the
      // address the server used then, and the guard compares with exactly
      // those rows. Without this the owner under her WhatsApp nickname was
      // told "a second guest, the team arranges it" for a massage she had paid.
      const given = guestEmail.clean(client_email);
      let ownRows = [];
      try { ownRows = (await db.getPayFirstRowsForPhone?.(from)) || []; } catch (_) { ownRows = []; }
      if (ownRows.some(r => sameEmail(r.pay_first?.customerEmail, given))) guardEmail = given;
    }
    const guard = await payFirst.guardExisting(from, session_type_id, start_date_time, { replacePending: !!replace_pending_payment, keepPending: !!keep_pending_payment, clientName: client_name || null, clientEmail: guardEmail });
    if (guard?.reshare) {
      const lang = conversationService.get(from)?.lang || 'en';
      conversationService.set(from, {
        payFirstLinkPending: { url: guard.paymentUrl, text: payFirst.linkMessage(guard.row, lang, guard.expiresAt), ctaLabel: payFirst.T.linkCta(lang), rowId: guard.row.id },
      });
      return {
        success: true,
        payFirst: true,
        payment_link_already_sent: true,
        requiresPayment: true,
        message: 'This exact booking already has an open payment link (nothing is booked until it is paid). Re-share it: respond with ui_type "cta_button" — the server sends the standard link message with the exact link. Do NOT create a new booking.',
      };
    }
    if (guard && !guard.proceed) return guard;
    payFirstReplaceRows = guard?.replaceRows || null;
  }

  // 1. Find or create client
  const guest = await resolveBookingGuest(from, { client_name, client_email, client_phone, tool: 'book_appointment', stored });
  if (guest.refusal) return guest.refusal;
  let client = guest.client;
  // From here on client_email is the address that passed the check, or null.
  // Whether the booking is for someone else is decided on that one too: an
  // address nobody typed counts as not given. Decided on the address as the
  // model sent it, a returning guest was asked for "THEIR own email" when the
  // model added another surname and a made-up address (review, Nov 2026).
  client_email = guest.email;

  // Booking for SOMEONE ELSE in the same chat (a friend, a partner): they get
  // their own booking on their own Mindbody profile. Before this, every
  // person was booked on the chat owner's profile and the repeat checks
  // below treated "same treatment + time" as the same booking — so a second
  // person's bookings silently vanished while the bot said they were made
  // (Gina & Nathalie, Oct 2026).
  let companionNote = null;
  let onCompanionProfile = false;
  const chatName = conversationService.get(from)?.userName || null;
  // The owner's own address: the one on their profile, or — when the profile
  // has none we trust — the one stored for their number. Compared with the
  // profile alone, a friend got a NEW profile carrying the owner's stored
  // address (review, Nov 2026).
  const ownersEmail = !!client_email && [client?.Email, guest.profileEmail, guest.storedEmail].some(own => sameEmail(own, client_email));
  if (client && client_name && ownersEmail) {
    // Someone else, but with the owner's email ("use my email for her"): an
    // own profile can't be made — book on the owner's profile, clearly marked.
    // The owner's own name with the owner's email is simply the owner.
    if (isOtherPerson(client, client_name, null, chatName)) companionNote = `For: ${client_name}`;
  } else if (client && client_name && isOtherPerson(client, client_name, client_email, chatName)) {
    // No address that passed the check: nothing can be booked for them yet.
    if (!client_email) return companionRequired(client_name, { vetted: guest.vetted });
    const companion = await resolveCompanionClient(client_name, client_email, { confirmed: confirmedRecently(from) });
    if (companion === NEEDS_FULL_NAME) return companionRequired(client_name, { needEmail: false });
    // No NEW profile for the second person before the Confirm tap either.
    if (companion === NEEDS_CONFIRM) return CONFIRMATION_REQUIRED;
    if (companion) {
      client = companion;
      onCompanionProfile = true;
    } else {
      // Their profile couldn't be found or created: book on the chat owner's
      // profile, clearly marked for the front desk.
      companionNote = `For: ${client_name} (${client_email})`;
      db.logError('companion_profile_failed', `Could not find or create a Mindbody profile for ${client_name} (${client_email}); booked on the chat owner's profile with a note.`, '', JSON.stringify({ phone: from }));
    }
  }
  const thisGuestName = client_name || `${client.FirstName || ''} ${client.LastName || ''}`;

  // Idempotency guard: if this customer already has a fresh, non-cancelled
  // booking for this exact session type + time, reuse it instead of creating a
  // duplicate. The model sometimes re-fires book_appointment (e.g. after a
  // transient "slot taken"), which previously double-booked the customer.
  if (!skip_payment) {
    // Only THIS person's earlier booking counts as a repeat — not a friend's
    // booking for the same treatment and time.
    const samePerson = (row) => !row?.customer_name || sameGuestName(row.customer_name, thisGuestName);
    let existingBooking = await db.getRecentBooking(from, session_type_id, start_date_time, samePerson);
    if (existingBooking && !samePerson(existingBooking)) existingBooking = null;
    if (existingBooking && existingBooking.mindbody_appointment_id) {
      logger.info('Idempotent book_appointment: reusing existing booking', existingBooking.mindbody_appointment_id);
      const priceCentsX = paymentService.getPriceInCents(session_type_id);
      const timeLabelX = formatDutchTime(start_date_time);
      const langX = conversationService.get(from)?.lang || 'en';
      // What the model reads follows the chat language (Melanie, 23 Nov 2026:
      // an English chat got "woensdag 25 november at 12:00" and the model
      // wrote the day itself). The cart label ends up on the Stripe line item
      // and keeps the form it always had.
      const dateLabelX = dayLabel(start_date_time, langX);
      const dateTimeLabelX = `${dateLabelX} ${langX === 'nl' ? 'om' : 'at'} ${timeLabelX}`;
      const cartLabelX = `${formatDutchDate(start_date_time)} ${langX === 'nl' ? 'om' : 'at'} ${timeLabelX}`;
      const serviceNameX = getServiceName(session_type_id);

      // What happens next depends on how far the ORIGINAL booking got. Blindly
      // re-adding to the cart here re-armed auto-billing for bookings that were
      // already billed or already PAID — a second Stripe session whose 15-min
      // timeline could cancel the very appointment the customer paid for
      // (audit finding #1/#5). getRecentBooking matches any non-cancelled row
      // from the last 15 minutes, so 'paid' and 'payment_sent' land here too.
      const base = {
        success: true,
        appointment_id: existingBooking.mindbody_appointment_id,
        service_name: serviceNameX,
        date_time_label: dateTimeLabelX,
        dateLabel: dateLabelX,
        timeLabel: timeLabelX,
        already_booked: true,
      };

      // These two status checks run BEFORE the pay-online/pay-on-location
      // split: a pay-on-location treatment that was prepaid as part of an
      // over-threshold journey has a 'paid'/'payment_sent' row too, and
      // answering it with "pay at reception" would contradict a live payment
      // link whose fuse can then silently cancel it (verify finding: refire).
      if (existingBooking.status === 'paid') {
        return {
          ...base,
          already_paid: true,
          requiresPayment: false,
          message: 'This booking is already PAID. Confirm it warmly; do NOT mention payment or send any payment link.',
        };
      }

      if (existingBooking.status === 'payment_sent') {
        // Re-share ONLY the link that belongs to THIS booking's session.
        // lastBillingLink is conversation-global; in a two-journey chat it may
        // be journey 2's link, and pointing booking 1's customer at it would
        // have them pay the wrong session while booking 1's fuse burns.
        const link = conversationService.get(from)?.lastBillingLink;
        const linkMatches = link?.url && existingBooking.stripe_session_id
          && link.sessionId === existingBooking.stripe_session_id;
        return {
          ...base,
          payment_link_already_sent: true,
          requiresPayment: false,
          ...(linkMatches ? { paymentUrl: link.url } : {}),
          message: 'A payment link was already sent for this booking. Tell the customer to use the link they received' + (linkMatches ? ' (re-share it via cta_button if helpful)' : '') + '; do NOT call send_payment again.',
        };
      }

      // Still unbilled. getRecentBooking DELIBERATELY matches 'pay_on_location'
      // rows (so a re-fire is de-duplicated instead of creating a second
      // Mindbody appointment). A re-fired pay-on-location booking returns the
      // same shape as a fresh one; recordPendingBooking below de-dups it in
      // the cart, so the journey total stays correct without double entries.
      if (!paymentService.requiresOnlinePayment(session_type_id)) {
        return {
          ...base,
          appointmentId: existingBooking.mindbody_appointment_id,
          serviceName: serviceNameX,
          dateTimeLabel: dateTimeLabelX,
          requiresPayment: false,
          payOnLocation: true,
          amount_cents: priceCentsX,
          price: priceCentsX != null ? `€${priceCentsX / 100}` : null,
        };
      }

      // Still unbilled ('pending') → same as a fresh booking: back into the
      // cart, auto-billing re-armed. recordPendingBooking de-dups by id.
      recordPendingBooking(from, {
        booking_event_id: existingBooking.id,
        appointment_id: existingBooking.mindbody_appointment_id,
        session_type_id,
        service_name: serviceNameX,
        date_time_label: cartLabelX,
        when_label: dateTimeLabelX,
        amount_cents: priceCentsX,
      });
      scheduleAutoPaymentLink(from);
      return {
        ...base,
        booking_event_id: existingBooking.id,
        amount_cents: priceCentsX,
        requiresPayment: !!priceCentsX,
        deferred: true,
      };
    }
  }

  // A booking for the chat owner on a profile that has no real email address
  // (empty, a placeholder, or the one an earlier version of the bot invented):
  // book only with an address the guest typed or the one stored for their
  // number. The profile itself is not rewritten (team decision): the address
  // goes into the appointment note and the team is told after the booking.
  // AFTER the repeat check above — "already booked / already paid" must never
  // be held up by a missing address — and before the journey and Confirm
  // gates, so the guest is asked before the confirmation, not after it.
  const ownBooking = !companionNote && !onCompanionProfile;
  let emailNote = null;
  if (ownBooking && !guest.profileEmail) {
    const given = client_email || guest.storedEmail;
    if (!given) return emailRequired(from, { tool: 'book_appointment', vetted: guest.vetted });
    emailNote = `Email: ${given}`;
  }
  // Where this booking's payment link and receipt go: only ever an address
  // that passed the check, is on the profile, or is stored for this number.
  const contactEmail = client_email || conversationService.get(from)?.customerEmail || guest.profileEmail || guest.storedEmail || null;
  // Best-effort, once the booking (or its payment link) exists.
  const bookedForOwner = async () => {
    if (!ownBooking || guest.forSomeoneElse) return;
    try {
      // Remembered for the number: the profile's own address when it has one
      // — another address typed in the chat can be a friend's.
      await afterOwnBooking(from, { client, clientName: client_name, guest, email: guest.profileEmail || client_email || guest.storedEmail });
    } catch (err) {
      logger.warn('Remembering the guest after a booking failed:', err.message);
    }
  };

  // Journey cap: more than 3 treatments in one journey (one payment batch) is
  // arranged personally by the team, not auto-booked. If 3 are already in the
  // cart, refuse the 4th and route to a human handoff.
  if (!skip_payment) {
    const cartCount = (conversationService.get(from)?.pendingBookings || []).length;
    if (cartCount >= 3) {
      markPendingLinkWithReply(from);
      return {
        error: 'too_many_treatments',
        message: 'The customer already has 3 treatments in this booking journey and is trying to add a 4th. Journeys of more than 3 treatments are arranged personally by our team — do NOT book this one. Tell the customer that for 4 or more treatments in one visit our team will set it up for them, ask for their email, then call request_human_handoff with the reason "journey of 4+ treatments".',
      };
    }
  }

  // Team threshold (owner decision, Sept 2026): an order of 2+ treatments that
  // totals €150 or more is arranged personally by the team, not by the bot.
  // The first treatment of an order is always bookable — a single 80-min
  // massage is €170 on its own — so this only fires when ADDING a treatment
  // would take the order over the line. The order so far is read from the
  // in-memory cart AND from this customer's open bookings for the same visit
  // day: the cart expires after 30 minutes, but customers add "one more
  // treatment" hours or days later. Whichever source shows more counts.
  if (!skip_payment) {
    const cart = conversationService.get(from)?.pendingBookings || [];
    const cartCents = cart.reduce((sum, b) => sum + (Number(b.amount_cents) || 0), 0);
    let day = { count: 0, totalCents: 0 };
    try {
      day = (await db.getOpenJourneyForDay?.(from, start_date_time)) || day;
    } catch (_) { /* fails open: the cart alone decides */ }
    // A link this booking REPLACES is not part of the order.
    for (const o of payFirstReplaceRows || []) {
      if (String(o.pay_first?.startDateTime || '').slice(0, 10) === String(start_date_time).slice(0, 10)) {
        day = { count: Math.max(0, (day.count || 0) - 1), totalCents: Math.max(0, (day.totalCents || 0) - (Number(o.amount_cents) || 0)) };
      }
    }
    const priorCount = Math.max(cart.length, day.count || 0);
    const priorCents = Math.max(cartCents, day.totalCents || 0);
    const thisCents = paymentService.getPriceInCents(session_type_id) || 0;
    const orderCents = priorCents + thisCents;

    if (priorCount >= 1 && orderCents >= paymentService.JOURNEY_TEAM_THRESHOLD_CENTS) {
      logger.info(`book_appointment routed to team — order for ${from} would total €${orderCents / 100} across ${priorCount + 1} treatments`);
      markPendingLinkWithReply(from);
      return {
        error: 'journey_needs_team',
        journey_total: `€${orderCents / 100}`,
        team_threshold: `€${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100}`,
        message: `This order would total €${orderCents / 100} across ${priorCount + 1} treatments. Orders of €${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100} or more are arranged personally by our team — do NOT book this treatment and do NOT retry. Tell the customer warmly that for an order of this size our team arranges everything personally so the whole schedule fits together; anything already booked in this chat stays booked. Ask for their email if you don't have it yet, then call request_human_handoff ONCE with a reason that starts with "Order of €${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100}+ — arrange personally" and lists the full wish list: every treatment, the date, the preferred times and the number of people, plus what is already booked.`,
      };
    }
  }

  // Hard confirmation gate: creating a NEW appointment requires that the
  // customer actually tapped the "Confirm" button (id=confirm_booking) within
  // the last 10 minutes. This guarantees the confirmation summary — which
  // carries the health declaration and cancellation policy — is never skipped,
  // no matter how the model behaves. Reschedules (skip_payment) are exempt:
  // they have their own confirmation in the reschedule flow.
  if (!skip_payment) {
    if (!confirmedRecently(from)) return CONFIRMATION_REQUIRED;
    // One Confirm tap covers the whole summary the customer confirmed — which
    // may list several treatments (sauna + two floats). Consuming it on the
    // FIRST booking made every later book_appointment in the same turn bounce
    // with confirmation_required, so the customer was asked to "confirm once
    // more" again and again (Maria incident: 5 confirmations for 3 bookings).
    // The gate now stays open for the agent turn that handles the tap: it is
    // marked used here and closed by agent.run when the NEXT turn starts, with
    // a hard cap so a runaway model can't book unbounded under one tap.
    const usedCount = (conversationService.get(from)?.bookingsUnderConfirm || 0) + 1;
    if (usedCount > MAX_BOOKINGS_PER_CONFIRM) {
      return {
        error: 'confirmation_required',
        message: 'This confirmation already covered the maximum number of bookings. Show a new confirmation summary for the remaining treatment(s) and wait for the customer to tap "Confirm" again.',
      };
    }
    conversationService.update(from, { bookingConfirmUsed: true, bookingsUnderConfirm: usedCount });
  }

  // Offered-slot gate: the datetime being booked must be one that
  // check_availability actually returned in this conversation. The model once
  // TRANSPOSED THE DATE when the customer picked a time in free text — it showed
  // today's slots, then confirmed and booked the same time TOMORROW. Mindbody
  // accepts any free slot, so only we can catch the invention. Compare on
  // YYYY-MM-DDTHH:MM so second/format drift doesn't false-positive, and snap the
  // booked value to the canonical offered dateTime on match.
  if (!skip_payment) {
    const offers = conversationService.get(from)?.offeredSlots || [];
    const keyOf = v => String(v).slice(0, 16);
    const match = offers.find(s => s.sessionTypeId === session_type_id && keyOf(s.dateTime) === keyOf(start_date_time));
    if (match) {
      start_date_time = match.dateTime; // canonical format, exactly as offered
    } else {
      const timePart = String(start_date_time).slice(11, 16);
      const sameTimeOtherDates = [...new Set(
        offers.filter(s => s.sessionTypeId === session_type_id && s.dateTime.slice(11, 16) === timePart)
          .map(s => s.dateTime.slice(0, 10))
      )];
      // Real times we DID offer for this treatment on the requested day — lets
      // the model recover honestly in one step when it invented a time (it once
      // promised a 17:30 float by adding 60 min to 16:30; float slots run on a
      // 90-min grid and that day closed at 18:00, so 17:30 never existed).
      const dayPart = String(start_date_time).slice(0, 10);
      const realTimesThatDay = [...new Set(
        offers.filter(s => s.sessionTypeId === session_type_id && s.dateTime.slice(0, 10) === dayPart)
          .map(s => s.dateTime.slice(11, 16))
      )].sort();
      logger.warn(`book_appointment blocked — ${start_date_time} (type ${session_type_id}) was never offered${sameTimeOtherDates.length ? `; same time offered on ${sameTimeOtherDates.join(', ')}` : ''}`);
      if (realTimesThatDay.length > 0 && !sameTimeOtherDates.length) {
        return {
          error: 'slot_not_offered',
          real_times_that_day: realTimesThatDay,
          message: `STOP: ${timePart} on ${dayPart} does not exist for this treatment — check_availability never returned it. The REAL available times that day are: ${realTimesThatDay.join(', ')}. Do not blame the customer and do not say it was "just taken": apologise, tell them ${timePart} is not available, and offer these real times (or another day). Never compute a start time yourself (e.g. "previous start + duration") — only times returned by check_availability exist.`,
        };
      }
      return {
        error: 'slot_not_offered',
        message: sameTimeOtherDates.length
          ? `STOP: you tried to book ${start_date_time}, but check_availability never returned that slot. A slot at ${timePart} WAS offered on ${sameTimeOtherDates.join(' and ')} — you most likely wrote the WRONG DATE. Use the offered slot's dateTime EXACTLY as returned by check_availability. Show the customer a corrected confirmation summary (with the right date spelled out) and only book after they tap Confirm again.`
          : `STOP: you tried to book ${start_date_time}, but that slot was never returned by check_availability in this conversation. Never invent or guess a date/time. Call check_availability for the customer's requested date, offer the real slots, and book only a slot from that result (copy its dateTime exactly).`,
      };
    }
  }

  // The day the guest confirmed. Melanie, 23 Nov 2026: she confirmed "Saturday
  // 25 November at 12:00" and the slot was Wednesday's. The summary that goes
  // out now always names a real day, and the day(s) it named are remembered
  // (reply-guards.js, confirmSummary): a slot on any other day is not booked
  // under that Confirm. It also closes what the offered-slot gate above left
  // open — after its "you most likely wrote the WRONG DATE" the next call, for
  // the day that WAS fetched, used to book under the same tap although the
  // guest had confirmed the other day. The Confirm is spent: a new summary and
  // a fresh tap are needed. Nothing remembered (restart, 30 minutes of
  // silence, a summary sent before this check existed) → book as before; a
  // late Confirm must keep working (Maria incident).
  if (!skip_payment) {
    const confirmed = conversationService.get(from)?.confirmSummary;
    const day = String(start_date_time).slice(0, 10);
    if (confirmed && Array.isArray(confirmed.dates) && !confirmed.dates.includes(day)) {
      conversationService.update(from, { bookingConfirmedAt: null, bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
      const lang = conversationService.get(from)?.lang || 'en';
      const fullDay = (d) => dayLabel(d, 'en', { year: true });
      const named = confirmed.dates.map(fullDay).join(' and ');
      logger.warn(`book_appointment blocked — ${start_date_time} is not a day of the confirmed summary (${confirmed.dates.join(', ') || 'no day named'})`);
      return {
        error: 'confirmed_day_differs',
        message: named
          ? `STOP: the summary the customer confirmed was for ${named}, but this call books ${fullDay(day)}. Nothing was booked. Show a new confirmation summary with the day written exactly as "${dayLabel(day, lang)}" and book only after a fresh Confirm — or, if the customer wants ${confirmed.dates.map(d => dayLabel(d, 'en')).join(' or ')}, check availability for that day first.`
          : `STOP: the summary the customer confirmed did not name the day, and this call books ${fullDay(day)}. Nothing was booked. Show a new confirmation summary with the day written exactly as "${dayLabel(day, lang)}" and book only after a fresh Confirm.`,
      };
    }
  }

  if (isPayFirstType) {
    const started = await bookPayFirst(from, { client, session_type_id, start_date_time, staff_id, client_name, client_email: contactEmail, notes, emailNote, companionNote, replaceRows: payFirstReplaceRows });
    if (started?.success) await bookedForOwner();
    return started;
  }

  // 2. Book appointment — extract Mindbody error message on failure
  // Always tag bookings made via the WhatsApp bot so staff can identify them in Mindbody.
  // Pay-on-location treatments (Float, saunas, oxygen, etc.) carry no Stripe link,
  // so we tag them UNPAID in Mindbody — that's how the front desk knows to collect
  // payment at the visit.
  const payOnLocation = !paymentService.requiresOnlinePayment(session_type_id);
  const botTag = '📱 WhatsApp Bot';
  const noteParts = [botTag];
  if (payOnLocation) noteParts.push('UNPAID — pay on location');
  if (companionNote) noteParts.push(companionNote);
  if (emailNote) noteParts.push(emailNote);
  if (notes) noteParts.push(notes);
  const finalNotes = noteParts.join(' | ');

  let appointment;
  try {
    appointment = await mindbodyService.addAppointment({
      clientId: client.Id,
      sessionTypeId: session_type_id,
      staffId: staff_id || 0,
      startDateTime: start_date_time,
      notes: finalNotes,
    });
  } catch (bookErr) {
    const mbMsg = bookErr.response?.data?.Error?.Message || bookErr.message;
    const mbCode = bookErr.response?.data?.Error?.Code || '';
    logger.warn('toolBookAppointment first attempt failed:', mbMsg);
    if (bookErr.code === 'BOOKING_OUTCOME_UNKNOWN') {
      appointment = await settleUnknownBooking(from, client.Id, session_type_id, start_date_time, staff_id, bookErr);
      if (!appointment) return BOOKING_UNCONFIRMED;
    }

    // Staff-related rejection: retry with the therapists who are ACTUALLY free
    // at this time (per bookableitems — the same source as the offered slot).
    // The old retry passed staffId 0, whose fallback picked the first staff
    // configured for the service, usually the same wrong person again — so the
    // bot claimed slots were "just taken" while they were still free
    // (Olivia/Marlies/Felice incidents). Retry regardless of whether the model
    // passed a staff_id: a wrong first-staff pick needs this rescue too.
    const isStaffError = !appointment && mbMsg && (
      mbMsg.toLowerCase().includes('staff') ||
      mbMsg.toLowerCase().includes('subscriber')
    );
    if (isStaffError) {
      let candidates = [];
      try {
        candidates = await mindbodyService.findAvailableStaffForTime(session_type_id, start_date_time, staff_id);
      } catch (_) { /* treated as no candidates */ }
      logger.info(`Retrying booking with time-matched staff: [${candidates.join(', ') || 'none'}]`);
      let lastErr = bookErr;
      for (const candidateId of candidates.slice(0, 3)) {
        try {
          appointment = await mindbodyService.addAppointment({
            clientId: client.Id,
            sessionTypeId: session_type_id,
            staffId: candidateId,
            startDateTime: start_date_time,
            notes: finalNotes,
          });
          break;
        } catch (candErr) {
          if (candErr.code === 'BOOKING_OUTCOME_UNKNOWN') {
            // Another POST could become a second appointment — look instead.
            appointment = await settleUnknownBooking(from, client.Id, session_type_id, start_date_time, candidateId, candErr);
            if (!appointment) return BOOKING_UNCONFIRMED;
            break;
          }
          lastErr = candErr;
          logger.warn(`Retry with staff ${candidateId} failed:`, candErr.response?.data?.Error?.Message || candErr.message);
        }
      }
      if (!appointment) {
        const retryMsg = lastErr.response?.data?.Error?.Message || lastErr.message;
        const retryCode = lastErr.response?.data?.Error?.Code || '';
        logger.error('toolBookAppointment staff retries exhausted:', retryMsg);
        db.logError('booking_failed', retryMsg, retryCode, JSON.stringify({
          phone: from, session_type_id, start_date_time, staff_id, mbCode, firstError: mbMsg, triedStaff: candidates.slice(0, 3),
        }));
        recordFailedSlot(from, session_type_id, start_date_time);
        return { error: 'booking_failed', mindbody_message: retryMsg };
      }
    } else if (!appointment) {
      logger.error('toolBookAppointment Mindbody error:', mbMsg);
      db.logError('booking_failed', mbMsg, mbCode, JSON.stringify({
        phone: from, session_type_id, start_date_time, staff_id,
      }));
      recordFailedSlot(from, session_type_id, start_date_time);
      return { error: 'booking_failed', mindbody_message: mbMsg };
    }
  }

  const serviceName = getServiceName(session_type_id);
  const timeLabel = formatDutchTime(start_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  // In the chat language for the model; the cart label (the Stripe line item)
  // keeps its old form — see the repeat check above.
  const dateLabel = dayLabel(start_date_time, lang);
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;
  const cartLabel = `${formatDutchDate(start_date_time)} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  // One atomic INSERT — the appointment id and date must never arrive in a
  // separate write, because a row without them is invisible to every
  // safety-net query (round-5 verify finding).
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName,
    // Pay-on-location bookings get their own status so the unpaid-timeout cron
    // (which only scans 'pending'/'confirmed'/'payment_sent') never touches them —
    // they are legitimately unpaid-online and must not be auto-cancelled.
    status: payOnLocation ? 'pay_on_location' : 'pending',
    amountCents: paymentService.getPriceInCents(session_type_id),
    appointmentDate: start_date_time,
    mindbodyAppointmentId: appointment.Id,
  });
  if (!bookingEventId && !payOnLocation && !skip_payment) {
    // logBookingEvent swallows DB errors and returns undefined. For a PAY-ONLINE
    // booking that leaves a live Mindbody slot with NO audit row — and the
    // unpaid-timeout cron reads only booking_events, so it could never bill it,
    // expire it, or even flag it: a free, unbillable, uncleanable slot. Safer to
    // roll the appointment back and fail so the customer simply retries.
    // (Pay-on-location and skip_payment reschedules are exempt: for them the
    // Mindbody appointment is itself the source of truth and no billing is owed.)
    logger.error(`book_appointment: no audit row persisted for pay-online booking apt ${appointment.Id} — rolling back to avoid an unbilled orphan slot`);
    try {
      await mindbodyService.cancelAppointment(appointment.Id);
    } catch (rollbackErr) {
      // Orphan slot: booked in Mindbody, no audit row, rollback failed. No
      // query can ever find it — flag it for the team explicitly.
      db.logError('orphan_unbilled_appointment', `Apt ${appointment.Id} (${serviceName || session_type_id}, ${from}) exists in Mindbody with NO audit row and could not be rolled back: ${rollbackErr.message}. MANUAL REVIEW: cancel or collect.`, '', JSON.stringify({ appointmentId: appointment.Id }));
      logger.error('book_appointment: rollback cancel failed:', rollbackErr.message);
    }
    // Ghost-row tombstone: the INSERT may have COMMITTED while reporting
    // failure. Any 'pending' row still claiming this (now cancelled)
    // appointment must not survive, or the customer's retry matches it via
    // getRecentBooking and gets billed for a dead slot (final-gate finding).
    const tomb = await db.tombstoneByAppointment(appointment.Id, from);
    if (tomb === null) {
      db.logError('ghost_row_untombstoned', `Possible ghost row for apt ${appointment.Id} (${from}) could not be tombstoned after rollback. MANUAL REVIEW: a retry may bill a cancelled slot.`, '', JSON.stringify({ appointmentId: appointment.Id }));
    }
    return { error: 'booking_failed', mindbody_message: 'We could not fully confirm your booking just now. Please try again in a moment.' };
  }

  await bookedForOwner();

  // Booking succeeded — clear any failed-slot records for this treatment so a
  // slot that later freed up isn't permanently blocked from being re-offered.
  const priorFailed = conversationService.get(from)?.failedSlots;
  if (priorFailed?.length) {
    conversationService.set(from, { failedSlots: priorFailed.filter(f => f.sessionTypeId !== session_type_id) });
  }

  // 4. Payment
  const priceCents = paymentService.getPriceInCents(session_type_id);

  // Pay-on-location treatments (Float, saunas, oxygen, red light, hydrowave, gym
  // combos) are settled at reception and the appointment is tagged UNPAID in
  // Mindbody. They still join the journey cart, because the prepay threshold is
  // a property of the JOURNEY, not of the treatment: on its own a €80 float is
  // paid at the desk, but as part of a €240 journey it is billed upfront with
  // everything else. paymentService.selectBillableItems makes that call at
  // billing time — recording it here only makes it visible to that decision.
  if (payOnLocation) {
    // skip_payment is a RESCHEDULE of an existing booking — the money for it is
    // already settled or already owed at reception. It must never enter the
    // cart, or moving a float to another day could push a later journey over
    // the threshold and bill the customer for it a second time.
    if (!skip_payment) {
      recordPendingBooking(from, {
        booking_event_id: bookingEventId,
        appointment_id: appointment.Id,
        session_type_id,
        service_name: serviceName,
        date_time_label: cartLabel,
        when_label: dateTimeLabel,
        amount_cents: priceCents,
        pay_on_location: true,
      });
      // Only bills if the journey later crosses the threshold; a sub-threshold
      // pay-on-location cart resolves to nothing_to_pay and sends no link.
      scheduleAutoPaymentLink(from);

      // Tell the model the truth about THIS journey. Once the cart total
      // reaches the prepay threshold, billing will put every treatment on a
      // Stripe link — so answering "no online payment needed, pay at
      // reception" (the normal pay-on-location reply) is false, and the
      // payment link that follows reads as a contradiction (Maria incident:
      // told twice to pay at the desk, then given 10 minutes to pay online).
      const journeyCents = (conversationService.get(from)?.pendingBookings || [])
        .reduce((sum, b) => sum + (Number(b.amount_cents) || 0), 0);
      if (journeyCents >= paymentService.JOURNEY_PREPAY_THRESHOLD_CENTS) {
        return {
          success: true,
          booking_event_id: bookingEventId,
          appointment_id: appointment.Id,
          appointmentId: appointment.Id,
          service_name: serviceName,
          serviceName,
          date_time_label: dateTimeLabel,
          dateTimeLabel,
          dateLabel,
          timeLabel,
          amount_cents: priceCents,
          price: priceCents != null ? `€${priceCents / 100}` : null,
          requiresPayment: true,
          deferred: true,
          prepayRequired: true,
          journey_total: `€${journeyCents / 100}`,
          prepay_threshold: `€${paymentService.JOURNEY_PREPAY_THRESHOLD_CENTS / 100}`,
        };
      }
    }
    return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, dateTimeLabel, requiresPayment: false, payOnLocation: true, amount_cents: priceCents, price: priceCents != null ? `€${priceCents / 100}` : null };
  }

  // skip_payment: reschedule of same paid treatment — no payment needed at all
  if (skip_payment || !priceCents) {
    return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, dateTimeLabel, requiresPayment: false };
  }

  // Record the real booking server-side so send_payment never has to trust
  // AI-provided IDs. The model sometimes hallucinates booking_event_id /
  // appointment_id (e.g. "1"), which detaches the Stripe payment from the real
  // appointment: the webhook marks a non-existent booking paid, the real row
  // stays 'pending', and the expiry cron then cancels a slot the customer paid
  // for. Storing the truth here closes that hole.
  recordPendingBooking(from, {
    booking_event_id: bookingEventId,
    appointment_id: appointment.Id,
    session_type_id,
    service_name: serviceName,
    date_time_label: cartLabel,
    when_label: dateTimeLabel,
    amount_cents: priceCents,
  });

  // Keep the billing details on the conversation so the automatic payment link
  // below can pre-fill the Stripe checkout even though the model isn't involved.
  conversationService.set(from, {
    customerEmail: contactEmail,
    customerName:  client_name  || conversationService.get(from)?.customerName  || `${client.FirstName || ''} ${client.LastName || ''}`.trim() || null,
  });

  // Payment is deferred so the bot can show "Add another treatment / Send
  // payment link" and bill a multi-treatment journey on ONE link. If the
  // customer never taps either button, scheduleAutoPaymentLink bills them
  // anyway after 5 minutes — the slot is already held, so it cannot be left
  // sitting there unpaid and unasked-for.
  scheduleAutoPaymentLink(from);

  return {
    success: true,
    booking_event_id: bookingEventId,
    appointment_id: appointment.Id,
    service_name: serviceName,
    date_time_label: dateTimeLabel,
    amount_cents: priceCents,
    dateLabel,
    timeLabel,
    requiresPayment: true,
    deferred: true,
  };
}

/**
 * Bill whatever is sitting in this conversation's cart.
 *
 * Shared by the send_payment tool (customer tapped "Send payment link") and by
 * the automatic sweep 5 minutes after a pay-online booking. The auto path is
 * why this is extracted: the link used to exist ONLY if the model chose to call
 * send_payment, so a customer who ignored the buttons kept a confirmed,
 * unpaid slot and was never asked for money.
 */
// One billing operation per conversation at a time. Without this, the T+5 auto
// timer and a customer tapping "Send payment link" in the same instant could
// each mint a Stripe session for the same cart — and whichever link the
// customer did NOT pay would have its 15-min timeline cancel the appointment
// they DID pay for (audit finding #3). The second caller simply receives the
// first caller's result.
const billingInFlight = new Map();

async function billPendingBookings(from, args) {
  const inFlight = billingInFlight.get(from);
  if (inFlight) return inFlight;
  const run = _billPendingBookings(from, args).finally(() => billingInFlight.delete(from));
  billingInFlight.set(from, run);
  return run;
}

async function _billPendingBookings(from, { customer_email, customer_name }) {
  // Bill ONLY the bookings recorded server-side during book_appointment. We do
  // NOT trust the model's `bookings` argument: it sometimes invents IDs (which
  // detaches the payment from the real appointment) and — now that most
  // treatments are pay-on-location — it could pass a pay-on-location treatment
  // that must never be charged online. recordPendingBooking runs for every
  // pay-online booking, so this list is the single source of truth for what to bill.
  const stored = conversationService.get(from)?.pendingBookings;
  const rawStored = (Array.isArray(stored) && stored.length) ? stored : [];

  // The cart is a MIRROR of booking_events, and mirrors go stale: the expiry
  // cron may have released an item, a re-fire may have re-added one that was
  // already billed, or the customer may have paid seconds ago. Money decisions
  // are made against the DB row, never the mirror: an item is billable only
  // while its row is still 'pending' (or 'pay_on_location') — audit #1/#2.
  //
  // Three buckets, because "not billable" and "not VERIFIABLE" are different
  // problems. A row in a resolved status is dropped for good. A row we cannot
  // READ (DB blip) postpones the WHOLE billing attempt instead: dropping it
  // would resolve the journey and permanently skip a legitimate charge — for
  // an appointment starting within ~40 min the cron's appointment_date filter
  // would then never rescue the slot either (verify finding: db-verify).
  const rawEffective = [];
  const unverifiable = [];
  for (const b of rawStored) {
    if (!b.booking_event_id) {
      // No audit row means no verification, no CAS write, no expiry ownership —
      // a rowless item sits outside every money guard, so it must never reach
      // a Stripe link (verify finding: paid-guards walked a cancelled rowless
      // float being charged). It stays desk-payable: its Mindbody note still
      // says UNPAID, so reception collects. Excluded from the journey total
      // too — an unverifiable amount must not tip other items into prepay.
      logger.warn(`send_payment: cart item for apt ${b.appointment_id} has no audit row — leaving it pay-at-reception, excluded from billing`);
      continue;
    }
    const row = await db.getBookingEventById(b.booking_event_id);
    if (row && (row.status === 'pending' || row.status === 'pay_on_location')) {
      rawEffective.push(b);
    } else if (!row) {
      unverifiable.push(b);
    } else {
      logger.warn(`send_payment: dropping cart item (booking_event ${b.booking_event_id}) — row status is '${row.status}', not billable`);
    }
  }

  if (unverifiable.length > 0) {
    // Leave the cart untouched and retry (bounded). Nothing is resolved,
    // nothing is minted: billing against state we cannot read risks a double
    // charge, and resolving the journey risks a permanent free slot.
    return postponeBilling(from, `${unverifiable.length} cart item(s) unverifiable (DB unreachable?)`, rawStored);
  }

  // Billing boundary — final hard guard on what may be charged online. Below
  // the journey prepay threshold this drops every pay-on-location treatment, as
  // it always has; at or above it the whole journey is billed upfront (a €240
  // massage + LED + float must not walk in unpaid). The rule lives in
  // payment.service so the money decision sits with the money code.
  const effective = paymentService.selectBillableItems(rawEffective);
  if (effective.length < rawEffective.length) {
    logger.warn(`send_payment: dropped ${rawEffective.length - effective.length} pay-on-location item(s) from the cart before billing (journey under the prepay threshold)`);
  } else if (rawEffective.some(b => b.pay_on_location)) {
    logger.info(`send_payment: journey crossed the prepay threshold — billing all ${effective.length} treatment(s) upfront, including pay-on-location ones`);
  }

  if (effective.length === 0) {
    // Nothing to bill. The journey is RESOLVED: clear the cart and disarm the
    // timer, or the finished journey's items leak into the next one — re-billed
    // on a later link, or falsely tripping the 3-treatment cap (audit #7).
    // Resolution is SUBTRACTIVE — only the snapshot this run examined leaves
    // the cart. A booking recorded while this run was mid-await survives, and
    // keeps its own timer (verify finding: wipe race).
    const remaining = resolveCartItems(from, rawStored);
    if (remaining.length === 0) cancelAutoPaymentLink(from);

    // If the server already auto-sent a link for this journey, "nothing to
    // bill" does NOT mean nothing is owed — the customer may be tapping "Send
    // payment link" minutes after the auto-link went out. But the stored link
    // is only re-shared after asking Stripe what it IS: a paid session means
    // nothing is owed (never dun a customer who paid — verify finding:
    // journey-end path A), and a dead session means the journey was released.
    const link = conversationService.get(from)?.lastBillingLink;
    if (link?.url && Date.now() - link.at < 20 * 60 * 1000) {
      const info = await paymentService.getSessionStatus(link.sessionId);
      // A Stripe API blip (info null) must NOT fall through to "nothing to
      // pay" while a live unpaid link may exist — re-sharing the link the
      // customer already has is harmless in every state (a paid session just
      // shows Stripe's already-paid page), whereas denying the debt while its
      // cancellation fuse burns is not (verify finding: live-status residual).
      if (!info || (info.status === 'open' && info.paymentStatus !== 'paid')) {
        return {
          success: true,
          payment_link_already_sent: true,
          paymentUrl: link.url,
          message: 'A payment link for this journey was ALREADY sent to the customer. Do not say nothing is owed — re-share that exact link via cta_button and ask them to complete it.',
        };
      }
      if (info && (info.status === 'expired')) {
        conversationService.update(from, { lastBillingLink: null });
        return {
          success: true,
          journey_expired: true,
          message: 'The payment window for the previous booking(s) expired and they were released. Do NOT say all is set — tell the customer the reservation lapsed and offer to book again.',
        };
      }
      // paid (or unknown): nothing is owed on that link — fall through.
      if (info?.paymentStatus === 'paid' || info?.status === 'complete') {
        conversationService.update(from, { lastBillingLink: null });
      }
    }
    return { success: true, nothing_to_pay: true, message: 'No online payment needed — these treatments are paid on location (or already paid). Just confirm the booking(s) warmly; do NOT send a payment link.' };
  }
  try {
    const payment = await paymentService.createCombinedPaymentLink({
      items: effective.map(b => ({
        bookingEventId: b.booking_event_id,
        appointmentId:  b.appointment_id,
        serviceName:    b.service_name,
        dateTimeLabel:  b.date_time_label,
        amountCents:    b.amount_cents,
        payOnLocation:  !!b.pay_on_location,
      })),
      customerEmail: customer_email,
      customerName:  customer_name,
      from,
    });

    // Persist the session id with a compare-and-swap: only rows still in a
    // billable status take the write. A row the paid-webhook flipped mid-mint
    // is NOT clobbered back to 'payment_sent' (TOCTOU), and — the lesson of
    // verify finding refire — a write that cannot be CONFIRMED is treated as
    // NOT DONE: the fresh session is expired rather than circulated, because a
    // link the DB doesn't know about is exactly what resurrects the
    // double-session catastrophe. The class flow got this guard first
    // (toolBookClass); this is the same read-back-or-expire for journeys.
    const writes = await Promise.all(effective
      .filter(b => b.booking_event_id)
      .map(async b => ({
        item: b,
        ok: await db.updateBookingEventIfStatus(
          b.booking_event_id,
          ['pending', 'pay_on_location'],
          { stripeSessionId: payment.sessionId, status: 'payment_sent' }
        ),
      }))
    );
    const unconfirmed = writes.filter(w => w.ok !== true);
    if (unconfirmed.length > 0) {
      for (const w of unconfirmed) {
        logger.error(`send_payment: session ${payment.sessionId} not confirmed on booking_event ${w.item.booking_event_id} (${w.ok === false ? 'status changed underneath' : 'DB unreachable'}) — aborting this mint`);
      }

      // ROLL BACK the writes that DID land, or the retry finds their rows
      // 'payment_sent' and silently drops legitimate charges (verify finding:
      // cas-write step 4). Reverting also detaches the rows from the aborted
      // session, so its expiry event — whenever it arrives — finds nothing it
      // owns and destroys nothing (the expired-webhook now checks ownership).
      await Promise.all(writes.filter(w => w.ok === true).map(async w => {
        const revert = await db.updateBookingEventIfStatus(
          w.item.booking_event_id,
          ['payment_sent'],
          { stripeSessionId: null, status: w.item.pay_on_location ? 'pay_on_location' : 'pending' }
        );
        if (revert !== true) {
          db.logError('billing_rollback_failed', `Could not revert booking_event ${w.item.booking_event_id} after aborted session ${payment.sessionId}. MANUAL REVIEW.`, '', JSON.stringify({ from }));
        }
      }));

      // Expire the aborted session — and CONFIRM it died. A failed expiry is
      // survivable now (rows no longer belong to it), but nobody should be
      // able to pay it, so retry once and flag if it stays open.
      let expired = await paymentService.expireSession(payment.sessionId);
      if (!expired) expired = await paymentService.expireSession(payment.sessionId);
      if (!expired) {
        db.logError('billing_zombie_session', `Aborted session ${payment.sessionId} for ${from} could not be expired — it stays payable until Stripe's own expiry. Rows were detached; a payment on it will trigger the dead-booking escalation.`, '', JSON.stringify({ from }));
      }

      // Retry via the same postponement path: the next attempt re-verifies
      // every row, so items that turn out paid/released drop away cleanly.
      return postponeBilling(from, `session ${payment.sessionId} aborted (unconfirmed writes)`, rawStored);
    }

    // Subtractive resolution (see above) + remember the link so a re-fire or a
    // late button tap re-shares it instead of minting a duplicate session.
    resolveCartItems(from, rawStored);
    conversationService.set(from, {
      billingRetries: 0,
      lastBillingLink: { url: payment.paymentUrl, sessionId: payment.sessionId, at: Date.now() },
    });
    // Start the 10-minute payment timeline (reminder, expiry notice, silent
    // removal from Mindbody at 15 min).
    schedulePaymentTimeline(from, payment.sessionId, payment.paymentUrl, effective.map(b => b.appointment_id));
    logger.info(`send_payment: ${effective.length} booking(s)${stored?.length ? ' (server-recorded)' : ''}, session ${payment.sessionId}`);
    return { success: true, paymentUrl: payment.paymentUrl };
  } catch (err) {
    logger.error('toolSendPayment error:', err.message);
    return { error: 'payment_failed', message: err.message };
  }
}

/**
 * Postpone a billing attempt that cannot safely proceed. The cart stays
 * intact; the retry counter only ever resets on a SUCCESSFUL billing (verify
 * finding: postpone path 2 — resetting it pre-mint made the manual-review arm
 * unreachable, so a persistent fault minted and killed a session every 5
 * minutes forever).
 *
 * WhatsApp: the auto-timer retries in 5 minutes, so "the link will follow" is
 * true. Web chat has no push channel — scheduleAutoPaymentLink is a no-op
 * there — so the customer must be asked to request the link again; promising
 * an automatic follow-up there was a lie the server couldn't keep (verify
 * finding: postpone path 1).
 */
function postponeBilling(from, why, cart) {
  const attempts = (conversationService.get(from)?.billingRetries || 0) + 1;
  conversationService.update(from, { billingRetries: attempts });
  const isWeb = String(from).startsWith('web_');
  if (attempts <= 3) {
    if (!isWeb) scheduleAutoPaymentLink(from);
    logger.warn(`send_payment: postponing billing for ${from} (${why}) — attempt ${attempts}/3${isWeb ? ' (web: customer-driven retry)' : ''}`);
  } else {
    db.logError('billing_postponed_repeatedly', `Billing for ${from} postponed ${attempts - 1} times (${why}). MANUAL REVIEW: bill or release manually.`, '', JSON.stringify({ from, cart }));
    logger.error(`send_payment: giving up automatic retries for ${from} — flagged for manual review`);
  }
  return {
    success: false,
    billing_deferred: true,
    message: isWeb
      ? 'The payment link cannot be prepared right now. Tell the customer their booking is reserved and ask them to request the payment link again in a minute or two.'
      : 'The payment link cannot be prepared right now. Tell the customer their booking is reserved and the payment link will follow automatically in a few minutes.',
  };
}

/**
 * Remove exactly `resolvedItems` from the conversation's cart, returning what
 * remains. Never wipes wholesale: a booking recorded while billing was
 * mid-flight is not this run's to resolve.
 */
function resolveCartItems(from, resolvedItems) {
  const keyOf = b => String(b.booking_event_id ?? `apt:${b.appointment_id}`);
  const resolved = new Set((resolvedItems || []).map(keyOf));
  const current = conversationService.get(from)?.pendingBookings || [];
  const remaining = current.filter(b => !resolved.has(keyOf(b)));
  conversationService.update(from, { pendingBookings: remaining });
  return remaining;
}

// ── Automatic payment link ────────────────────────────────────────────────────
// A pay-online booking holds a real Mindbody slot the moment it is made, but
// the Stripe link only went out if the model called send_payment. Customers who
// never tapped "Send payment link" therefore kept a confirmed slot and were
// never asked to pay. The server now bills them itself: 5 minutes after the
// last pay-online booking, anything still sitting in the cart is billed and the
// link is pushed to the customer. The window restarts on every new booking so a
// customer building a 3-treatment journey is not interrupted mid-cart.
const AUTO_BILL_DELAY_MS = 5 * 60 * 1000;
const autoBillTimers = new Map();

function cancelAutoPaymentLink(from) {
  const timer = autoBillTimers.get(from);
  if (timer) {
    clearTimeout(timer);
    autoBillTimers.delete(from);
  }
}

function scheduleAutoPaymentLink(from) {
  // Web chat has no channel to push a link to; the cron still releases the slot.
  if (String(from).startsWith('web_')) return;
  cancelAutoPaymentLink(from);

  const timer = setTimeout(async () => {
    autoBillTimers.delete(from);
    try {
      const conv = conversationService.get(from);
      const pending = conv?.pendingBookings;
      // Already billed (customer tapped the button, or the cart was cleared).
      if (!Array.isArray(pending) || pending.length === 0) return;

      // A team member is handling this customer (bot paused, or "I'm on it").
      // When the cart holds ONLY pay-on-location treatments, the link exists
      // purely because the journey crossed the prepay threshold — skipping it
      // is safe: the appointments stay booked as normal pay-at-reception
      // bookings (UNPAID note) and the team settles payment with the customer.
      // Firing it anyway ambushed a customer who had asked for a person with a
      // 10-minute payment deadline and then released her bookings (Maria
      // incident). Carts with true pay-online items still get their link —
      // those bookings cannot survive without one — and the timeline's own
      // human-takeover hold protects them at T+15.
      if (pending.every(b => b.pay_on_location) && await db.isHumanHandling(from)) {
        db.logError('autobill_skipped_human_takeover',
          `Journey for ${from} crossed the prepay threshold, but a human is handling the conversation — NO payment link was sent. The appointments remain booked as pay-at-reception (UNPAID). Settle payment with the customer or adjust the bookings.`,
          '', JSON.stringify({ from, appointmentIds: pending.map(b => b.appointment_id) }));
        logger.info(`Auto payment link skipped for ${from} — human takeover, pay-on-location-only journey`);
        return;
      }

      const result = await billPendingBookings(from, {
        customer_email: conv?.customerEmail,
        customer_name:  conv?.customerName,
      });
      if (!result?.paymentUrl) return;

      const lang = conv?.lang || 'en';
      const msg = lang === 'nl'
        ? 'Je boeking is nog niet bevestigd — hij wordt pas definitief na betaling 💳\n\n⏳ Rond je betaling binnen 10 minuten af, anders geven we je plek weer vrij.'
        : 'Your booking isn\'t confirmed yet — it\'s only final once payment is complete 💳\n\n⏳ Please pay within 10 minutes, otherwise we release your spot.';
      await whatsappService.sendCTAButton(from, msg, lang === 'nl' ? 'Betaal Nu' : 'Pay Now', result.paymentUrl);
      db.logMessage(from, 'assistant', msg);
      logger.info(`Auto payment link sent to ${from} — customer never tapped "Send payment link"`);
    } catch (err) {
      logger.warn('Auto payment link failed:', err.message);
    }
  }, AUTO_BILL_DELAY_MS);

  timer.unref?.(); // never hold the process open for a pending nudge
  autoBillTimers.set(from, timer);
}

async function toolSendPayment(from, args = {}) {
  // The model is billing now, so the automatic fallback is no longer needed.
  cancelAutoPaymentLink(from);
  // Stripe only ever gets an address the guest typed, the one book_appointment
  // settled on, or the one stored for this number — not the model's own
  // (Touriya, 27 Sep 2026).
  const customer_email = (await reachableEmail(from, args.customer_email, conversationService.get(from)?.customerEmail)) || undefined;
  return billPendingBookings(from, { ...args, customer_email });
}

// ---- The 24-hour rule (cancelling or moving is charged in full) ----
// Shanta, 1 Nov 2026: the team's policy is that an appointment cancelled or
// rescheduled within 24 hours of its start is charged in full. Whether a start
// is "within 24 hours" is decided here, on the server clock — not by the model.
const LATE_CHANGE_MS = 24 * 60 * 60 * 1000;
// A guest who writes after the start is a no-show (same policy). Up to 12
// hours after the start that still counts as "inside 24 hours"; anything older
// is an appointment that took place or was missed (see startedLongAgo).
const NO_SHOW_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Milliseconds until a start time on the server clock (negative once it has
 * started), or null when it can't be read. Starts are naive Amsterdam-local
 * datetimes as Mindbody returns them ("2026-11-01T09:00:00"), compared with
 * the server's own local time — never UTC.
 * "24 hours" is elapsed time, as it always was in get_appointments: on the two
 * clock-change weekends the line sits an hour off the wall clock. Whether the
 * team means clock hours there is an open question — don't "fix" it unasked.
 */
function msUntilStart(start, now = new Date()) {
  if (!start) return null;
  const ms = new Date(String(start)).getTime() - now.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Is a change to an appointment starting at `start` "inside 24 hours"?
 * true  = starts within the next 24 hours, or started less than 12 hours ago;
 * false = 24 hours or more away;
 * null  = not for this rule: unreadable (the caller falls back to its next
 *         source) or started 12 hours ago or more (see startedLongAgo).
 */
function isLateChange(start, now = new Date()) {
  const ms = msUntilStart(start, now);
  if (ms === null) return null;
  if (ms >= LATE_CHANGE_MS) return false;
  return ms > -NO_SHOW_WINDOW_MS ? true : null;
}

/** Started 12 hours ago or more: the appointment took place or was missed. */
function startedLongAgo(start, now = new Date()) {
  const ms = msUntilStart(start, now);
  return ms !== null && ms <= -NO_SHOW_WINDOW_MS;
}

const LATE_CHANGE_POLICY = 'Starts within 24 hours. If the customer wants to cancel or move it: that is charged in full — tell them exactly that plus both options (someone else may come in their place; with medical proof they can ask the team for an exception). Never say it is free and never promise an exception.';
const CANCELLED_LATE_NOTE = 'Cancelled inside 24 hours: per the cancellation policy the full amount is charged. Do not promise a refund, a credit or an exception — only the team can decide that.';
// An appointment that has already started (review of the Shanta fix): it is no
// longer "within 24 hours" for the model, but cancelling it is not free either.
const ALREADY_STARTED_POLICY = 'Already started. Only if the customer wants to cancel or move it: that is charged in full, as for a no-show — say so before they confirm. Never say it is free and never promise a refund or an exception; only the team can decide that.';
const CANCELLED_AFTER_START_NOTE = 'Cancelled after the appointment had started: per the cancellation policy the full amount is charged, as for a no-show. Do not promise a refund, a credit or an exception — only the team can decide that.';

// What the guest says they booked, kept across the "what is your email?"
// round (ask_for_details): two messages later the model often passes only the
// address. Reused for 15 minutes, then it is a new question.
const LOOKUP_EXPECTATION_MS = 15 * 60 * 1000;

function expectationOf({ customer_expects, expected_date, expected_count, expected_other_people } = {}) {
  return {
    customer_expects: String(customer_expects || '').trim(),
    expected_date: expected_date || null,
    expected_count: Number.isInteger(expected_count) ? expected_count : null,
    expected_other_people: expected_other_people === true,
  };
}

const LOOKUP_INSTRUCTION = 'This list is built by the server and is complete for the profile it names. Say only what is in it: the same number of appointments, dates, start times and treatment names. Never add, merge, split, rename or infer an appointment, and never use the customer\'s own description to fill a gap. You cannot see other people\'s profiles or cancelled bookings. serviceName null means the booking system does not show which treatment it is: say exactly that, never guess.';
const SERVER_REPLY_INSTRUCTION = ' The server sends the customer this overview itself: call respond once with ui_type "none" and one short line; your text is not sent. Do not call request_human_handoff for this.';
// Found in review: told to "say only what is in it", the model restated the
// list the server had just sent — the guest read it twice.
const PLAIN_REPLY_INSTRUCTION = ' If you reply with ui_type "none", the server sends the customer this list right before your reply: do not repeat the list, only answer their question.';
// Cancel and reschedule requests keep their own flow (confirm_cancel buttons).
const CHANGE_REQUEST = /\b(?:cancel\w*|reschedul\w*|move|moving|annuleer\w*|annuler\w*|afzeg\w*|af\s+zeggen|verzet\w*|verplaats\w*|omboek\w*)\b/i;
// So does a guest who can't come (Shanta, 1 Nov 2026: the policy and a
// handoff). Found in the integration review: "my husband and I can't make it
// today" was read as a claim about what is booked, and the server's "I can't
// confirm that everything you described is booked" replaced the policy reply.
const CANT_COME = /\b(?:can['’]?t|cannot|can\s+not|won['’]?t|will\s+not|not\s+able\s+to|unable\s+to)\s+(?:make\s+it|come|attend)\b|\bniet\s+(?:redden|halen|komen)\b|\b(?:ill|sick|ziek)\b/i;

/**
 * Tara, 19 Nov 2026: two rows named 'Treatment' became 'a lymphatic drainage
 * followed by a facial for both you and your husband'. The list is named,
 * complete and compared in code (appointment-overview.js); after the lookup
 * the server's own list is what the guest sees (executeRespond), and when it
 * cannot confirm what the guest described the team is flagged and mailed here,
 * without the model having to hand off.
 */
async function toolGetAppointments(from, { client_phone, client_email, client_name, ...expectArgs } = {}) {
  let clients = [];
  let foundOthers = false;

  // Helper: try all lookup strategies in order. Security review, 24 Nov 2026:
  // the email, name or number the customer gives only finds a profile; its
  // appointments are shown only when the number we trust is on it (the
  // WhatsApp sender; in the website chat a number the visitor typed).
  // Profiles found by the sender's own number are theirs by definition.
  async function tryLookups(primaryPhone) {
    const web = isWebSession(from);
    const ownPhone = web ? typedPhone(from, client_phone) : from;
    const owned = (list) => list.filter(c => profileHasPhone(c, ownPhone));
    const byOwnNumber = (primaryPhone && !web) ? await mindbodyService.getAllClientsByPhone(primaryPhone) : [];
    clients = byOwnNumber;
    if (clients.length === 0 && client_phone) {
      const byNumber = await mindbodyService.getAllClientsByPhone(client_phone);
      // The website visitor's number alone proves nothing: email AND number.
      clients = web ? [] : owned(byNumber);
      if (byNumber.length > clients.length) foundOthers = true;
    }
    // The email the customer gave takes priority over the phone result (the
    // phone may have matched a different person, e.g. the agent's own number)
    // — when it is theirs.
    if (client_email) {
      const c = await mindbodyService.getClientByPhone(null, client_email);
      if (c && (profileHasPhone(c, ownPhone) || byOwnNumber.some(o => String(o.Id) === String(c.Id)))) clients = [c];
      else if (c) foundOthers = true;
    }
    if (clients.length === 0 && client_name) {
      const c = await mindbodyService.searchClientByName(client_name);
      if (c && !web && profileHasPhone(c, ownPhone)) clients = [c];
      else if (c) foundOthers = true;
    }
  }

  // The guest's own words; when the model passes none, the ones kept from the
  // email round (if recent).
  let expectation = expectationOf(expectArgs);
  if (!expectation.customer_expects) {
    const kept = conversationService.get(from)?.lookupExpectation;
    if (kept?.customer_expects && Date.now() - kept.at < LOOKUP_EXPECTATION_MS) expectation = kept;
  }
  // The model left the guest's words out, but her own message in this turn
  // involves another person ("…for me and my husband"): her words are the
  // expectation — one profile can never confirm that (found in review). Not
  // for a cancel or a reschedule: that flow has its own confirmation.
  if (!expectation.customer_expects) {
    const said = String(conversationService.get(from)?.turnGuestText || '').trim();
    if (said && appointmentOverview.mentionsOtherPeople(said) && !CHANGE_REQUEST.test(said) && !CANT_COME.test(said)) {
      expectation = expectationOf({ customer_expects: said.slice(0, 500) });
    }
  }

  const hasExtra = client_phone || client_email || client_name;

  // Always ask for email/name first — never rely on phone number alone.
  // Only proceed with the lookup once the customer has provided their details.
  if (!hasExtra) {
    if (expectation.customer_expects) conversationService.set(from, { lookupExpectation: { ...expectation, at: Date.now() } });
    return {
      status: 'ask_for_details',
      instruction: 'Ask the customer: "To look up your booking, could you share the email address you used when you booked?"',
    };
  }

  await tryLookups(from);

  if (clients.length === 0 && foundOthers) {
    return {
      status: 'not_linked',
      instruction: isWebSession(from)
        ? 'A profile with these details exists, but not with a phone number the visitor typed here, so you may not show anything from it. Say nothing about that profile. Ask once for the phone number they use at Renessence (only a number they type counts); if they already gave it, point them to welcome@renessence.com.'
        : 'A profile with these details exists, but it is not linked to this WhatsApp number, so you may not show anything from it. Say nothing about that profile (no name, no appointments, not even that it exists under another number). Call request_human_handoff (reason: booking lookup - details not linked to this number, plus what they asked) and say the team will check and reply here.',
    };
  }

  if (clients.length === 0) {
    if (expectation.customer_expects) conversationService.set(from, { lookupExpectation: { ...expectation, at: Date.now() } });
    return {
      status: 'not_found',
      instruction: 'No profile found under these details. Ask once whether the booking could be under another email address or name. If they confirm the details are right, call request_human_handoff (reason: booking not found, plus what they expect) and say the team will check and reply here. Do not send them to an email address.',
    };
  }
  conversationService.set(from, { lookupExpectation: null });

  // Look back 7 days so yesterday's / recent appointments are visible too
  const lookbackDate = formatDateISO(addDays(new Date(), -7));
  const futureDate = formatDateISO(addDays(new Date(), 90));

  let all = [];
  for (const client of clients) {
    const appts = await mindbodyService.getStaffAppointments(lookbackDate, futureDate, client.Id);
    all = all.concat(appts);
  }

  // Names of session types the bot does not sell (the team books those too).
  // Optional: without them such a row is "a treatment booked by our team".
  let names = {};
  try { names = (await mindbodyService.getSessionTypeNames?.()) || {}; } catch (_) { names = {}; }

  const lang = conversationService.get(from)?.lang || 'en';
  const web = isWebSession(from);
  // Pay-first bookings still waiting for payment are not in Mindbody yet: the
  // guest's list names them (and their link), the comparison counts them.
  let payFirstRows = [];
  if (!web) {
    try { payFirstRows = (await db.getPayFirstRowsForPhone?.(from)) || []; } catch (_) { payFirstRows = []; }
  }
  const overview = appointmentOverview.buildOverview(all, { names, now: new Date(), lang, payFirstRows });
  // What the model gets: every upcoming appointment, after the most recent
  // past one (Shanta: "your last appointment was on …", the no-show rule).
  // Cancelled rows are left out, and past visits no longer push upcoming ones
  // off the list.
  const shown = [...(overview.lastPast ? [overview.lastPast] : []), ...overview.upcoming];
  const appointments = await Promise.all(shown.map(async item => {
    const apt = item.apt;
    // Look up payment status from DB.
    // If no record exists the booking was made externally (Mindbody website / front desk)
    // — assume paid so we don't incorrectly tell the customer they haven't paid.
    let isPaid = false;
    try {
      const row = await db.query(
        `SELECT status FROM booking_events WHERE mindbody_appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [String(apt.Id)]
      );
      if (!row.rows?.length) {
        // External booking — treat as paid
        isPaid = true;
      } else {
        isPaid = row.rows[0].status === 'paid';
      }
    } catch (_) {
      // On DB error, default to paid to avoid false "not paid" messages
      isPaid = true;
    }

    // Shanta, 1 Nov 2026: "within 24 hours" used to be true for every PAST
    // appointment of the 7-day look-back too, so a visit last week read as a
    // late change. It now means: not started yet, and starting within 24 hours.
    const msAhead = msUntilStart(apt.StartDateTime);
    const isWithin24h = msAhead !== null && msAhead >= 0 && msAhead < LATE_CHANGE_MS;
    const isPast = msAhead !== null && msAhead < 0;
    return {
      id: apt.Id,
      serviceName: item.serviceName,
      dateLabel: dayLabel(apt.StartDateTime, lang),
      timeLabel: formatDutchTime(apt.StartDateTime),
      dateTime: apt.StartDateTime,
      ...(item.forPerson ? { forPerson: item.forPerson } : {}),
      isPast,
      isWithin24h,
      isPaid,
      ...(isWithin24h ? { late_change_policy: LATE_CHANGE_POLICY } : {}),
      // Found in review: with past appointments no longer "within 24 hours"
      // nothing told the model to warn before the confirmation, while the
      // cancel after the tap is charged in full.
      ...(isPast ? { already_started_policy: ALREADY_STARTED_POLICY } : {}),
    };
  }));

  // Remember what was shown, so cancel_appointments can work out "inside 24
  // hours" from the appointment's real start instead of the model's flag.
  // set(), not update(): the state may have expired while Mindbody answered.
  if (appointments.length > 0) {
    const known = { ...(conversationService.get(from)?.knownAppointments || {}) };
    for (const a of appointments) known[String(a.id)] = { dateTime: a.dateTime, serviceName: a.serviceName };
    conversationService.set(from, { knownAppointments: known });
  }

  // Compare in code; the guest gets the server's text (executeRespond).
  const check = appointmentOverview.checkExpectation(expectation, overview.allUpcoming, overview.pending);
  const text = appointmentOverview.renderOverview(overview, check.verdict, lang, { web, clients });
  // A guest who can't come, or wants to cancel or move something, needs the
  // model's own reply (the policy, the confirm buttons): the list goes first
  // and never replaces it. Found in the integration review: a lookup that
  // matched "massage today at 9" replaced the late-cancel policy (Shanta).
  const said = String(conversationService.get(from)?.turnGuestText || '');
  const keepReply = CHANGE_REQUEST.test(said) || CANT_COME.test(said);
  conversationService.set(from, {
    lookupReply: {
      text,
      lang: lang === 'nl' ? 'nl' : 'en',
      // Re-rendered when the reply that carries it is in another language
      // (a guest writing Dutch for the first time; found in review).
      render: { overview, verdict: check.verdict, web, clients },
      mustReplace: check.verdict === 'needs_team' && !keepReply,
      expectationGiven: check.verdict !== 'not_requested' && !keepReply,
      keepReply,
    },
  });

  if (check.verdict === 'needs_team') {
    try {
      const words = expectation.customer_expects;
      db.markConversationEscalated(from, `Booking check: guest expects "${words.slice(0, 100)}" — Mindbody shows ${overview.totalUpcoming}`);
      if (!(await db.hasRecentTeamNotification?.(from, 'booking_check', TEAM_NOTIFY_COOLDOWN_MIN))) {
        const within24h = overview.upcoming.some(a => {
          const ms = msUntilStart(a.dateTime);
          return ms !== null && ms > -NO_SHOW_WINDOW_MS && ms < LATE_CHANGE_MS;
        });
        const note = appointmentOverview.teamNote({ words, clients, overview, reasons: check.reasons, within24h, web });
        const customerName = conversationService.get(from)?.userName
          || [clients[0]?.FirstName, clients[0]?.LastName].filter(Boolean).join(' ') || 'Unknown';
        const customerEmail = await reachableEmail(from, client_email, clients[0]?.Email);
        await db.logEscalation(from, customerName, 'booking_check', note);
        emailService.sendEscalationEmail({ customerName, customerPhone: from, customerEmail: customerEmail || null, message: note })
          .catch(err => logger.error('Booking check email error:', err.message));
      }
    } catch (err) {
      // The guest still gets the list; the flag above is the team's signal.
      logger.error(`[${from}] booking check alert failed:`, err.message);
    }
  }

  let payFirstStatus = null;
  try { payFirstStatus = await payFirst.statusLine(from); } catch (_) { /* optional */ }
  const serverReply = check.verdict !== 'not_requested' && !keepReply;
  return {
    profile: appointmentOverview.profileLabel(clients).label,
    count_upcoming: overview.totalUpcoming,
    appointments,
    check: check.verdict,
    ...(serverReply ? { server_reply: true } : {}),
    instruction: LOOKUP_INSTRUCTION + (serverReply ? SERVER_REPLY_INSTRUCTION : PLAIN_REPLY_INSTRUCTION),
    ...(payFirstStatus ? { pay_first_status: payFirstStatus } : {}),
  };
}

async function toolCancelAppointments(from, { appointment_ids, is_reschedule, is_within_24h, service_name, date_time }) {
  // HARD GATE — never cancel without an explicit "Yes, cancel it" tap.
  // The prompt already demanded a confirmation, but nothing enforced it: a
  // customer asking "did anyone cancel? is a later time possible?" (purely an
  // availability question) had her real booking destroyed 7 seconds later.
  // Cancelling is the most destructive thing this bot can do, so it gets the
  // same code-level gate as booking.
  const cancelConf = conversationService.get(from)?.cancelConfirmedAt;
  const cancelConfirmedRecently = cancelConf && (Date.now() - cancelConf) < 10 * 60 * 1000;
  if (!cancelConfirmedRecently) {
    return {
      error: 'confirmation_required',
      message: 'You do NOT have the customer\'s explicit cancellation confirmation, so nothing was cancelled. If — and only if — they actually want to cancel, first show the confirmation with buttons [{"id":"confirm_cancel","title":"Yes, cancel it"},{"id":"keep_appointment","title":"No, keep it"}], naming the exact treatment, date and time (and the 100% charge if within 24h). Only call cancel_appointments after they tap "Yes, cancel it". IMPORTANT: a question about availability, a later time, or whether someone else cancelled is NOT a cancellation request — answer it without cancelling anything.',
    };
  }
  // Consume the confirmation so it covers exactly one cancellation.
  conversationService.update(from, { cancelConfirmedAt: null });

  const cancelled = [];
  const failed = [];
  // Cancelled inside 24 hours / after the appointment took place (decided
  // below, per appointment).
  const cancelledLate = [];
  const cancelledAfterStart = [];
  // Why the team has to look at this chat. The dashboard keeps ONE reason per
  // guest and the last write wins, so everything this cancellation raises goes
  // out as one line at the end — a late cancel and a refund in the same call
  // used to leave only one of the two on the dashboard.
  const teamReasons = [];
  const conv = conversationService.get(from);
  const customerName = conv?.userName || null;
  // The day as the model wrote it goes into the team's emails: with a note
  // when its weekday does not match its date (dateCheckNote). The cancellation
  // itself goes by appointment id and is never held up by it.
  const dateNote = dateCheckNote(date_time, { lone: 'none' });
  logDateCheck(from, customerName, dateNote);

  for (const id of appointment_ids) {
    try {
      // Look up booking details from DB before cancelling (needed for refund email).
      // "The query FAILED" and "no paid row exists" are different answers: the
      // refund machinery lives behind `if (bookingRow…)`, so collapsing them
      // (the old bare catch) let one transient DB read silently skip a €130+
      // refund with no flag — the re-gate's last confirmed finding, walked
      // independently by both attackers. A failed lookup now means paid-state
      // UNKNOWN, which must terminate in a review flag, never in silence.
      let bookingRow = null;
      let paidLookupFailed = false;
      try {
        const res = await db.query(
          `SELECT id, customer_name, service_name, amount_cents, appointment_date AS start_date_time FROM booking_events WHERE mindbody_appointment_id = $1 AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
          [String(id)]
        );
        bookingRow = res.rows?.[0] || null;
      } catch (lookupErr) {
        paidLookupFailed = true;
        logger.error(`Cancel ${id}: paid-row lookup failed (${lookupErr.message}) — paid state UNKNOWN, will flag for review`);
      }

      const cancelledApt = await mindbodyService.cancelAppointment(id);
      // H14: push to cancelled immediately after Mindbody succeeds — side-effect failures below
      // must NOT affect the cancelled/failed reporting
      cancelled.push(id);
      // This site's API often records a cancel as "NoShow" (still effective —
      // the appointment is released), but the calendar entry can linger as a
      // billable no-show. Tell the team so therapist pay/billing gets corrected.
      const recordedAsNoShow = /^no[\s-]?show$/i.test(String(cancelledApt?.Status || '').trim());

      // Inside 24 hours? The server decides; the model's is_within_24h is only
      // a hint. Found while checking the Shanta incident (1 Nov 2026; it did
      // not happen to her): with the flag simply left out, cancelling a paid
      // appointment two hours before its start sent finance a refund request
      // and promised the guest a refund within 7 business days. In order:
      // what get_appointments showed for this id, else the start time in
      // Mindbody's own cancel reply, else the model's flag (state gone after
      // a restart or the 30-minute TTL, and no start in the reply).
      const known = conversationService.get(from)?.knownAppointments?.[String(id)] || null;
      const start = msUntilStart(known?.dateTime) !== null ? known.dateTime : cancelledApt?.StartDateTime;
      // Started 12 hours ago or more: it took place or was missed. That is not
      // "inside 24 hours", but it is never a free cancellation either — found
      // in review of this fix: get_appointments no longer calls such an
      // appointment "within 24 hours", so the model left the flag off and a
      // paid no-show from the day before got a refund request and a refund
      // promise. No refund, no promise, and the team looks at it.
      const afterStart = startedLongAgo(start);
      let late = isLateChange(start);
      if (late === null) late = afterStart ? false : !!is_within_24h;
      if (late) cancelledLate.push(id);
      if (afterStart) cancelledAfterStart.push(id);
      const chargedInFull = late || afterStart;
      // Nothing is refunded or promised then: the full amount is charged (paid
      // online or due at reception) and only the team can decide otherwise —
      // so every such cancel lands in front of them. Noted here, before the
      // side-effects, so that none of them failing can lose it.
      if (chargedInFull) {
        const treatment = bookingRow?.service_name || known?.serviceName || service_name || 'treatment';
        teamReasons.push(late
          ? `Late cancellation (inside 24h): ${treatment} — check the fee`
          : `Cancelled after its start time: ${treatment} — check the fee`);
      }

      // Side-effects run in their own try/catch so they never flip this ID to failed[]
      try {
        // Paid state unknown at cancel time → the refund gate below cannot be
        // trusted to run. Flag it so the team checks whether a refund is owed;
        // the appointment is already cancelled either way.
        if (paidLookupFailed) {
          db.logError('cancelled_paid_state_unknown', `Apt ${id} (${from}) was cancelled while the paid-row lookup was failing — if this booking was PAID, a refund is owed and NO refund email was sent. MANUAL REVIEW.`, '', JSON.stringify({ appointmentId: id }));
        }

        // Cancel any open Stripe session so expiry webhook doesn't fire
        paymentService.cancelPendingPaymentByAppointment(id).catch(err =>
          logger.warn('Stripe session cancel error:', err.message)
        );

        db.query(
          `UPDATE booking_events SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer' WHERE mindbody_appointment_id = $1`,
          [id]
        ).catch(err => logger.error('DB cancel log:', err.message));

        // Drop the cancelled appointment from the in-progress cart so a later
        // send_payment can't charge for a treatment that was just cancelled
        // (e.g. book → cancel → book something else in the same chat).
        const cartConv = conversationService.get(from);
        if (cartConv?.pendingBookings?.length) {
          conversationService.update(from, {
            pendingBookings: cartConv.pendingBookings.filter(b => String(b.appointment_id) !== String(id)),
          });
        }

        // Always notify the welcome team of any cancellation (external or bot-booked)
        emailService.sendCancellationNotificationEmail({
          customerName: bookingRow?.customer_name || customerName,
          customerPhone: from,
          serviceName: bookingRow?.service_name || service_name,
          dateTime: bookingRow?.start_date_time || date_time,
          isWithin24h: chargedInFull,
          isReschedule: !!is_reschedule,
          statusNote: recordedAsNoShow
            ? 'Mindbody recorded this cancellation with status "NoShow". The booking is released, but the calendar entry may still show as a billable no-show — please check the appointment in Mindbody and correct it to a cancellation if needed (therapist pay/billing).'
            : null,
          ...(dateNote ? { dateNote } : {}),
        }).catch(err => logger.error('Cancellation notification email error:', err.message));

        // If paid, not a reschedule, and outside 24h → notify finance team for refund
        // Within 24h or after the start: no refund per policy (full amount charged)
        if (bookingRow && !is_reschedule && !chargedInFull) {
          // The refund NOTIFICATION comes before the refund PROMISE: the email
          // is the only thing that makes the promise true, and it must not be
          // skippable by a WhatsApp send throwing first. A failed email writes
          // a review flag so the refund can't silently evaporate (final-gate
          // contract finding).
          teamReasons.push(`Refund to process: ${bookingRow.service_name || 'treatment'}`);
          try {
            await emailService.sendRefundNotificationEmail({
              customerName: bookingRow.customer_name,
              customerPhone: from,
              serviceName: bookingRow.service_name,
              dateTime: bookingRow.start_date_time,
              amountCents: bookingRow.amount_cents,
            });
          } catch (mailErr) {
            db.logError('refund_notification_failed', `Refund owed to ${from} for ${bookingRow.service_name} (€${(bookingRow.amount_cents || 0) / 100}) — the finance notification email FAILED: ${mailErr.message}. MANUAL REVIEW: process the refund.`, '', JSON.stringify({ bookingEventId: bookingRow.id ?? null, appointmentId: id }));
            logger.error('Refund email error:', mailErr.message);
          }
          const lang = conversationService.get(from)?.lang || 'en';
          await whatsappService.sendText(
            from,
            lang === 'nl'
              ? 'Bedankt voor je geduld! Ons team verwerkt je terugbetaling binnen 7 werkdagen. Je ziet het bedrag binnenkort terug op je oorspronkelijke betaalmethode.'
              : 'Thanks for your patience! Our team will take care of your refund within 7 business days, you\'ll see it back on your original payment method shortly after.'
          );
        }
      } catch (sideErr) {
        logger.error(`Cancel ${id} side-effect error (appointment was cancelled):`, sideErr.message);
      }
    } catch (err) {
      logger.error(`Cancel ${id} error:`, err.message);
      failed.push(id);
    }
  }

  // Any cancellation that didn't actually take effect leaves a billable slot on
  // the Mindbody calendar (the therapist still gets paid). The bot must NOT tell
  // the customer it's cancelled — instead ask the team to cancel it by hand.
  if (failed.length > 0) {
    logger.warn(`Cancellation FAILED for appointment(s) ${failed.join(', ')} — escalating to team for manual cancellation`);
    teamReasons.push('Cancellation failed — cancel it in Mindbody by hand');
    emailService.sendEscalationEmail({
      customerName,
      customerPhone: from,
      customerEmail: null,
      message: `⚠️ AUTOMATIC CANCELLATION FAILED — please cancel this in Mindbody by hand so the slot is freed. Appointment ID(s): ${failed.join(', ')}. Treatment: ${service_name || 'unknown'} on ${date_time || 'unknown'}. The bot did NOT tell the customer it was cancelled; it said the team would take care of it.`,
      ...(dateNote ? { dateNote } : {}),
    }).catch(err => logger.error('Failed-cancel escalation email error:', err.message));
  }

  if (teamReasons.length > 0) db.markConversationEscalated(from, teamReasons.join(' · '));

  // Several appointments in one cancellation, not all of them charged: say
  // which, or the model would call the refunded one "charged in full" too.
  const onlyFor = (ids) => (ids.length < cancelled.length ? ` This applies to appointment ${ids.join(', ')} only.` : '');
  const notes = [];
  if (cancelledLate.length > 0) notes.push(`${CANCELLED_LATE_NOTE}${onlyFor(cancelledLate)}`);
  if (cancelledAfterStart.length > 0) notes.push(`${CANCELLED_AFTER_START_NOTE}${onlyFor(cancelledAfterStart)}`);
  return {
    cancelled,
    failed,
    ...(cancelledLate.length > 0 ? { within24h: true } : {}),
    ...(notes.length > 0 ? { policy_note: notes.join(' ') } : {}),
  };
}

async function toolCheckClassSchedule(from, { session_type_ids, start_date, end_date }) {
  const paused = (session_type_ids || []).map(id => settings.pausedTreatment(id)).find(Boolean);
  if (paused && session_type_ids.every(id => settings.pausedTreatment(id))) return pausedResult(paused);
  try {
    const classes = await mindbodyService.getClasses(session_type_ids, start_date, end_date);
    const now = new Date();
    const lang = conversationService.get(from)?.lang || 'en';

    const result = classes
      .filter(c => {
        if (c.IsCanceled) return false;
        if (new Date(c.StartDateTime) <= now) return false;
        if (closedFor(c.StartDateTime, 0)) return false;
        const maxCap = c.MaxCapacity || 0;
        const booked = c.TotalBooked || 0;
        if (maxCap > 0 && booked >= maxCap) return false;
        return true;
      })
      .slice(0, 10)
      .map(c => ({
        id: `class_${c.Id}`,
        classId: c.Id,
        name: c.ClassDescription?.Name || 'Studio Class',
        dateLabel: dayLabel(c.StartDateTime, lang),
        timeLabel: formatDutchTime(c.StartDateTime),
        dateTime: c.StartDateTime,
        sessionTypeId: c.ClassDescription?.SessionType?.Id || session_type_ids[0],
        spotsLeft: c.MaxCapacity ? c.MaxCapacity - (c.TotalBooked || 0) : null,
      }));

    return { classes: result };
  } catch (err) {
    logger.warn('check_class_schedule error:', err.message);
    return { classes: [], error: err.message };
  }
}

async function toolBookClass(from, { class_id, session_type_id, class_name, class_date_time, client_name, client_email, client_phone }) {
  {
    const p = settings.pausedTreatment(session_type_id || 83);
    if (p) return pausedResult(p);
  }
  {
    const c = class_date_time ? closedFor(class_date_time, 0) : null;
    if (c) return closedResult(c, class_date_time);
  }
  // 1. Find or create client — the same rules as book_appointment (Touriya,
  // 27 Sep 2026): no invented address, no made-up surname, and in the website
  // chat "web_<session>" is never looked up or stored as a phone number.
  const guest = await resolveBookingGuest(from, { client_name, client_email, client_phone, tool: 'book_class', stored: await storedContact(from) });
  if (guest.refusal) return guest.refusal;
  const client = guest.client;
  // A profile without a real address: only with one the guest typed or the
  // one stored for their number — as in book_appointment.
  const ownEmail = guest.email || guest.profileEmail || guest.storedEmail;
  if (!ownEmail) return emailRequired(from, { tool: 'book_class', vetted: guest.vetted });

  // 2. Enrol in class
  const visit = await mindbodyService.addClientToClass(client.Id, class_id);

  const timeLabel = formatDutchTime(class_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  // In the chat language for the model; the Stripe line item keeps its old form.
  const dateLabel = dayLabel(class_date_time, lang);
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;
  const stripeLabel = `${formatDutchDate(class_date_time)} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  const priceCents = paymentService.getPriceInCents(session_type_id);
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName: class_name,
    status: 'pending',
    amountCents: priceCents,
    appointmentDate: class_date_time,
    mindbodyAppointmentId: class_id,
  });
  // Remember the guest / tell the team about a profile without an address —
  // not for an enrolment that is rolled back just below.
  if (bookingEventId || !priceCents) {
    try {
      await afterOwnBooking(from, { client, clientName: client_name, guest, email: guest.profileEmail || ownEmail });
    } catch (err) {
      logger.warn('Remembering the guest after a class booking failed:', err.message);
    }
  }

  // 4. Payment link.
  //
  // The expiry cron treats "status 'pending' with no stripe_session_id" as
  // PROOF a booking was never billed, and releases it without consulting
  // Stripe. That proof holds only if minting a link and persisting its session
  // id are inseparable. So: no audit row → no link at all; and if the session
  // id cannot be CONFIRMED as persisted, the freshly minted session is expired
  // on the spot — a link the DB doesn't know about must never reach a customer,
  // because a payment on it would land on a row the cron considers never-billed
  // (audit finding #6).
  if (priceCents) {
    if (!bookingEventId) {
      // No audit row → the enrolment is invisible to every safety net and
      // carries no unpaid marker: a flag-free free class (final-gate finding,
      // walked identically by two attackers). Mirror the appointment path:
      // roll the enrolment back so the customer simply retries, tombstone any
      // ghost row (the INSERT may have committed despite reporting failure),
      // and flag the orphan if the rollback itself fails.
      logger.error(`toolBookClass: no audit row for class ${class_id} — rolling back the enrolment`);
      try {
        await mindbodyService.removeClientFromClass(client.Id, class_id);
      } catch (rollbackErr) {
        db.logError('orphan_unbilled_class', `Class ${class_id} (${class_name}, ${from}) is enrolled in Mindbody with NO audit row and could not be rolled back: ${rollbackErr.message}. MANUAL REVIEW: remove or collect €${priceCents / 100}.`, '', JSON.stringify({ classId: class_id, clientId: client.Id }));
        logger.error('toolBookClass: rollback failed:', rollbackErr.message);
      }
      const tomb = await db.tombstoneByAppointment(class_id, from);
      if (tomb === null) {
        db.logError('ghost_row_untombstoned', `Possible ghost row for class ${class_id} (${from}) could not be tombstoned after rollback. MANUAL REVIEW.`, '', JSON.stringify({ classId: class_id }));
      }
      return { error: 'booking_failed', mindbody_message: 'We could not fully confirm your class booking just now. Please try again in a moment.' };
    }
    try {
      const payment = await paymentService.createPaymentLink({
        appointmentId: class_id,
        clientId: client.Id,
        from,
        serviceName: class_name,
        dateTime: stripeLabel,
        amount: priceCents,
        // As before the profile's own address first — but never a placeholder
        // on it, and never one the model made up.
        customerEmail: guest.profileEmail || ownEmail,
        customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
        bookingEventId,
        isClass: true,
      });
      await db.updateBookingEvent(bookingEventId, { stripeSessionId: payment.sessionId, status: 'payment_sent' });
      // updateBookingEvent swallows DB errors, so read back to be sure. One
      // retry: a transient read error right after a SUCCESSFUL write would
      // otherwise expire a perfectly tracked session (and the expired-webhook
      // would then cancel the class the customer was told is booked).
      let persisted = await db.getBookingEventById(bookingEventId);
      if (!persisted) persisted = await db.getBookingEventById(bookingEventId);
      if (persisted?.stripe_session_id !== payment.sessionId) {
        logger.error(`toolBookClass: could not persist session ${payment.sessionId} on booking_event ${bookingEventId} — expiring it rather than circulating an untracked link`);
        await paymentService.expireSession(payment.sessionId);
        return classPaymentDeferred(from, bookingEventId, class_id, class_name, dateLabel, timeLabel);
      }
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, dateTimeLabel, requiresPayment: true, paymentUrl: payment.paymentUrl };
    } catch (payErr) {
      logger.error('Class payment link error:', payErr.message);
      return classPaymentDeferred(from, bookingEventId, class_id, class_name, dateLabel, timeLabel);
    }
  }

  return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false };
}

/**
 * A class is enrolled but no payment link could be produced. The bot promises
 * "our team will arrange the payment" — this makes that promise TRUE: the row
 * is flagged for review (which also keeps the never-billed cron from silently
 * releasing the enrolment ~36 minutes after the promise), and the team gets a
 * review entry (final-gate finding: the promise previously had no mechanism).
 */
async function classPaymentDeferred(from, bookingEventId, classId, className, dateLabel, timeLabel) {
  // Flip to needs_review ONLY on a confirmed flag write (round-9 finding): the
  // flip takes the row out of every sweep, so an unconfirmed flag must instead
  // leave it 'pending' — the never-billed cron then releases it with the
  // customer informed, which is a permitted terminal.
  const flagged = await db.logError('class_payment_link_failed', `Class ${classId} (${className}, ${from}) is enrolled but no payment link could be produced. The customer was told the team will arrange payment — collect €22 or release the spot.`, '', JSON.stringify({ bookingEventId, classId }));
  if (flagged === true) {
    await db.updateBookingEvent(bookingEventId, { status: 'needs_review' });
  } else {
    logger.error(`classPaymentDeferred: could not persist review flag for booking_event ${bookingEventId} — leaving row in-sweep`);
  }
  return { success: true, classId, className, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
}

// How long after notifying the team we suppress a repeat notification for the
// same customer. The team was getting ~12 identical "Customer needs help"
// emails for one person in a morning; once they're notified they're on it, and
// pausing the bot stops the flow entirely anyway.
const TEAM_NOTIFY_COOLDOWN_MIN = parseInt(process.env.TEAM_NOTIFY_COOLDOWN_MIN || '60', 10);

// Shanta, 1 Nov 2026: the bot wrote "I have reported it" while a handoff
// without an email address was refused here and alerted nobody. On WhatsApp
// the team answers in the chat itself and the phone number is known, so a
// missing email never blocks the three team forwards below. Website chat is
// different: the team cannot write back there, so the email stays required.
const needsEmailToReach = (from) => String(from).startsWith('web_');

// Melanie, 23 Nov 2026: her chat ended with a handoff and a gift-card forward,
// and what the team gets there is the day as the model wrote it ("Saturday 25
// November"). A forward is never held back or rewritten — it is how a guest
// reaches a person. It gets a note written by code instead: the day the
// request came in, every weekday that does not match its date, and for a
// weekday without a date ("next Friday") the dates it can mean. Null when
// there is nothing to note. Never throws.
// `lone` — which weekdays without a date get candidate dates (found in
// review: "lost a ring last Saturday", "open Monday to Friday" and "Black
// Friday" in a handoff reason each got two future dates and "please confirm
// the day with the guest"):
//   'all'    a field that IS the requested day (preferred_day, new_date);
//   'future' free text (the handoff reason): only "next / this / coming
//            Friday", "volgende / komende / aanstaande vrijdag";
//   'none'   a cancellation — cancelled by id, its real start is known.
const FUTURE_WORD = /(?<![\p{L}])(?:next|this coming|this|coming|upcoming|volgende|komende|aanstaande|deze)[ \t]{1,3}$/iu;
const NOT_A_DAY_ASKED = /(?<![\p{L}])(?:last|every|each|black|afgelopen|vorige|elke|iedere)[ \t]{1,3}$/iu;
const WEEKDAY_WORD = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)';
const DAYS_JOIN = '[ \\t]{0,3}(?:to|till|until|through|–|-|t\\/m|tot|and|or|en|of|&|\\/|,)[ \\t]{0,3}';
const RANGE_AFTER = new RegExp(`^\\p{L}{0,6}${DAYS_JOIN}${WEEKDAY_WORD}`, 'iu');   // "Monday| to Friday"
const RANGE_BEFORE = new RegExp(`${WEEKDAY_WORD}\\p{L}{0,6}${DAYS_JOIN}$`, 'iu'); // "Monday to |Friday"
function dateCheckNote(text, { lone = 'all' } = {}) {
  try {
    const now = new Date();
    const s = typeof text === 'string' ? text : '';
    const full = (d) => dayLabel(d, 'en', { year: true });
    const lines = [];
    for (const hit of findWeekdayDates(s, now)) {
      if (hit.ok) continue;
      lines.push(hit.date
        ? `Date check: ${full(hit.date).split(' ').slice(1).join(' ')} is a ${EN_DAYS[hit.actual]}, not a ${EN_DAYS[hit.weekday]} — please confirm the day with the guest.`
        : `Date check: "${hit.text.trim()}" is not a date that exists — please confirm the day with the guest.`);
    }
    for (const word of (lone === 'none' ? [] : loneWeekdays(s, now))) {
      const before = s.slice(Math.max(0, word.index - 20), word.index);
      const after = s.slice(word.index + word.token.length);
      if (NOT_A_DAY_ASKED.test(before) || RANGE_AFTER.test(after) || RANGE_BEFORE.test(before)) continue;
      if (lone === 'future' && !FUTURE_WORD.test(before)) continue;
      const around = weekdaysAround(word.weekday, now, now);
      const options = around.today
        ? `${full(around.today)} (today) or ${full(around.coming)}`
        : `${full(around.coming)} or ${full(weekdaysAround(word.weekday, around.coming, now).near.slice(-1)[0])}`;
      lines.push(`No date was given for "${word.token}": it can be ${options} — please confirm the day with the guest.`);
    }
    const unique = [...new Set(lines)];
    return unique.length > 0 ? `Request received ${full(now)}. ${unique.join(' ')}` : null;
  } catch (_) {
    return null;
  }
}

// The note in the escalation log, as an entry of its own: the forward's own
// entry is what the repeat check compares, so its text stays exactly the
// request.
function logDateCheck(from, customerName, note) {
  if (!note) return;
  try {
    Promise.resolve(db.logEscalation(from, customerName, 'date_check', note)).catch(() => {});
  } catch (_) { /* best-effort */ }
}

// Touriya, 27 Sep 2026: with the email field required, the model put an
// address there that nobody had typed and the team got it as "the guest's
// email". The three forwards pass on only an address the guest typed or the
// one stored for their number (reachableEmail); anything else is dropped. On
// WhatsApp that never holds a forward back.
async function toolHumanHandoff(from, name, { reason, customer_email }) {
  customer_email = await reachableEmail(from, customer_email);
  if (!customer_email && needsEmailToReach(from)) {
    return { sent: false, error: 'email_required', message: 'Ask the visitor for an email address so our team can reach them - only an address they type in this chat counts.' };
  }
  const conv = conversationService.get(from);
  const customerName = conv?.userName || name || 'Unknown';

  // Always flag the conversation (idempotent) so the dashboard shows it.
  db.markConversationEscalated(from, `Handoff: ${String(reason || '').slice(0, 160)}`);

  // Already told the team about this customer recently? Don't email again.
  const alreadyNotified = await db.hasRecentTeamNotification(from, 'human_handoff', TEAM_NOTIFY_COOLDOWN_MIN);
  if (alreadyNotified) {
    logger.info(`Escalation email suppressed — team already notified within ${TEAM_NOTIFY_COOLDOWN_MIN}m: ${from}`);
    return withPaymentLinksClosed(from, {
      sent: true,
      already_escalated: true,
      message: 'The team has already been notified about this customer and is looking into it. Do NOT escalate again — simply reassure the customer that the team will come back to them, and answer anything else you can.',
    });
  }

  const dateNote = dateCheckNote(reason, { lone: 'future' });
  db.logEscalation(from, customerName, 'human_handoff', reason);
  logDateCheck(from, customerName, dateNote);
  emailService.sendEscalationEmail({ customerName, customerPhone: from, customerEmail: customer_email || null, message: reason, ...(dateNote ? { dateNote } : {}) })
    .catch(err => logger.error('Escalation email error:', err.message));
  return withPaymentLinksClosed(from, { sent: true });
}

/**
 * The team takes over (handoff, gift card, reschedule): an unpaid pay-first
 * link must not stay payable behind their back — it would book a treatment the
 * team is arranging differently. Closed silently; the model is told.
 */
async function withPaymentLinksClosed(from, result) {
  let closed = [];
  try { closed = await payFirst.closeOpenCheckoutsForHandoff(from); } catch (_) { closed = []; }
  if (closed.length > 0) conversationService.update(from, { payFirstLinkPending: null });
  if (closed.length === 0) return result;
  return {
    ...result,
    payment_link_cancelled: closed,
    message: `${result.message ? `${result.message} ` : ''}The customer's unpaid payment link (${closed.join(', ')}) was cancelled, because the team now arranges it — tell them nothing is booked or charged and the team will come back to them.`,
  };
}

// Reschedules are arranged by the team, not the bot (cancel+rebook here caused
// paid-but-cancelled edge cases). The bot states the policy, collects the new
// date + treatment (and an email only if the guest gives one — see
// needsEmailToReach), and forwards it to welcome@.
async function toolForwardReschedule(from, name, { new_date, treatment, customer_email, customer_name, current_appointment }) {
  if (!new_date || !treatment) {
    return {
      sent: false,
      error: 'missing_details',
      message: 'Before forwarding, ask for whatever is still missing: the new date they want and the treatment (appointment type).',
    };
  }
  customer_email = await reachableEmail(from, customer_email);
  if (!customer_email && needsEmailToReach(from)) {
    return {
      sent: false,
      error: 'email_required',
      message: 'Ask the customer for their email before forwarding — the team needs it to reach them. Only an address they type in this chat counts.',
    };
  }
  const conv = conversationService.get(from);
  const customerName = customer_name || conv?.userName || name || 'Unknown';
  const detail = `New: ${new_date} | ${treatment}${current_appointment ? ` | current: ${current_appointment}` : ''}`;

  // Suppress only an IDENTICAL repeat — if the customer corrects the date or
  // treatment, the team still gets the updated request.
  if (await db.hasRecentTeamNotification(from, 'reschedule_request', TEAM_NOTIFY_COOLDOWN_MIN, detail)) {
    logger.info(`Reschedule email suppressed — identical request already sent: ${from}`);
    return withPaymentLinksClosed(from, { sent: true, already_sent: true, message: 'This exact reschedule request was already sent to the team. Do NOT send it again — tell the customer the team has the request and will get back to them. Do not promise the new time.' });
  }

  const dateNote = dateCheckNote(new_date);
  db.logEscalation(from, customerName, 'reschedule_request', detail);
  logDateCheck(from, customerName, dateNote);
  db.markConversationEscalated(from, `Reschedule request: ${String(treatment || '').slice(0, 60)} → ${String(new_date || '').slice(0, 60)}`);
  emailService.sendRescheduleRequestEmail({
    customerName,
    customerPhone: from,
    customerEmail: customer_email || null,
    newDate: new_date,
    treatment,
    currentAppointment: current_appointment,
    ...(dateNote ? { dateNote } : {}),
  }).catch(err => logger.error('Reschedule email error:', err.message));
  return withPaymentLinksClosed(from, { sent: true });
}

// Detect an OLD (pre-migration) gift-card number. Read-only, no side effects.
// The model calls this the moment a customer gives a gift-card number, so it can
// warn them it won't work online and route them to the team instead.
function toolCheckGiftCard({ gift_card_number }) {
  const isOld = giftCardCheck.isOldGiftCard(gift_card_number);
  return {
    is_old_system: isOld,
    message: isOld
      ? 'This gift card is from the OLD system and will error if used for online payment. Explain that to the customer, then collect their email, appointment date and appointment type and call forward_gift_card_request with old_system: true. Do NOT ask them to pay online.'
      : 'Not an old-system card. Continue the normal gift-card flow (collect treatment + day, then forward_gift_card_request).',
  };
}

// Gift-card bookings are handled by the team, not the bot — redeeming a gift
// card requires Mindbody's point of sale, which we can't drive here. So the bot
// just collects the details and emails welcome@ to arrange it. old_system flags
// a pre-migration card that needs a manual transfer by the team.
async function toolForwardGiftCard(from, name, { gift_card_number, treatment, preferred_day, customer_name, customer_email, old_system }) {
  if (!gift_card_number || !treatment || !preferred_day) {
    return {
      sent: false,
      error: 'missing_details',
      message: old_system
        ? 'Before forwarding this old-system card, ask for whatever is still missing: the gift card number, their email, the appointment date, and the appointment type.'
        : 'Before forwarding, ask the customer for whatever is still missing: the gift card number, the treatment they want, and the day (with a time preference if they have one).',
    };
  }
  customer_email = await reachableEmail(from, customer_email);
  if (old_system && !customer_email && needsEmailToReach(from)) {
    return {
      sent: false,
      error: 'email_required',
      message: 'For an old-system gift card the team needs to reach the customer — ask for their email before forwarding. Only an address they type in this chat counts.',
    };
  }
  const conv = conversationService.get(from);
  const customerName = customer_name || conv?.userName || name || 'Unknown';
  const kind = old_system ? 'gift_card_old_system' : 'gift_card_request';
  const detail = `Gift card ${gift_card_number} | ${treatment} | ${preferred_day}`;

  // Suppress only an IDENTICAL repeat — a changed card number, treatment or day
  // is a genuinely new request and still goes through.
  if (await db.hasRecentTeamNotification(from, kind, TEAM_NOTIFY_COOLDOWN_MIN, detail)) {
    logger.info(`Gift card email suppressed — identical request already sent: ${from}`);
    return withPaymentLinksClosed(from, { sent: true, already_sent: true, message: 'This exact gift-card request was already sent to the team. Do NOT send it again — just reassure the customer the team will be in touch.' });
  }

  const dateNote = dateCheckNote(preferred_day);
  db.logEscalation(from, customerName, kind, detail);
  logDateCheck(from, customerName, dateNote);
  db.markConversationEscalated(from, old_system ? 'Old gift card — transfer needed' : 'Gift card booking request');
  emailService.sendGiftCardRequestEmail({
    customerName,
    customerPhone: from,
    customerEmail: customer_email || null,
    giftCardNumber: gift_card_number,
    treatment,
    preferredDay: preferred_day,
    oldSystem: !!old_system,
    ...(dateNote ? { dateNote } : {}),
  }).catch(err => logger.error('Gift card email error:', err.message));
  return withPaymentLinksClosed(from, { sent: true });
}

// ---- Respond tool ----

// Web chat callback map: webFrom -> resolve fn
const webCallbacks = new Map();

// Same idea as the pay-first link: after a lookup the server's own list goes
// out, not the model's reading of it (Tara, 19 Nov 2026). Not twice within
// ten minutes when it only goes before the model's reply.
const LOOKUP_REPEAT_MS = 10 * 60 * 1000;

/** A lookup's list in the chat's language now (the reply may have just switched it). */
function lookupTextFor(from, lookup) {
  const lang = conversationService.get(from)?.lang === 'nl' ? 'nl' : 'en';
  if (!lookup.render || lookup.lang === lang) return lookup.text;
  const r = lookup.render;
  return appointmentOverview.renderOverview(r.overview, r.verdict, lang, { web: r.web, clients: r.clients });
}

/**
 * A lookup's list that no reply carried yet (the model never answered, or its
 * call failed): sent as the whole reply. true when it went out.
 */
async function sendPendingLookup(from) {
  const lookup = conversationService.get(from)?.lookupReply;
  if (!lookup) return false;
  conversationService.update(from, { lookupReply: { ...lookup, mustReplace: true } });
  await executeRespond(from, { message: '', ui_type: 'none' });
  return true;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.wroteThisTurn] a booking, class booking, cancel or
 *   payment ran in this turn: the model's text explains what happened and is
 *   not replaced by a lookup's list (unless the list must go out).
 */
async function executeRespond(from, args, opts = {}) {
  let { message } = args;
  const { ui_type, buttons, list_sections, list_button_label, cta_label, cta_url, detected_language } = args;

  if (detected_language) {
    const langChanged = conversationService.get(from)?.lang !== detected_language;
    conversationService.update(from, { lang: detected_language });
    if (langChanged) persistGuardState(from);
    // Shown in the dashboard (language badge, translator default) and stats.
    if (!String(from).startsWith('web_')) db.setConversationLanguage?.(from, detected_language)?.catch?.(() => {});
  }

  // A pay-first payment link created in this turn: the server sends the
  // standard message with the EXACT link (the model's copy of a long Stripe
  // URL can be truncated, and its wording can drift into "booked"/"reserved").
  const pendingLink = conversationService.get(from)?.payFirstLinkPending;
  let replyType = ui_type;
  if (pendingLink && !from.startsWith('web_')) {
    conversationService.update(from, { payFirstLinkPending: null });
    // Only a link whose row is still open may go out. Rows are never deleted:
    // an unreadable row (DB hiccup) still gets its link — every close in this
    // turn already cleared the pending link itself.
    let row = await db.getBookingEventById(pendingLink.rowId).catch(() => null);
    if (!row) row = await db.getBookingEventById(pendingLink.rowId).catch(() => null);
    if (!row || row.status === 'awaiting_payment') {
      conversationService.update(from, { payFirstLinkSentAt: Date.now() });
      await payFirst.sendGuestMessage(from, pendingLink.text, { ctaLabel: pendingLink.ctaLabel, ctaUrl: pendingLink.url });
      // Normally the link message IS the reply; when another booking in this
      // turn did not produce a link, the model's explanation goes out too —
      // as plain text (the exact link already went out).
      if (!pendingLink.alsoSendModelText) return;
      if (replyType === 'cta_button') replyType = 'none';
    } else if (replyType === 'cta_button') {
      // The link was closed in this turn: never send the model's copy of it.
      replyType = 'none';
    }
  }

  // The model's own copy of a pay-first link (e.g. from earlier in the chat)
  // may only go out while that checkout is still open.
  if (replyType === 'cta_button' && !from.startsWith('web_')) {
    const sid = String(cta_url || '').match(/cs_(?:live|test)_[A-Za-z0-9]+/)?.[0];
    if (sid) {
      const pfRow = await db.getPayFirstRowBySession(sid).catch(() => null);
      if (pfRow && pfRow.pay_first && pfRow.status !== 'awaiting_payment') replyType = 'none';
    }
  }

  // Tara, 4 Nov 2026: the model may imitate the label restored history puts
  // on a colleague's lines (team-context.js). It never poses as one.
  message = teamContext.stripColleagueLabel(message);

  // A lookup in this turn (get_appointments): the guest gets the server's own
  // list. When it could not confirm what the guest described it replaces the
  // reply whatever the model chose (after a booking, cancel or payment call in
  // this turn it goes before the reply instead); when the guest described something it
  // replaces a plain reply; otherwise it goes before a plain reply. Buttons,
  // lists and links are left alone (the cancel flow), and so is the
  // explanation after a booking, cancel or payment in this turn.
  let overviewFirst = null;
  let replaced = false;
  const interactive = ['buttons', 'list', 'cta_button'].includes(replyType);
  const lookup = conversationService.get(from)?.lookupReply;
  if (lookup) {
    conversationService.update(from, { lookupReply: null });
    const lookupText = lookupTextFor(from, lookup);
    if (lookup.mustReplace && opts.wroteThisTurn) {
      // A payment link made in this turn (send_payment) exists only in this
      // reply: the list goes first, the link still goes out (found in review).
      // The same for any reply after a booking call: found in the integration
      // review, the question for a missing email address (Touriya, 27 Sep
      // 2026) was replaced by the list, and the booking was silently not made.
      overviewFirst = lookupText;
    } else if (lookup.mustReplace) {
      message = lookupText;
      replaced = true;
    } else if (lookup.keepReply && lookup.render?.verdict === 'needs_team' && !opts.wroteThisTurn) {
      overviewFirst = lookupText;
    } else if (!interactive && !opts.wroteThisTurn) {
      if (lookup.expectationGiven) {
        message = lookupText;
        replaced = true;
      } else {
        const last = conversationService.get(from)?.lookupReplySent;
        if (!(last && last.text === lookupText && Date.now() - last.at < LOOKUP_REPEAT_MS)) overviewFirst = lookupText;
      }
    }
    if (replaced) replyType = 'none';
    if (replaced || overviewFirst) conversationService.update(from, { lookupReplySent: { text: lookupText, at: Date.now() } });
  }

  // The first reply after a colleague's message says the AI is answering
  // again (set by the message handler; Tara, 4 Nov 2026). Once — and the
  // colleague message it was shown for is remembered, so a second guest
  // message that arrives while this one is being sent does not get it again
  // (found in review). In front of buttons, a list or a link it goes as its
  // own message: a quoted question can take an interactive message over
  // WhatsApp's 1024-character limit, and the buttons would be lost.
  const state = conversationService.get(from);
  const prefix = state?.replyPrefix;
  if (prefix) {
    conversationService.update(from, { replyPrefix: null, replyPrefixShownFor: state.replyPrefixFor ?? null });
    const line = (state?.lang === 'nl' ? prefix.nl : prefix.en) || prefix.en;
    if (line && overviewFirst) overviewFirst = `${line}\n\n${overviewFirst}`;
    else if (line && ['buttons', 'list', 'cta_button'].includes(replyType)) overviewFirst = line;
    else if (line) message = `${line}\n\n${message}`;
  }

  // Web chat mode — resolve callback instead of sending via WhatsApp
  if (from.startsWith('web_') && webCallbacks.has(from)) {
    const resolve = webCallbacks.get(from);
    webCallbacks.delete(from);
    // One answer per web message: the list and the model's reply together.
    if (overviewFirst) message = `${overviewFirst}\n\n${message}`;
    conversationService.addMessage(from, 'assistant', message);
    db.logMessage(from, 'assistant', message);
    if (replaced) resolve({ message, ui_type: 'text' });
    else resolve({ message, ui_type: ui_type || 'text', buttons, list_sections, list_button_label, cta_label, cta_url });
    return;
  }

  if (overviewFirst) {
    try {
      await whatsappService.sendText(from, overviewFirst);
      conversationService.addMessage(from, 'assistant', overviewFirst);
      db.logMessage(from, 'assistant', overviewFirst);
    } catch (err) {
      logger.warn('Appointment overview send failed:', err.message);
    }
  }

  try {
    switch (replyType) {
      case 'buttons': {
        const validButtons = (buttons || []).filter(b => b.id && b.title).map(b => ({
          id: b.id,
          title: String(b.title).substring(0, 20),
        }));
        if (validButtons.length === 0) {
          await whatsappService.sendText(from, message);
        } else {
          await whatsappService.sendButtons(from, message, validButtons);
        }
        break;
      }
      case 'list': {
        const validSections = (list_sections || [])
          .map(s => ({
            title: String(s.title || 'Options').substring(0, 24),
            rows: (s.rows || []).filter(r => r.id && r.title).map(r => ({
              id: r.id,
              title: String(r.title).substring(0, 24),
              description: String(r.description || '').substring(0, 72),
            })),
          }))
          .filter(s => s.rows.length > 0);

        if (validSections.length === 0) {
          // AI forgot list_sections — send plain text
          logger.warn('respond list called with no valid sections, sending text');
          await whatsappService.sendText(from, message);
        } else {
          try {
            await whatsappService.sendList(from, message, (list_button_label || 'View').substring(0, 20), validSections);
          } catch (listErr) {
            // List failed — build readable text fallback that includes the options
            logger.error('sendList failed, using text fallback:', listErr.response?.data || listErr.message);
            const allRows = validSections.flatMap(s => s.rows);
            const optionLines = allRows.map(r => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
            const lang = conversationService.get(from)?.lang || 'en';
            const replyHint = lang === 'nl' ? 'Typ de gewenste tijd:' : 'Type the time you want:';
            await whatsappService.sendText(from, `${message}\n\n${optionLines}\n\n${replyHint}`).catch(() => {});
          }
        }
        break;
      }
      case 'cta_button':
        await whatsappService.sendCTAButton(from, message, (cta_label || 'Open').substring(0, 20), cta_url);
        break;
      default:
        await whatsappService.sendText(from, message);
    }
  } catch (sendErr) {
    logger.error('executeRespond fatal error:', sendErr.message);
    // Never drop a link: a failed CTA falls back to text WITH the URL.
    const fallback = replyType === 'cta_button' && cta_url ? `${message}\n\n${cta_url}` : message;
    await whatsappService.sendText(from, fallback).catch(() => {});
  }

  conversationService.addMessage(from, 'assistant', message);
  db.logMessage(from, 'assistant', message);
}

module.exports = {
  firstNameOf,
  sameGuestName,
  toolCheckAvailability,
  toolLookupClient,
  toolBookAppointment,
  toolSendPayment,
  billPendingBookings,
  scheduleAutoPaymentLink,
  schedulePaymentTimeline,
  cancelAutoPaymentLink,
  closeUsedConfirmation,
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
};
