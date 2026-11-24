// Regression for "Touriya" (Sun 27 Sep 2026). On 15 Sep the bot had asked for
// her full name and email and booked an Infrared Sauna. Twelve days later she
// booked again; this time the bot did not ask. book_appointment was called
// with only her first name and an address at example.com that nobody had
// typed — the model made it up because the tool demanded one — and a second
// Mindbody profile, "Touriya WhatsApp", was created with it. In November her
// payment failed and the team could not email her (Bianca: "Can we please make
// sure the bot is getting people's email addresses when booking?").
//
// Nothing in code checked where an address came from, nothing durable kept the
// one she had given, and a profile's own address was never looked at.
//
// Each block pins one part of the fix:
//  1. the booking of 27 Sep: an address nobody typed books nothing, creates
//     nothing and is never even searched in Mindbody; a new profile needs a
//     typed address, a first AND last name, and the Confirm tap
//  2. guests we already know: a real address on the profile → never asked and
//     booked exactly as before; a profile like hers ("WhatsApp", an address
//     nobody typed) → asked once, then remembered; the team hears about the
//     profile instead of the bot rewriting it
//  3. second person, classes, website chat, pay-first
//  4. the team: a handoff never waits for an email and never forwards an
//     invented one; only a typed or stored address reaches Stripe
//  5. lookup_client says what is still needed
//  6. the agent loop: the guest gets the email question, not "No availability"
//  7. the guard itself can fail (database down) without breaking a booking
//  8. "review round": what running the first version of this fix brought up
//
// What Jest cannot show: whether the real model asks before it calls the tool.
// The refusal in code is the part that holds either way.
//
// First name only; every address and number in this file is made up.

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
}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/outage-alert.service', () => ({
  recordAgentFailure: jest.fn(), recordAgentSuccess: jest.fn().mockResolvedValue(), holdingMessage: () => 'hold', HOLDING_TEXTS: [],
}));
jest.mock('../src/services/mindbody.service', () => {
  const actual = jest.requireActual('../src/services/mindbody.service');
  return {
    RESOURCE_MAP: actual.RESOURCE_MAP,
    isStaffRejection: actual.isStaffRejection,
    isRoomRejection: actual.isRoomRejection,
    getClientByPhone: jest.fn(),
    getClientById: jest.fn(),
    searchClientByEmail: jest.fn(),
    addClient: jest.fn(),
    addAppointment: jest.fn(),
    addClientToClass: jest.fn(),
    removeClientFromClass: jest.fn().mockResolvedValue({}),
    cancelAppointment: jest.fn().mockResolvedValue({}),
    findClientAppointmentAt: jest.fn().mockResolvedValue(null),
    findAvailableStaffForTime: jest.fn().mockResolvedValue([]),
    getRoomOccupancy: jest.fn(),
    invalidateRoomOccupancy: jest.fn(),
    getStaff: jest.fn().mockResolvedValue([]),
    // get_appointments (the lookup of the Tara fix), for the integration test in block 6
    getAllClientsByPhone: jest.fn().mockResolvedValue([]),
    searchClientByName: jest.fn().mockResolvedValue(null),
    getStaffAppointments: jest.fn().mockResolvedValue([]),
    getSessionTypeNames: jest.fn().mockResolvedValue({}),
  };
});
jest.mock('../src/services/payment.service', () => ({
  ...jest.requireActual('../src/services/payment.service'),
  createCombinedPaymentLink: jest.fn(),
  createPaymentLink: jest.fn(),
  createPayFirstCheckout: jest.fn(),
  getSessionDetails: jest.fn(),
  getSessionStatus: jest.fn().mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' }),
  expireSession: jest.fn().mockResolvedValue(true),
}));

