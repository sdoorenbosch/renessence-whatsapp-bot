// Security review of the November fixes (24 Nov 2026): an email address the
// guest TYPED was treated as proof that the Mindbody profile carrying it is
// theirs. Anyone who knew a guest's address could type it on WhatsApp, have
// the bot book on that guest's profile (and remember the profile for their
// own number), or ask "which appointments do I have?" and see that guest's
// appointments. Before the fix it was worse: the model's own word was enough.
//
// The team chose the simple rule (Sam, 24 Nov 2026): a profile found by email,
// name or another phone number is only used when THIS WhatsApp number is on
// it. Otherwise nothing is booked or shown and the team takes over. In the
// website chat there is no number to trust: the profile must carry a phone
// number the visitor typed.
//
// Every name, address and number in this file is made up.

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
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
}));
jest.mock('../src/services/mindbody.service', () => {
  const actual = jest.requireActual('../src/services/mindbody.service');
  return {
    RESOURCE_MAP: actual.RESOURCE_MAP,
    isStaffRejection: actual.isStaffRejection,
    isRoomRejection: actual.isRoomRejection,
    getClientByPhone: jest.fn(),
    getAllClientsByPhone: jest.fn(),
    getClientById: jest.fn(),
    searchClientByEmail: jest.fn(),
    searchClientByName: jest.fn(),
    addClient: jest.fn(),
    addAppointment: jest.fn(),
    addClientToClass: jest.fn(),
    removeClientFromClass: jest.fn().mockResolvedValue({}),
    findClientAppointmentAt: jest.fn().mockResolvedValue(null),
    findAvailableStaffForTime: jest.fn().mockResolvedValue([]),
    getRoomOccupancy: jest.fn(),
    invalidateRoomOccupancy: jest.fn(),
    getStaff: jest.fn().mockResolvedValue([]),
    getStaffAppointments: jest.fn(),
    getSessionTypeNames: jest.fn().mockResolvedValue({}),
  };
});
jest.mock('../src/services/payment.service', () => ({
  ...jest.requireActual('../src/services/payment.service'),
  createCombinedPaymentLink: jest.fn(),
  createPaymentLink: jest.fn(),
  createPayFirstCheckout: jest.fn(),
}));
jest.mock('../src/data/database', () => ({
  getGuestContact: jest.fn().mockResolvedValue(null),
  saveGuestContact: jest.fn().mockResolvedValue(),
  getGuestTypedTexts: jest.fn().mockResolvedValue([]),
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn().mockResolvedValue(),
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  logError: jest.fn().mockResolvedValue(true),
  logBookingEvent: jest.fn().mockResolvedValue(501),
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
  getConversationStatus: jest.fn().mockResolvedValue(null),
  isHumanHandling: jest.fn().mockResolvedValue(false),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../src/data/database');
const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');

const PHONE = '31600000077';           // the guest writing on WhatsApp
const WEB = 'web_ownership';
const SAUNA = 65;
const SLOT = '2026-11-26T14:00:00';
const TYPED = 'noor.owner@guest.fixture';

// Somebody else's profile that carries the typed address.
const STRANGER = { Id: 501, FirstName: 'Rosa', LastName: 'Stranger', Email: TYPED, MobilePhone: '+31699999999', Active: true };
// The guest's own profile, found by email, with her number written the Dutch way.
const OWN_BY_EMAIL = { Id: 502, FirstName: 'Noor', LastName: 'Owner', Email: TYPED, MobilePhone: '06 0000 0077', Active: true };
// A profile without any phone number.
const NO_PHONE = { Id: 503, FirstName: 'Noor', LastName: 'Owner', Email: TYPED, Active: true };

const typed = (text, from = PHONE) => conversations.addMessage(from, 'user', text);
const tapConfirm = (from = PHONE) => conversations.set(from, { bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
const book = (args = {}, from = PHONE) => tools.toolBookAppointment(from, { session_type_id: SAUNA, start_date_time: SLOT, staff_id: 100000094, client_name: 'Noor Owner', client_email: TYPED, ...args });
const bookClass = (args = {}, from = PHONE) => tools.toolBookClass(from, { class_id: 456, session_type_id: 83, class_name: 'Vinyasa Flow', class_date_time: '2026-11-27T09:00:00', client_name: 'Noor Owner', client_email: TYPED, ...args });
const flat = (id, start) => ({ Id: id, Status: 'Booked', StartDateTime: start, EndDateTime: start, SessionTypeId: 65, StaffId: 11, ClientId: 501, Notes: '' });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 10, 24, 16, 0));
  jest.clearAllMocks();
  for (const from of [PHONE, WEB]) {
    conversations.clear(from);
    tools.cancelAutoPaymentLink(from);
    conversations.set(from, { lang: 'en', userName: 'Noor', offeredSlots: [{ sessionTypeId: SAUNA, dateTime: SLOT }] });
  }
  typed(`my email is ${TYPED}`);
  typed(`my email is ${TYPED}`, WEB);
  mindbody.getClientByPhone.mockResolvedValue(null);
  mindbody.getAllClientsByPhone.mockResolvedValue([]);
  mindbody.getClientById.mockResolvedValue(null);
  mindbody.searchClientByEmail.mockResolvedValue(STRANGER);
  mindbody.searchClientByName.mockResolvedValue(null);
  mindbody.addClient.mockImplementation(async ({ firstName, lastName, email }) => ({ Id: 77, FirstName: firstName, LastName: lastName, Email: email }));
  mindbody.addAppointment.mockResolvedValue({ Id: 9001 });
  mindbody.addClientToClass.mockResolvedValue({ Id: 1 });
  mindbody.getStaffAppointments.mockResolvedValue([flat(7001, '2026-11-26T10:00:00')]);
});
afterEach(() => {
  tools.cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

describe('booking: a profile found by email must carry this WhatsApp number', () => {
  test('somebody else\'s profile with the typed address: nothing booked, nothing remembered, nothing said about that profile', async () => {
    tapConfirm();
    const r = await book();
    expect(r).toMatchObject({ error: 'profile_not_linked', nothing_booked: true });
    expect(r.message).toMatch(/request_human_handoff/);
    expect(JSON.stringify(r)).not.toMatch(/Rosa|Stranger|501/);
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(mindbody.addClient).not.toHaveBeenCalled();
    expect(db.saveGuestContact).not.toHaveBeenCalled();
  });

  test('her own profile, found by email, with her number written another way: booked on it', async () => {
    mindbody.searchClientByEmail.mockResolvedValue(OWN_BY_EMAIL);
    tapConfirm();
    const r = await book();
    expect(r.success).toBe(true);
    expect(mindbody.addAppointment).toHaveBeenCalledWith(expect.objectContaining({ clientId: 502 }));
  });

  test('a profile with the address but no phone number at all: the team takes over', async () => {
    mindbody.searchClientByEmail.mockResolvedValue(NO_PHONE);
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'profile_not_linked' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('a returning guest found by her number books exactly as before', async () => {
    mindbody.getClientByPhone.mockResolvedValue({ ...OWN_BY_EMAIL, MobilePhone: undefined });
    tapConfirm();
    const r = await book();
    expect(r.success).toBe(true);
    expect(mindbody.getClientByPhone).toHaveBeenCalledWith(PHONE, null);
    expect(mindbody.searchClientByEmail).not.toHaveBeenCalled();
  });

  test('creating a new profile fails because the address exists elsewhere: never falls back to that profile', async () => {
    mindbody.searchClientByEmail.mockResolvedValue(null);
    mindbody.addClient.mockRejectedValue({ response: { data: { Error: { Code: 'InvalidClientCreation' } } } });
    mindbody.getClientByPhone.mockImplementation(async (phone, mail) => (mail ? STRANGER : null));
    tapConfirm();
    expect(await book()).toMatchObject({ error: 'profile_not_linked' });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('a class: the same rule', async () => {
    expect(await bookClass()).toMatchObject({ error: 'profile_not_linked' });
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();
    mindbody.searchClientByEmail.mockResolvedValue(OWN_BY_EMAIL);
    await bookClass();
    expect(mindbody.addClientToClass).toHaveBeenCalled();
  });

  test('website chat: the profile must carry a number the visitor typed', async () => {
    mindbody.searchClientByEmail.mockResolvedValue(OWN_BY_EMAIL);
    expect(await bookClass({}, WEB)).toMatchObject({ error: 'profile_not_linked' });
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();
    typed('my number is 06 0000 0077', WEB);
    await bookClass({ client_phone: '0600000077' }, WEB);
    expect(mindbody.addClientToClass).toHaveBeenCalled();
  });
});

describe('"which appointments do I have?": only profiles that carry this number', () => {
  const lookUp = (args, from = PHONE) => tools.toolGetAppointments(from, { customer_expects: '', ...args });

  test('somebody else\'s profile found by the typed email: no appointments shown, the team checks', async () => {
    mindbody.getClientByPhone.mockResolvedValue(STRANGER);
    const r = await lookUp({ client_email: TYPED });
    expect(r.status).toBe('not_linked');
    expect(r.appointments).toBeUndefined();
    expect(mindbody.getStaffAppointments).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/Rosa|Stranger|501/);
    expect(r.instruction).toMatch(/request_human_handoff/);
  });

  test('her own profile found by email (her number is on it): shown', async () => {
    mindbody.getClientByPhone.mockResolvedValue(OWN_BY_EMAIL);
    const r = await lookUp({ client_email: TYPED });
    expect(r.appointments).toHaveLength(1);
    expect(mindbody.getStaffAppointments).toHaveBeenCalledWith(expect.any(String), expect.any(String), 502);
  });

  test('her number finds her own profile and the email finds somebody else: only her own appointments', async () => {
    mindbody.getAllClientsByPhone.mockImplementation(async (p) => (p === PHONE ? [{ ...OWN_BY_EMAIL, MobilePhone: undefined }] : []));
    mindbody.getClientByPhone.mockResolvedValue(STRANGER);
    const r = await lookUp({ client_email: TYPED });
    expect(r.appointments).toHaveLength(1);
    expect(mindbody.getStaffAppointments).toHaveBeenCalledTimes(1);
    expect(mindbody.getStaffAppointments).toHaveBeenCalledWith(expect.any(String), expect.any(String), 502);
  });

  test('a name search or another number that finds somebody else: nothing shown', async () => {
    mindbody.searchClientByName.mockResolvedValue(STRANGER);
    expect((await lookUp({ client_name: 'Rosa Stranger' })).status).toBe('not_linked');
    mindbody.searchClientByName.mockResolvedValue(null);
    mindbody.getAllClientsByPhone.mockImplementation(async (p) => (p === '0699999999' ? [STRANGER] : []));
    expect((await lookUp({ client_phone: '0699999999' })).status).toBe('not_linked');
    expect(mindbody.getStaffAppointments).not.toHaveBeenCalled();
  });

  test('website chat: email AND a typed number on the same profile', async () => {
    mindbody.getClientByPhone.mockResolvedValue(OWN_BY_EMAIL);
    expect((await lookUp({ client_email: TYPED }, WEB)).status).toBe('not_linked');
    typed('06 0000 0077', WEB);
    const r = await lookUp({ client_email: TYPED, client_phone: '0600000077' }, WEB);
    expect(r.appointments).toHaveLength(1);
  });
});
