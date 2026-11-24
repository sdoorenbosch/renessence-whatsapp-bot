// Regression for "Tara" (19 Nov 2026): the evening before her visit she asked
// the bot to confirm two treatments each for herself and her husband. The team
// had booked one each, both at 09:00. get_appointments returned two rows named
// "Treatment" (the name was read from apt.SessionType.Name, which the
// appointments endpoint does not return); the bot answered that it "seems to
// be" what she described and pointed at an email address. The couple arrived
// expecting four treatments. Nobody on the team was alerted.
//
// The team (Fabiana): "the information provided was correct, but the action
// taken did not match what had been communicated."
//
// Each block pins one part of the fix:
//  1. names come from the session type id (the bot's catalog, then Mindbody's
//     own list), never "Treatment"; an unknown one is said to be unknown
//  2. the list is complete: cancelled rows are not appointments and last
//     week's visits never push tomorrow off the list
//  3. after a lookup the SERVER's own list is what the guest sees; when it
//     cannot confirm what the guest described the team is flagged and mailed
//     by code (once), without the model having to hand off
//  4. the cancel flow and a plain "what have I booked?" keep working
//  5. website chat and Dutch texts
//
// Mock rows have the FLAT layout the live endpoint returns (SessionTypeId,
// StaffId, ClientId, Status, StartDateTime, EndDateTime, Notes — no
// SessionType, Client or Staff object). One test uses the nested layout.

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
  getAllClientsByPhone: jest.fn().mockResolvedValue([]),
  getClientByPhone: jest.fn().mockResolvedValue(null),
  searchClientByName: jest.fn().mockResolvedValue(null),
  getStaffAppointments: jest.fn().mockResolvedValue([]),
  getSessionTypeNames: jest.fn().mockResolvedValue({}),
  cancelAppointment: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/pay-first.service', () => ({
  ...jest.requireActual('../src/services/pay-first.service'),
  closeOpenCheckoutsForHandoff: jest.fn().mockResolvedValue([]),
}));
// A small stand-in for the escalations table: the cooldown check sees what
// was logged before it.
const mockEscalations = [];
jest.mock('../src/data/database', () => ({
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  logError: jest.fn().mockResolvedValue(true),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  getBookingEventById: jest.fn().mockResolvedValue(null),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  markConversationEscalated: jest.fn(),
  setNeedsReply: jest.fn(),
  getConversationStatus: jest.fn().mockResolvedValue(null),
  setConversationLanguage: jest.fn().mockResolvedValue(),
  hasRecentTeamNotification: jest.fn(async (phone, reason) => mockEscalations.some(e => e.phone === phone && e.reason === reason)),
  logEscalation: jest.fn(async (phone, name, reason, message) => { mockEscalations.push({ phone, reason, message }); }),
  getGuestContact: jest.fn().mockResolvedValue(null),
  getGuestTypedTexts: jest.fn().mockResolvedValue([]),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const email = require('../src/services/email.service');
const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');
const agent = require('../src/agents/renessence.agent');
const { TOOLS } = require('../src/agents/tool-definitions');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { checkReply, correctReply } = require('../src/agents/reply-guards');

const PHONE = '31600000124';
const WEB = 'web_tara';
const EMAIL = 'tara@guest.fixture';
const CLIENT = { Id: '100000111', FirstName: 'Tara', LastName: 'Guest', Email: EMAIL };

// Flat rows, as the live endpoint returns them.
const flat = (id, start, sessionTypeId, extra = {}) => ({
  Id: id, Status: 'Booked', StartDateTime: start, EndDateTime: start.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, '0')}`),
  SessionTypeId: sessionTypeId, StaffId: 11, ClientId: CLIENT.Id, Notes: '', ...extra,
});
// What the team booked for 20 Nov: one lymphatic drainage and one facial, both at 09:00.
const MASSAGE = flat(9001, '2026-11-20T09:00:00', 37);
const FACIAL = flat(9002, '2026-11-20T09:00:00', 41);
// Her mother's appointments, cancelled on 4 Nov.
const CANCELLED = [
  flat(8001, '2026-11-20T11:00:00', 37, { Status: 'Cancelled' }),
  flat(8002, '2026-11-20T12:15:00', 41, { Status: 'LateCancelled' }),
  flat(8003, '2026-11-20T13:30:00', 41, { Status: 'NoShow' }),
];

// What she wrote at 21:33, and what the bot answered at 21:34.
const HER_WORDS = 'tomorrow I have two lymphatic drainage followed by two facials for me and my husband';
const REPLY_OF_19_NOV = 'I see that you have two treatments scheduled for tomorrow at 09:00. However, I don\'t have specific details about which treatments these are. Based on what you shared, it seems to be a lymphatic drainage followed by a facial for both you and your husband.\n\nIf you believe there\'s an error or wish to double-check, feel free to reach out to welcome@renessence.com for confirmation or adjustments.';

const COUNT_LINE = 'That is 2 appointments in total. 2 of them start at the same time (09:00). I can only see this one profile, so I can\'t tell who each appointment is for.';
const NEEDS_TEAM_WA = 'I can\'t confirm from this that everything you described is booked, so I\'ve asked my colleagues to check. They\'ll reply here on WhatsApp. If you haven\'t heard from us before your visit, please check at reception when you arrive.';
const NEEDS_TEAM_WEB = 'I can\'t confirm from this that everything you described is booked, so I\'ve asked my colleagues to check. They will email you at the address you gave. If you haven\'t heard from us before your visit, please check at reception when you arrive.';
const SHOWN = 'If that\'s not what you expected, tell me what is different and I\'ll ask my colleagues to check.';
const LIST_OF_20_NOV = [
  'Here is everything our booking system shows under your profile (Tara G.):',
  '• Friday 20 November, 09:00 — Lymphatic Drainage 60 min',
  '• Friday 20 November, 09:00 — Renewal Facial',
].join('\n');
const OVERVIEW_OF_20_NOV = `${LIST_OF_20_NOV}\n\n${COUNT_LINE}\n\n${NEEDS_TEAM_WA}`;

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const respond = (id, message, extra = {}) => call(id, 'respond', { message, ui_type: 'none', detected_language: 'en', ...extra });
function script(...toolCallBatches) {
  mockCreate.mockReset();
  for (const batch of toolCallBatches) {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: batch } }] });
  }
}
function toolResults() {
  const msgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
  return Object.fromEntries(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content)]));
}
const sentTexts = () => whatsapp.sendText.mock.calls.map(c => c[1]);
const lookUp = (args, from = PHONE) => tools.toolGetAppointments(from, { client_email: EMAIL, ...args });
const HER_CHECK = { customer_expects: HER_WORDS, expected_date: '2026-11-20', expected_count: 4, expected_other_people: true };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 10, 19, 21, 34, 7)); // Thu 19 Nov 2026, 21:34 Amsterdam
  jest.clearAllMocks();
  mockEscalations.length = 0;
  conversations.clear(PHONE);
  conversations.clear(WEB);
  conversations.set(PHONE, { lang: 'en' });
  db.query.mockImplementation(async () => ({ rows: [] }));
  mindbody.getAllClientsByPhone.mockResolvedValue([]);
  mindbody.getClientByPhone.mockResolvedValue(CLIENT);
  mindbody.getSessionTypeNames.mockResolvedValue({});
  mindbody.getStaffAppointments.mockResolvedValue([MASSAGE, FACIAL, ...CANCELLED]);
  db.getPayFirstRowsForPhone.mockResolvedValue([]);
  db.logEscalation.mockImplementation(async (phone, name, reason, message) => { mockEscalations.push({ phone, reason, message }); });
});
afterEach(() => jest.useRealTimers());

// ── 1. Names ─────────────────────────────────────────────────────────────────

describe('1. every appointment is named from its session type, never "Treatment"', () => {
  test('flat rows get their names from the session type id', async () => {
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments.map(a => a.serviceName)).toEqual(['Lymphatic Drainage 60 min', 'Renewal Facial']);
    expect(JSON.stringify(r)).not.toMatch(/"Treatment"/);
    expect(r.profile).toBe('Tara G.');
    expect(r.count_upcoming).toBe(2);
  });

  test('a session type the bot does not sell is named from Mindbody\'s own list', async () => {
    mindbody.getSessionTypeNames.mockResolvedValue({ 620: 'Couples Ritual' });
    mindbody.getStaffAppointments.mockResolvedValue([flat(9010, '2026-11-20T09:00:00', 620)]);
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments[0].serviceName).toBe('Couples Ritual');
    expect(conversations.get(PHONE).lookupReply.text).toContain('• Friday 20 November, 09:00 — Couples Ritual');
  });

  test('a session type nobody knows is listed as booked by our team, never guessed', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([flat(9011, '2026-11-20T09:00:00', 620)]);
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments[0].serviceName).toBeNull();
    expect(r.instruction).toMatch(/serviceName null/);
    expect(conversations.get(PHONE).lookupReply.text).toContain('• Friday 20 November, 09:00 — a treatment booked by our team (I can\'t see its name)');
  });

  test('Mindbody\'s name list failing never stops a lookup', async () => {
    mindbody.getSessionTypeNames.mockRejectedValue(new Error('timeout'));
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments.map(a => a.id)).toEqual([9001, 9002]);
  });

  test('the nested layout (SessionType object) is read as well', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([
      { Id: 9020, StartDateTime: '2026-11-20T09:00:00', SessionType: { Id: 41, Name: 'Orchid Stem Cell Facial' } },
      { Id: 9021, StartDateTime: '2026-11-20T10:00:00', SessionType: { Name: 'Hydrowave Massage' } },
    ]);
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments.map(a => a.serviceName)).toEqual(['Renewal Facial', 'Hydrowave Massage']);
  });

  test('a booking the bot made for someone else says who it is for', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([flat(9030, '2026-11-20T09:00:00', 37, { Notes: '📱 WhatsApp Bot | For: Sam (sam@guest.fixture)' })]);
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments[0].forPerson).toBe('Sam');
    expect(conversations.get(PHONE).lookupReply.text).toContain('• Friday 20 November, 09:00 — Lymphatic Drainage 60 min (for Sam)');
  });
});

// ── 2. The list is complete ──────────────────────────────────────────────────

describe('2. the list is everything the booking system shows', () => {
  test('cancelled and no-show rows are not appointments', async () => {
    const r = await lookUp({ customer_expects: '' });
    expect(r.appointments.map(a => a.id)).toEqual([9001, 9002]);
    expect(conversations.get(PHONE).lookupReply.text).not.toMatch(/11:00|12:15|13:30/);
  });

  test('last week\'s visits never push tomorrow off the list', async () => {
    const lastWeek = Array.from({ length: 12 }, (_, i) => flat(7000 + i, `2026-11-1${3 + (i % 6)}T${String(9 + Math.floor(i / 6)).padStart(2, '0')}:00:00`, 58));
    mindbody.getStaffAppointments.mockResolvedValue([...lastWeek, MASSAGE, FACIAL]);
    const r = await lookUp({ customer_expects: '' });
    // Only the most recent past visit is kept (as before: isPast), then every upcoming one.
    expect(r.appointments.map(a => a.id)).toEqual([7011, 9001, 9002]);
    expect(r.appointments[0]).toMatchObject({ isPast: true });
    expect(r.count_upcoming).toBe(2);
  });

  test('nothing upcoming: the guest is told so, by the server', async () => {
    mindbody.getStaffAppointments.mockResolvedValue(CANCELLED);
    const r = await lookUp(HER_CHECK);
    expect(r.check).toBe('needs_team');
    expect(conversations.get(PHONE).lookupReply.text).toBe(`Our booking system shows no upcoming appointments under your profile (Tara G.).\n\n${NEEDS_TEAM_WA}`);
  });
});

// ── 3. The evening of 19 Nov ─────────────────────────────────────────────────

describe('3. what the guest describes is compared in code, and the server\'s list goes out', () => {
  test('four expected, two shown: the guest gets the system\'s own list and the team is flagged and emailed once', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, ...HER_CHECK })],
      [respond('r', REPLY_OF_19_NOV)],
    );
    await agent.run(PHONE, 'Tara', EMAIL);

    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
    const sent = sentTexts()[0];
    expect(sent).not.toMatch(/followed by|seems|@/);
    // What the model saw: a complete, named list and the verdict.
    expect(toolResults().g).toMatchObject({ check: 'needs_team', server_reply: true, count_upcoming: 2, profile: 'Tara G.' });
    expect(toolResults().g.instruction).toMatch(/your text is not sent/);
    // The team: flagged and mailed by code, without a handoff call.
    expect(db.markConversationEscalated).toHaveBeenCalledWith(PHONE, `Booking check: guest expects "${HER_WORDS}" — Mindbody shows 2`);
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    const mail = email.sendEscalationEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ customerPhone: PHONE });
    expect(mail.message).toMatch(/^BOOKING CHECK — VISIT WITHIN 24 HOURS: guest wrote "tomorrow I have two lymphatic/);
    expect(mail.message).toMatch(/#9001 2026-11-20 09:00–10:00 Lymphatic Drainage 60 min; #9002 2026-11-20 09:00–10:00 Renewal Facial/);
    expect(mail.message).toMatch(/Why flagged: .*expects 4.*shows 2/);
    expect(db.logEscalation).toHaveBeenCalledWith(PHONE, expect.any(String), 'booking_check', mail.message);
    // What is remembered as said is what went out.
    expect(conversations.getMessages(PHONE).filter(m => m.role === 'assistant').map(m => m.content)).toEqual([OVERVIEW_OF_20_NOV]);
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', OVERVIEW_OF_20_NOV);
  });

  test('the model miscounts (2): her husband in her words still sends it to the team', async () => {
    const r = await lookUp({ customer_expects: HER_WORDS, expected_date: '2026-11-20', expected_count: 2 });
    expect(r.check).toBe('needs_team');
    expect(conversations.get(PHONE).lookupReply).toMatchObject({ mustReplace: true });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('the companion words count in Dutch too', async () => {
    const r = await lookUp({ customer_expects: 'morgen een massage voor mij en mijn man', expected_date: '2026-11-20', expected_count: 2 });
    expect(r.check).toBe('needs_team');
  });

  test('the expectation survives the "what is your email?" round', async () => {
    const first = await tools.toolGetAppointments(PHONE, HER_CHECK);
    expect(first.status).toBe('ask_for_details');
    // Two messages later the model passes only the address.
    const r = await lookUp({ customer_expects: '' });
    expect(r.check).toBe('needs_team');
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('…but not for ever: after 15 minutes it is a new question', async () => {
    await tools.toolGetAppointments(PHONE, HER_CHECK);
    jest.advanceTimersByTime(16 * 60 * 1000);
    conversations.update(PHONE, {}); // the chat is still open
    const r = await lookUp({ customer_expects: '' });
    expect(r.check).toBe('not_requested');
  });

  test('a wrong date from the model cannot hide tomorrow\'s appointments', async () => {
    const r = await lookUp({ customer_expects: 'my two treatments on Friday', expected_date: '2026-11-27', expected_count: 2 });
    expect(r.check).toBe('needs_team');
    expect(conversations.get(PHONE).lookupReply.text).toContain(LIST_OF_20_NOV);
  });

  test('what the guest describes and the list agree: shown, not "matches" — and the team is not bothered', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([flat(9100, '2026-11-20T10:00:00', 58)]);
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: 'my float tomorrow at 10', expected_date: '2026-11-20', expected_count: 1 })],
      [respond('r', 'Yes, your float is confirmed for tomorrow at 10:00!')],
    );
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(toolResults().g.check).toBe('shown');
    expect(sentTexts()).toEqual([[
      'Here is everything our booking system shows under your profile (Tara G.):',
      '• Friday 20 November, 10:00 — Float Journey',
      '',
      'That is 1 appointment in total. I can only see this one profile, so I can\'t tell who each appointment is for.',
      '',
      SHOWN,
    ].join('\n')]);
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('two lookups in one turn alert the team once', async () => {
    script(
      [call('g1', 'get_appointments', { client_email: EMAIL, ...HER_CHECK }), call('g2', 'get_appointments', { client_email: EMAIL, ...HER_CHECK })],
      [respond('r', REPLY_OF_19_NOV)],
    );
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
  });

  test('the turn ends without a reply: the list still goes out, not "No availability"', async () => {
    script(...Array.from({ length: 8 }, (_, i) => [call(`g${i}`, 'get_appointments', { client_email: EMAIL, ...HER_CHECK })]));
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
  });

  test('"not found" no longer sends the guest to an email address', async () => {
    mindbody.getClientByPhone.mockResolvedValue(null);
    const r = await lookUp(HER_CHECK);
    expect(r.status).toBe('not_found');
    expect(r.instruction).toMatch(/request_human_handoff/);
    expect(r.instruction).toMatch(/Do not send them to an email address/);
    expect(r.instruction).not.toMatch(/@/);
  });

  test('the server\'s list passes the weekday check as it is', async () => {
    await lookUp(HER_CHECK);
    const text = conversations.get(PHONE).lookupReply.text;
    expect(checkReply(PHONE, { message: text, ui_type: 'none' }, {})).toBeNull();
    expect(correctReply(PHONE, { message: text, ui_type: 'none' }, {}).message).toBe(text);
  });
});

// ── 4. What keeps working ────────────────────────────────────────────────────

describe('4. the cancel flow and a plain lookup', () => {
  const CONFIRM_CANCEL = {
    message: 'Are you sure you want to cancel Lymphatic Drainage 60 min on Friday 20 November at 09:00?',
    ui_type: 'buttons',
    buttons: [{ id: 'confirm_cancel', title: 'Yes, cancel it' }, { id: 'keep_appointment', title: 'No, keep it' }],
  };

  test('cancel flow untouched: an empty customer_expects leaves the confirm_cancel buttons as written', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', CONFIRM_CANCEL.message, { ui_type: 'buttons', buttons: CONFIRM_CANCEL.buttons })],
    );
    await agent.run(PHONE, 'Tara', 'cancel my massage');
    expect(whatsapp.sendButtons).toHaveBeenCalledWith(PHONE, CONFIRM_CANCEL.message, CONFIRM_CANCEL.buttons);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(toolResults().g.check).toBe('not_requested');
    expect(toolResults().g.server_reply).toBeUndefined();
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
  });

  test('a plain lookup sends the system\'s list before the model\'s own sentence', async () => {
    const MODEL = 'Is there anything you would like to change?';
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', MODEL)],
    );
    await agent.run(PHONE, 'Tara', 'what have I booked?');
    expect(sentTexts()).toEqual([`${LIST_OF_20_NOV}\n\n${COUNT_LINE}`, MODEL]);
    expect(conversations.getMessages(PHONE).filter(m => m.role === 'assistant').map(m => m.content)).toEqual([`${LIST_OF_20_NOV}\n\n${COUNT_LINE}`, MODEL]);
  });

  test('the same list is not sent twice within ten minutes', async () => {
    for (const text of ['what have I booked?', 'and tomorrow?']) {
      script([call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })], [respond('r', 'Anything else?')]);
      await agent.run(PHONE, 'Tara', text);
    }
    expect(sentTexts()).toEqual([`${LIST_OF_20_NOV}\n\n${COUNT_LINE}`, 'Anything else?', 'Anything else?']);
  });

  test('a lookup from an earlier turn is never sent in a later one', async () => {
    await lookUp({ customer_expects: '' });
    script([respond('r', 'Hello again!')]);
    await agent.run(PHONE, 'Tara', 'hi');
    expect(sentTexts()).toEqual(['Hello again!']);
  });

  test('get_appointments no longer runs in the parallel read-only group', () => {
    const src = require('fs').readFileSync(require.resolve('../src/agents/renessence.agent'), 'utf8');
    const readOnly = src.match(/const READ_ONLY = new Set\(\[([^\]]*)\]\)/)[1];
    expect(readOnly).not.toMatch(/get_appointments/);
  });
});

// ── 5. Website chat and Dutch ────────────────────────────────────────────────

describe('5. website chat and Dutch', () => {
  test('web chat gets the email sentence, not the WhatsApp one', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, ...HER_CHECK })],
      [respond('r', REPLY_OF_19_NOV)],
    );
    const reply = await agent.runWeb('tara', EMAIL);
    expect(reply).toMatchObject({ message: `${LIST_OF_20_NOV}\n\n${COUNT_LINE}\n\n${NEEDS_TEAM_WEB}`, ui_type: 'text' });
    expect(reply.message).not.toMatch(/WhatsApp/);
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: WEB, customerEmail: EMAIL }));
    expect(email.sendEscalationEmail.mock.calls[0][0].message).toMatch(/told the team will email them/);
  });

  test('Dutch texts', async () => {
    conversations.set(PHONE, { lang: 'nl' });
    await lookUp({ customer_expects: 'morgen twee lymfedrainages en twee gezichtsbehandelingen voor mij en mijn man', expected_date: '2026-11-20', expected_count: 4 });
    expect(conversations.get(PHONE).lookupReply.text).toBe([
      'Dit is alles wat ons boekingssysteem laat zien onder jouw profiel (Tara G.):',
      '• vrijdag 20 november, 09:00 — Lymphatic Drainage 60 min',
      '• vrijdag 20 november, 09:00 — Renewal Facial',
      '',
      'Dat zijn 2 afspraken in totaal. 2 daarvan beginnen op hetzelfde tijdstip (09:00). Ik zie alleen dit ene profiel en kan dus niet zien voor wie elke afspraak is.',
      '',
      'Ik kan hiermee niet bevestigen dat alles wat je beschrijft geboekt is, dus ik heb mijn collega\'s gevraagd het na te kijken. Zij reageren hier via WhatsApp. Heb je vóór je bezoek nog niets gehoord, vraag het dan even na bij de receptie.',
    ].join('\n'));
  });

  test('Dutch: one appointment, a name nobody knows, nothing upcoming, the shown ending', async () => {
    conversations.set(PHONE, { lang: 'nl' });
    mindbody.getStaffAppointments.mockResolvedValue([flat(9011, '2026-11-20T09:00:00', 620)]);
    await lookUp({ customer_expects: '' });
    expect(conversations.get(PHONE).lookupReply.text).toBe([
      'Dit is alles wat ons boekingssysteem laat zien onder jouw profiel (Tara G.):',
      '• vrijdag 20 november, 09:00 — een behandeling die door ons team is geboekt (de naam kan ik niet zien)',
      '',
      'Dat is 1 afspraak in totaal. Ik zie alleen dit ene profiel en kan dus niet zien voor wie elke afspraak is.',
    ].join('\n'));

    mindbody.getStaffAppointments.mockResolvedValue([flat(9100, '2026-11-20T10:00:00', 58)]);
    await lookUp({ customer_expects: 'mijn float morgen om 10 uur', expected_date: '2026-11-20', expected_count: 1 });
    expect(conversations.get(PHONE).lookupReply.text).toMatch(/\n\nKlopt dit niet met wat je verwachtte\? Laat me weten wat er anders is, dan vraag ik mijn collega's het na te kijken\.$/);

    mindbody.getStaffAppointments.mockResolvedValue([]);
    await lookUp({ customer_expects: '' });
    expect(conversations.get(PHONE).lookupReply.text).toBe('Ons boekingssysteem laat geen komende afspraken zien onder jouw profiel (Tara G.).');
  });
});

// ── 6. The words the model gets ──────────────────────────────────────────────

describe('6. tool definition and prompt', () => {
  test('get_appointments asks for the guest\'s own words, and the server treats a missing value as ""', () => {
    const def = TOOLS.find(t => t.function.name === 'get_appointments').function;
    expect(def.parameters.required).toEqual(['customer_expects']);
    expect(Object.keys(def.parameters.properties)).toEqual(expect.arrayContaining(['customer_expects', 'expected_date', 'expected_count', 'expected_other_people']));
    expect(def.description).toMatch(/server-built, complete list/);
  });

  test('the lookup section says: only what is in the list, and no email address for a missing booking', () => {
    const p = buildSystemPrompt(PHONE, 'Tara');
    const section = p.slice(p.indexOf('## Looking up appointments'), p.indexOf('## Cancellation flow'));
    expect(section).toMatch(/never add, merge, split, rename or infer an appointment/);
    expect(section).toMatch(/customer_expects/);
    expect(section).toMatch(/call request_human_handoff so the team checks and replies here/);
    expect(section).not.toMatch(/welcome@renessence\.com/);
  });
});

// ── 7. After review ──────────────────────────────────────────────────────────

describe('7. found in review', () => {
  const outage = require('../src/services/outage-alert.service');
  const overviewLib = require('../src/agents/appointment-overview');
  const PF_AWAITING = { id: 501, status: 'awaiting_payment', service_name: 'Deep Tissue Massage 60 min', pay_first: { startDateTime: '2026-11-20T10:00:00' } };

  test('a pay-first booking still waiting for payment is listed with its link — not "nothing booked, wait for the team"', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([]);
    db.getPayFirstRowsForPhone.mockResolvedValue([PF_AWAITING]);
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: 'is my massage tomorrow at 10 booked?', expected_date: '2026-11-20', expected_count: 1 })],
      [respond('r', 'Your massage is waiting for payment: please use the link.')],
    );
    await agent.run(PHONE, 'Tara', 'is my massage tomorrow at 10 booked?');
    expect(toolResults().g.check).toBe('shown');
    expect(sentTexts()).toEqual([[
      'Our booking system shows no upcoming appointments under your profile (Tara G.).',
      '',
      'Waiting for your payment, not booked yet:',
      '• Friday 20 November, 10:00 — Deep Tissue Massage 60 min',
      'Please use the payment link I sent to secure it.',
      '',
      SHOWN,
    ].join('\n')]);
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('a paid pay-first booking that is being made is listed too, and the team note names it', async () => {
    db.getPayFirstRowsForPhone.mockResolvedValue([{ ...PF_AWAITING, status: 'booking' }]);
    await lookUp(HER_CHECK);
    const { text } = conversations.get(PHONE).lookupReply;
    expect(text).toContain('Paid, the booking is being made now (you\'ll get a confirmation here):\n• Friday 20 November, 10:00 — Deep Tissue Massage 60 min');
    expect(email.sendEscalationEmail.mock.calls[0][0].message).toMatch(/Pay-first, not in Mindbody yet: 2026-11-20 10:00 Deep Tissue Massage 60 min \(paid, booking in progress\)/);
  });

  test('the model leaves customer_expects empty, but her own message names her husband: the team checks', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', REPLY_OF_19_NOV)],
    );
    await agent.run(PHONE, 'Tara', `I'm just confirming that ${HER_WORDS} ${EMAIL}`);
    expect(toolResults().g.check).toBe('needs_team');
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('…and her words are kept through the "what is your email?" round even when the model passed none', async () => {
    script(
      [call('g', 'get_appointments', { customer_expects: '' })],
      [respond('r', 'Could you share the email address you used when you booked?')],
    );
    await agent.run(PHONE, 'Tara', `I'm just confirming that ${HER_WORDS}`);
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', REPLY_OF_19_NOV)],
    );
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(sentTexts()).toEqual(['Could you share the email address you used when you booked?', OVERVIEW_OF_20_NOV]);
  });

  test('a cancel request that mentions another person keeps its own flow', async () => {
    const buttons = [{ id: 'confirm_cancel', title: 'Yes, cancel it' }, { id: 'keep_appointment', title: 'No, keep it' }];
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', 'Cancel Lymphatic Drainage 60 min on Friday 20 November at 09:00?', { ui_type: 'buttons', buttons })],
    );
    await agent.run(PHONE, 'Tara', 'please cancel our massage tomorrow, my husband is ill');
    expect(toolResults().g.check).toBe('not_requested');
    expect(whatsapp.sendButtons).toHaveBeenCalledWith(PHONE, 'Cancel Lymphatic Drainage 60 min on Friday 20 November at 09:00?', buttons);
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('more than 10 upcoming: the guest is told these are the first 10 of 12, and the 12th day still counts', async () => {
    mindbody.getStaffAppointments.mockResolvedValue(Array.from({ length: 12 }, (_, i) => flat(9200 + i, `2026-12-${String(i + 1).padStart(2, '0')}T10:00:00`, 58)));
    const r = await lookUp({ customer_expects: 'my float on 12 December', expected_date: '2026-12-12', expected_count: 1 });
    expect(r.check).toBe('shown');
    expect(r.count_upcoming).toBe(12);
    const { text } = conversations.get(PHONE).lookupReply;
    expect(text).toMatch(/^Here are the first 10 of the 12 upcoming appointments our booking system shows under your profile \(Tara G\.\):\n/);
    expect(text).toContain('\n\nThese are the first 10 of your 12 upcoming appointments. I can only see this one profile');
    expect(text).not.toMatch(/everything|in total/);
  });

  test('a guest writing Dutch for the first time gets the list in Dutch', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: 'morgen twee behandelingen voor mij en mijn man', expected_date: '2026-11-20', expected_count: 4 })],
      [respond('r', 'Ik kijk het na.', { detected_language: 'nl' })],
    );
    await agent.run(PHONE, 'Tara', `Ik wil bevestigen: morgen twee behandelingen voor mij en mijn man. ${EMAIL}`);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toMatch(/^Dit is alles wat ons boekingssysteem laat zien onder jouw profiel \(Tara G\.\):\n• vrijdag 20 november, 09:00 — Lymphatic Drainage 60 min\n/);
    expect(sentTexts()[0]).toMatch(/Zij reageren hier via WhatsApp\./);
  });

  test('the model call fails after a needs_team lookup: the guest gets the list, not "Something went wrong"', async () => {
    script([call('g', 'get_appointments', { client_email: EMAIL, ...HER_CHECK })]);
    mockCreate.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    outage.recordAgentFailure.mockResolvedValueOnce({ kind: 'other', notifyCustomer: true, outage: false });
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
  });

  test('needs_team replaces a buttons reply as well', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, ...HER_CHECK })],
      [respond('r', 'Shall I confirm both of you?', { ui_type: 'buttons', buttons: [{ id: 'yes', title: 'Yes' }] })],
    );
    await agent.run(PHONE, 'Tara', EMAIL);
    expect(whatsapp.sendButtons).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
  });

  test('a cancel that ran in the same turn keeps the model\'s explanation (a shown lookup does not replace it)', async () => {
    mindbody.getStaffAppointments.mockResolvedValue([flat(9100, '2026-11-20T10:00:00', 58)]);
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: 'my float tomorrow at 10', expected_date: '2026-11-20', expected_count: 1 })],
      [call('c', 'cancel_appointments', { appointment_ids: [9100], is_reschedule: false, is_within_24h: true, service_name: 'Float Journey', date_time: '2026-11-20T10:00:00' })],
      [respond('r', 'I need your confirmation before I cancel anything.')],
    );
    await agent.run(PHONE, 'Tara', 'cancel my float tomorrow at 10');
    expect(sentTexts()).toEqual(['I need your confirmation before I cancel anything.']);
  });

  test('needs_team and a payment link made in the same turn: the list goes first, the link still goes out', async () => {
    await lookUp(HER_CHECK);
    await tools.executeRespond(PHONE, { message: 'Here is your payment link.', ui_type: 'cta_button', cta_label: 'Pay', cta_url: 'https://pay.example.test/x' }, { wroteThisTurn: true });
    expect(sentTexts()).toEqual([OVERVIEW_OF_20_NOV]);
    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
  });

  test('a plain lookup tells the model the list goes out before its reply, so it does not repeat it', async () => {
    const plain = await lookUp({ customer_expects: '' });
    expect(plain.instruction).toMatch(/the server sends the customer this list right before your reply: do not repeat the list/);
    const checked = await lookUp(HER_CHECK);
    expect(checked.instruction).not.toMatch(/do not repeat the list/);
    expect(checked.instruction).toMatch(/your text is not sent/);
  });

  test('the server treats a missing customer_expects as ""', async () => {
    const r = await lookUp({});
    expect(r.check).toBe('not_requested');
  });

  test('companion words: "our", "onze", "both", "me and Sam", "hubby" all go to the team', () => {
    mindbody.getStaffAppointments.mockResolvedValue([]);
    const ov = overviewLib.buildOverview([flat(1, '2026-11-25T09:00:00', 37), flat(2, '2026-11-25T09:00:00', 41)], { now: new Date(), lang: 'en' });
    for (const words of [
      'our two treatments tomorrow at 9', 'can you confirm our massages tomorrow', 'onze twee behandelingen morgen om 9 uur',
      'kun je onze afspraken van morgen bevestigen', 'both treatments tomorrow, one each', 'a massage and a facial tomorrow for me and Sam',
      'me and my hubby tomorrow', 'een massage voor mij en Sam',
    ]) {
      expect([words, overviewLib.checkExpectation({ customer_expects: words, expected_date: '2026-11-25', expected_count: 2 }, ov.upcoming).verdict]).toEqual([words, 'needs_team']);
    }
    expect(overviewLib.checkExpectation({ customer_expects: 'my two treatments on the 25th', expected_date: '2026-11-25', expected_count: 2 }, ov.upcoming).verdict).toBe('shown');
  });

  test('each reason on its own: nothing upcoming, the other-people flag, an unnamed row, the people sum', () => {
    const now = new Date();
    const exp = (extra) => ({ customer_expects: 'my treatments tomorrow', expected_date: '2026-11-20', expected_count: 1, ...extra });
    expect(overviewLib.checkExpectation(exp(), []).reasons).toEqual(['no upcoming appointments under this profile']);
    const one = overviewLib.buildOverview([flat(1, '2026-11-20T09:00:00', 37)], { now }).upcoming;
    expect(overviewLib.checkExpectation(exp(), one).verdict).toBe('shown');
    expect(overviewLib.checkExpectation(exp({ expected_other_people: true }), one).verdict).toBe('needs_team');
    const unnamed = overviewLib.buildOverview([flat(1, '2026-11-20T09:00:00', 620)], { now }).upcoming;
    expect(overviewLib.checkExpectation(exp(), unnamed).reasons).toEqual(['a treatment name is not visible']);
    const couple = overviewLib.buildOverview([flat(1, '2026-11-20T09:00:00', 69)], { now }).upcoming;
    expect(couple[0].people).toBe(2);
    expect(overviewLib.checkExpectation(exp({ expected_count: 2 }), couple).verdict).toBe('shown');
    expect(overviewLib.checkExpectation(exp({ expected_count: 3 }), couple).verdict).toBe('needs_team');
  });

  test('two profiles read: the list says "profiles"', () => {
    const ov = overviewLib.buildOverview([MASSAGE], { now: new Date() });
    const text = overviewLib.renderOverview(ov, 'not_requested', 'en', { clients: [CLIENT, { Id: 2, FirstName: 'Sam', LastName: 'Guest' }] });
    expect(text).toMatch(/^Here is everything our booking system shows under your profiles \(Tara G\., Sam G\.\):/);
    expect(text).toMatch(/I can only see these profiles, so I can't tell who each appointment is for\.$/);
  });

  test('the expectation is kept across "not found", and cleared after a lookup that found the profile', async () => {
    mindbody.getClientByPhone.mockResolvedValue(null);
    expect((await lookUp(HER_CHECK)).status).toBe('not_found');
    mindbody.getClientByPhone.mockResolvedValue(CLIENT);
    expect((await lookUp({ customer_expects: '' })).check).toBe('needs_team');
    expect((await lookUp({ customer_expects: '' })).check).toBe('not_requested');
  });

  test('website chat: a plain lookup\'s list and the model\'s answer come as one message', async () => {
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', 'Anything else?')],
    );
    const reply = await agent.runWeb('tara', 'what have I booked?');
    expect(reply.message).toBe(`${LIST_OF_20_NOV}\n\n${COUNT_LINE}\n\nAnything else?`);
  });

  test('a failing alert never fails the lookup', async () => {
    db.logEscalation.mockRejectedValue(new Error('db down'));
    const r = await lookUp(HER_CHECK);
    expect(r.check).toBe('needs_team');
    expect(db.markConversationEscalated).toHaveBeenCalled();
    expect(conversations.get(PHONE).lookupReply.mustReplace).toBe(true);
  });

  test('the line after a colleague sits on the list when the list goes first', async () => {
    conversations.set(PHONE, { lang: 'en', replyPrefix: { en: 'You\'re chatting with the Renessence AI assistant again.', nl: 'x' } });
    script(
      [call('g', 'get_appointments', { client_email: EMAIL, customer_expects: '' })],
      [respond('r', 'Anything else?')],
    );
    await agent.run(PHONE, 'Tara', 'what have I booked?');
    expect(sentTexts()).toEqual([`You're chatting with the Renessence AI assistant again.\n\n${LIST_OF_20_NOV}\n\n${COUNT_LINE}`, 'Anything else?']);
  });
});