// ── in-memory guest_contacts, typed messages and team notices ────────────────
const mockContacts = new Map();   // phone → { email, full_name, mindbody_client_id }
const mockTyped = new Map();      // phone → what conversation_messages holds of the guest's own texts with an "@"
const mockNotices = [];           // { phone, reason }
const mockGetGuestContact = async (phone) => (mockContacts.has(phone) ? { ...mockContacts.get(phone) } : null);
const mockSaveGuestContact = async (phone, { email = null, fullName = null, mindbodyClientId = null } = {}) => {
  const old = mockContacts.get(phone) || {};
  mockContacts.set(phone, {
    email: email || old.email || null,
    full_name: fullName || old.full_name || null,
    mindbody_client_id: mindbodyClientId != null ? String(mindbodyClientId) : (old.mindbody_client_id || null),
  });
};
const mockGetGuestTypedTexts = async (phone) => mockTyped.get(phone) || [];
jest.mock('../src/data/database', () => ({
  getGuestContact: jest.fn(),
  saveGuestContact: jest.fn(),
  getGuestTypedTexts: jest.fn(),
  hasRecentTeamNotification: jest.fn(async (phone, reason) => mockNotices.some(n => n.phone === phone && n.reason === reason)),
  logEscalation: jest.fn(async (phone, _name, reason) => { mockNotices.push({ phone, reason }); }),
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  setConversationLanguage: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  logError: jest.fn().mockResolvedValue(true),
  logBookingEvent: jest.fn(),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  updateBookingEventIfStatus: jest.fn().mockResolvedValue(true),
  getRecentBooking: jest.fn().mockResolvedValue(null),
  getBookingEventById: jest.fn().mockResolvedValue(null),
  getBookingEventByAppointment: jest.fn().mockResolvedValue(null),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  tombstoneByAppointment: jest.fn().mockResolvedValue(0),
  getOpenJourneyForDay: jest.fn().mockResolvedValue({ count: 0, totalCents: 0 }),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  getActivePayFirstHolds: jest.fn().mockResolvedValue([]),
  insertPayFirstRow: jest.fn(),
  markConversationEscalated: jest.fn(),
  isHumanHandling: jest.fn().mockResolvedValue(false),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const email = require('../src/services/email.service');
const mindbody = require('../src/services/mindbody.service');
const payments = require('../src/services/payment.service');
const payFirst = require('../src/services/pay-first.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');
const agent = require('../src/agents/renessence.agent');
const { TOOLS } = require('../src/agents/tool-definitions');
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const PHONE = '31600000027';
const WEB = 'web_touriya';
const SAUNA = 65;        // Infrared Sauna (large, 1 person), €35 at reception — what she booked
const MASSAGE_60 = 31;   // pay-first
const LED_ADDON = 30;    // booked first, then paid by link
const SLOT = '2026-09-27T14:00:00';
const MASSAGE_SLOT = '2026-09-30T14:00:00';

const INVENTED = 'touriya@example.com';        // the kind of address the model made up
const PLAUSIBLE = 'touriya.w@gmail.com';       // looks real, but nobody typed it
const TYPED = 'Touriya.Sauna@Guest.Fixture'; // typed with capitals, as guests do
const HERS = 'touriya.sauna@guest.fixture';  // the same address as the model passes it

// Her profile as the bot left it on 27 Sep, and one as the front desk makes it.
const POLLUTED = { Id: 7, FirstName: 'Touriya', LastName: 'WhatsApp', Email: INVENTED };
// Her WhatsApp number is on it: a profile found by email is only hers when it
// is (tests/profile-ownership.test.js).
const REAL = { Id: 8, FirstName: 'Touriya', LastName: 'Fixture', Email: HERS, MobilePhone: '+31600000027', Active: true };

/** Something the guest wrote in this chat (the 30-minute memory). */
const typed = (text, from = PHONE) => conversations.addMessage(from, 'user', text);
/** The handler's Confirm-tap effect. */
const tapConfirm = (from = PHONE) => conversations.set(from, { bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
const book = (args = {}, from = PHONE) => tools.toolBookAppointment(from, { session_type_id: SAUNA, start_date_time: SLOT, staff_id: 100000094, ...args });
const bookClass = (args = {}, from = PHONE) => tools.toolBookClass(from, { class_id: 456, session_type_id: 83, class_name: 'Vinyasa Flow', class_date_time: '2026-09-29T09:00:00', ...args });
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const order = (fn) => fn.mock.invocationCallOrder[0];

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 8, 27, 12, 16)); // Sun 27 Sep 2026, 12:16 Amsterdam
  jest.clearAllMocks();
  mockContacts.clear();
  mockTyped.clear();
  mockNotices.length = 0;
  // Set per test: block 7 lets all three fail, and that must not leak into the next test.
  db.getGuestContact.mockImplementation(mockGetGuestContact);
  db.saveGuestContact.mockImplementation(mockSaveGuestContact);
  db.getGuestTypedTexts.mockImplementation(mockGetGuestTypedTexts);
  for (const from of [PHONE, WEB]) {
    conversations.clear(from);
    tools.cancelAutoPaymentLink(from);
    // The slots she was genuinely offered.
    conversations.set(from, { lang: 'en', userName: 'Touriya', offeredSlots: [{ sessionTypeId: SAUNA, dateTime: SLOT }, { sessionTypeId: MASSAGE_60, dateTime: MASSAGE_SLOT }] });
  }
  mindbody.getClientByPhone.mockResolvedValue(null);
  mindbody.getClientById.mockResolvedValue(null);
  mindbody.searchClientByEmail.mockResolvedValue(null);
  mindbody.addClient.mockImplementation(async ({ firstName, lastName, email: e }) => ({ Id: 77, FirstName: firstName, LastName: lastName, Email: e }));
  mindbody.addAppointment.mockResolvedValue({ Id: 9001 });
  mindbody.addClientToClass.mockResolvedValue({ Id: 1 });
  db.logBookingEvent.mockResolvedValue(501);
  db.getRecentBooking.mockResolvedValue(null);
  db.getBookingEventById.mockImplementation(async (id) => ({ id, status: 'payment_sent', stripe_session_id: 'cs_class' }));
  payments.createPaymentLink.mockResolvedValue({ sessionId: 'cs_class', paymentUrl: 'https://pay.stripe.test/cs_class' });
});
afterEach(() => {
  tools.cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

// ── 1. The booking of 27 Sep ─────────────────────────────────────────────────

describe('the booking of 27 Sep: an address nobody typed', () => {
  test.each([
    ['at example.com', INVENTED, 'placeholder'],
    ['that looks real', PLAUSIBLE, 'not_from_guest'],
    ['that is no address at all', 'touriya-at-whatsapp', 'invalid'],
  ])('an invented address %s books nothing, creates nothing and is never searched in Mindbody', async (_label, address, reason) => {
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: address });

    expect(r).toMatchObject({ error: 'email_required', reason, nothing_booked: true });
    expect(r.message).toMatch(/NOTHING was booked and no profile was created/);
    expect(r.message).toMatch(/never invent/);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
    // The phone lookup never carries the model's address either.
    expect(mindbody.getClientByPhone).toHaveBeenCalledTimes(1);
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null);
    // Declining is not a dead end: the team books by hand.
    expect(r.message).toMatch(/request_human_handoff/);
    expect(r.message).toMatch(/No email - book by hand:/);
  });

  test('the address she typed is accepted, whatever the capitals — and her profile carries her real name, address and number', async () => {
    typed(`Touriya Fixture\n${TYPED}`);
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });

    expect(r).toMatchObject({ success: true, payOnLocation: true });
    expect(mindbody.searchClientByEmail).toHaveBeenCalledWith(HERS);
    expect(mindbody.addClient).toHaveBeenCalledTimes(1);
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Touriya', lastName: 'Fixture', email: HERS, mobilePhone: PHONE, city: 'Amsterdam' });
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 77, sessionTypeId: SAUNA, startDateTime: SLOT }));
    // Remembered for next time: twelve days later the memory is gone.
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '77' });
  });

  test('an address she typed in an earlier visit (only in the stored messages) counts too', async () => {
    mockTyped.set(PHONE, [`Touriya Fixture\n${TYPED}`]);
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(r.success).toBe(true);
    expect(db.getGuestTypedTexts).toHaveBeenCalledWith(PHONE);
    expect(mindbody.addClient).toHaveBeenCalledWith(expect.objectContaining({ email: HERS }));
  });

  test('no profile before the Confirm tap — and a missing address is asked for before the confirmation', async () => {
    typed(`Touriya Fixture\n${TYPED}`);
    const early = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(early.error).toBe('confirmation_required');
    expect(mindbody.addClient).not.toHaveBeenCalled();

    const invented = await book({ client_name: 'Touriya Fixture', client_email: INVENTED });
    expect(invented.error).toBe('email_required');
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });

  test('a one-word name never becomes "Touriya WhatsApp": the full name is asked for', async () => {
    typed(TYPED);
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: HERS });
    expect(r).toMatchObject({ error: 'email_required', reason: 'name_missing', need_name: true, nothing_booked: true });
    expect(r.message).toMatch(/first and last name/);
    expect(mindbody.addClient).not.toHaveBeenCalled();

    // A surname the bot once made up is not a name either.
    const again = await book({ client_name: 'Touriya WhatsApp', client_email: HERS });
    expect(again).toMatchObject({ error: 'email_required', need_name: true });
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });

  test('her WhatsApp name supplies the surname when its first name matches', async () => {
    conversations.set(PHONE, { userName: 'Touriya Fixture' });
    typed(TYPED);
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: HERS });
    expect(r.success).toBe(true);
    expect(mindbody.addClient).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Touriya', lastName: 'Fixture' }));
  });
});

// ── 2. Guests we already know ────────────────────────────────────────────────

describe('guests we already know', () => {
  test('a real address on the profile: never asked, booked exactly as before', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    tapConfirm();
    const r = await book(); // the model passes no name and no email

    expect(r).toMatchObject({ success: true, appointmentId: 9001, payOnLocation: true, requiresPayment: false });
    // Same calls, same order: phone lookup → appointment → audit row. Nothing else touches Mindbody.
    expect(mindbody.getClientByPhone).toHaveBeenCalledTimes(1);
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null);
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(mindbody.addAppointment).toHaveBeenCalledWith({ clientId: 8, sessionTypeId: SAUNA, staffId: 100000094, startDateTime: SLOT, notes: '📱 WhatsApp Bot | UNPAID — pay on location' });
    expect(order(mindbody.getClientByPhone)).toBeLessThan(order(mindbody.addAppointment));
    expect(order(mindbody.addAppointment)).toBeLessThan(order(db.logBookingEvent));
    expect(mindbody.getClientById).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
    expect(mindbody.addClient).not.toHaveBeenCalled();
    await flush();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('an invented address next to a real profile is dropped, not a reason to ask', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: INVENTED });
    expect(r.success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8 }));
    await flush();
    expect(mockContacts.get(PHONE).email).toBe(HERS);
  });

  test('a search result without Email: the full profile is read before anyone is asked', async () => {
    mindbody.getClientByPhone.mockResolvedValue({ Id: 8, FirstName: 'Touriya', LastName: 'Fixture' });
    mindbody.getClientById.mockResolvedValue(REAL);
    tapConfirm();
    const r = await book();
    expect(r.success).toBe(true);
    expect(mindbody.getClientById).toHaveBeenCalledWith(8);
  });

  test('a profile like hers ("Touriya WhatsApp", an address nobody typed): asked once, then booked, the team told once, and remembered', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    tapConfirm();

    // Not asked on 27 Sep — asked now.
    const first = await book();
    expect(first).toMatchObject({ error: 'email_required', reason: 'missing', nothing_booked: true });
    expect(first.need_name).toBeUndefined(); // the profile exists: no new name needed
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    // Passing the address that sits on the profile does not help: nobody typed it.
    expect((await book({ client_email: INVENTED })).error).toBe('email_required');

    // She types it; the bot books on her profile and does NOT rewrite it.
    typed(TYPED);
    const second = await book({ client_email: HERS });
    expect(second.success).toBe(true);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 7, notes: `📱 WhatsApp Bot | UNPAID — pay on location | Email: ${HERS}` }));
    await flush();
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerPhone: PHONE,
      customerEmail: HERS,
      message: `Mindbody profile 7 (Touriya WhatsApp) has no real email address. The guest gave: ${HERS}. Please update or merge the profile.`,
    }));
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });

    // Weeks later, memory gone: not asked again, and the team is not mailed again this week.
    conversations.clear(PHONE);
    conversations.set(PHONE, { lang: 'en', userName: 'Touriya', offeredSlots: [{ sessionTypeId: SAUNA, dateTime: SLOT }] });
    db.getRecentBooking.mockResolvedValue(null);
    tapConfirm();
    const third = await book();
    expect(third.success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 7, notes: expect.stringContaining(`Email: ${HERS}`) }));
    await flush();
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('a "WhatsApp" profile with an address that looks real: trusted only when she typed it', async () => {
    // No list of placeholders recognises "firstname@gmail.com"; the surname the bot made up is the signal.
    mindbody.getClientByPhone.mockResolvedValue({ ...POLLUTED, Email: PLAUSIBLE });
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();

    mockTyped.set(PHONE, [`my email is ${PLAUSIBLE}`]); // she did type it, at an earlier visit
    expect((await book()).success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 7, notes: '📱 WhatsApp Bot | UNPAID — pay on location' }));
    await flush();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('a re-sent booking on a profile without an address is still answered "already booked", not with a question', async () => {
    mindbody.getClientByPhone.mockResolvedValue({ Id: 9, FirstName: 'Touriya', LastName: 'Fixture', Email: '' });
    db.getRecentBooking.mockResolvedValue({ id: 500, status: 'pay_on_location', customer_name: 'Touriya Fixture', mindbody_appointment_id: 9001 });
    const r = await book();
    expect(r).toMatchObject({ success: true, already_booked: true, payOnLocation: true });
    expect(r.error).toBeUndefined();
  });

  test('the stored contact finds her when the phone search misses — no second profile', async () => {
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });
    mindbody.getClientById.mockResolvedValue(REAL);
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: INVENTED }); // what the model sent on 27 Sep

    expect(r.success).toBe(true);
    expect(mindbody.getClientById).toHaveBeenCalledWith('8');
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8 }));
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
  });

  test('a stored profile that was removed or now belongs to someone else is not used; her stored address finds her', async () => {
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });
    mindbody.getClientById.mockResolvedValue({ Id: 8, FirstName: 'Somebody', LastName: 'Else', Email: 'else@guest.fixture', Active: true });
    mindbody.searchClientByEmail.mockResolvedValue({ ...REAL, Id: 12 });
    tapConfirm();
    const r = await book();
    expect(r.success).toBe(true);
    expect(mindbody.searchClientByEmail).toHaveBeenCalledWith(HERS);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 12 }));
  });
});

