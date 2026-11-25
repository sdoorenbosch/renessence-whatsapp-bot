// Regression for "Melanie" (Mon 23 Nov 2026, 15:12). She asked for treatments
// "for Saturday". The model turned that into 2026-11-25 by itself — a Saturday
// in 2023, a Wednesday in 2026; the coming Saturday was 28 November.
// check_availability fetched Wednesday's times, the bot showed them six times
// as "Saturday, 25th November", she confirmed "Saturday 25 November at 12:00",
// and only the server-built payment message said "Wednesday 25 November".
// The team (Fabiana): "The chatbot is mixing up days and dates … the guests
// are also getting confused."
//
// Nothing in code knew which weekday a date is at the point where text leaves
// for the guest. Each block pins one part of the fix:
//  1. the calendar (src/utils/calendar.js): the one place that knows it
//  2. the prompt: a 28-day calendar in Session, and no hand-written weekday +
//     date left in the prompt or the tool definitions
//  3. check_availability: the weekday argument, labels in the chat language,
//     and the day named when nothing is free
//  4. the pair finder and the code correction, as tables
//  5. the turn of 23 Nov through agent.run with a scripted model
//  6. the confirmation summary names the day, and book_appointment only books
//     the day the guest confirmed
//  7. what the bot forwards to the team carries a date-check note
//
// What Jest cannot show: whether the real model reads the calendar. Block 5
// scripts the model; the checks in code are the part that is guaranteed.

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn(), retrieve: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}), sendCTAButton: jest.fn().mockResolvedValue({}), sendImage: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/email.service', () => ({
  sendEscalationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendRescheduleRequestEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendGiftCardRequestEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendCancellationNotificationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendRefundNotificationEmail: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../src/services/outage-alert.service', () => ({
  recordAgentFailure: jest.fn(), recordAgentSuccess: jest.fn().mockResolvedValue(), holdingMessage: () => 'hold', HOLDING_TEXTS: [],
}));
jest.mock('../src/services/mindbody.service', () => ({
  getBookableItems: jest.fn(),
  getRoomOccupancy: jest.fn().mockResolvedValue({ known: true, busy: new Map() }),
  RESOURCE_MAP: { 31: [3, 4], 32: [3, 4] },
  getClientByPhone: jest.fn(),
  getAllClientsByPhone: jest.fn().mockResolvedValue([]),
  searchClientByName: jest.fn().mockResolvedValue(null),
  getStaffAppointments: jest.fn().mockResolvedValue([]),
  addAppointment: jest.fn(),
  cancelAppointment: jest.fn().mockResolvedValue({}),
  isBenignCancelError: jest.fn().mockReturnValue(false),
  findAvailableStaffForTime: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/services/pay-first.service', () => ({
  ...jest.requireActual('../src/services/pay-first.service'),
  closeOpenCheckoutsForHandoff: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/data/database', () => ({
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  logError: jest.fn().mockResolvedValue(true),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  getActivePayFirstHolds: jest.fn().mockResolvedValue([]),
  getBookingEventById: jest.fn().mockResolvedValue(null),
  getBookingEventByAppointment: jest.fn().mockResolvedValue(null),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  getRecentBooking: jest.fn().mockResolvedValue(null),
  getOpenJourneyForDay: jest.fn().mockResolvedValue({ count: 0, totalCents: 0 }),
  logBookingEvent: jest.fn().mockResolvedValue(77),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  updateBookingEventIfStatus: jest.fn().mockResolvedValue(true),
  tombstoneByAppointment: jest.fn().mockResolvedValue(0),
  isHumanHandling: jest.fn().mockResolvedValue(false),
  markConversationEscalated: jest.fn(),
  getConversationStatus: jest.fn().mockResolvedValue(null),
  setConversationLanguage: jest.fn().mockResolvedValue(),
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));
// book_appointment runs for real unless a test scripts its answer (the
// two-person payment chain, a pay-first link made in the same turn).
jest.mock('../src/agents/tool-implementations', () => {
  const actual = jest.requireActual('../src/agents/tool-implementations');
  return { ...actual, toolBookAppointment: jest.fn(actual.toolBookAppointment) };
});

const fs = require('fs');
const path = require('path');
const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const email = require('../src/services/email.service');
const mindbody = require('../src/services/mindbody.service');
const payFirst = require('../src/services/pay-first.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');
const agent = require('../src/agents/renessence.agent');
const cal = require('../src/utils/calendar');
const { TOOLS } = require('../src/agents/tool-definitions');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { checkReply, correctReply } = require('../src/agents/reply-guards');

const realBookAppointment = jest.requireActual('../src/agents/tool-implementations').toolBookAppointment;

const PHONE = '31600000025';
const TAILORED_60 = 31;   // pay-first
const NSR = 45;           // Fridays only
const SAUNA_2P = 69;      // Finnish Sauna for 2, paid at reception
const CLIENT = { Id: 'c25', FirstName: 'Melanie', LastName: 'A', Email: 'melanie@guest.fixture' };

// The six texts the bot sent on 23 Nov (#7, #9, #11, #15, #19, #21), retyped:
// the guest's first name only, other therapist names.
const SAUNA_TIMES = '- 08:15\n- 09:45\n- 11:15\n- 12:45\n- 14:15\n- 15:45';
const BOT_TEXTS_OF_23_NOV = [
  'Here are the available times for a Tailored Massage on Saturday, 25th November:\n\n📅 09:00 - Therapist Lisa, 60 min (€130)\n📅 09:00 - Therapist Lisa, 80 min (€170)\n📅 12:00 - Therapist Emma, 60 min (€130)\n\nWould you like to choose one for your booking?',
  `Here are the available times for the Finnish Sauna (2 people) on Saturday, 25th November:\n\n${SAUNA_TIMES}\n\nWould you like to choose a time for the Finnish Sauna and a time for the Tailored Massage (using the earlier slots I provided), so I can proceed with booking them?`,
  'Here are the available times for the Renewal Facial on Saturday, 25th November:\n\n📅 09:00 - Therapist Lisa (€165)\n📅 10:35 - Therapist Lisa (€165)\n\nWould you like to select a time for the Renewal Facial and let me know if you\'d like to proceed with booking the Finnish Sauna too?',
  `Here are the available times for the Finnish Sauna for 1 person on Saturday, 25th November:\n\n${SAUNA_TIMES}\n\nWould you like to book any of these times along with a Renewal Facial slot?`,
  'Please confirm your booking:\n\n✅ Tailored Massage\n📅 Saturday 25 November at 12:00\n👤 Melanie\n\nBy confirming, you declare that you are in good health, have disclosed any relevant medical conditions, and understand that you participate at your own risk.\nCancellations are free of charge up to 24 hours before your scheduled start time. After that, the full amount will be charged.\n\nShall I confirm this booking?',
  'Please confirm your booking:\n\n✅ Tailored Massage\n📅 Saturday 25 November at 12:00\n👤 Melanie\n\nBy confirming, you declare that you are in good health, have disclosed any relevant medical conditions, and understand that you participate at your own risk. Cancellations are free of charge up to 24 hours before your scheduled start time. After that, the full amount will be charged.\n\nShall I confirm this booking?',
];
// …and the payment message the server built itself (#23) — the only one that named the real day.
const SERVER_PAYMENT_TEXT = 'To book *Tailored Massage 60 min* on Wednesday 25 November at 12:00 with Therapist Emma, please pay €130 via the link below. Your appointment is booked as soon as the payment is complete, and you\'ll get a confirmation here within a minute.\n\n⏳ The link is valid until 16:19 — until you\'ve paid, this time isn\'t reserved for you yet.';

const WRONG = BOT_TEXTS_OF_23_NOV[0];
const WRONG_FIXED = WRONG.replace('Saturday, 25th November', 'Wednesday, 25th November');
const RIGHT = 'Here are the available times for a Tailored Massage on Saturday 28 November:\n\n📅 11:50 - Therapist Lisa\n📅 13:35 - Therapist Emma\n\nWould you like to choose one for your booking?';
const SUMMARY = (dayLine) => `Please confirm your booking:\n\n✅ Finnish Sauna (2 people)\n${dayLine}\n👤 Melanie\n\nBy confirming, you declare that you are in good health, have disclosed any relevant medical conditions, and understand that you participate at your own risk.\nCancelling or rescheduling is free of charge up to 24 hours before your scheduled start time. After that, the full amount will be charged.\n\nShall I confirm this booking?`;
const CONFIRM_BUTTONS = { ui_type: 'buttons', buttons: [{ id: 'confirm_booking', title: 'Confirm' }, { id: 'cancel_booking', title: 'Cancel' }] };

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const respond = (id, message, extra = {}) => call(id, 'respond', { message, ui_type: 'none', detected_language: 'en', ...extra });
const check = (id, date, extra = {}) => call(id, 'check_availability', { session_type_ids: [TAILORED_60], start_date: date, end_date: date, ...extra });
function script(...toolCallBatches) {
  mockCreate.mockReset();
  for (const batch of toolCallBatches) {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: batch } }] });
  }
}
/** The tool results the model saw, by tool_call_id. */
function toolResults() {
  const msgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
  return Object.fromEntries(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content)]));
}
const sentTexts = () => whatsapp.sendText.mock.calls.map(c => c[1]);
const saidByBot = () => conversations.getMessages(PHONE).filter(m => m.role === 'assistant').map(m => m.content);
const loggedErrors = (type) => db.logError.mock.calls.filter(c => c[0] === type);
/** Wrong pairs the finder sees in a text (prose, or a list/button field with `short`). */
const flags = (text, opts = {}) => cal.findWeekdayDates(text, new Date(), opts).filter(h => !h.ok);

