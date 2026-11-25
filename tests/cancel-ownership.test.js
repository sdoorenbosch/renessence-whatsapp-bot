// Security audit, 25 Nov 2026: cancel_appointments only cancels appointments
// of the guest in this chat. The ids come from the model, and the model reads
// untrusted text, so before this gate any appointment id (guessed, or typed
// into the chat) could be cancelled once the guest tapped "Yes, cancel it".
// Allowed: what get_appointments showed this sender (it only lists profiles
// that carry the sender's own number) and what was booked in this chat.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}), sendCTAButton: jest.fn().mockResolvedValue({}), sendImage: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/email.service', () => ({
  sendEscalationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendCancellationNotificationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendRefundNotificationEmail: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../src/services/mindbody.service', () => ({
  getAllClientsByPhone: jest.fn().mockResolvedValue([]),
  getClientByPhone: jest.fn().mockResolvedValue(null),
  searchClientByName: jest.fn().mockResolvedValue(null),
  getStaffAppointments: jest.fn().mockResolvedValue([]),
  cancelAppointment: jest.fn().mockResolvedValue({ Status: 'Cancelled' }),
}));
jest.mock('../src/data/database', () => ({
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  logError: jest.fn().mockResolvedValue(true),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  markConversationEscalated: jest.fn(),
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');

const PHONE = '31600000077';
const OTHER = '31600000078';
const OWN = { Id: 8101, StartDateTime: '2026-12-20T10:00:00', SessionType: { Name: 'Tailored Massage 60 min' } };

beforeEach(() => {
  jest.clearAllMocks();
  conversations.clear(PHONE);
  conversations.clear(OTHER);
  mindbody.cancelAppointment.mockResolvedValue({ Status: 'Cancelled' });
});

const tapYesCancel = (phone, extra = {}) => conversations.set(phone, { lang: 'en', cancelConfirmedAt: Date.now(), ...extra });

describe('cancel_appointments: only the guest\'s own appointments', () => {
  test('an id this guest was never shown is refused, nothing reaches Mindbody', async () => {
    tapYesCancel(PHONE);
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [999999] });
    expect(r.error).toBe('appointment_not_verified');
    expect(r.refused).toEqual([999999]);
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });

  test('the refusal keeps the tap: after get_appointments the same confirmation still cancels', async () => {
    tapYesCancel(PHONE);
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [OWN.Id] })).error).toBe('appointment_not_verified');

    mindbody.getAllClientsByPhone.mockResolvedValue([{ Id: 7, MobilePhone: PHONE }]);
    mindbody.getStaffAppointments.mockResolvedValue([OWN]);
    await tools.toolGetAppointments(PHONE, { client_email: 'guest@example.com' });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [OWN.Id] });
    expect(r.cancelled).toEqual([OWN.Id]);
    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(OWN.Id);
  });

  test('what another sender was shown does not count for this sender', async () => {
    conversations.set(OTHER, { knownAppointments: { [OWN.Id]: { dateTime: OWN.StartDateTime } } });
    tapYesCancel(PHONE);
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [OWN.Id] });
    expect(r.error).toBe('appointment_not_verified');
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });

  test('a mix: the own one is cancelled, the foreign one refused and named', async () => {
    tapYesCancel(PHONE, { knownAppointments: { [OWN.Id]: { dateTime: OWN.StartDateTime, serviceName: 'Tailored Massage 60 min' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [OWN.Id, 424242] });
    expect(r.cancelled).toEqual([OWN.Id]);
    expect(r.refused).toEqual([424242]);
    expect(r.refused_note).toMatch(/NOT cancelled/);
    expect(mindbody.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(OWN.Id);
  });

  test('an appointment booked in this chat may be cancelled', async () => {
    tapYesCancel(PHONE, { pendingBookings: [{ appointment_id: 8202, booking_event_id: 1 }] });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [8202] });
    expect(r.cancelled).toEqual([8202]);
  });

  test('ids as strings or numbers match the same appointment', async () => {
    tapYesCancel(PHONE, { knownAppointments: { 8101: { dateTime: OWN.StartDateTime } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: ['8101'] });
    expect(r.cancelled).toEqual(['8101']);
  });

  test('without the tap the confirmation gate still answers first', async () => {
    conversations.set(PHONE, { knownAppointments: { [OWN.Id]: { dateTime: OWN.StartDateTime } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [OWN.Id] });
    expect(r.error).toBe('confirmation_required');
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });
});