// ── 3. Second person, classes, website chat, pay-first ───────────────────────

describe('a second person in the chat', () => {
  beforeEach(() => mindbody.getClientByPhone.mockResolvedValue(REAL));

  test('needs their own typed address — an invented one books nothing for them', async () => {
    tapConfirm();
    const r = await book({ client_name: 'Nadia Voorbeeld', client_email: 'nadia@example.com' });
    expect(r).toMatchObject({ error: 'companion_email_required', reason: 'placeholder', nothing_booked: true });
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('with a typed address they get their own profile — after Confirm, with a full name, and never as the owner\'s stored contact', async () => {
    typed('Nadia Voorbeeld, nadia@guest.fixture');
    const early = await book({ client_name: 'Nadia Voorbeeld', client_email: 'nadia@guest.fixture' });
    expect(early.error).toBe('confirmation_required');
    expect(mindbody.addClient).not.toHaveBeenCalled();

    tapConfirm();
    const oneWord = await book({ client_name: 'Nadia', client_email: 'nadia@guest.fixture' });
    expect(oneWord).toMatchObject({ error: 'companion_email_required', reason: 'name_missing', need_name: true });
    expect(mindbody.addClient).not.toHaveBeenCalled();

    const r = await book({ client_name: 'Nadia Voorbeeld', client_email: 'nadia@guest.fixture' });
    expect(r.success).toBe(true);
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Nadia', lastName: 'Voorbeeld', email: 'nadia@guest.fixture', mobilePhone: null, city: 'Amsterdam' });
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 77 }));
    await flush();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
  });

  test('"use my email for her": the owner\'s real address may be shared, booked on the owner\'s profile with a note', async () => {
    tapConfirm();
    const r = await book({ client_name: 'Nadia Voorbeeld', client_email: HERS });
    expect(r.success).toBe(true);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8, notes: expect.stringMatching(/For: Nadia Voorbeeld/) }));
    await flush();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
  });
});

describe('classes and the website chat', () => {
  test('book_class refuses an invented address too — no profile, no enrolment', async () => {
    const r = await bookClass({ client_name: 'Touriya Fixture', client_email: INVENTED });
    expect(r).toMatchObject({ error: 'email_required', reason: 'placeholder', nothing_booked: true });
    expect(r.message).toMatch(/call book_class again/);
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();

    // Nor a class on a profile like hers until she has given her address.
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    expect(await bookClass()).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();
    typed(TYPED);
    expect((await bookClass({ client_email: HERS })).success).toBe(true);
    expect(mindbody.addClientToClass).toHaveBeenCalledWith(7, 456);
    expect(payments.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: HERS }));
  });

  test('a class for a guest with a real profile: enrolled as before, and only her real address reaches Stripe', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    const r = await bookClass({ client_email: INVENTED });
    expect(r).toMatchObject({ success: true, requiresPayment: true });
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null); // the model's address is not even searched
    expect(mindbody.addClientToClass).toHaveBeenCalledWith(8, 456);
    expect(payments.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: HERS }));
  });

  test('a website visitor is found by the email they typed — "web_…" is never a phone number', async () => {
    typed('Touriya Fixture', WEB);
    typed(TYPED, WEB);
    const r = await bookClass({ client_name: 'Touriya Fixture', client_email: HERS }, WEB);

    expect(r.success).toBe(true);
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).toHaveBeenCalledWith(HERS);
    // No number typed → the new profile has none (it used to get "+web_…").
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Touriya', lastName: 'Fixture', email: HERS, mobilePhone: null, city: 'Amsterdam' });
    await flush();
    // A website session is not a number we can remember.
    expect(db.getGuestContact).not.toHaveBeenCalled();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
  });

  test('a website visitor\'s phone number counts only when they typed it', async () => {
    typed(`Touriya Fixture ${TYPED} 06 1234 5678`, WEB);
    await bookClass({ client_name: 'Touriya Fixture', client_email: HERS, client_phone: '+31612345678' }, WEB);
    // Only for the NEW profile — nobody is looked up by it (it can be anyone's number).
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.addClient).toHaveBeenCalledWith(expect.objectContaining({ mobilePhone: '+31612345678' }));

    mindbody.getClientByPhone.mockClear();
    mindbody.addClient.mockClear();
    await bookClass({ client_name: 'Touriya Fixture', client_email: HERS, client_phone: '+31687654321' }, WEB); // the model's own
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.addClient).toHaveBeenCalledWith(expect.objectContaining({ mobilePhone: null }));
  });

  test('website chat: book_appointment writes nothing to Mindbody without a recorded Confirm', async () => {
    typed(`Touriya Fixture ${TYPED} 0612345678`, WEB);
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS, client_phone: '0612345678' }, WEB);
    // The website widget cannot record a Confirm tap (separate ticket), so this is where it ends today.
    expect(r.error).toBe('confirmation_required');
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    for (const [phone] of mindbody.getClientByPhone.mock.calls) expect(String(phone)).not.toMatch(/^web_/);
  });
});

describe('pay-first treatments', () => {
  test('no payment link with an invented address — and the open-link check never sees it', async () => {
    const guard = jest.spyOn(payFirst, 'guardExisting');
    tapConfirm();
    const r = await book({ session_type_id: MASSAGE_60, start_date_time: MASSAGE_SLOT, client_name: 'Touriya Fixture', client_email: INVENTED });

    expect(r.error).toBe('email_required');
    const guardArgs = guard.mock.calls.map(c => c[3]);
    guard.mockRestore();
    expect(guardArgs).toEqual([expect.objectContaining({ clientEmail: null })]);
    expect(db.insertPayFirstRow).not.toHaveBeenCalled();
    expect(payments.createPayFirstCheckout).not.toHaveBeenCalled();
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });
});