/** A therapist's free window in Mindbody's shape (65 minutes: one 60-minute slot at its start). */
function window(date, time, sessionTypeId, staff = { Id: 5, Name: 'Lisa' }) {
  const [h, m] = time.split(':').map(Number);
  const end = h * 60 + m + 65;
  const pad = (n) => String(n).padStart(2, '0');
  return { StartDateTime: `${date}T${time}:00`, EndDateTime: `${date}T${pad(Math.floor(end / 60))}:${pad(end % 60)}:00`, Staff: staff, SessionType: { Id: sessionTypeId } };
}
/** Wednesday 25 Nov: 09:00 and 12:00. Saturday 28 Nov: 11:50 and 13:35 (the times the team later gave her). */
function mindbodyOf23Nov() {
  mindbody.getBookableItems.mockImplementation(async (id, start, end) => {
    const days = { '2026-11-25': ['09:00', '12:00'], '2026-11-27': ['10:00'], '2026-11-28': ['11:50', '13:35'], '2026-11-29': ['10:00'] };
    return Object.entries(days)
      .filter(([d]) => d >= start && d <= end)
      .flatMap(([d, times]) => times.map((t, i) => window(d, t, id, i ? { Id: 7, Name: 'Emma' } : { Id: 5, Name: 'Lisa' })));
  });
}
/** The handler's Confirm-tap effect, plus the slots she was genuinely offered. */
function tapConfirm(offeredSlots, extra = {}) {
  conversations.set(PHONE, { lang: 'en', hydrated: true, bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0, offeredSlots, ...extra });
}
const offer = (dateTime, sessionTypeId = SAUNA_2P) => ({ dateTime, sessionTypeId });
const bookSauna = (dateTime) => tools.toolBookAppointment(PHONE, { session_type_id: SAUNA_2P, start_date_time: dateTime });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-23T15:12:00')); // Mon 23 Nov 2026, 15:12 Amsterdam
  jest.clearAllMocks();
  conversations.clear(PHONE);
  conversations.clear('web_melanie');
  tools.toolBookAppointment.mockImplementation(realBookAppointment);
  mindbodyOf23Nov();
  mindbody.getClientByPhone.mockResolvedValue(CLIENT);
  mindbody.addAppointment.mockResolvedValue({ Id: 9001 });
  db.query.mockImplementation(async () => ({ rows: [] }));
  db.hasRecentTeamNotification.mockResolvedValue(false);
});
afterEach(() => {
  tools.cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

// ── 1. The calendar ──────────────────────────────────────────────────────────

describe('1. the calendar knows which weekday a date is', () => {
  test('25 November 2026 is a Wednesday, and the coming Saturday is the 28th', () => {
    expect(cal.weekdayOf('2026-11-25')).toBe(3);
    expect(cal.weekdayOf('2026-11-25T12:00:00')).toBe(3);
    expect(cal.dayLabel('2026-11-25T12:00:00', 'en')).toBe('Wednesday 25 November');
    expect(cal.dayLabel('2026-11-25', 'nl')).toBe('woensdag 25 november');
    expect(cal.weekdaysAround(6, '2026-11-25')).toEqual({ near: ['2026-11-28'], coming: '2026-11-28', today: null });
    // Around a date further away: that week's Saturdays, and separately the coming one.
    expect(cal.weekdaysAround(6, '2026-12-20')).toEqual({ near: ['2026-12-19', '2026-12-26'], coming: '2026-11-28', today: null });
    expect(cal.weekdaysAround(1, '2026-11-25')).toEqual({ near: ['2026-11-23', '2026-11-30'], coming: '2026-11-30', today: '2026-11-23' });
  });

  test('a label far from today carries its year, so it is read back as the same day', () => {
    expect(cal.dayLabel('2026-11-16', 'en')).toBe('Monday 16 November');
    expect(cal.dayLabel('2027-11-27', 'en')).toBe('Saturday 27 November 2027');   // a year ahead
    expect(cal.dayLabel('2026-09-01', 'nl')).toBe('dinsdag 1 september 2026');    // twelve weeks back
    expect(cal.dayLabel('2026-11-28', 'en', { year: true })).toBe('Saturday 28 November 2026');
    for (const day of ['2026-11-16', '2027-11-27', '2026-09-01', '2027-07-04']) {
      for (const lang of ['en', 'nl']) {
        expect(cal.findWeekdayDates(cal.dayLabel(day, lang))).toEqual([expect.objectContaining({ date: day, ok: true })]);
      }
    }
  });

  test('never throws on something that is not a date', () => {
    expect(cal.weekdayOf('next week')).toBeNull();
    expect(cal.weekdayOf(undefined)).toBeNull();
    expect(cal.dayLabel('2026-11-31', 'en')).toBe('2026-11-31');
    expect(cal.findWeekdayDates(undefined)).toEqual([]);
    expect(cal.correctWeekdays(null)).toBe('');
    expect(cal.rangeDays('2026-11-27', '2026-11-29')).toEqual(['2026-11-27', '2026-11-28', '2026-11-29']);
    expect(cal.rangeDays('nonsense', '2026-11-29')).toEqual([]);
    expect(cal.weekdaysAround(undefined, '2026-11-25')).toEqual({ near: [], coming: null, today: null });
  });

  test('the calendar for the prompt: 28 days from today, with today, tomorrow and the weekend marked', () => {
    const lines = cal.calendarLines(new Date(), 28);
    expect(lines).toHaveLength(28);
    expect(lines.slice(0, 7)).toEqual([
      'Monday 23 November 2026 = 2026-11-23 (today)',
      'Tuesday 24 November 2026 = 2026-11-24 (tomorrow)',
      'Wednesday 25 November 2026 = 2026-11-25 (the day after tomorrow / overmorgen)',
      'Thursday 26 November 2026 = 2026-11-26',
      'Friday 27 November 2026 = 2026-11-27',
      'Saturday 28 November 2026 = 2026-11-28 (this weekend)',
      'Sunday 29 November 2026 = 2026-11-29 (this weekend)',
    ]);
    expect(lines[27]).toBe('Sunday 20 December 2026 = 2026-12-20');
  });

  test('New Year: a day in January is next year\'s, a day in late December last year\'s', () => {
    jest.setSystemTime(new Date('2026-12-28T10:00:00')); // Monday
    expect(cal.findWeekdayDates('Saturday 2 January')).toEqual([expect.objectContaining({ date: '2027-01-02', ok: true })]);
    expect(cal.findWeekdayDates('Friday 2 January')).toEqual([expect.objectContaining({ date: '2027-01-02', ok: false })]);
    expect(cal.dayLabel('2027-01-02', 'en')).toBe('Saturday 2 January');
    expect(cal.calendarLines(new Date(), 28).slice(3, 6)).toEqual([
      'Thursday 31 December 2026 = 2026-12-31',
      'Friday 1 January 2027 = 2027-01-01',
      'Saturday 2 January 2027 = 2027-01-02 (this weekend)',
    ]);
    expect(cal.weekdaysAround(6, '2026-12-30')).toEqual({ near: ['2027-01-02'], coming: '2027-01-02', today: null });

    jest.setSystemTime(new Date('2027-01-03T10:00:00')); // Sunday
    expect(cal.findWeekdayDates('Wednesday 30 December')).toEqual([expect.objectContaining({ date: '2026-12-30', ok: true })]);
    expect(cal.findWeekdayDates('Saturday 2 January')).toEqual([expect.objectContaining({ date: '2027-01-02', ok: true })]);
  });

  test.each([
    ['back', '2026-10-24T23:30:00', '2026-10-25T02:30:00', 'Sunday 25 October 2026 = 2026-10-25', 'Monday 26 October 2026 = 2026-10-26'],
    ['forward', '2027-03-27T23:30:00', '2027-03-28T03:30:00', 'Sunday 28 March 2027 = 2027-03-28', 'Monday 29 March 2027 = 2027-03-29'],
  ])('the night the clocks go %s: no day is skipped or doubled', (_, eveningBefore, inTheNight, sunday, monday) => {
    jest.setSystemTime(new Date(eveningBefore)); // Saturday evening
    const lines = cal.calendarLines(new Date(), 28);
    expect(lines[1]).toBe(`${sunday} (tomorrow; this weekend)`);
    expect(lines[2]).toBe(`${monday} (the day after tomorrow / overmorgen)`);
    const dates = lines.map(l => l.match(/= (\d{4}-\d{2}-\d{2})/)[1]);
    expect(new Set(dates).size).toBe(28);
    for (let i = 1; i < dates.length; i++) expect(cal.weekdayOf(dates[i])).toBe((cal.weekdayOf(dates[i - 1]) + 1) % 7);
    expect(cal.findWeekdayDates(sunday.split(' = ')[0])).toEqual([expect.objectContaining({ ok: true })]);
    expect(cal.findWeekdayDates(sunday.split(' = ')[0].replace('Sunday', 'Saturday'))).toEqual([expect.objectContaining({ ok: false, actual: 0 })]);

    jest.setSystemTime(new Date(inTheNight));
    expect(cal.calendarLines(new Date(), 28)[0]).toBe(`${sunday} (today; this weekend)`);
    expect(cal.calendarLines(new Date(), 28)[1]).toBe(`${monday} (tomorrow)`);
    expect(cal.dayLabel(`${sunday.slice(-10)}T02:30:00`, 'en', { year: true })).toBe(sunday.split(' = ')[0]);
  });
});

// ── 2. The prompt and the tool definitions ───────────────────────────────────

describe('2. the prompt gives a calendar to read and no day to work out', () => {
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const session = (p) => p.lastIndexOf('\n## Session\n');

  test('Session holds the 28-day calendar before the Customer line, and the prompt-cache layout holds', () => {
    const p = buildSystemPrompt(PHONE, 'Melanie');
    const tail = p.slice(session(p));
    expect(session(p)).toBeGreaterThan(p.length * 0.9);
    expect(tail.match(/^\w+day \d{1,2} \w+ \d{4} = \d{4}-\d{2}-\d{2}/gm)).toHaveLength(28);
    expect(tail).toContain('Today is Monday 23 November 2026. Tomorrow is Tuesday 24 November 2026.');
    expect(tail).toContain('Saturday 28 November 2026 = 2026-11-28 (this weekend)');
    expect(tail).toContain('Today: 2026-11-23 | Tomorrow: 2026-11-24 | Next Monday: 2026-11-30 | In 30 days: 2026-12-23');
    expect(tail.indexOf('Sunday 20 December 2026 = 2026-12-20')).toBeLessThan(tail.indexOf('Customer: Melanie'));
    expect(tail.indexOf('In 30 days:')).toBeLessThan(tail.indexOf('Customer: Melanie'));
    // Everything up to the customer line is the same for every guest that day.
    const other = buildSystemPrompt('31600000026', 'Bob', true, false, { payFirstStatus: 'Tailored Massage 60 min — AWAITING PAYMENT' });
    const shared = commonPrefix(p, other);
    expect(shared / Math.min(p.length, other.length)).toBeGreaterThan(0.98);
    expect(shared).toBeGreaterThan(p.indexOf('In 30 days: 2026-12-23'));
    expect(other.slice(session(other))).toMatch(/Customer: Bob \| Phone: 31600000026\nPay-first bookings of this customer: Tailored Massage 60 min/);
  });

  test('the static part explains how to read it, in at most six bullets and without a date in it', () => {
    const p = buildSystemPrompt(PHONE, 'Melanie');
    const stat = p.slice(0, session(p));
    const at = stat.indexOf('\n## Dates and weekdays\n');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(stat.indexOf('\n## Booking flow\n'));
    const section = stat.slice(at + 1, stat.indexOf('\n## ', at + 1));
    expect(section.split('\n').filter(l => l.startsWith('- ')).length).toBeLessThanOrEqual(6);
    expect(section).not.toMatch(/\d{4}|\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)/);
    expect(section).toMatch(/Session section at the end of this prompt/);
    expect(section).toMatch(/pass it as weekday to check_availability/);
  });

  test('examples that had the model compose a day itself are placeholders now', () => {
    const p = buildSystemPrompt(PHONE, 'Melanie');
    const stat = p.slice(0, session(p));
    for (const old of ['1 mei', 'Sunday 20 September', '[date]', '[datum]', 'today+30 days', 'Parse whatever they type as a date']) {
      expect(stat).not.toContain(old);
    }
    expect(stat).toContain('📅 <dateLabel> at [time]');
    expect(stat).toMatch(/end_date = the "In 30 days" date/);
    const defs = JSON.stringify(TOOLS);
    for (const old of ['Saturday 23 May', 'Saturday 19 July', 'Saturday 12 July']) expect(defs).not.toContain(old);
  });

  test('no weekday + date pair is left in the tool definitions, and none in the static prompt that a new year can make wrong', () => {
    const defs = JSON.stringify(TOOLS);
    const p = buildSystemPrompt(PHONE, 'Melanie');
    const stat = p.slice(0, session(p));
    for (const lang of ['en', 'nl']) {
      for (const shortField of [false, true]) {
        expect(cal.findWeekdayDates(defs, new Date(), { lang, shortField })).toEqual([]);
        // Opening hours and closures are written by code with their year: right in any year.
        for (const clock of ['2026-11-23T15:12:00', '2027-11-23T15:12:00', '2028-11-23T15:12:00']) {
          expect(cal.findWeekdayDates(stat, new Date(clock), { lang, shortField }).filter(h => !h.ok).map(h => h.text)).toEqual([]);
        }
      }
    }
  });

  test('the pair finder flags nothing in the whole prompt, the tool definitions or the knowledge base', () => {
    const corpus = {
      prompt: buildSystemPrompt(PHONE, 'Melanie', false, false, { payFirstStatus: 'Tailored Massage 60 min on Wednesday 25 November at 12:00 — AWAITING PAYMENT' }),
      tools: JSON.stringify(TOOLS),
      knowledgeBase: fs.readFileSync(path.join(__dirname, '../src/data/knowledge-base.json'), 'utf8'),
    };
    for (const [name, text] of Object.entries(corpus)) {
      for (const lang of ['en', 'nl']) {
        for (const shortField of [false, true]) {
          expect([name, flags(text, { lang, shortField }).map(h => h.text)]).toEqual([name, []]);
        }
      }
    }
  });

  test('check_availability takes the weekday the customer named', () => {
    const fn = TOOLS.find(t => t.function.name === 'check_availability').function;
    expect(fn.parameters.properties.weekday.enum).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(fn.parameters.required).toEqual(['session_type_ids', 'start_date', 'end_date']);
    expect(fn.parameters.properties.start_date.description).toMatch(/Session calendar/);
  });
});

// ── 3. check_availability ────────────────────────────────────────────────────

describe('3. check_availability: the weekday the guest named is checked against the date', () => {
  const checkDay = (start, extra = {}) => tools.toolCheckAvailability(PHONE, { session_type_ids: [TAILORED_60], start_date: start, end_date: start, ...extra });

  test('2026-11-25 for "Saturday" is refused before Mindbody is asked, and nothing counts as offered', async () => {
    const r = await checkDay('2026-11-25', { weekday: 'saturday' });
    expect(r).toMatchObject({ error: 'weekday_mismatch', slots: [], staff: [] });
    expect(r.message).toBe('Nothing was checked: 2026-11-25 is a Wednesday, not a Saturday. Saturdays near that date: Saturday 28 November 2026 (2026-11-28). The coming Saturday is Saturday 28 November 2026 (2026-11-28). If the customer named only the weekday, call check_availability again with the coming Saturday. If the customer gave the date and no weekday, call again with that date and leave weekday out. If they gave both and they do not match, ask which one they mean and name both options.');
    expect(mindbody.getBookableItems).not.toHaveBeenCalled();
    expect(conversations.get(PHONE)?.offeredSlots).toBeUndefined();
    expect(db.saveConversationState).not.toHaveBeenCalled();
  });

  test('a range without that weekday is refused too; around a date further away it names that week\'s days', async () => {
    const range = await tools.toolCheckAvailability(PHONE, { session_type_ids: [TAILORED_60], start_date: '2026-11-24', end_date: '2026-11-26', weekday: 'Saturday' });
    expect(range.error).toBe('weekday_mismatch');
    expect(range.message).toMatch(/^Nothing was checked: there is no Saturday between 2026-11-24 and 2026-11-26\. /);
    const far = await checkDay('2026-12-20', { weekday: 'zaterdag' });
    expect(far.message).toContain('2026-12-20 is a Sunday, not a Saturday. Saturdays near that date: Saturday 19 December 2026 (2026-12-19) and Saturday 26 December 2026 (2026-12-26). The coming Saturday is Saturday 28 November 2026 (2026-11-28).');
    expect(mindbody.getBookableItems).not.toHaveBeenCalled();
  });

  test('the real Saturday is checked, and its times carry the day in the chat language', async () => {
    const en = await checkDay('2026-11-28', { weekday: 'saturday' });
    expect(mindbody.getBookableItems).toHaveBeenCalledWith(TAILORED_60, '2026-11-28', '2026-11-28');
    expect(en.slots.map(s => [s.dateLabel, s.timeLabel])).toEqual([['Saturday 28 November', '11:50'], ['Saturday 28 November', '13:35']]);
    expect(en.days).toEqual([{ date: '2026-11-28', label: 'Saturday 28 November', labelNl: 'zaterdag 28 november' }]);
    expect(conversations.get(PHONE).offeredSlots.map(s => s.dateTime)).toEqual(['2026-11-28T11:50:00', '2026-11-28T13:35:00']);

    conversations.set(PHONE, { lang: 'nl' });
    const nl = await checkDay('2026-11-28', { weekday: 'saturday' });
    expect(nl.slots.map(s => s.dateLabel)).toEqual(['zaterdag 28 november', 'zaterdag 28 november']);
  });

  test('without a weekday the date is checked as before — and labelled with its real day', async () => {
    const r = await checkDay('2026-11-25');
    expect(r.slots.map(s => [s.dateLabel, s.timeLabel])).toEqual([['Wednesday 25 November', '09:00'], ['Wednesday 25 November', '12:00']]);
    expect(r.days).toEqual([{ date: '2026-11-25', label: 'Wednesday 25 November', labelNl: 'woensdag 25 november' }]);
  });

  test('a range that does contain the weekday is not cut down to it', async () => {
    const r = await tools.toolCheckAvailability(PHONE, { session_type_ids: [TAILORED_60], start_date: '2026-11-27', end_date: '2026-11-29', weekday: 'saturday' });
    expect(r.error).toBeUndefined();
    expect(r.days.map(d => d.label)).toEqual(['Friday 27 November', 'Saturday 28 November', 'Sunday 29 November']);
  });

  test('a date written with a time is cut to the day, and a weekday the server does not know is ignored', async () => {
    const r = await tools.toolCheckAvailability(PHONE, { session_type_ids: [TAILORED_60], start_date: '2026-11-28T00:00:00', end_date: '2026-11-28T23:59:00', weekday: 'someday' });
    expect(mindbody.getBookableItems).toHaveBeenCalledWith(TAILORED_60, '2026-11-28', '2026-11-28');
    expect(r.slots).toHaveLength(2);
  });

  test('nothing free: the answer names the day that was checked', async () => {
    mindbody.getBookableItems.mockResolvedValue([]);
    const none = await checkDay('2026-11-25');
    expect(none).toMatchObject({ slots: [], staff: [], no_availability: true });
    expect(none.message).toMatch(/^No availability found for Wednesday 25 November 2026\./);
    expect(none.days).toEqual([{ date: '2026-11-25', label: 'Wednesday 25 November', labelNl: 'woensdag 25 november' }]);

    const range = await tools.toolCheckAvailability(PHONE, { session_type_ids: [TAILORED_60], start_date: '2026-11-25', end_date: '2026-11-27' });
    expect(range.message).toMatch(/^No availability found for Wednesday 25 November 2026 – Friday 27 November 2026\./);
  });

  test('a treatment that only runs on Fridays, asked for a Wednesday: "nothing on Wednesday 25 November", not a bare empty list', async () => {
    mindbody.getBookableItems.mockResolvedValue([window('2026-11-25', '10:00', NSR)]);
    const r = await tools.toolCheckAvailability(PHONE, { session_type_ids: [NSR], start_date: '2026-11-25', end_date: '2026-11-25' });
    expect(r).toMatchObject({ slots: [], staff: [], no_availability: true });
    expect(r.message).toMatch(/Wednesday 25 November 2026/);
  });

  test('too little notice left today: the day is named there too', async () => {
    // 15:12 now; pay-first treatments need an hour's notice.
    mindbody.getBookableItems.mockResolvedValue([window('2026-11-23', '15:30', TAILORED_60)]);
    const r = await checkDay('2026-11-23');
    expect(r).toMatchObject({ slots: [], no_availability: true, notice_required: '60 minutes' });
    expect(r.message).toMatch(/^There are no times left with enough notice on Monday 23 November 2026: /);
    expect(r.days).toEqual([{ date: '2026-11-23', label: 'Monday 23 November', labelNl: 'maandag 23 november' }]);
  });

  test('no times in the part of the day asked for: the day is named there as well', async () => {
    const r = await checkDay('2026-11-28', { part_of_day: 'evening' });
    expect(r).toMatchObject({ slots: [], no_slots_in_part: true });
    expect(r.message).toMatch(/^No evening slots for Saturday 28 November 2026, but there IS availability/);
    expect(r.days).toEqual([{ date: '2026-11-28', label: 'Saturday 28 November', labelNl: 'zaterdag 28 november' }]);
  });

  test('other tools label days the same way', async () => {
    mindbody.getAllClientsByPhone.mockResolvedValue([CLIENT]);
    mindbody.getStaffAppointments.mockResolvedValue([{ Id: 41, StartDateTime: '2026-11-25T12:00:00', SessionType: { Name: 'Tailored Massage 60 min' } }]);
    const mine = await tools.toolGetAppointments(PHONE, { client_email: 'melanie@guest.fixture' });
    expect(mine.appointments[0]).toMatchObject({ dateLabel: 'Wednesday 25 November', timeLabel: '12:00' });

    conversations.set(PHONE, { lang: 'nl' });
    const mijn = await tools.toolGetAppointments(PHONE, { client_email: 'melanie@guest.fixture' });
    expect(mijn.appointments[0].dateLabel).toBe('woensdag 25 november');
  });
});

// ── 4. The pair finder and the code correction ───────────────────────────────

describe('4. a weekday next to a date that is another weekday is found', () => {
  test('all six texts the bot sent on 23 Nov are caught; the payment text the server built is not', () => {
    for (const text of BOT_TEXTS_OF_23_NOV) {
      expect(flags(text)).toEqual([expect.objectContaining({ date: '2026-11-25', weekday: 6, actual: 3, ok: false })]);
      expect(checkReply(PHONE, { message: text, ui_type: 'none' }, {})).toMatchObject({ kind: 'weekday', error: 'weekday_mismatch' });
    }
    expect(cal.findWeekdayDates(SERVER_PAYMENT_TEXT)).toEqual([expect.objectContaining({ date: '2026-11-25', ok: true })]);
    expect(checkReply(PHONE, { message: SERVER_PAYMENT_TEXT, ui_type: 'cta_button' }, {})).toBeNull();
    // …and the text the server builds today, for the same slot.
    const built = payFirst.linkMessage({ id: 1, service_name: 'Tailored Massage 60 min', amount_cents: 13000, pay_first: { startDateTime: '2026-11-25T12:00:00', staffName: 'Emma' } }, 'en');
    expect(built).toContain('Wednesday 25 November at 12:00');
    expect(flags(built)).toEqual([]);
    const gebouwd = payFirst.linkMessage({ id: 1, service_name: 'Tailored Massage 60 min', amount_cents: 13000, pay_first: { startDateTime: '2026-11-25T12:00:00', staffName: 'Emma' } }, 'nl');
    expect(gebouwd).toContain('woensdag 25 november om 12:00');
    expect(flags(gebouwd, { lang: 'nl' })).toEqual([]);
  });

  // The first design of this check missed 19 of 53 ways of writing the pair.
  test.each([
    'Saturday 25 November', 'Saturday, 25th November', 'Saturday 25th of November 2026', 'Saturday 25 Nov', 'Sat, 25 Nov', 'Saturday, Nov. 25',
    '*Saturday* 25 November', '*Saturday, 25 November*', '_Saturday_ 25 November', '~Saturday~ 25 November',
    'Saturday - 25 November', 'Saturday – 25 November', 'Saturday: 25 November', 'Saturday\n25 November',
    '25 November, Saturday', '25th November - Saturday', '25 November (Sat)', 'November 25 (Saturday)', 'November 25th, Saturday',
    'Saturday the 25th at 12:00', 'Saturday (25th)', 'this Saturday (25 November)', 'on Saturday, which is 25 November', 'Saturday, the 25th of November', 'for Saturday (November 25)',
    'Saturday afternoon, 25 November', 'Saturday 25.11', 'Saturday 25.11.2026', 'Saturday 25-11', 'Saturday 25/11', 'Saturday 2026-11-25',
    '📅 Saturday 25 November at 12:00', 'SATURDAY 25 NOVEMBER',
    'zaterdag 25 november', 'Zaterdag 25 November', 'zaterdag de 25e', 'zaterdag, 25 november', 'zaterdag (25 november)',
    'zaterdagochtend 25 november', 'zaterdagmiddag 25 nov', 'zaterdagavond 25 november', 'zaterdag 25-11', 'zaterdag 25-11-2026', 'zaterdag 25 nov. om 12.00 uur',
  ])('%j', (text) => {
    for (const lang of ['en', 'nl']) {
      expect(flags(text, { lang })).toEqual([expect.objectContaining({ date: '2026-11-25', weekday: 6, actual: 3, ok: false })]);
    }
  });

  test('a date that does not exist is a mismatch too', () => {
    expect(flags('Saturday 31 November')).toEqual([expect.objectContaining({ date: null, ok: false })]);
  });

  test('two-letter Dutch abbreviations count in a list row or button, never in a sentence', () => {
    expect(flags('za 25 nov', { lang: 'nl', shortField: true })).toEqual([expect.objectContaining({ date: '2026-11-25', ok: false })]);
    expect(flags('wo 25 nov', { lang: 'nl', shortField: true })).toEqual([]);
    expect(cal.findWeekdayDates('za 25 nov', new Date(), { lang: 'nl' })).toEqual([]);
    expect(cal.findWeekdayDates('do 25 Nov', new Date(), { lang: 'en', shortField: true })).toEqual([]);
  });

  // Sentences the check must leave alone: nothing is flagged, nothing is rewritten.
  test.each([
    ['a modal verb, not the month', 'Saturday 2 may work better for you both.'],
    ['a modal verb after an abbreviation', 'Sat 2 may be busy, Sunday is quieter.'],
    ['a time with a full stop', 'zaterdag 10.30 uur is nog vrij'],
    ['a time range', 'Saturday 10-12 is the quietest part of the day.'],
    ['a time, not 10 December', 'Saturday 10.12 is still free.'],
    ['a weekday and a time', 'Saturday at 12:00 or Sunday 9:00?'],
    ['a weekday and times on new lines', 'Saturday\n- 09:00\n- 12:00'],
    ['a weekday, a colon and times', 'Saturday: 11:50 or 13:35'],
    ['a number of people', 'Saturday 2 people can come, Sunday 3.'],
    ['an ordinal that is no date', 'Is Saturday your 1st choice?'],
    ['opening hours', 'Monday–Thursday 07:00–21:00 · Friday 07:00–20:00 · Saturday 09:00–20:00 · Sunday 09:00–18:00'],
    ['two sentences', 'We are open every Saturday. 25 November is fully booked.'],
    ['a birthday with its year', 'So you were born on Friday 6 February 1987 — happy birthday in advance!'],
    ['a birthday and a wish', 'My birthday is 25 November, so Saturday would be perfect.'],
    ['a promotion with dates', 'From now until 1 November, every 1 Month Pass comes with a personal training session. Saturday is the last day to sign up.'],
    ['a promotion period', 'The promotion runs from 19 October – 1 November 2026. Monday to Friday you can sign up at reception.'],
    ['a closure with years', 'Friday 25 December 2026 – Saturday 26 December 2026: closed (Christmas)'],
    ['a date and a choice of days', '25 November, Saturday and Sunday are full.'],
    ['another weekday after a correct pair', 'Sunday 29 November or Saturday?'],
    ['a correct pair after another weekday', 'Saturday or Sunday 29 November?'],
    ['two correct pairs', 'Saturday 28 November, Sunday 29 November'],
    ['a correct pair, date first', 'on 28 November (Saturday) at 12:00'],
    ['a correct range', 'Mon 30 Nov – Sun 6 Dec'],
    ['Black Friday', 'Black Friday 27 November'],
    ['the past tense of sit', 'I sat 2 hours in the sauna in November.'],
    ['round the clock', 'The app is there for you Monday to Sunday 24/7.'],
    ['a correct pair with its year', 'Saturday 28 November 2026 at 12:00'],
  ])('left alone — %s', (_, text) => {
    for (const lang of ['en', 'nl']) {
      expect(flags(text, { lang })).toEqual([]);
      expect(cal.correctWeekdays(text, new Date(), { lang })).toBe(text);
    }
    expect(checkReply(PHONE, { message: text, ui_type: 'none' }, {})).toBeNull();
    expect(correctReply(PHONE, { message: text, ui_type: 'none' }, {})).toEqual({ message: text, ui_type: 'none' });
  });

  test.each([
    'zo 1 dec kan ook', 'dat is zo 2 mei geregeld', 'ik kan do 26 nov', 'wat kan ik do 3 dec',
  ])('Dutch sentence left alone — %j', (text) => {
    expect(cal.findWeekdayDates(text, new Date(), { lang: 'nl' })).toEqual([]);
    expect(cal.correctWeekdays(text, new Date(), { lang: 'nl' })).toBe(text);
  });
});

describe('4b. the correction in code: the right weekday, or no weekday at all', () => {
  // Near today and a full name or English abbreviation: the weekday is replaced, in the form it was written.
  test.each([
    ['Saturday, 25th November: 09:00, 12:00', 'Wednesday, 25th November: 09:00, 12:00'],
    ['*Saturday* 25 November', '*Wednesday* 25 November'],
    ['SATURDAY 25 NOVEMBER', 'WEDNESDAY 25 NOVEMBER'],
    ['Sat, 25 Nov at 12:00', 'Wed, 25 Nov at 12:00'],
    ['Sat. 25 Nov', 'Wed. 25 Nov'],
    ['25 November (Saturday)', '25 November (Wednesday)'],
    ['zaterdagochtend 25 november', 'woensdagochtend 25 november'],
    ['Zaterdag 25 november om 12:00', 'Woensdag 25 november om 12:00'],
    ['You wrote Saturday 25 November, but Saturday 28 November is free too.', 'You wrote Wednesday 25 November, but Saturday 28 November is free too.'],
  ])('%j → %j', (text, fixed) => {
    expect(cal.correctWeekdays(text)).toBe(fixed);
    expect(flags(fixed)).toEqual([]);
  });

  // Anywhere the right weekday is less certain, the weekday word goes: a date without a weekday is never false.
  test.each([
    ['a visit seven weeks ago', 'Your last visit was on Friday 3 October.', 'Your last visit was on 3 October.', {}],
    ['a day more than half a year ahead', 'See you on Saturday 4 July!', 'See you on 4 July!', {}],
    ['a date that does not exist', 'Saturday 31 November at 10:00', '31 November at 10:00', {}],
    ['a two-letter Dutch abbreviation in a list row', 'za 25 nov · Lisa', '25 nov · Lisa', { lang: 'nl', shortField: true }],
    ['far ahead, in bold', '*Saturday* 4 July', '4 July', {}],
    ['far ahead, the whole day in bold', '*Saturday, 4 July*', '*4 July*', {}],
    ['far ahead, in brackets — "this" goes with the weekday', 'this Saturday (4 July) at 10:00', '4 July at 10:00', {}],
    ['far ahead, with an article', 'Saturday the 4th of July', 'the 4th of July', {}],
    ['a day number without its month: which month is a guess', 'Saturday the 25th at 12:00', 'the 25th at 12:00', {}],
    ['…also in Dutch', 'zaterdag de 25e om 12:00', 'de 25e om 12:00', { lang: 'nl' }],
    ['far ahead, date first', '4 July (Saturday) at 10:00', '4 July at 10:00', {}],
    ['far ahead, date first with a comma', 'on 4 July, Saturday.', 'on 4 July.', {}],
    ['far ahead, Dutch part of the day goes with it', 'zaterdagmiddag 4 juli', '4 juli', {}],
  ])('%s', (_, text, fixed, opts) => {
    expect(cal.correctWeekdays(text, new Date(), opts)).toBe(fixed);
  });
});

// ── 5. The turn of 23 Nov ────────────────────────────────────────────────────

describe('5. a wrong weekday does not reach the guest', () => {
  test('wrong label → refused once → the model checks Saturday → only the right message is sent', async () => {
    script(
      [check('a', '2026-11-25')],
      [respond('r1', WRONG)],
      [check('b', '2026-11-28', { weekday: 'saturday' })],
      [respond('r2', RIGHT)],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(sentTexts()).toEqual([RIGHT]);
    const refused = toolResults().r1;
    expect(refused).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(refused.message).toBe('NOT SENT — the weekday does not match the date. "Saturday, 25th November": 25 November 2026 is a Wednesday, not a Saturday. The coming Saturday is Saturday 28 November 2026 (2026-11-28). If the customer asked for the WEEKDAY, your date is wrong: call check_availability for the right date and show those times — the times you have now belong to Wednesday 25 November. If the customer asked for the DATE, write it with the weekday given here. If their own message mixes a weekday and a date that do not match, ask which one they mean and name both correct options. Then call respond again.');
    expect(toolResults().r2).toEqual({ sent: true });
    // What was not sent is not remembered as said — the wrong label can no longer feed itself.
    expect(saidByBot()).toEqual([RIGHT]);
    expect(db.logMessage.mock.calls.filter(c => c[1] === 'assistant').map(c => c[2])).toEqual([RIGHT]);
    expect(loggedErrors('weekday_mismatch_blocked')).toHaveLength(1);
    expect(loggedErrors('weekday_mismatch_blocked')[0][1]).toContain(PHONE);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(0);
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
  });

  test('…also when the new check and the new reply come in one model message', async () => {
    script(
      [check('a', '2026-11-25')],
      [respond('r1', WRONG)],
      [check('b', '2026-11-28', { weekday: 'saturday' }), respond('r2', RIGHT)],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(sentTexts()).toEqual([RIGHT]);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(0);
  });

  test('the model first tries the wrong date with the weekday: refused by check_availability, nothing fetched for Wednesday', async () => {
    script(
      [check('a', '2026-11-25', { weekday: 'saturday' })],
      [check('b', '2026-11-28', { weekday: 'saturday' })],
      [respond('r', RIGHT)],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(toolResults().a).toMatchObject({ error: 'weekday_mismatch' });
    expect(mindbody.getBookableItems).toHaveBeenCalledTimes(1);
    expect(mindbody.getBookableItems).toHaveBeenCalledWith(TAILORED_60, '2026-11-28', '2026-11-28');
    expect([...new Set(conversations.get(PHONE).offeredSlots.map(s => s.dateTime.slice(0, 10)))]).toEqual(['2026-11-28']);
    expect(sentTexts()).toEqual([RIGHT]);
  });

  test('a model that insists is corrected in code: the message that goes out is true, and that is what is stored', async () => {
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [respond('r2', WRONG)]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(sentTexts()).toEqual([WRONG_FIXED]);
    expect(toolResults().r2).toEqual({ sent: true });
    expect(saidByBot()).toEqual([WRONG_FIXED]);
    expect(db.logMessage.mock.calls.filter(c => c[1] === 'assistant').map(c => c[2])).toEqual([WRONG_FIXED]);
    expect(loggedErrors('weekday_mismatch_blocked')).toHaveLength(1);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(1);
    // Corrected, so nothing for the team to chase in the chat.
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
  });

  test('renaming the day without checking it: Wednesday\'s times never go out as "Saturday 28 November"', async () => {
    const renamed = WRONG.replace('Saturday, 25th November', 'Saturday 28 November');
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [respond('r2', renamed)]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(flags(renamed)).toEqual([]); // a correct pair in itself — over the wrong day's times
    expect(sentTexts()).toEqual([WRONG_FIXED]);
    expect(saidByBot()).toEqual([WRONG_FIXED]);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(1);
  });

  test('…the same in a list: rows of Wednesday\'s slots cannot be relabelled', async () => {
    const list = (day) => ({
      ui_type: 'list', list_button_label: 'View times',
      list_sections: [{ title: 'Available', rows: [
        { id: 'slot_2026-11-25T09:00:00_5_31', title: '09:00', description: `${day} · Lisa` },
        { id: 'slot_2026-11-25T12:00:00_7_31', title: '12:00', description: `${day} · Emma` },
      ] }],
    });
    script(
      [check('a', '2026-11-25')],
      [respond('r1', 'Here are the available times for Tailored Massage on Saturday 25 November:', list('Saturday 25 November'))],
      [respond('r2', 'Here are the available times for Tailored Massage on Saturday 28 November:', list('Saturday 28 November'))],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(whatsapp.sendList).toHaveBeenCalledTimes(1);
    const [, message, , sections] = whatsapp.sendList.mock.calls[0];
    expect(message).toBe('Here are the available times for Tailored Massage on Wednesday 25 November:');
    expect(sections[0].rows.map(r => r.description)).toEqual(['Wednesday 25 November · Lisa', 'Wednesday 25 November · Emma']);
  });

  test('a row that names another day than its own slot is refused, and corrected if the model insists', async () => {
    const reply = respond('r', 'Here are the available times for Tailored Massage:', {
      ui_type: 'list', list_button_label: 'View times',
      list_sections: [{ title: 'Available', rows: [{ id: 'slot_2026-11-25T09:00:00_5_31', title: '09:00', description: 'Saturday 28 November · Lisa' }] }],
    });
    script([{ ...reply, id: 'r1' }], [{ ...reply, id: 'r2' }]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(toolResults().r1.message).toMatch(/"Saturday 28 November".*slot.*Wednesday 25 November/);
    expect(whatsapp.sendList.mock.calls[0][3][0].rows[0].description).toBe('Wednesday 25 November · Lisa');
  });

  test('nothing was fetched for the refused date: a rewrite with the right date is simply sent', async () => {
    script(
      [respond('r1', 'Shall I check *Saturday* – 25 November for you?')],
      [respond('r2', 'Shall I check Saturday 28 November for you?')],
    );
    await agent.run(PHONE, 'Melanie', 'Saturday please');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(sentTexts()).toEqual(['Shall I check Saturday 28 November for you?']);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(0);
  });

  test('the guest asked for the date: the rewrite with the right weekday for it is sent', async () => {
    const dated = WRONG.replace('Saturday, 25th November', 'Wednesday 25 November');
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [respond('r2', dated)]);
    await agent.run(PHONE, 'Melanie', 'Tailored massage on the 25th');

    expect(sentTexts()).toEqual([dated]);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(0);
  });

  test('Dutch: "zaterdag 25 november" is refused and, if it comes back, sent as "woensdag 25 november"', async () => {
    const fout = 'Dit zijn de beschikbare tijden voor een Tailored Massage op zaterdag 25 november:\n\n09:00 en 12:00';
    script([check('a', '2026-11-25')], [respond('r1', fout, { detected_language: 'nl' })], [respond('r2', fout, { detected_language: 'nl' })]);
    await agent.run(PHONE, 'Melanie', 'Tailored massage zaterdag');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(sentTexts()).toEqual([fout.replace('zaterdag 25 november', 'woensdag 25 november')]);
  });

  test('a reply sent with a booking is corrected, not refused — and the booking runs once', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')]);
    script([
      call('b', 'book_appointment', { session_type_id: SAUNA_2P, start_date_time: '2026-11-25T14:15:00' }),
      respond('r', '✅ Finnish Sauna (2 people) is booked for Saturday 25 November at 14:15!\n\nNo online payment needed — please pay €80 at reception when you arrive. Would you like to add another treatment?', {
        ui_type: 'buttons', buttons: [{ id: 'cart_add_more', title: 'Add another treatment' }, { id: 'cart_done', title: "That's all" }],
      }),
    ]);
    await agent.run(PHONE, 'Melanie', 'Confirm');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(toolResults().b).toMatchObject({ success: true, dateLabel: 'Wednesday 25 November', dateTimeLabel: 'Wednesday 25 November at 14:15' });
    expect(toolResults().r).toEqual({ sent: true });
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendButtons.mock.calls[0][1]).toMatch(/^✅ Finnish Sauna \(2 people\) is booked for Wednesday 25 November at 14:15!/);
    expect(loggedErrors('weekday_mismatch_blocked')).toHaveLength(0);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(1);
  });

  test('a booking that was refused changes nothing: the reply after it can still be handed back', async () => {
    conversations.set(PHONE, { lang: 'en', hydrated: true, offeredSlots: [offer('2026-11-25T14:15:00')] }); // no Confirm tap yet
    script(
      [call('b', 'book_appointment', { session_type_id: SAUNA_2P, start_date_time: '2026-11-25T14:15:00' }), respond('r1', SUMMARY('📅 Saturday 25 November at 14:15'), CONFIRM_BUTTONS)],
      [respond('r2', SUMMARY('📅 Wednesday 25 November at 14:15'), CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', 'yes book it');

    expect(toolResults().b).toMatchObject({ error: 'confirmation_required' });
    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendButtons.mock.calls[0][1]).toContain('📅 Wednesday 25 November at 14:15');
  });

  test('the two-person payment chain still sends both messages, each corrected, links untouched', async () => {
    tools.toolBookAppointment
      .mockResolvedValueOnce({ success: true, booking_event_id: 1, requiresPayment: true, deferred: true })
      .mockResolvedValueOnce({ success: true, booking_event_id: 2, requiresPayment: true, deferred: true });
    const link = (id, who, url) => respond(id, `✅ Reserved for ${who} on Saturday 25 November at 12:00. Complete payment to confirm:`, { ui_type: 'cta_button', cta_label: 'Pay Now', cta_url: url });
    script(
      [
        call('b1', 'book_appointment', { session_type_id: 64, start_date_time: '2026-11-25T12:00:00', client_name: 'Melanie A', client_email: 'melanie@guest.fixture' }),
        call('b2', 'book_appointment', { session_type_id: 64, start_date_time: '2026-11-25T12:00:00', client_name: 'Anna B', client_email: 'anna@guest.fixture' }),
        link('r1', 'Melanie', 'https://pay.example.com/one'),
      ],
      [link('r2', 'Anna', 'https://pay.example.com/two')],
    );
    await agent.run(PHONE, 'Melanie', 'Confirm');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(tools.toolBookAppointment).toHaveBeenCalledTimes(2);
    expect(whatsapp.sendCTAButton.mock.calls).toEqual([
      [PHONE, '✅ Reserved for Melanie on Wednesday 25 November at 12:00. Complete payment to confirm:', 'Pay Now', 'https://pay.example.com/one'],
      [PHONE, '✅ Reserved for Anna on Wednesday 25 November at 12:00. Complete payment to confirm:', 'Pay Now', 'https://pay.example.com/two'],
    ]);
    expect(loggedErrors('weekday_mismatch_blocked')).toHaveLength(0);
  });

  test('a pay-first link made in this turn: the server\'s own message goes out untouched, and nothing is handed back', async () => {
    const serverText = 'To book *Tailored Massage 60 min* on Wednesday 25 November at 12:00 with Therapist Emma, please pay €130 via the link below.';
    tools.toolBookAppointment.mockImplementationOnce(async (from) => {
      conversations.update(from, { payFirstLinkPending: { rowId: 501, text: serverText, ctaLabel: 'Pay & book', url: 'https://checkout.stripe.com/c/pay/cs_test_m1' } });
      return { success: true, payFirst: true };
    });
    script([
      call('b', 'book_appointment', { session_type_id: TAILORED_60, start_date_time: '2026-11-25T12:00:00' }),
      respond('r', 'Here is your payment link for Saturday 25 November.', { ui_type: 'cta_button', cta_label: 'Pay', cta_url: 'https://checkout.stripe.com/c/pay/cs_test_m1' }),
    ]);
    await agent.run(PHONE, 'Melanie', 'Confirm & pay');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendCTAButton.mock.calls).toEqual([[PHONE, serverText, 'Pay & book', 'https://checkout.stripe.com/c/pay/cs_test_m1']]);
    expect(sentTexts()).toEqual([]);
  });

  test('a handoff in the same model message: the reply is corrected, the team is alerted once', async () => {
    script([
      call('h', 'request_human_handoff', { reason: 'Order of €150+ — arrange personally: Tailored Massage and Finnish Sauna for 2' }),
      respond('r', 'Our team will arrange your treatments for Saturday 25 November personally and get back to you here.'),
    ]);
    await agent.run(PHONE, 'Melanie', 'Confirm');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual(['Our team will arrange your treatments for Wednesday 25 November personally and get back to you here.']);
  });

  test('the model runs out of rounds after the refusal: the reply that was held back goes out corrected', async () => {
    const rounds = Array.from({ length: 6 }, (_, i) => [call(`g${i}`, 'check_gift_card', { gift_card_number: '12345' })]);
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], ...rounds);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(mockCreate).toHaveBeenCalledTimes(8);
    expect(sentTexts()).toEqual([WRONG_FIXED]);
    expect(saidByBot()).toEqual([WRONG_FIXED]);
  });

  test('plain text without a tool call is corrected as well', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Your massage is on Saturday 25 November at 12:00.', tool_calls: [] } }] });
    await agent.run(PHONE, 'Melanie', 'When is my massage?');

    // (This path also sends the loop's fallback text afterwards, as it did before; not pinned here.)
    expect(sentTexts()[0]).toBe('Your massage is on Wednesday 25 November at 12:00.');
    expect(sentTexts()).not.toContain('Your massage is on Saturday 25 November at 12:00.');
    expect(saidByBot()).toEqual(['Your massage is on Wednesday 25 November at 12:00.']);
  });

  test('website chat: the visitor gets the corrected reply too', async () => {
    script([respond('r1', 'We still have times on Saturday 25 November.')], [respond('r2', 'We still have times on Saturday 25 November.')]);
    const reply = await agent.runWeb('melanie', 'Do you have time on Saturday?');

    expect(reply.message).toBe('We still have times on Wednesday 25 November.');
    expect(conversations.getMessages('web_melanie').filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['We still have times on Wednesday 25 November.']);
  });

  test('the check itself never costs the guest an answer', () => {
    expect(checkReply(PHONE, undefined, {})).toBeNull();
    expect(checkReply(PHONE, { message: { not: 'a string' }, buttons: 'x', list_sections: [null, { rows: [null, 5] }] }, {})).toBeNull();
    expect(checkReply(PHONE, { message: WRONG }, null)).toMatchObject({ kind: 'weekday' });
    const odd = { message: 12, list_sections: 'none' };
    expect(correctReply(PHONE, odd, null)).toBe(odd);
    expect(correctReply(PHONE, undefined, {})).toBeUndefined();
    // A write tool did something in this turn: no objection (the loop corrects and sends).
    expect(checkReply(PHONE, { message: WRONG }, { wrote: true })).toBeNull();
  });
});

// ── 6. The confirmation summary and the booking ──────────────────────────────

describe('6. the guest confirms a day, and only that day is booked', () => {
  test('a summary without the day is refused once, with the line to write', async () => {
    conversations.set(PHONE, { lang: 'en', hydrated: true, offeredSlots: [offer('2026-11-25T14:15:00')] });
    script(
      [respond('r1', SUMMARY('📅 Saturday at 14:15'), CONFIRM_BUTTONS)],
      [respond('r2', SUMMARY('📅 Wednesday 25 November at 14:15'), CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', '14:15 please');

    const refused = toolResults().r1;
    expect(refused).toMatchObject({ sent: false, error: 'summary_needs_day' });
    expect(refused.message).toMatch(/^NOT SENT — a confirmation summary must name each booking's day as weekday \+ day \+ month/);
    expect(refused.message).toContain('"📅 Wednesday 25 November at 14:15"');
    expect(refused.message).toMatch(/same Confirm\/Cancel buttons/);
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendButtons.mock.calls[0][1]).toContain('📅 Wednesday 25 November at 14:15');
    expect(conversations.get(PHONE).confirmSummary).toEqual({ dates: ['2026-11-25'], at: Date.now() });
  });

  test('"Saturday the 28th" is not weekday + day + month either', async () => {
    script(
      [respond('r1', SUMMARY('📅 Saturday the 28th at 14:15'), CONFIRM_BUTTONS)],
      [respond('r2', SUMMARY('📅 Saturday 28 November at 14:15'), CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', '14:15 please');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'summary_needs_day' });
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-28']);
  });

  test('still no day: the summary is sent, but it stands for no day', async () => {
    script(
      [respond('r1', SUMMARY('📅 Saturday at 14:15'), CONFIRM_BUTTONS)],
      [respond('r2', SUMMARY('📅 Saturday at 14:15'), CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', '14:15 please');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(1);
    expect(conversations.get(PHONE).confirmSummary).toEqual({ dates: [], at: Date.now() });
  });

  test('the summary of 23 Nov: refused; if the model insists the guest reads "Wednesday 25 November" before confirming', async () => {
    script(
      [respond('r1', BOT_TEXTS_OF_23_NOV[4], CONFIRM_BUTTONS)],
      [respond('r2', BOT_TEXTS_OF_23_NOV[5], CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', 'Please book the massage at 12');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(whatsapp.sendButtons.mock.calls[0][1]).toContain('📅 Wednesday 25 November at 12:00');
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-25']);
  });

  test('a summary for several days stands for each of them; other buttons are no summary', async () => {
    script([respond('r', 'Please confirm your booking:\n\n✅ Float Journey\n📅 Saturday 28 November at 14:45\n\n✅ Finnish Sauna\n📅 Sunday 29 November at 12:45\n\nShall I confirm this booking?', CONFIRM_BUTTONS)]);
    await agent.run(PHONE, 'Melanie', 'both please');
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-28', '2026-11-29']);

    conversations.clear(PHONE);
    script([respond('r', 'When would you like your massage?', { ui_type: 'buttons', buttons: [{ id: 'date_today', title: 'Today' }, { id: 'date_other', title: 'Other date' }] })]);
    await agent.run(PHONE, 'Melanie', 'a massage');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(conversations.get(PHONE).confirmSummary).toBeUndefined();
  });

  test('the day she confirmed is booked', async () => {
    tapConfirm([offer('2026-11-28T14:15:00')], { confirmSummary: { dates: ['2026-11-28'], at: Date.now() } });
    const r = await bookSauna('2026-11-28T14:15:00');
    expect(r).toMatchObject({ success: true, dateLabel: 'Saturday 28 November', dateTimeLabel: 'Saturday 28 November at 14:15' });
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
  });

  test('another day than the one she confirmed is not booked, and the Confirm is spent', async () => {
    // She read "Saturday 28 November"; the slot the model books is Wednesday's.
    tapConfirm([offer('2026-11-25T14:15:00')], { confirmSummary: { dates: ['2026-11-28'], at: Date.now() } });
    const r = await bookSauna('2026-11-25T14:15:00');

    expect(r.error).toBe('confirmed_day_differs');
    expect(r.message).toBe('STOP: the summary the customer confirmed was for Saturday 28 November 2026, but this call books Wednesday 25 November 2026. Nothing was booked. Show a new confirmation summary with the day written exactly as "Wednesday 25 November" and book only after a fresh Confirm — or, if the customer wants Saturday 28 November, check availability for that day first.');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(conversations.get(PHONE)).toMatchObject({ bookingConfirmedAt: null, bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
    // The same tap books nothing else either.
    expect((await bookSauna('2026-11-25T14:15:00')).error).toBe('confirmation_required');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('right after slot_not_offered the same Confirm no longer books the other day', async () => {
    // Only Wednesday was ever fetched; the summary she confirmed said Saturday 28.
    tapConfirm([offer('2026-11-25T14:15:00')], { confirmSummary: { dates: ['2026-11-28'], at: Date.now() } });
    const first = await bookSauna('2026-11-28T14:15:00');
    expect(first.error).toBe('slot_not_offered');
    expect(first.message).toMatch(/WAS offered on 2026-11-25/);

    const second = await bookSauna('2026-11-25T14:15:00');
    expect(second.error).toBe('confirmed_day_differs');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('a summary that named no day confirms no day', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')], { confirmSummary: { dates: [], at: Date.now() } });
    const r = await bookSauna('2026-11-25T14:15:00');
    expect(r.error).toBe('confirmed_day_differs');
    expect(r.message).toMatch(/^STOP: the summary the customer confirmed did not name the day, and this call books Wednesday 25 November 2026\. Nothing was booked\./);
    expect(r.message).toContain('"Wednesday 25 November"');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('in a Dutch chat the label to write is Dutch', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')], { lang: 'nl', confirmSummary: { dates: ['2026-11-28'], at: Date.now() } });
    const r = await bookSauna('2026-11-25T14:15:00');
    expect(r.message).toContain('written exactly as "woensdag 25 november"');
  });

  test('state lost (restart, 30 minutes of silence, an older chat): a late Confirm books as before', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')]); // no confirmSummary in memory
    const r = await bookSauna('2026-11-25T14:15:00');
    expect(r.success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
  });

  test('the whole way: summary for Saturday 28, Confirm, a booking call for Wednesday 25 → nothing booked', async () => {
    conversations.set(PHONE, { lang: 'en', hydrated: true, offeredSlots: [offer('2026-11-25T14:15:00'), offer('2026-11-28T14:15:00')] });
    script([respond('r', SUMMARY('📅 Saturday 28 November at 14:15'), CONFIRM_BUTTONS)]);
    await agent.run(PHONE, 'Melanie', '14:15 on Saturday');
    // The handler's Confirm-tap effect.
    conversations.set(PHONE, { bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0 });

    script(
      [call('b', 'book_appointment', { session_type_id: SAUNA_2P, start_date_time: '2026-11-25T14:15:00' })],
      [respond('r2', SUMMARY('📅 Wednesday 25 November at 14:15'), CONFIRM_BUTTONS)],
    );
    await agent.run(PHONE, 'Melanie', 'Confirm');

    expect(toolResults().b).toMatchObject({ error: 'confirmed_day_differs' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-25']);
  });
});

// ── 7. What reaches the team ─────────────────────────────────────────────────

describe('7. a day forwarded to the team comes with a date check — and is never held back', () => {
  const ORDER = 'Order of €150+ — arrange personally: Tailored Massage for 1 at 12:00 and Finnish Sauna for 2 at 14:15 on Saturday 25 November';
  const NOTE = 'Request received Monday 23 November 2026. Date check: 25 November 2026 is a Wednesday, not a Saturday — please confirm the day with the guest.';

  /** The HTML the REAL email templates produce (this file mocks the service; the mail transport is captured here). */
  async function renderedEmails(send) {
    const posts = [];
    let real;
    process.env.MS_TENANT_ID = 'tenant'; process.env.MS_CLIENT_ID = 'client'; process.env.MS_CLIENT_SECRET = 'secret';
    jest.isolateModules(() => {
      jest.doMock('axios', () => ({ post: jest.fn(async (url, body) => { posts.push(body); return { data: { access_token: 'x', expires_in: 3600 } }; }) }));
      real = jest.requireActual('../src/services/email.service');
    });
    try {
      await send(real);
    } finally {
      jest.dontMock('axios');
      delete process.env.MS_TENANT_ID; delete process.env.MS_CLIENT_ID; delete process.env.MS_CLIENT_SECRET;
    }
    return posts.filter(body => body?.message).map(body => body.message.body.content);
  }

  test('handoff: the reason goes out as written, with the note next to it', async () => {
    const r = await tools.toolHumanHandoff(PHONE, 'Melanie', { reason: ORDER });
    expect(r).toEqual({ sent: true });
    expect(email.sendEscalationEmail).toHaveBeenCalledWith({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, message: ORDER, dateNote: NOTE });
    expect(db.logEscalation.mock.calls).toEqual([
      [PHONE, 'Melanie', 'human_handoff', ORDER],
      [PHONE, 'Melanie', 'date_check', NOTE],
    ]);
  });

  test('gift card: a weekday without a date gets the dates it can mean; the repeat check still compares the request itself', async () => {
    const r = await tools.toolForwardGiftCard(PHONE, 'Melanie', { gift_card_number: 'GC-123', treatment: 'Tailored Massage', preferred_day: 'next Saturday, before the sauna' });
    expect(r).toEqual({ sent: true });
    const note = 'Request received Monday 23 November 2026. No date was given for "Saturday": it can be Saturday 28 November 2026 or Saturday 5 December 2026 — please confirm the day with the guest.';
    expect(email.sendGiftCardRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ preferredDay: 'next Saturday, before the sauna', dateNote: note }));
    const detail = 'Gift card GC-123 | Tailored Massage | next Saturday, before the sauna';
    expect(db.hasRecentTeamNotification).toHaveBeenCalledWith(PHONE, 'gift_card_request', expect.any(Number), detail);
    expect(db.logEscalation.mock.calls).toEqual([
      [PHONE, 'Melanie', 'gift_card_request', detail],
      [PHONE, 'Melanie', 'date_check', note],
    ]);
  });

  test('a weekday that is today: today and next week', async () => {
    await tools.toolForwardGiftCard(PHONE, 'Melanie', { gift_card_number: 'GC-123', treatment: 'Facial', preferred_day: 'Monday' });
    expect(email.sendGiftCardRequestEmail.mock.calls[0][0].dateNote).toBe('Request received Monday 23 November 2026. No date was given for "Monday": it can be Monday 23 November 2026 (today) or Monday 30 November 2026 — please confirm the day with the guest.');
  });

  test('reschedule: a wrong pair is noted; a right one, or no day at all, adds nothing', async () => {
    await tools.toolForwardReschedule(PHONE, 'Melanie', { new_date: 'Saturday 25 November, afternoon', treatment: 'Float Journey' });
    expect(email.sendRescheduleRequestEmail).toHaveBeenLastCalledWith(expect.objectContaining({ newDate: 'Saturday 25 November, afternoon', dateNote: NOTE }));
    expect(db.hasRecentTeamNotification).toHaveBeenLastCalledWith(PHONE, 'reschedule_request', expect.any(Number), 'New: Saturday 25 November, afternoon | Float Journey');

    await tools.toolForwardReschedule(PHONE, 'Melanie', { new_date: 'Saturday 28 November, afternoon', treatment: 'Float Journey' });
    expect(email.sendRescheduleRequestEmail.mock.calls[1][0]).not.toHaveProperty('dateNote');

    await tools.toolHumanHandoff(PHONE, 'Melanie', { reason: 'running late' });
    expect(email.sendEscalationEmail).toHaveBeenLastCalledWith({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, message: 'running late' });
    expect(db.logEscalation.mock.calls.filter(c => c[2] === 'date_check')).toHaveLength(1);
  });

  test('a repeat that is suppressed sends no second note', async () => {
    db.hasRecentTeamNotification.mockResolvedValue(true);
    const again = await tools.toolForwardReschedule(PHONE, 'Melanie', { new_date: 'Saturday 25 November, afternoon', treatment: 'Float Journey' });
    expect(again).toMatchObject({ sent: true, already_sent: true });
    expect(db.logEscalation).not.toHaveBeenCalled();
    expect(email.sendRescheduleRequestEmail).not.toHaveBeenCalled();
  });

  test('cancel_appointments: the cancellation goes through, the email to the team carries the note', async () => {
    conversations.set(PHONE, { lang: 'en', userName: 'Melanie', cancelConfirmedAt: Date.now(), knownAppointments: { 9001: { serviceName: 'Finnish Sauna' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], service_name: 'Finnish Sauna', date_time: 'Saturday 25 November at 14:15' });
    expect(r.cancelled).toEqual([9001]);
    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(9001);
    expect(email.sendCancellationNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({ dateTime: 'Saturday 25 November at 14:15', dateNote: NOTE }));
    expect(db.logEscalation.mock.calls).toEqual([[PHONE, 'Melanie', 'date_check', NOTE]]);
  });

  test('the emails show the note, and look as before without one', async () => {
    const [handoff, gift, moved, cancelled, plain] = await renderedEmails(async (real) => {
      await real.sendEscalationEmail({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, message: ORDER, dateNote: NOTE });
      await real.sendGiftCardRequestEmail({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, giftCardNumber: 'GC-123', treatment: 'Tailored Massage', preferredDay: 'Saturday 25 November', dateNote: NOTE });
      await real.sendRescheduleRequestEmail({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, newDate: 'Saturday 25 November', treatment: 'Float Journey', dateNote: NOTE });
      await real.sendCancellationNotificationEmail({ customerName: 'Melanie', customerPhone: PHONE, serviceName: 'Finnish Sauna', dateTime: 'Saturday 25 November at 14:15', dateNote: NOTE });
      await real.sendEscalationEmail({ customerName: 'Melanie', customerPhone: PHONE, customerEmail: null, message: 'running late' });
    });
    for (const html of [handoff, gift, moved, cancelled]) {
      expect(html).toContain('Date check: 25 November 2026 is a Wednesday, not a Saturday');
      expect(html).toContain('Request received Monday 23 November 2026.');
      expect(html).not.toMatch(/null|undefined/);
    }
    expect(handoff).toContain('on Saturday 25 November'); // the reason itself is not rewritten
    expect(plain).not.toMatch(/Date check|Request received|null|undefined/);
  });

  test('through the loop: the handoff and the gift-card forward of 23 Nov are not refused, and both carry the note', async () => {
    script([
      call('h', 'request_human_handoff', { reason: ORDER }),
      respond('r', 'Our team will arrange everything personally and reach out to you here.'),
    ]);
    await agent.run(PHONE, 'Melanie', 'Confirm');
    expect(toolResults().h).toEqual({ sent: true });
    expect(email.sendEscalationEmail.mock.calls[0][0].dateNote).toBe(NOTE);

    script([
      call('g', 'forward_gift_card_request', { gift_card_number: 'GC-123', treatment: 'Tailored Massage', preferred_day: 'Saturday 25 November at 12:00' }),
      respond('r', 'Thanks! I\'ve sent your gift-card booking request to our team.'),
    ]);
    await agent.run(PHONE, 'Melanie', 'I would like to pay with a gift card');
    expect(toolResults().g).toEqual({ sent: true });
    expect(email.sendGiftCardRequestEmail.mock.calls[0][0].dateNote).toBe(NOTE);
  });
});

// ── 8. Found in review ───────────────────────────────────────────────────────
// Each case below was reproduced by a reviewer of the first version of this
// fix: a correct sentence rewritten into a false one by code, a wrong pair
// that still went out, or a correct reply that was thrown away.

describe('8. found in review', () => {
  // A weekday that ends a range or a list is not the weekday of the date
  // after it; a date followed by ", Saturday, …" is a list, not a pair.
  test.each([
    'Our winter programme runs Monday to Friday, 30 November to 4 December.',
    'I have slots on 25 November, Saturday, and Monday.',
    'Open Monday–Friday 30 November – 4 December.',
    'van maandag t/m vrijdag, 30 november t/m 4 december',
    'Both Saturday and Sunday, 28 November and 29 November, are free.',
    'Friday through Sunday, 27 November through 29 November',
    'So not 25 November – Saturday?',
    'Promotion until 2 November – Saturday, Sunday and holidays included.',
    // counters and US-style numbers are no dates; a numbered list item is no day
    'Yes — Saturday 12/5 at 11:50 is free.',
    'Times for Saturday (1/2):',
    'Saturday 2/2 guests confirmed',
    'Saturday:\n1. April – 09:00',
    // a day number without its month that was right for this or last month
    'Thanks for visiting us yesterday, Sunday the 22nd.',
    'Your treatment was last Saturday the 21st.',
    // rules no test held in place before
    'Saturday 1st floor.',
    'Saturday 1st timers are welcome.',
    'We have Saturday 28 November, Sunday at 10:00 too.',
  ])('left alone — %j', (text) => {
    for (const lang of ['en', 'nl']) {
      expect(flags(text, { lang })).toEqual([]);
      expect(cal.correctWeekdays(text, new Date(), { lang })).toBe(text);
    }
    expect(correctReply(PHONE, { message: text, ui_type: 'none' }, {})).toEqual({ message: text, ui_type: 'none' });
  });

  // Two days that share one month: each day is checked with that month.
  test.each([
    ['Saturday 25 and Sunday 26 November', 'Wednesday 25 and Thursday 26 November', {}],
    ['zaterdag 25 en zondag 26 november', 'woensdag 25 en donderdag 26 november', { lang: 'nl' }],
    ['Monday 24 – Friday 28 November', 'Tuesday 24 – Saturday 28 November', {}],
    ['Sat 25 / Sun 26 Nov', 'Wed 25 / Thu 26 Nov', {}],
  ])('one month for two days — %j → %j', (text, fixed, opts) => {
    expect(flags(text, opts)).toHaveLength(2);
    expect(cal.correctWeekdays(text, new Date(), opts)).toBe(fixed);
    expect(flags(fixed, opts)).toEqual([]);
  });

  test('…and a correct pair of that kind counts for both days in a summary', async () => {
    expect(cal.findWeekdayDates('📅 Saturday 28 and Sunday 29 November at 10:00').map(h => [h.date, h.ok])).toEqual([['2026-11-28', true], ['2026-11-29', true]]);
    script([respond('r', 'Please confirm your booking:\n\n✅ Finnish Sauna\n📅 Saturday 28 and Sunday 29 November at 10:00\n\nShall I confirm this booking?', CONFIRM_BUTTONS)]);
    await agent.run(PHONE, 'Melanie', 'both days at 10');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-28', '2026-11-29']);
  });

  // Wrong pairs written in forms the first version did not see.
  test.each([
    'Saturday 25 November', 'Saturday 25 November', '25 November at 12:00 (Saturday)', 'on the 25th (Saturday)',
    'Saturday · 25 November', 'Saturday | 25 November', '25 November is a Saturday.', 'Saturday is the 25th of November.',
    'zaterdag a.s. 25 november', '25 november is een zaterdag.',
  ])('also seen — %j', (text) => {
    expect(flags(text)).toEqual([expect.objectContaining({ date: '2026-11-25', weekday: 6, ok: false })]);
  });

  // Where code cannot be sure of the right weekday it removes the word — and
  // what it belonged to: the part of the day and "this" / "a" / "next".
  test.each([
    ['See you Saturday afternoon, 4 July!', 'See you 4 July!', {}],
    ['Tot zaterdagmiddag 4 juli!', 'Tot 4 juli!', { lang: 'nl' }],
    ['It is on Saturday morning the 25th.', 'It is on the 25th.', {}],
    ['Tot zaterdagochtend de 25e!', 'Tot de 25e!', { lang: 'nl' }],
    ['I booked you in for a Saturday, 4 July.', 'I booked you in for 4 July.', {}],
    ['See you next Saturday, 4 July!', 'See you 4 July!', {}],
    // right for last year's 2 May: code does not write "Sunday" over it
    ['your gift card was bought on Saturday 2 May.', 'your gift card was bought on 2 May.', {}],
  ])('removed cleanly — %j → %j', (text, fixed, opts) => {
    expect(cal.correctWeekdays(text, new Date(), opts)).toBe(fixed);
  });

  test('a day number without its month is read as the day this turn checked', () => {
    expect(cal.findWeekdayDates('I have these times on Friday the 1st', new Date(), { knownDays: ['2027-01-01'] })).toEqual([expect.objectContaining({ date: '2027-01-01', ok: true })]);
    expect(cal.correctWeekdays('Saturday the 25th: 09:00, 12:00', new Date(), { knownDays: new Set(['2026-11-25']) })).toBe('Wednesday the 25th: 09:00, 12:00');
  });

  test('…so the guest who asked for Saturday is still told it is a Wednesday', async () => {
    const text = 'Here are the times for Saturday the 25th: 09:00, 12:00';
    script([check('a', '2026-11-25')], [respond('r1', text)], [respond('r2', text)]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');
    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(sentTexts()).toEqual(['Here are the times for Wednesday the 25th: 09:00, 12:00']);
  });

  test('a long run of spaces, tabs or marks after a weekday is scanned in linear time', () => {
    jest.useRealTimers();
    const now = new Date('2026-11-23T15:12:00');
    for (const filler of [' ', '\t', '*']) {
      const text = `for Saturday${filler.repeat(3000)}x`;
      const t0 = process.hrtime.bigint();
      cal.findWeekdayDates(text, now);
      cal.correctWeekdays(text, now);
      expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(100);
    }
  });

  test('the calendar reads today on the local clock, also between midnight and 02:00 and on both clock-change nights', () => {
    for (const [at, first] of [
      ['2026-11-24T00:30:00', 'Tuesday 24 November 2026 = 2026-11-24 (today)'],
      ['2026-10-25T00:30:00', 'Sunday 25 October 2026 = 2026-10-25 (today; this weekend)'],
      ['2027-03-28T00:30:00', 'Sunday 28 March 2027 = 2027-03-28 (today; this weekend)'],
    ]) {
      const now = new Date(at);
      expect(cal.calendarLines(now)[0]).toBe(first);
      const today = first.split(' = ')[1].slice(0, 10);
      expect(cal.findWeekdayDates(`${cal.dayLabel(today, 'en', { now })} at 10:00`, now)).toEqual([expect.objectContaining({ date: today, ok: true })]);
    }
  });

  // Every field of a reply is checked and corrected, not only the message and the row description.
  test.each([
    ['a button title', (d) => ({ message: 'Which day?', ui_type: 'buttons', buttons: [{ id: 'd1', title: d }] }), (a) => a.buttons[0].title],
    ['the list button', (d) => ({ message: 'Pick a time', ui_type: 'list', list_button_label: d, list_sections: [{ title: 'Times', rows: [{ id: 'x', title: '09:00' }] }] }), (a) => a.list_button_label],
    ['a section title', (d) => ({ message: 'Pick a time', ui_type: 'list', list_button_label: 'View', list_sections: [{ title: d, rows: [{ id: 'x', title: '09:00' }] }] }), (a) => a.list_sections[0].title],
    ['a row title', (d) => ({ message: 'Pick a time', ui_type: 'list', list_button_label: 'View', list_sections: [{ title: 'Times', rows: [{ id: 'x', title: d }] }] }), (a) => a.list_sections[0].rows[0].title],
  ])('a wrong pair in %s', (_, build, field) => {
    expect(checkReply(PHONE, build('Sat 25 Nov'), {})).toMatchObject({ kind: 'weekday', error: 'weekday_mismatch' });
    expect(field(correctReply(PHONE, build('Sat 25 Nov'), {}))).toBe('Wed 25 Nov');
    expect(checkReply(PHONE, build('Sat 28 Nov'), {})).toBeNull();
  });

  test('two-letter Dutch counts in a list field when the reply is Dutch, also in a chat stored as English', () => {
    conversations.set(PHONE, { lang: 'en' });
    const list = (rowTitle, message = 'Kies een tijd') => ({ message, ui_type: 'list', detected_language: 'nl', list_button_label: 'Bekijk', list_sections: [{ title: 'Tijden', rows: [{ id: 'x', title: rowTitle }] }] });
    expect(checkReply(PHONE, list('za 25 nov 09:00'), {})).toMatchObject({ kind: 'weekday' });
    expect(correctReply(PHONE, list('za 25 nov 09:00'), {}).list_sections[0].rows[0].title).toBe('25 nov 09:00');
    expect(checkReply(PHONE, list('09:00', 'Kan za 25 nov ook?'), {})).toBeNull();
    expect(checkReply(PHONE, { ...list('za 25 nov 09:00'), detected_language: 'en' }, {})).toBeNull();
  });

  test('a slot row put right in code keeps its time inside the 24 characters of a row title, and its marks', async () => {
    const reply = (id) => respond(id, 'Here are the available times for Tailored Massage:', {
      ui_type: 'list', list_button_label: 'View times',
      list_sections: [{ title: 'Available', rows: [
        { id: 'slot_2026-11-25T09:00:00_5_31', title: 'Sat 28 Nov · 09:00' },
        { id: 'slot_2026-11-25T12:00:00_7_31', title: '*Sat 28 Nov* · 12:00' },
      ] }],
    });
    script([reply('r1')], [reply('r2')]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(whatsapp.sendList.mock.calls[0][3][0].rows.map(r => r.title)).toEqual(['Wed 25 Nov · 09:00', '*Wed 25 Nov* · 12:00']);
  });

  // The retry rule decides on the days this turn fetched.
  test('a list whose rows were refused for their own slot\'s day: the rewrite with that day is sent', async () => {
    const list = (day) => ({
      ui_type: 'list', list_button_label: 'View times',
      list_sections: [{ title: 'Available', rows: [
        { id: 'slot_2026-11-25T09:00:00_5_31', title: '09:00', description: `${day} · Lisa` },
        { id: 'slot_2026-11-25T12:00:00_7_31', title: '12:00', description: `${day} · Emma` },
      ] }],
    });
    script(
      [check('a', '2026-11-25')],
      [respond('r1', 'Here are the available times for Tailored Massage on Saturday 28 November:', list('Saturday 28 November'))],
      [respond('r2', 'Here are the available times for Tailored Massage on Wednesday 25 November:', list('Wednesday 25 November'))],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    const [, message, , sections] = whatsapp.sendList.mock.calls[0];
    expect(message).toBe('Here are the available times for Tailored Massage on Wednesday 25 November:');
    expect(sections[0].rows.map(r => r.description)).toEqual(['Wednesday 25 November · Lisa', 'Wednesday 25 November · Emma']);
  });

  test('two days fetched: the rewrite that puts the second day right is sent, and the refusal does not say whose times they are', async () => {
    const wrong = 'Here are the times for Tailored Massage this weekend:\n\nSaturday 28 November: 11:50, 13:35\nSunday 28 November: 10:00';
    const right = 'Here are the times for Tailored Massage this weekend:\n\nSaturday 28 November: 11:50, 13:35\nSunday 29 November: 10:00';
    script(
      [call('a', 'check_availability', { session_type_ids: [TAILORED_60], start_date: '2026-11-28', end_date: '2026-11-29' })],
      [respond('r1', wrong)],
      [respond('r2', right)],
    );
    await agent.run(PHONE, 'Melanie', 'A tailored massage this weekend');

    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(toolResults().r1.message).not.toContain('the times you have now belong to');
    expect(sentTexts()).toEqual([right]);
  });

  test('a new check of the same day does not let a renamed day through', async () => {
    const renamed = WRONG.replace('Saturday, 25th November', 'Saturday 28 November');
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [check('b', '2026-11-25')], [respond('r2', renamed)]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday, please');
    expect(sentTexts()).toEqual([WRONG_FIXED]);
  });

  test('a check refused for its weekday fetched nothing: the rewrite with the right day is sent', async () => {
    script([check('a', '2026-11-25', { weekday: 'saturday' })], [respond('r1', 'We still have times on Saturday 25 November.')], [respond('r2', 'Saturday 28 November at 11:50 or 13:35?')]);
    await agent.run(PHONE, 'Melanie', 'Saturday please');
    expect(toolResults().r1).toMatchObject({ sent: false, error: 'weekday_mismatch' });
    expect(sentTexts()).toEqual(['Saturday 28 November at 11:50 or 13:35?']);
  });

  test('the question the refusal suggests — which day do you mean? — is sent, it offers no times', async () => {
    const question = 'Just to be sure: do you mean Wednesday 25 November or Saturday 28 November?';
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [respond('r2', question)]);
    await agent.run(PHONE, 'Melanie', 'A tailored massage on Saturday the 25th please');
    expect(sentTexts()).toEqual([question]);
  });

  test('a rename written together with a handoff is sent: a write tool ran, the reply is only corrected', async () => {
    const renamed = 'Our team will arrange your treatments for Saturday 28 November at 11:50 personally.';
    script([check('a', '2026-11-25')], [respond('r1', WRONG)], [call('h', 'request_human_handoff', { reason: 'Guest wants a journey, arrange personally' }), respond('r2', renamed)]);
    await agent.run(PHONE, 'Melanie', 'Can your team arrange it?');
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual([renamed]);
  });

  test('the model call after a refusal fails: the reply that was held back goes out, put right — not "Something went wrong"', async () => {
    const outage = require('../src/services/outage-alert.service');
    outage.recordAgentFailure.mockResolvedValueOnce({ kind: 'other', notifyCustomer: true, outage: false });
    conversations.set(PHONE, { lang: 'en', hydrated: true, offeredSlots: [offer('2026-11-25T14:15:00')] });
    mockCreate.mockReset();
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [respond('r1', SUMMARY('📅 Saturday 25 November at 14:15'), CONFIRM_BUTTONS)] } }] })
      .mockRejectedValueOnce(new Error('429 rate limited'));
    await agent.run(PHONE, 'Melanie', '14:15 please');

    expect(sentTexts()).toEqual([]);
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendButtons.mock.calls[0][1]).toContain('📅 Wednesday 25 November at 14:15');
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-25']);
  });

  test('a summary with one day written in full and one without its date is handed back', async () => {
    const summary = 'Please confirm your booking:\n\n✅ Finnish Sauna\n📅 Saturday 28 November at 14:15\n\n✅ Finnish Sauna\n📅 Sunday at 12:45\n\nShall I confirm this booking?';
    script([respond('r1', summary, CONFIRM_BUTTONS)], [respond('r2', summary.replace('📅 Sunday at 12:45', '📅 Sunday 29 November at 12:45'), CONFIRM_BUTTONS)]);
    await agent.run(PHONE, 'Melanie', 'both please');
    expect(toolResults().r1).toMatchObject({ sent: false, error: 'summary_needs_day' });
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-28', '2026-11-29']);
  });

  test('a summary held back until the turn ran out is remembered when it goes out', async () => {
    const rounds = Array.from({ length: 7 }, (_, i) => [call(`g${i}`, 'check_gift_card', { gift_card_number: '12345' })]);
    script([respond('r1', SUMMARY('📅 Saturday 25 November at 14:15'), CONFIRM_BUTTONS)], ...rounds);
    await agent.run(PHONE, 'Melanie', '14:15 please');
    expect(whatsapp.sendButtons.mock.calls[0][1]).toContain('📅 Wednesday 25 November at 14:15');
    expect(conversations.get(PHONE).confirmSummary.dates).toEqual(['2026-11-25']);
  });

  test('a model text that is not sent (pay-first link pending) is not logged as corrected', async () => {
    const serverText = 'To book *Tailored Massage 60 min* on Wednesday 25 November at 12:00 with Therapist Emma, please pay €130 via the link below.';
    tools.toolBookAppointment.mockImplementationOnce(async (from) => {
      conversations.update(from, { payFirstLinkPending: { rowId: 501, text: serverText, ctaLabel: 'Pay & book', url: 'https://checkout.stripe.com/c/pay/cs_test_m1' } });
      return { success: true, payFirst: true };
    });
    script([
      call('b', 'book_appointment', { session_type_id: TAILORED_60, start_date_time: '2026-11-25T12:00:00' }),
      respond('r', 'Here is your payment link for Saturday 25 November.', { ui_type: 'cta_button', cta_label: 'Pay', cta_url: 'https://checkout.stripe.com/c/pay/cs_test_m1' }),
    ]);
    await agent.run(PHONE, 'Melanie', 'Confirm & pay');
    expect(whatsapp.sendCTAButton.mock.calls).toEqual([[PHONE, serverText, 'Pay & book', 'https://checkout.stripe.com/c/pay/cs_test_m1']]);
    expect(loggedErrors('weekday_mismatch_autocorrected')).toHaveLength(0);
  });

  // Labels: the model reads the chat language, the Stripe line item keeps its old form.
  test('the cart keeps the Stripe label as before and carries the chat-language label next to it', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')]);
    await bookSauna('2026-11-25T14:15:00');
    expect(conversations.get(PHONE).pendingBookings[0]).toMatchObject({ date_time_label: 'woensdag 25 november at 14:15', when_label: 'Wednesday 25 November at 14:15' });
  });

  test('a repeated booking call answers with the chat-language label', async () => {
    tapConfirm([offer('2026-11-25T14:15:00')]);
    db.getRecentBooking.mockResolvedValueOnce({ id: 70, mindbody_appointment_id: 9001, status: 'paid', customer_name: null });
    const r = await bookSauna('2026-11-25T14:15:00');
    expect(r).toMatchObject({ already_booked: true, dateLabel: 'Wednesday 25 November', date_time_label: 'Wednesday 25 November at 14:15' });
  });

  test('class schedules are labelled in the chat language', async () => {
    mindbody.getClasses = jest.fn().mockResolvedValue([{ Id: 1, StartDateTime: '2026-11-25T12:00:00', MaxCapacity: 10, TotalBooked: 1, ClassDescription: { Name: 'Yoga', SessionType: { Id: 83 } } }]);
    conversations.set(PHONE, { lang: 'en' });
    expect((await tools.toolCheckClassSchedule(PHONE, { session_type_ids: [83], start_date: '2026-11-25', end_date: '2026-11-25' })).classes[0].dateLabel).toBe('Wednesday 25 November');
    conversations.set(PHONE, { lang: 'nl' });
    expect((await tools.toolCheckClassSchedule(PHONE, { session_type_ids: [83], start_date: '2026-11-25', end_date: '2026-11-25' })).classes[0].dateLabel).toBe('woensdag 25 november');
  });

  test('a class booking: the Stripe line item keeps its old label, the model reads the chat language', async () => {
    const paymentService = require('../src/services/payment.service');
    const link = jest.spyOn(paymentService, 'createPaymentLink').mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_c1', sessionId: 'cs_test_c1' });
    mindbody.addClientToClass = jest.fn().mockResolvedValue({ Id: 1 });
    conversations.set(PHONE, { lang: 'en', hydrated: true });
    try {
      const r = await tools.toolBookClass(PHONE, { class_id: 4242, session_type_id: 83, class_name: 'Yoga', class_date_time: '2026-11-25T12:00:00', client_email: 'melanie@guest.fixture' });
      expect(link).toHaveBeenCalledWith(expect.objectContaining({ dateTime: 'woensdag 25 november at 12:00' }));
      expect(r).toMatchObject({ dateLabel: 'Wednesday 25 November' });
    } finally {
      link.mockRestore();
    }
  });

  // What the team gets: candidate dates only for a day that is asked for.
  test('a handoff reason about something past, a range or Black Friday gets no candidate dates', async () => {
    for (const reason of [
      'Guest lost a ring in the sauna last Saturday and asks whether it was found.',
      'Customer asks whether we are open Monday to Friday during Christmas.',
      'Question about Black Friday offers',
      'Guest was charged twice on Friday',
    ]) {
      email.sendEscalationEmail.mockClear();
      db.logEscalation.mockClear();
      await tools.toolHumanHandoff(PHONE, 'Melanie', { reason });
      expect(email.sendEscalationEmail.mock.calls[0][0]).not.toHaveProperty('dateNote');
      expect(db.logEscalation.mock.calls.filter(c => c[2] === 'date_check')).toEqual([]);
    }
    await tools.toolHumanHandoff(PHONE, 'Melanie', { reason: 'Guest wants a journey next Friday, arrange personally' });
    expect(email.sendEscalationEmail.mock.calls.pop()[0].dateNote).toContain('No date was given for "Friday": it can be Friday 27 November 2026 or Friday 4 December 2026');
  });

  test('a cancellation by id with a weekday and no date adds no note', async () => {
    conversations.set(PHONE, { lang: 'en', userName: 'Melanie', cancelConfirmedAt: Date.now(), knownAppointments: { 9001: { serviceName: 'Finnish Sauna' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], service_name: 'Finnish Sauna', date_time: 'Saturday at 14:15' });
    expect(r.cancelled).toEqual([9001]);
    expect(email.sendCancellationNotificationEmail.mock.calls[0][0]).not.toHaveProperty('dateNote');
    expect(db.logEscalation).not.toHaveBeenCalled();
  });

  test('a treatment limited to certain days: the prompt points at the calendar instead of having the model work out the weekday', () => {
    const prompt = buildSystemPrompt(PHONE, 'Melanie');
    const rules = prompt.split('\n').filter(l => /if it is not a \w+, do NOT call check_availability/i.test(l));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toMatch(/Look the requested date up in the Session calendar; if it is not a/);
  });
});