// ── 4. The team and Stripe ───────────────────────────────────────────────────

describe('what the team and Stripe are given', () => {
  test('a handoff goes to the team at once without an email — an invented address is dropped, never forwarded', async () => {
    const r = await tools.toolHumanHandoff(PHONE, 'Touriya', { reason: 'payment link for a missed payment', customer_email: INVENTED });
    expect(r).toEqual({ sent: true });
    expect(db.markConversationEscalated).toHaveBeenCalledWith(PHONE, expect.stringMatching(/^Handoff: payment link/));
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: PHONE, customerEmail: null }));

    await tools.toolForwardReschedule(PHONE, 'Touriya', { new_date: 'Sunday 4 October', treatment: 'Infrared Sauna', customer_email: PLAUSIBLE });
    expect(email.sendRescheduleRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: null }));

    await tools.toolForwardGiftCard(PHONE, 'Touriya', { gift_card_number: 'OLD9', treatment: 'Infrared Sauna', preferred_day: 'Sunday', customer_email: INVENTED, old_system: true });
    expect(email.sendGiftCardRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: null }));
  });

  test('the address she typed, or the one stored for her number, does reach the team', async () => {
    typed(TYPED);
    await tools.toolHumanHandoff(PHONE, 'Touriya', { reason: 'a question', customer_email: HERS });
    expect(email.sendEscalationEmail).toHaveBeenLastCalledWith(expect.objectContaining({ customerEmail: HERS }));

    conversations.clear(PHONE);
    mockNotices.length = 0;
    mockContacts.set(PHONE, { email: 'touriya.stored@guest.fixture', full_name: 'Touriya Fixture', mindbody_client_id: '8' });
    await tools.toolHumanHandoff(PHONE, 'Touriya', { reason: 'another question', customer_email: INVENTED });
    expect(email.sendEscalationEmail).toHaveBeenLastCalledWith(expect.objectContaining({ customerEmail: 'touriya.stored@guest.fixture' }));
  });

  test('send_payment: only a typed or stored address reaches Stripe', async () => {
    payments.createCombinedPaymentLink.mockResolvedValue({ sessionId: 'cs_new', paymentUrl: 'https://pay.stripe.test/cs_new' });
    db.getBookingEventById.mockImplementation(async (id) => ({ id, status: 'pending' }));
    const cart = () => conversations.set(PHONE, { pendingBookings: [{ booking_event_id: 77, appointment_id: 5001, session_type_id: MASSAGE_60, service_name: 'Tailored Massage', date_time_label: 'zondag 27 september at 14:00', amount_cents: 13000 }] });

    cart();
    await tools.toolSendPayment(PHONE, { customer_email: INVENTED });
    expect(payments.createCombinedPaymentLink.mock.calls[0][0].customerEmail).toBeUndefined();

    cart();
    typed(TYPED);
    await tools.toolSendPayment(PHONE, { customer_email: HERS });
    expect(payments.createCombinedPaymentLink.mock.calls[1][0].customerEmail).toBe(HERS);
  });
});

// ── 5. lookup_client ─────────────────────────────────────────────────────────

describe('lookup_client says what is still needed', () => {
  test('a new guest: full name and email', async () => {
    const r = await tools.toolLookupClient(PHONE);
    expect(r).toMatchObject({ found: false, needs_name_and_email: true });
    expect(r.message).toMatch(/first and last name/);
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null);
  });

  test('a known guest with a real address: nothing to ask', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    expect(await tools.toolLookupClient(PHONE)).toMatchObject({ found: true, name: 'Touriya Fixture', email: HERS, clientId: '8', email_on_file: true });
  });

  test('a profile like hers: the email is still needed — no reserved address and no "WhatsApp" surname reach the model', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    const r = await tools.toolLookupClient(PHONE);
    expect(r).toMatchObject({ found: true, name: 'Touriya', email: null, clientId: '7', needs_email: true });
    expect(JSON.stringify(r)).not.toMatch(/example\.com|WhatsApp"/);
  });

  test('her stored contact is used: for a profile without an address, and when the phone search misses', async () => {
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '7' });
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    expect(await tools.toolLookupClient(PHONE)).toMatchObject({ found: true, email: HERS, email_on_file: true });

    mindbody.getClientByPhone.mockResolvedValue(null);
    mindbody.getClientById.mockResolvedValue(REAL);
    expect(await tools.toolLookupClient(PHONE)).toMatchObject({ found: true, name: 'Touriya Fixture', email: HERS, email_on_file: true });
  });

  test('"Mindbody did not answer" is not "a new guest"', async () => {
    mindbody.getClientByPhone.mockRejectedValue(new Error('timeout of 15000ms exceeded'));
    const r = await tools.toolLookupClient(PHONE);
    expect(r).toMatchObject({ found: false, lookup_failed: true });
    expect(r.needs_name_and_email).toBeUndefined();
    expect(r.message).toMatch(/Do NOT (say|tell)/);
  });

  test('a website visitor is always asked', async () => {
    expect(await tools.toolLookupClient(WEB)).toMatchObject({ found: false, needs_name_and_email: true });
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
  });
});

// ── 6. The agent loop ────────────────────────────────────────────────────────

describe('the agent loop after a refused booking', () => {
  const inventedCall = (id, extra = {}) => call(id, 'book_appointment', { session_type_id: SAUNA, start_date_time: SLOT, client_name: 'Touriya Fixture', client_email: INVENTED, ...extra });
  const classCall = (id) => call(id, 'book_class', { class_id: 456, session_type_id: 83, class_name: 'Vinyasa Flow', class_date_time: '2026-09-29T09:00:00', client_name: 'Touriya Fixture', client_email: PLAUSIBLE });
  const EMAIL_QUESTION = 'Before I can book this for you, I need your email address — could you type it here? We use it for your confirmation and to reach you if anything changes.';

  test('a model that keeps calling the tool: the guest gets the email question, not "No availability" — one other address is tried, then no booking call runs', async () => {
    // Round 1 invents an address, round 2 another one; rounds 3-8 keep trying instead of replying.
    script([inventedCall('b1')], [inventedCall('b2', { client_email: PLAUSIBLE })], [classCall('c3')], [inventedCall('b4', { client_email: 'third.try@gmail.com' })], ...[5, 6, 7, 8].map(i => [inventedCall(`b${i}`)]));
    await agent.run(PHONE, 'Touriya', 'Confirm');

    // The first call and ONE call with another address ran; nothing after that touched Mindbody.
    expect(mindbody.getClientByPhone).toHaveBeenCalledTimes(2);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();
    const results = toolResults();
    expect(results.b1).toMatchObject({ error: 'email_required', reason: 'placeholder' });
    expect(results.b2).toMatchObject({ error: 'email_required', reason: 'not_from_guest', nothing_booked: true });
    expect(results.b2.not_run).toBeUndefined();
    for (const skipped of [results.c3, results.b4, results.b5]) {
      expect(skipped).toMatchObject({ error: 'email_required', reason: 'not_from_guest', nothing_booked: true, not_run: true });
      expect(skipped.message).toMatch(/^This call was NOT run/);
      expect(skipped.message).toContain(results.b2.message);
    }

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, EMAIL_QUESTION);
    expect(whatsapp.sendText.mock.calls[0][1]).not.toMatch(/availability/i);
    // Stored like any other reply: the next turn and the dashboard see the question.
    expect(conversations.getMessages(PHONE).slice(-1)[0]).toEqual({ role: 'assistant', content: EMAIL_QUESTION });
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', EMAIL_QUESTION);
  });

  test('in Dutch, and with the full name when that is missing too', async () => {
    conversations.set(PHONE, { lang: 'nl' });
    script(...[1, 2, 3, 4, 5, 6, 7, 8].map(i => [inventedCall(`b${i}`, { client_name: 'Touriya' })]));
    await agent.run(PHONE, 'Touriya', 'Bevestigen');
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText.mock.calls[0][1]).toBe('Voordat ik dit voor je kan boeken, heb ik je volledige naam en e-mailadres nodig — wil je die hier typen? We gebruiken ze voor je bevestiging en om je te bereiken als er iets verandert.');
  });

  test('a model that does reply after the refusal: its own question goes out, nothing else', async () => {
    script([inventedCall('b1')], [call('r', 'respond', { message: 'Could you type your email address for me?', ui_type: 'none', detected_language: 'en' })]);
    await agent.run(PHONE, 'Touriya', 'Confirm');
    expect(whatsapp.sendText.mock.calls.map(c => c[1])).toEqual(['Could you type your email address for me?']);
  });

  // Integration review, Nov 2026: with "no booking call runs any more in this
  // turn" a guest who HAD just typed her address was asked for it again when
  // the model left it out of its first call and put it right in the next
  // round. The server checks every address anyway, so one corrected call runs.
  test('the guest had typed her address and the model left it out: the corrected call in the next round books, she is not asked again', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed(`my email is ${TYPED}`);
    tapConfirm();
    script(
      [call('b1', 'book_appointment', { session_type_id: SAUNA, start_date_time: SLOT, staff_id: 100000094 })],
      [call('b2', 'book_appointment', { session_type_id: SAUNA, start_date_time: SLOT, staff_id: 100000094, client_email: HERS })],
      [call('r', 'respond', { message: 'You are booked for the Infrared Sauna.', ui_type: 'none', detected_language: 'en' })],
    );
    await agent.run(PHONE, 'Touriya', 'Confirm');

    const results = toolResults();
    expect(results.b1).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(results.b2).toMatchObject({ success: true, appointmentId: 9001 });
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText.mock.calls.map(c => c[1])).toEqual(['You are booked for the Infrared Sauna.']);
  });

  test('the same call sent again unchanged is not a correction: it does not run', async () => {
    script([inventedCall('b1')], [inventedCall('b2')], ...[3, 4, 5, 6, 7, 8].map(i => [inventedCall(`b${i}`)]));
    await agent.run(PHONE, 'Touriya', 'Confirm');
    expect(mindbody.getClientByPhone).toHaveBeenCalledTimes(1);
    expect(toolResults().b2).toMatchObject({ error: 'email_required', reason: 'placeholder', not_run: true });
  });

  test('a second call in the SAME model message is never the correction', async () => {
    script([inventedCall('b1'), inventedCall('b2', { client_email: PLAUSIBLE })], ...[2, 3, 4, 5, 6, 7, 8].map(i => [inventedCall(`x${i}`)]));
    await agent.run(PHONE, 'Touriya', 'Confirm');
    expect(mindbody.getClientByPhone).toHaveBeenCalledTimes(1);
    expect(toolResults().b2).toMatchObject({ not_run: true });
  });

  test('the refusal tells the model about that one way out', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    tapConfirm();
    const r = await book();
    expect(r.message).toMatch(/Do NOT call book_appointment again in this turn — unless the customer has ALREADY typed it in this chat and you left it out or changed it: then call once more with it copied exactly\./);
  });

  // The contact is written before the tool answers: a second booking call in
  // the same turn (a journey) reads it. Not awaited, that call asked for the
  // address the guest had just given.
  test('the stored contact is there when the booking call returns', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed(TYPED);
    tapConfirm();
    let finishWrite;
    db.saveGuestContact.mockImplementation((...a) => new Promise(resolve => { finishWrite = () => resolve(mockSaveGuestContact(...a)); }));
    let answered = false;
    const booking = book({ client_email: HERS }).then(r => { answered = true; return r; });
    await flush(200);
    // The appointment is made, the write is still under way: the tool waits.
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);
    finishWrite();
    expect((await booking).success).toBe(true);
    expect(mockContacts.get(PHONE)).toMatchObject({ email: HERS, mindbody_client_id: '7' });
  });

  test('a refused call for a second person: the owner\'s own call in the same turn is not run — and is told so, not just "nothing was booked for Nadia"', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    tapConfirm();
    const ownCall = (id) => call(id, 'book_appointment', { session_type_id: SAUNA, start_date_time: SLOT });
    script(
      [call('f1', 'book_appointment', { session_type_id: SAUNA, start_date_time: SLOT, client_name: 'Nadia Voorbeeld', client_email: PLAUSIBLE }), ownCall('o1')],
      ...[2, 3, 4, 5, 6, 7, 8].map(i => [ownCall(`o${i}`)]),
    );
    await agent.run(PHONE, 'Touriya', 'Confirm');

    // With the Confirm tap recorded the owner's call would have booked had it run.
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    const results = toolResults();
    expect(results.f1).toMatchObject({ error: 'companion_email_required', reason: 'not_from_guest' });
    expect(results.f1.not_run).toBeUndefined();
    expect(results.o1).toMatchObject({ error: 'companion_email_required', reason: 'not_from_guest', nothing_booked: true, not_run: true });
    expect(results.o1.message).toMatch(/^This call was NOT run/);
    expect(results.o1.message).toMatch(/Nothing was booked by this call either/);
    expect(results.o1.message).toContain(results.f1.message);

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Before I can book this for your guest, I need their full name and their own email address — could you type them here? Each guest gets their own booking.');
  });

  test('without a refused booking the old fallback is unchanged', async () => {
    script(...[1, 2, 3, 4, 5, 6, 7, 8].map(i => [call(`l${i}`, 'lookup_client', {})]));
    await agent.run(PHONE, 'Touriya', 'Hi');
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/^No availability was found/));
  });

  // Integration review of the five November fixes: a lookup the server could
  // not confirm (Tara, 19 Nov 2026) replaced EVERY plain reply of its turn —
  // also the question for the email address after a refused booking. The
  // guest got her appointment list, never the question, and her new booking
  // was silently not made. The list still goes out; the question follows it.
  describe('a lookup in the same turn that needs the team', () => {
    const HER_WORDS = 'tomorrow my husband and I have a float, and please book me the sauna at 14:00';
    const lookup = call('g', 'get_appointments', { client_email: HERS, customer_expects: HER_WORDS });
    const LIST_START = 'Here is everything our booking system shows under your profile (Touriya F.):';
    beforeEach(() => {
      mindbody.getClientByPhone.mockImplementation(async (phone, address) => (address ? REAL : null));
      mindbody.getStaffAppointments.mockResolvedValue([{ Id: 5001, Status: 'Booked', StartDateTime: '2026-09-28T10:00:00', EndDateTime: '2026-09-28T11:00:00', SessionTypeId: 58, ClientId: 8, Notes: '' }]);
    });

    test('the model asks for the address itself: the list goes first, then its question', async () => {
      script([lookup, inventedCall('b1')], [call('r', 'respond', { message: 'Could you type your email address so I can book the sauna?', ui_type: 'none', detected_language: 'en' })]);
      await agent.run(PHONE, 'Touriya', HER_WORDS);
      expect(toolResults().b1).toMatchObject({ error: 'email_required', nothing_booked: true });
      const sent = whatsapp.sendText.mock.calls.map(c => c[1]);
      expect(sent).toHaveLength(2);
      expect(sent[0].startsWith(LIST_START)).toBe(true);
      expect(sent[1]).toBe('Could you type your email address so I can book the sauna?');
      expect(conversations.getMessages(PHONE).slice(-2).map(m => m.content)).toEqual(sent);
      expect(db.logMessage.mock.calls.filter(c => c[1] === 'assistant').map(c => c[2])).toEqual(sent);
    });

    test('the model never replies: the list, then the server\'s email question', async () => {
      script([lookup, inventedCall('b1')], ...[2, 3, 4, 5, 6, 7, 8].map(i => [inventedCall(`b${i}`)]));
      await agent.run(PHONE, 'Touriya', HER_WORDS);
      const sent = whatsapp.sendText.mock.calls.map(c => c[1]);
      expect(sent).toHaveLength(2);
      expect(sent[0].startsWith(LIST_START)).toBe(true);
      expect(sent[1]).toBe(EMAIL_QUESTION);
    });
  });
});

// ── 7. The guard's own state can be missing ──────────────────────────────────

describe('the guard never breaks a booking', () => {
  test('database down: reads as "nothing stored, nothing typed" — a new guest is asked, a known guest still books, nothing throws', async () => {
    db.getGuestContact.mockRejectedValue(new Error('connection refused'));
    db.getGuestTypedTexts.mockRejectedValue(new Error('connection refused'));
    db.saveGuestContact.mockRejectedValue(new Error('connection refused'));
    tapConfirm();

    // Typed in an earlier visit, but the stored messages cannot be read.
    const asked = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(asked).toMatchObject({ error: 'email_required', reason: 'not_from_guest' });

    mindbody.getClientByPhone.mockResolvedValue(REAL);
    const booked = await book();
    expect(booked.success).toBe(true);
    await flush();

    await expect(tools.toolLookupClient(PHONE)).resolves.toMatchObject({ found: true, email_on_file: true });
    await expect(tools.toolHumanHandoff(PHONE, 'Touriya', { reason: 'a question', customer_email: HERS })).resolves.toMatchObject({ sent: true });
  });
});

// ── After review ─────────────────────────────────────────────────────────────
// The first version of this fix was reviewed by running it. Each test below
// failed before its repair, or pins a rule that could be taken out without
// any test noticing.

describe('review round: her own booking stays hers, a friend\'s never becomes hers', () => {
  test('on a profile like hers the model passes her full name with the address she typed: booked on HER profile — "WhatsApp" is not a surname that makes her someone else', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed(`Touriya Fixture\n${TYPED}`);
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });

    expect(r.success).toBe(true);
    // No third profile for her, and no search for one.
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 7, notes: `📱 WhatsApp Bot | UNPAID — pay on location | Email: ${HERS}` }));
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '7' });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);

    // The same booking sent again without the name is a repeat, not a second appointment.
    const row = { id: 501, status: 'pay_on_location', customer_name: 'Touriya Fixture', mindbody_appointment_id: 9001 };
    db.getRecentBooking.mockImplementation(async (_from, _type, _start, matches) => ((matches ? matches(row) : true) ? row : null));
    expect(await book()).toMatchObject({ success: true, already_booked: true });
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
  });

  test('a returning guest is not asked for "THEIR own email" when the model adds another surname and an address she never typed', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    tapConfirm();
    const r = await book({ client_name: 'Touriya Anders', client_email: PLAUSIBLE });
    expect(r.success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8 }));
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();

    // Another first name is still a second person, who needs an address of their own.
    const friend = await book({ client_name: 'Nadia Voorbeeld', client_email: PLAUSIBLE });
    expect(friend).toMatchObject({ error: 'companion_email_required', reason: 'not_from_guest' });
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
  });

  test('"use my email for her" when the owner\'s own address is the stored one: on the owner\'s profile with a note — never a new profile for the friend with the owner\'s address', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
    tapConfirm();
    const r = await book({ client_name: 'Nadia Voorbeeld', client_email: HERS });
    expect(r.success).toBe(true);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 7, notes: expect.stringMatching(/For: Nadia Voorbeeld/) }));
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
  });

  test('one typed address for both, the owner booked first: from then on it is the owner\'s — the friend is booked on the owner\'s profile with a note', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed(`Touriya Fixture and Nadia Voorbeeld, ${TYPED} for both of us`);
    tapConfirm();
    expect((await book({ client_name: 'Touriya Fixture', client_email: HERS })).success).toBe(true);
    await flush();
    const friend = await book({ client_name: 'Nadia Voorbeeld', client_email: HERS });
    expect(friend.success).toBe(true);
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 7, notes: expect.stringMatching(/For: Nadia Voorbeeld/) }));
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '7' });
  });

  test('the address stored for a number is its owner\'s: a first call for a friend does not make the friend\'s profile with it', async () => {
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: null });
    tapConfirm();
    const r = await book({ client_name: 'Nadia Voorbeeld' });
    expect(r).toMatchObject({ error: 'email_required', reason: 'missing', nothing_booked: true });
    expect(mindbody.addClient).not.toHaveBeenCalled();

    // For the owner herself the stored name and address are enough for a new profile.
    expect((await book()).success).toBe(true);
    expect(mindbody.addClient).toHaveBeenCalledTimes(1);
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Touriya', lastName: 'Fixture', email: HERS, mobilePhone: PHONE, city: 'Amsterdam' });
  });

  test('a class booked for a friend is not stored as the owner\'s contact, and the team is not asked to put the friend\'s address on the owner\'s profile', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed('a class for my friend Nadia Voorbeeld, nadia@guest.fixture');
    const r = await bookClass({ client_name: 'Nadia Voorbeeld', client_email: 'nadia@guest.fixture' });
    expect(r.success).toBe(true);
    await flush();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();

    // The owner is still asked for her own address at her own next booking.
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'email_required', reason: 'missing' });
  });

  test('her own class on a profile like hers: remembered and the team told once — but not for an enrolment that is rolled back', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    typed(TYPED);
    db.logBookingEvent.mockResolvedValueOnce(undefined); // no audit row → the enrolment is undone
    expect((await bookClass({ client_email: HERS })).error).toBe('booking_failed');
    await flush();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();

    expect((await bookClass({ client_email: HERS })).success).toBe(true);
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('what is stored for a number is the profile\'s own address when it has one — not another address typed in the chat', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    typed('nadia@guest.fixture'); // her friend's, typed in the same chat
    tapConfirm();
    expect((await book({ client_email: 'nadia@guest.fixture' })).success).toBe(true);
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });

    // The same after a class.
    mockContacts.clear();
    expect((await bookClass({ client_email: 'nadia@guest.fixture' })).success).toBe(true);
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });
  });

  test('a first booking from a new number under another name is not remembered as "the owner"', async () => {
    // A WhatsApp name with another surname: clearly for a friend — no phone on the profile either.
    conversations.set(PHONE, { userName: 'Touriya Fixture' });
    typed('for my friend Nadia Voorbeeld, nadia@guest.fixture');
    tapConfirm();
    expect((await book({ client_name: 'Nadia Voorbeeld', client_email: 'nadia@guest.fixture' })).success).toBe(true);
    expect(mindbody.addClient).toHaveBeenLastCalledWith(expect.objectContaining({ firstName: 'Nadia', mobilePhone: null }));

    // A one-word WhatsApp name can be a nickname: the phone is kept, but nothing is stored for the number.
    conversations.clear(PHONE);
    conversations.set(PHONE, { lang: 'en', userName: 'Sunny', offeredSlots: [{ sessionTypeId: SAUNA, dateTime: SLOT }] });
    db.getRecentBooking.mockResolvedValue(null);
    typed('Anna Smit, anna.smit@guest.fixture');
    tapConfirm();
    expect((await book({ client_name: 'Anna Smit', client_email: 'anna.smit@guest.fixture' })).success).toBe(true);
    expect(mindbody.addClient).toHaveBeenLastCalledWith(expect.objectContaining({ firstName: 'Anna', mobilePhone: PHONE }));
    await flush();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
  });

  test('a class for a new guest whose WhatsApp name is not their real name: the profile keeps the phone number, as before', async () => {
    // Without it the unpaid-class release and the reminders cannot find her.
    conversations.set(PHONE, { userName: 'Sunny Days' });
    typed('Anna Smit, anna.smit@guest.fixture');
    const r = await bookClass({ client_name: 'Anna Smit', client_email: 'anna.smit@guest.fixture' });
    expect(r.success).toBe(true);
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Anna', lastName: 'Smit', email: 'anna.smit@guest.fixture', mobilePhone: PHONE, city: 'Amsterdam' });
  });

  test('Mindbody refuses the new profile because it already exists: that profile is used', async () => {
    typed(`Touriya Fixture\n${TYPED}`);
    tapConfirm();
    mindbody.addClient.mockRejectedValue(Object.assign(new Error('exists'), { response: { data: { Error: { Code: 'InvalidClientCreation' } } } }));
    mindbody.getClientByPhone.mockResolvedValueOnce(null).mockResolvedValue(REAL);
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(r.success).toBe(true);
    expect(mindbody.getClientByPhone).toHaveBeenLastCalledWith(PHONE, HERS);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8 }));
  });
});

describe('review round: a surname is never made up from the WhatsApp name', () => {
  test.each([
    ['an emoji in it', 'Touriya 🌸 Fixture'],
    ['a job title', 'Touriya | Coach'],
    ['decoration around the name', '~Touriya~ Fixture'],
    ['only an initial for a surname', 'Touriya F'],
    ['another first name', 'Sanne Fixture'],
  ])('a WhatsApp name with %s supplies nothing: the full name is asked for', async (_label, chatName) => {
    conversations.set(PHONE, { userName: chatName });
    typed(TYPED);
    tapConfirm();
    const r = await book({ client_name: 'Touriya', client_email: HERS });
    expect(r).toMatchObject({ error: 'email_required', reason: 'name_missing', need_name: true });
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });

  test('an initial on WhatsApp ("T Fixture") supplies the surname only — the first name stays the one she gave', async () => {
    conversations.set(PHONE, { userName: 'T Fixture' });
    typed(TYPED);
    tapConfirm();
    expect((await book({ client_name: 'Touriya', client_email: HERS })).success).toBe(true);
    expect(mindbody.addClient).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Touriya', lastName: 'Fixture' }));
  });

  test('a guest with one name, or who will not give a surname, is not asked for ever: the team books by hand', async () => {
    typed(`Noor ${TYPED}`);
    tapConfirm();
    const r = await book({ client_name: 'Noor', client_email: HERS });
    expect(r).toMatchObject({ error: 'email_required', reason: 'name_missing' });
    expect(r.message).toMatch(/request_human_handoff/);
    expect(r.message).toMatch(/No full name - book by hand:/);

    // The same way out for a second person.
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    typed('and for Noor, noor@guest.fixture');
    const friend = await book({ client_name: 'Noor', client_email: 'noor@guest.fixture' });
    expect(friend).toMatchObject({ error: 'companion_email_required', reason: 'name_missing' });
    expect(friend.message).toMatch(/No full name - book by hand:/);

    // In the website chat there is no team to hand over to.
    typed(`Noor ${TYPED} 0612345678`, WEB);
    const web = await book({ client_name: 'Noor', client_email: HERS, client_phone: '0612345678' }, WEB);
    expect(web).toMatchObject({ error: 'email_required', reason: 'name_missing' });
    expect(web.message).toMatch(/renessence\.com\/booking/);
    expect(web.message).not.toMatch(/request_human_handoff/);
  });
});

describe('review round: the website chat', () => {
  test('a visitor is never found by a phone number — a typed number can be anyone\'s; it only goes on a NEW profile', async () => {
    typed('Vera Visitor vera@guest.fixture 06 1234 5678', WEB);
    // That number is on somebody else's Mindbody profile.
    mindbody.getClientByPhone.mockResolvedValue({ Id: 900, FirstName: 'Somebody', LastName: 'Else', Email: 'somebody.else@guest.fixture' });
    const r = await bookClass({ client_name: 'Vera Visitor', client_email: 'vera@guest.fixture', client_phone: '0612345678' }, WEB);

    expect(r.success).toBe(true);
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.searchClientByEmail).toHaveBeenCalledWith('vera@guest.fixture');
    expect(mindbody.addClient).toHaveBeenCalledWith({ firstName: 'Vera', lastName: 'Visitor', email: 'vera@guest.fixture', mobilePhone: '0612345678', city: 'Amsterdam' });
    expect(mindbody.addClientToClass).toHaveBeenCalledWith(77, 456);
    // Stripe shows the visitor's own address, nobody else's.
    expect(payments.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ clientId: 77, customerEmail: 'vera@guest.fixture' }));
  });

  test('a profile Mindbody says exists already is looked for by the visitor\'s email only', async () => {
    typed('Vera Visitor vera@guest.fixture 06 1234 5678', WEB);
    mindbody.addClient.mockRejectedValue(Object.assign(new Error('exists'), { response: { data: { Error: { Code: 'InvalidClientCreation' } } } }));
    mindbody.searchClientByEmail.mockResolvedValueOnce(null).mockResolvedValue({ Id: 55, FirstName: 'Vera', LastName: 'Visitor', Email: 'vera@guest.fixture', MobilePhone: '+31612345678' });
    const r = await bookClass({ client_name: 'Vera Visitor', client_email: 'vera@guest.fixture', client_phone: '0612345678' }, WEB);
    expect(r.success).toBe(true);
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.addClientToClass).toHaveBeenCalledWith(55, 456);
  });

  test('book_appointment for a new visitor still needs a phone number they typed themselves', async () => {
    typed(`Touriya Fixture ${TYPED}`, WEB);
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS, client_phone: '0612345678' }, WEB); // the model's own number
    expect(r.error).toBe('client_phone_required');
    expect(r.message).toMatch(/only a number they typed/);
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });
});

describe('review round: what Mindbody answers is checked before it is trusted', () => {
  const STRANGER = { Id: '100000001', FirstName: 'Someone', LastName: 'Else', Email: 'someone.else@guest.fixture', Active: true };

  test('a by-id read that comes back with another profile: her address is asked for — a stranger\'s is never taken as hers', async () => {
    mindbody.getClientByPhone.mockResolvedValue({ Id: 8, FirstName: 'Touriya', LastName: 'Fixture' });
    mindbody.getClientById.mockResolvedValue(STRANGER);
    const looked = await tools.toolLookupClient(PHONE);
    expect(looked).toMatchObject({ found: true, clientId: '8', email: null, needs_email: true });
    expect(JSON.stringify(looked)).not.toMatch(/someone\.else/);

    tapConfirm();
    expect(await book()).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('a stored profile id that Mindbody answers with another profile, or with one that is no longer active, is not used', async () => {
    mockContacts.set(PHONE, { email: HERS, full_name: null, mindbody_client_id: '8' });
    mindbody.getClientById.mockResolvedValue(STRANGER);
    mindbody.searchClientByEmail.mockResolvedValue({ ...REAL, Id: 12 });
    tapConfirm();
    expect((await book()).success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 12 }));

    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });
    mindbody.getClientById.mockResolvedValue({ ...REAL, Active: false });
    mindbody.searchClientByEmail.mockResolvedValue({ ...REAL, Id: 13 });
    expect((await book()).success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 13 }));
  });

  test('a full-profile read that fails: she is asked (fail closed), but the team is not told that her profile has no address', async () => {
    mindbody.getClientByPhone.mockResolvedValue({ Id: 8, FirstName: 'Touriya', LastName: 'Fixture' });
    mindbody.getClientById.mockRejectedValue(new Error('timeout of 15000ms exceeded'));
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'email_required', reason: 'missing' });

    typed(TYPED);
    expect((await book({ client_email: HERS })).success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 8, notes: expect.stringContaining(`Email: ${HERS}`) }));
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya Fixture', mindbody_client_id: '8' });
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });

  test('after the team merged her profile away: lookup_client and the booking agree — her address is on file, she is not treated as new', async () => {
    // What the fix stored for "Touriya WhatsApp"; profile 7 is gone, by phone and by id.
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
    const looked = await tools.toolLookupClient(PHONE);
    expect(looked).toMatchObject({ found: true, name: 'Touriya', email: HERS, email_on_file: true });
    expect(looked.needs_name_and_email).toBeUndefined();
    expect(looked.message).toMatch(/Do NOT ask for it again/);

    mindbody.searchClientByEmail.mockResolvedValue({ ...REAL, Id: 12 }); // the merged profile carries her address
    tapConfirm();
    expect((await book()).success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 12 }));
  });
});

describe('review round: only what the GUEST typed counts', () => {
  test('an address that stands only in a message of the bot is not typed by the guest', async () => {
    conversations.addMessage(PHONE, 'assistant', `Is your email address ${HERS}?`);
    typed('yes');
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(r).toMatchObject({ error: 'email_required', reason: 'not_from_guest' });
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });

  test('the team handing the chat back ("__RESUME__ …") is not the guest typing', async () => {
    conversations.addMessage(PHONE, 'user', `__RESUME__ her address is ${HERS}`);
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: HERS });
    expect(r).toMatchObject({ error: 'email_required', reason: 'not_from_guest' });
    expect(mindbody.addClient).not.toHaveBeenCalled();
  });

  test('our own mailbox is never a guest\'s address — not when the guest quotes it, not when it sits on a profile', async () => {
    typed('I mailed welcome@renessence.com yesterday');
    tapConfirm();
    const r = await book({ client_name: 'Touriya Fixture', client_email: 'welcome@renessence.com' });
    expect(r).toMatchObject({ error: 'email_required', reason: 'placeholder' });
    expect(mindbody.addClient).not.toHaveBeenCalled();

    mindbody.getClientByPhone.mockResolvedValue({ ...REAL, Email: 'welcome@renessence.com' });
    expect(await tools.toolLookupClient(PHONE)).toMatchObject({ found: true, email: null, needs_email: true });
  });

  test.each([
    ['no address', ''],
    ['a placeholder', INVENTED],
  ])('a front-desk profile (a normal surname) with %s is asked too — for a treatment and for a class', async (_label, Email) => {
    const profile = { Id: 9, FirstName: 'Touriya', LastName: 'Fixture', Email };
    mindbody.getClientByPhone.mockResolvedValue(profile);
    mindbody.getClientById.mockResolvedValue(profile);
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(await bookClass()).toMatchObject({ error: 'email_required', reason: 'missing' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();

    typed(TYPED);
    expect((await book({ client_email: HERS })).success).toBe(true);
    await flush();
    // This profile really has none: the team is told.
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });
});

describe('review round: what reaches Stripe and the pay-first row', () => {
  const payFirstReady = () => {
    mindbody.findAvailableStaffForTime.mockResolvedValue([100000094]);
    mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map() });
    db.insertPayFirstRow.mockResolvedValue(801);
    payments.createPayFirstCheckout.mockResolvedValue({ sessionId: 'cs_pf', paymentUrl: 'https://pay.stripe.test/cs_pf', expiresAt: Math.floor(Date.now() / 1000) + 1800 });
  };
  const massage = (args = {}) => book({ session_type_id: MASSAGE_60, start_date_time: MASSAGE_SLOT, ...args });
  // Booked first, paid by link afterwards (not pay-first, not paid at reception).
  const ledAddOn = (args = {}) => {
    conversations.set(PHONE, { offeredSlots: [{ sessionTypeId: LED_ADDON, dateTime: SLOT }] });
    return book({ session_type_id: LED_ADDON, ...args });
  };

  test('a returning guest with a real profile: an address the model made up reaches no pay-first checkout', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    payFirstReady();
    tapConfirm();
    expect((await massage({ client_email: PLAUSIBLE })).success).toBe(true);
    expect(payments.createPayFirstCheckout).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: HERS }));
    expect(db.insertPayFirstRow.mock.calls[0][0].payFirst).toMatchObject({ customerEmail: HERS, notes: null });
    // A guest with an address on the profile gets the same row as before this fix.
    expect(db.insertPayFirstRow.mock.calls[0][0].payFirst).not.toHaveProperty('emailNote');
  });

  test('…and no payment link sent afterwards: the link is pre-filled with the address on her profile', async () => {
    mindbody.getClientByPhone.mockResolvedValue(REAL);
    tapConfirm();
    expect(await ledAddOn({ client_email: PLAUSIBLE })).toMatchObject({ success: true, requiresPayment: true });
    expect(conversations.get(PHONE).customerEmail).toBe(HERS);

    payments.createCombinedPaymentLink.mockResolvedValue({ sessionId: 'cs_new', paymentUrl: 'https://pay.stripe.test/cs_new' });
    db.getBookingEventById.mockImplementation(async (id) => ({ id, status: 'pending' }));
    await tools.toolSendPayment(PHONE, { customer_email: PLAUSIBLE });
    expect(payments.createCombinedPaymentLink.mock.calls[0][0].customerEmail).toBe(HERS);
  });

  test('a profile like hers with her address stored: Stripe gets the stored address — never the placeholder on the profile', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    mockContacts.set(PHONE, { email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
    payFirstReady();
    tapConfirm();
    expect((await massage()).success).toBe(true);
    expect(payments.createPayFirstCheckout).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: HERS }));

    conversations.clear(PHONE);
    conversations.set(PHONE, { lang: 'en', userName: 'Touriya' });
    tapConfirm();
    expect((await ledAddOn()).success).toBe(true);
    expect(conversations.get(PHONE).customerEmail).toBe(HERS);
  });

  test('pay-first on a profile without an address: the address she typed travels with the row on its own, not inside the model\'s notes — remembered and the team told when the link is made', async () => {
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    payFirstReady();
    typed(TYPED);
    tapConfirm();
    expect((await massage({ client_email: HERS, notes: 'Add-on requested: LED Light Face Therapy (+€30)' })).success).toBe(true);
    expect(db.insertPayFirstRow.mock.calls[0][0].payFirst).toMatchObject({
      clientId: '7', customerEmail: HERS, emailNote: `Email: ${HERS}`, notes: 'Add-on requested: LED Light Face Therapy (+€30)',
    });
    // The payment webhook has no chat to read: both happen here.
    await flush();
    expect(mockContacts.get(PHONE)).toEqual({ email: HERS, full_name: 'Touriya', mindbody_client_id: '7' });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });
});

// ── The words the model reads ────────────────────────────────────────────────

describe('tool descriptions and prompt', () => {
  const tool = (name) => TOOLS.find(t => t.function.name === name).function;

  test('no email field is required, and each one says: only what the customer typed', () => {
    for (const [name, field] of [['book_appointment', 'client_email'], ['book_class', 'client_email'], ['send_payment', 'customer_email'], ['request_human_handoff', 'customer_email'], ['forward_reschedule_request', 'customer_email'], ['forward_gift_card_request', 'customer_email']]) {
      const t = tool(name);
      expect(t.parameters.required || []).not.toContain(field);
      expect(t.parameters.properties[field].description).toMatch(/typed/);
      expect(t.parameters.properties[field].description).toMatch(/[Nn]ever invent|NEVER invent/);
    }
    expect(tool('book_appointment').parameters.properties.client_name.description).toMatch(/never make up a surname/i);
    expect(tool('lookup_client').description).toMatch(/still need to ask/);
  });

  test('the texts agree on when client_email may be left out: only when lookup_client said email_on_file', async () => {
    // They used to say "leave it out for a returning guest" — also for one whose
    // profile has no address, who had just typed it and was then asked again.
    for (const name of ['book_appointment', 'book_class']) {
      const d = tool(name).parameters.properties.client_email.description;
      expect(d).toMatch(/Leave it out only when lookup_client said email_on_file/);
      expect(d).not.toMatch(/Leave it out for a returning guest/);
    }
    mindbody.getClientByPhone.mockResolvedValue(POLLUTED);
    const looked = await tools.toolLookupClient(PHONE);
    expect(looked.needs_email).toBe(true);
    expect(looked.message).toMatch(/pass it as client_email/);
    expect(buildSystemPrompt(PHONE, 'Touriya')).toMatch(/`needs_email` → ask for their email address first \(ui_type "none"\) and pass what they type as client_email/);
  });

  test('the prompt follows the lookup result, forbids invented addresses and shows a new address in the summary', () => {
    const p = buildSystemPrompt(PHONE, 'Touriya');
    expect(p).toMatch(/email_on_file/);
    expect(p).toMatch(/needs_email/);
    expect(p).toMatch(/needs_name_and_email/);
    expect(p).toMatch(/Email addresses are never invented/);
    expect(p).toMatch(/📧/);
    // All of it in the shared prefix: nothing per guest before "## Session".
    expect(p.indexOf('Email addresses are never invented')).toBeLessThan(p.lastIndexOf('\n## Session\n'));
    const web = buildSystemPrompt(WEB, null);
    expect(web.slice(web.lastIndexOf('\n## Session\n'))).toMatch(/## Web chat/);
  });
});
