// Regression for "Shanta" (Sun 1 Nov 2026). At 06:52 she wrote that she would
// not make her 09:00 appointment that day: she was in too much pain to come.
// The bot answered "Geen zorgen, we kunnen je afspraak verschuiven. Onze grace
// period … is 5 minuten, maar in jouw geval … zullen we er flexibel mee omgaan.
// Ik heb het voor je gemeld…" — a reply with no tool call at all. So a free,
// flexible move was promised two hours before the start, and "I have reported
// it" was said although the bot had alerted nobody.
//
// The team (Fabiana): appointments cancelled or rescheduled within 24 hours
// are charged in full; someone else may come in the guest's place, or the
// guest can provide medical proof to REQUEST an exception. Warm and
// understanding is fine — promising flexibility or a free move is not.
//
// Each block pins one part of the fix:
//  1. the reply of 1 Nov is not sent: the loop bounces it once and the model
//     has to state the policy and alert the team (a model that insists is
//     sent, with the chat flagged for the team)
//  2. the promise check itself, as a table — it catches known phrasings only
//  3. the team can be alerted without an email on WhatsApp ("I have reported
//     it" used to be said while the handoff was refused for a missing email)
//  4. cancel_appointments: the server decides "inside 24 hours", the model's
//     flag is only a hint — a forgotten flag no longer promises a refund
//  5. get_appointments: a visit last week is not "within 24 hours"; what it
//     showed is remembered for the cancel
//  6. the words: prompt, knowledge base, reminder and confirmation email
//
// What Jest cannot show: whether the real model picks the new prompt section.
// Block 1 scripts the model; the bounce is the only part code can guarantee.
//
// Tests marked "Found in review of the fix" pin what the reviewers of this
// change broke or found unpinned (a promise next to the guest's own "niet",
// bold marks, promises in the team's name, correct policy answers bounced,
// a no-show from yesterday refunded, a second respond call left unanswered).

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
  cancelAppointment: jest.fn().mockResolvedValue({}),
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
  getBookingEventById: jest.fn().mockResolvedValue(null),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  markConversationEscalated: jest.fn(),
  getConversationStatus: jest.fn().mockResolvedValue(null),
  setConversationLanguage: jest.fn().mockResolvedValue(),
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn(),
  hasReminderBeenSent: jest.fn().mockResolvedValue(false),
  logReminder: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));
// Only book_appointment is replaced (to stand in for a pay-first link made in
// the same turn); every tool this file is about runs for real.
jest.mock('../src/agents/tool-implementations', () => ({
  ...jest.requireActual('../src/agents/tool-implementations'),
  toolBookAppointment: jest.fn(),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const email = require('../src/services/email.service');
const mindbody = require('../src/services/mindbody.service');
const payFirst = require('../src/services/pay-first.service');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');
const agent = require('../src/agents/renessence.agent');
const { TOOLS } = require('../src/agents/tool-definitions');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { checkReply, PROMISE_PATTERNS } = require('../src/agents/reply-guards');

const PHONE = '31600000063';
const WEB = 'web_shanta';

// What the bot sent on 1 Nov (first name only; nothing else of the guest's).
const REPLY_OF_1_NOV = 'Goedemorgen Shanta, wat vervelend om te horen dat je pijn hebt. 🌿 Geen zorgen, we kunnen je afspraak verschuiven. Onze grace period voor massages en spa behandelingen is 5 minuten, maar in jouw geval, gezien de situatie, zullen we er flexibel mee omgaan.\n\nIk heb het voor je gemeld en ons team neemt spoedig contact met je op om te kijken hoe we dit kunnen oplossen. Sterkte en een voorspoedig herstel! 🙏';
// What the team wants said instead.
const POLICY_REPLY = 'Goedemorgen Shanta, wat vervelend — ik wens je veel beterschap. Binnen 24 uur voor aanvang wordt een afspraak volledig in rekening gebracht. Er mag wel iemand anders in jouw plaats komen, en met een medisch bewijs kun je ons team om een uitzondering vragen; het team bekijkt elk verzoek. Ik heb je bericht doorgegeven aan ons team, zij nemen hier contact met je op. Aan je afspraak is nog niets gewijzigd.';
const GUEST_MESSAGE = 'Goedemorgen, ik ga het niet redden voor mijn afspraak vandaag om 9 uur. Ik heb veel pijn. Mijn excuses.';
const HANDOFF_REASON = 'Can\'t come / late change: "ik ga het niet redden voor mijn afspraak vandaag om 9 uur" — today 09:00, illness';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const respond = (id, message, extra = {}) => call(id, 'respond', { message, ui_type: 'none', detected_language: 'nl', ...extra });
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
const needsReplyReasons = () => db.markConversationEscalated.mock.calls.map(c => c[1]);
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 10, 1, 6, 52)); // Sun 1 Nov 2026, 06:52 Amsterdam
  jest.clearAllMocks();
  conversations.clear(PHONE);
  conversations.clear(WEB);
  db.query.mockImplementation(async () => ({ rows: [] }));
  db.getConversationStatus.mockResolvedValue(null);
  mindbody.cancelAppointment.mockResolvedValue({});
});
afterEach(() => jest.useRealTimers());

// ── 1. The turn of 1 Nov ─────────────────────────────────────────────────────

describe('the reply of 1 Nov is not sent', () => {
  test('a promise with no tool call is bounced; the policy and a handoff go out instead', async () => {
    script(
      [respond('r1', REPLY_OF_1_NOV)],
      [call('h', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r2', POLICY_REPLY)],
    );
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(sentTexts()).toEqual([POLICY_REPLY]);
    // The model was told why its first reply did not go out.
    const bounced = toolResults().r1;
    expect(bounced).toMatchObject({ sent: false, error: 'promise_not_allowed' });
    expect(bounced.message).toMatch(/^NOT sent\./);
    expect(bounced.message).toMatch(/request_human_handoff/);
    expect(toolResults().r2).toEqual({ sent: true });
    // The team was alerted, without an email address, exactly once.
    expect(toolResults().h).toEqual({ sent: true });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: PHONE, customerEmail: null, message: HANDOFF_REASON }));
    expect(needsReplyReasons()).toEqual([expect.stringMatching(/^Handoff: Can't come \/ late change:/)]);
    // Only the reply that went out is remembered as said.
    expect(conversations.getMessages(PHONE).filter(m => m.role === 'assistant').map(m => m.content)).toEqual([POLICY_REPLY]);
  });

  test('a model that repeats the promise is sent the second time — and the chat is flagged for the team', async () => {
    script([respond('r1', REPLY_OF_1_NOV)], [respond('r2', REPLY_OF_1_NOV)]);
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(sentTexts()).toEqual([REPLY_OF_1_NOV]);
    expect(toolResults().r2).toEqual({ sent: true });
    expect(needsReplyReasons()).toEqual(['Check bot reply: possible promise about a late change']);
    expect(db.logError).toHaveBeenCalledWith('promise_reply_sent', expect.stringContaining(PHONE), '', expect.stringContaining('flexibel'));
  });

  test('a handoff that already went out is not repeated after the bounce (once per turn, not per model message)', async () => {
    script(
      [call('h1', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r1', REPLY_OF_1_NOV)],
      [call('h2', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r2', POLICY_REPLY)],
    );
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(toolResults().h2).toMatchObject({ skipped: true });
    expect(sentTexts()).toEqual([POLICY_REPLY]);
  });

  test('a forward that was refused may be tried again in the same turn', async () => {
    // Nothing reached the team the first time, so "already ran" would be a lie.
    script(
      [call('f1', 'forward_reschedule_request', { new_date: 'zondag 29 november' })],
      [call('f2', 'forward_reschedule_request', { new_date: 'zondag 29 november', treatment: 'Tailored Massage' }), respond('r', 'Ik heb je verzoek doorgegeven aan ons team.')],
    );
    await agent.run(PHONE, 'Shanta', 'Kan het naar 29 november?');

    expect(toolResults().f1).toMatchObject({ sent: false, error: 'missing_details' });
    expect(toolResults().f2).toEqual({ sent: true });
    expect(email.sendRescheduleRequestEmail).toHaveBeenCalledTimes(1);
  });

  test('a pay-first link made in this turn is never held back by the check', async () => {
    tools.toolBookAppointment.mockImplementation(async (from) => {
      conversations.update(from, { payFirstLinkPending: { rowId: 501, text: 'Betaal via de link hieronder.', ctaLabel: 'Betaal & boek', url: 'https://checkout.stripe.com/c/pay/cs_test_a1' } });
      return { success: true, payFirst: true };
    });
    script([
      call('b', 'book_appointment', { session_type_id: 31, start_date_time: '2026-11-08T10:00:00' }),
      respond('r', 'We zullen flexibel omgaan met je afspraak — hier is je betaallink.'),
    ]);
    await agent.run(PHONE, 'Shanta', 'Bevestig & betaal');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(PHONE, 'Betaal via de link hieronder.', 'Betaal & boek', 'https://checkout.stripe.com/c/pay/cs_test_a1');
    expect(toolResults().r).toEqual({ sent: true });
  });

  test('a payment-link reply in the website chat is never held back either', async () => {
    script([respond('r', 'We can move your appointment — here is your payment link.', { ui_type: 'cta_button', cta_label: 'Pay Now', cta_url: 'https://checkout.stripe.com/c/pay/cs_test_b2', detected_language: 'en' })]);
    const reply = await agent.runWeb('shanta', 'Send payment link');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply).toMatchObject({ ui_type: 'cta_button', cta_url: 'https://checkout.stripe.com/c/pay/cs_test_b2' });
  });

  test('website chat: the promise is bounced there as well, and the visitor gets the rewritten reply', async () => {
    script([respond('r1', 'No worries, we can move your appointment.', { detected_language: 'en' })], [respond('r2', 'Our team looks at every request.', { detected_language: 'en' })]);
    const reply = await agent.runWeb('shanta', 'I can\'t make it today');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(reply.message).toBe('Our team looks at every request.');
  });

  test('on the last round of the loop the reply is sent rather than bounced into the fallback text', async () => {
    const rounds = Array.from({ length: 7 }, (_, i) => [call(`g${i}`, 'check_gift_card', { gift_card_number: '12345' })]);
    script(...rounds, [respond('r', REPLY_OF_1_NOV)]);
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(sentTexts()).toEqual([REPLY_OF_1_NOV]);
    expect(needsReplyReasons()).toEqual(['Check bot reply: possible promise about a late change']);
  });

  // Found in review of the fix. Until the bounce existed the turn ended with the
  // first respond call, so a second one in the same model message never needed
  // an answer. Now the loop goes on — and the model API refuses a request in
  // which a tool call has no result: the guest would get "Something went wrong".
  test('a bounced reply answers every respond call of that model message', async () => {
    script(
      [respond('r1', REPLY_OF_1_NOV), respond('r1b', 'Sterkte en beterschap!')],
      [call('h', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r2', POLICY_REPLY)],
    );
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    const sent = mockCreate.mock.calls[1][0].messages;
    const asked = sent.filter(m => m.role === 'assistant').flatMap(m => (m.tool_calls || []).map(tc => tc.id));
    const answered = new Set(sent.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    expect(asked).toEqual(expect.arrayContaining(['r1', 'r1b']));
    expect(asked.filter(id => !answered.has(id))).toEqual([]);
    expect(toolResults().r1b).toMatchObject({ sent: false });
    expect(sentTexts()).toEqual([POLICY_REPLY]);
  });

  // Found in review of the fix: six tool rounds, the promise in round 7
  // (bounced), and in the last round the model does what the bounce asked for
  // first — the handoff — without a reply. The guest got "No availability was
  // found for that date" from the loop's fallback.
  test('a bounced reply is still the answer when the model runs out of rounds without writing a new one', async () => {
    const rounds = Array.from({ length: 6 }, (_, i) => [call(`g${i}`, 'check_gift_card', { gift_card_number: '12345' })]);
    script(...rounds, [respond('r', REPLY_OF_1_NOV)], [call('h', 'request_human_handoff', { reason: HANDOFF_REASON })]);
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(mockCreate).toHaveBeenCalledTimes(8);
    expect(sentTexts()).toEqual([REPLY_OF_1_NOV]);
    expect(needsReplyReasons().at(-1)).toMatch(/Check bot reply: possible promise about a late change/);
    expect(db.logError).toHaveBeenCalledWith('promise_reply_sent', expect.any(String), '', expect.any(String));
  });

  test('a reply held back earlier is not sent after all once another reply went out', async () => {
    // A payment link with a new booking does not end the turn (a second link
    // may follow); when the rounds then run out, the bounced text stays unsent.
    tools.toolBookAppointment.mockResolvedValue({ success: true });
    const rounds = Array.from({ length: 6 }, (_, i) => [call(`g${i}`, 'check_gift_card', { gift_card_number: '12345' })]);
    script(
      [respond('r1', REPLY_OF_1_NOV)],
      [call('b', 'book_appointment', { session_type_id: 31, start_date_time: '2026-11-08T10:00:00' }), respond('r2', 'Betaal via de link hieronder.', { ui_type: 'cta_button', cta_label: 'Betaal', cta_url: 'https://pay.example.com/abc' })],
      ...rounds,
    );
    await agent.run(PHONE, 'Shanta', 'Bevestig & betaal');

    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
    expect(sentTexts()).not.toContain(REPLY_OF_1_NOV);
    expect(db.logError).not.toHaveBeenCalledWith('promise_reply_sent', expect.anything(), expect.anything(), expect.anything());
  });

  // Found in review of the fix: the dashboard keeps ONE reason per guest, the
  // last one written. "Check bot reply" replaced "Handoff: Can't come / late
  // change: … today 09:00, illness" — the line the front desk needed.
  test('the "check bot reply" flag is added to the reason already standing, not written over it', async () => {
    db.getConversationStatus.mockResolvedValue({ needs_reply: true, needs_reply_reason: `Handoff: ${HANDOFF_REASON}` });
    script(
      [call('h', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r1', REPLY_OF_1_NOV)],
      [respond('r2', REPLY_OF_1_NOV)],
    );
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(sentTexts()).toEqual([REPLY_OF_1_NOV]);
    expect(needsReplyReasons().at(-1)).toBe(`Handoff: ${HANDOFF_REASON} · Check bot reply: possible promise about a late change`);
  });

  test('…and a chat the team already closed gets the plain flag', async () => {
    db.getConversationStatus.mockResolvedValue({ needs_reply: false, needs_reply_reason: 'Handoff: something from last week' });
    script([respond('r1', REPLY_OF_1_NOV)], [respond('r2', REPLY_OF_1_NOV)]);
    await agent.run(PHONE, 'Shanta', GUEST_MESSAGE);

    expect(needsReplyReasons()).toEqual(['Check bot reply: possible promise about a late change']);
  });

  test('an ordinary reply goes out untouched, in one round', async () => {
    script([respond('r', 'Ja, we zijn op zondag open van 09:00 tot 18:00 uur.')]);
    await agent.run(PHONE, 'Shanta', 'Zijn jullie op zondag open?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual(['Ja, we zijn op zondag open van 09:00 tot 18:00 uur.']);
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
  });
});

// ── 2. The promise check ─────────────────────────────────────────────────────

describe('the promise check', () => {
  const verdict = (message) => checkReply(PHONE, { message, ui_type: 'none' }, {});

  test.each([
    ['the reply of 1 Nov', REPLY_OF_1_NOV],
    ['NL: we can move your appointment', 'Geen zorgen, we kunnen je afspraak verschuiven.'],
    ['NL: without the comma', 'Geen probleem we kunnen je afspraak verzetten naar volgende week.'],
    ['NL: inverted word order', 'Wat vervelend! Dan kunnen we je afspraak kosteloos verzetten.'],
    ['NL: I will move it', 'Ik zal je afspraak verplaatsen naar volgende week.'],
    ['NL: rebook', 'We zullen je behandeling omboeken naar een andere dag.'],
    ['NL: flexible', 'Gezien de situatie zullen we er flexibel mee omgaan, je afspraak blijft staan.'],
    ['NL: coulant', 'Voor je afspraak van vandaag zijn we natuurlijk coulant.'],
    ['NL: an exception will be made', 'We zullen voor je afspraak een uitzondering maken.'],
    ['NL: we make an exception', 'In jouw geval maken we een uitzondering voor deze behandeling.'],
    ['NL: by way of exception', 'Bij wijze van uitzondering brengen we je afspraak niet in rekening.'],
    ['EN: we can move your appointment', 'No worries, we can move your appointment to another day.'],
    ['EN: without the comma', 'No worries we can move your appointment.'],
    ['EN: we\'ll reschedule', 'I\'m sorry to hear that! We\'ll reschedule your appointment free of charge.'],
    ['EN: I will shift it', 'I will shift your booking to next week at no extra cost.'],
    ['EN: happy to move', 'We\'d be happy to move your treatment to a later date.'],
    ['EN: move it', 'About your appointment today: we can move it for you.'],
    ['EN: flexible', 'Given the situation we\'ll be flexible with your appointment.'],
    ['EN: the team will be flexible', 'Our team will be flexible about your session today.'],
    ['EN: make an exception', 'In your case we will make an exception for this appointment.'],
    ['EN: making an exception', 'We are making an exception for your booking.'],
    ['EN: grace period', 'Our grace period for your treatment is 15 minutes.'],
    ['EN: grace period, also when it is denied (the bot never needs the term)', 'We do not have a grace period for your treatment.'],
    ['EN: grace period, however hedged', 'Perhaps a grace period applies to your treatment.'],
    // Found in review of the fix. The guest's own "can't / niet" earlier in the
    // sentence is not a denial of the promise (she wrote "ik ga het niet redden"):
    ['NL: after the guest\'s own "niet"', 'Omdat je niet kunt komen kunnen we je afspraak verzetten naar een andere dag.'],
    ['NL: "niet redt"', 'Nu je het vandaag niet redt kunnen we je afspraak kosteloos verzetten.'],
    ['NL: "niet erg", no comma', 'Dat is helemaal niet erg we kunnen je afspraak gewoon verzetten.'],
    ['NL: if you can\'t come, an exception', 'Als je vandaag niet kunt komen dan maken we een uitzondering voor je afspraak.'],
    ['NL: only this once', 'Alleen deze keer maken we een uitzondering voor je afspraak.'],
    ['EN: after the guest\'s own "can\'t"', 'Since you can\'t make it today we can move your appointment to next week.'],
    ['EN: you can\'t come, so', 'You can\'t come today so we can move your appointment to another day.'],
    ['EN: if you can\'t make it', 'If you can\'t make it we can move your appointment.'],
    ['EN: the guest\'s "can\'t" and the promise share one subject', 'We see you can\'t come and will make an exception for your appointment.'],
    ['EN: only this once', 'Only this once we will make an exception for your appointment.'],
    ['EN: a denial in the sentence before', 'I\'m sorry you can\'t make it. No worries, we can move your appointment.'],
    ['EN: "can\'t promise" in the sentence before is about something else', 'I can\'t promise a refund. No worries, we can move your appointment.'],
    ['EN: a kind wish first', 'We hope you feel better soon and will make an exception for your appointment.'],
    ['NL: "of" meaning "or"', 'Je kunt iemand anders sturen, of we kunnen je afspraak verzetten.'],
    ['NL: "zo snel mogelijk" is not "possibly"', 'Geen zorgen, ons team zal je afspraak zo snel mogelijk verzetten.'],
    // …WhatsApp bold or italics inside the phrase:
    ['NL: bold around the appointment', 'Geen zorgen, we kunnen je *afspraak* verschuiven.'],
    ['NL: bold around "kosteloos"', 'Geen zorgen, we kunnen je afspraak *kosteloos* verzetten naar een andere dag.'],
    ['EN: bold around the verb', 'No worries, we can **move** your appointment.'],
    ['EN: italics around the appointment', 'No worries, we can move your _appointment_ to another day.'],
    // …and a promise made in the team's name:
    ['NL: the team will make an exception', 'Ons team zal een uitzondering voor je afspraak maken.'],
    ['NL: the team makes an exception', 'Ons team maakt in jouw geval een uitzondering voor je afspraak.'],
    ['NL: an exception is made', 'In dit geval wordt er een uitzondering gemaakt voor je afspraak.'],
    ['NL: the team can move it', 'Geen zorgen, ons team kan je afspraak kosteloos verzetten.'],
    ['EN: the team will make an exception', 'Our team will make an exception for your appointment.'],
    ['EN: an exception will be made', 'Given the circumstances an exception will be made for your appointment.'],
    ['EN: the team will move it', 'Our team will move your appointment to a new date for you.'],
    ['EN: the team can reschedule', 'No worries — our team can reschedule your appointment free of charge.'],
    ['EN: some flexibility', 'We will show some flexibility for your appointment today.'],
  ])('fires — %s', (_label, message) => {
    expect(verdict(message)).toMatchObject({ kind: 'promise', error: 'promise_not_allowed' });
  });

  test.each([
    ['cannot promise a move', 'I can\'t promise we can move your appointment.'],
    ['cannot move', 'Unfortunately we can\'t move your appointment within 24 hours without the full charge.'],
    ['NL cannot move', 'Je afspraak van vandaag kunnen we niet verzetten zonder kosten.'],
    ['NL cannot move, main-clause order', 'We kunnen je afspraak helaas niet kosteloos verzetten.'],
    ['no exception', 'Within 24 hours of your appointment no exception can be made by me.'],
    ['I cannot make one', 'I can\'t make an exception for your appointment myself; only the team decides.'],
    ['NL no exception', 'Ik kan zelf geen uitzondering maken voor je afspraak.'],
    ['only the team', 'Alleen ons team kan een uitzondering maken voor je afspraak.'],
    ['never flexible', 'We are never flexible about appointments inside 24 hours.'],
    ['asking the team', 'I\'ve asked the team whether we can move your appointment.'],
    ['we can ask', 'We can ask the team to move your appointment; they decide.'],
    ['NL passing the request on', 'Ik kan je verzoek om je afspraak te verzetten doorgeven aan ons team.'],
    ['reschedules are the team\'s', 'Reschedules are arranged by our team.'],
    ['memberships', 'Our memberships are flexible.'],
    ['memberships, with a treatment in the same message', 'Our memberships are flexible, and you can book a treatment whenever it suits you.'],
    ['a class description', 'Vinyasa Flow bouwt kracht en flexibiliteit op. Zal ik een sessie voor je zoeken?'],
    ['the policy itself (EN)', 'I\'m sorry to hear that. Appointments cancelled or rescheduled within 24 hours of the start time are charged in full. Someone else is welcome to come in your place, and with medical proof you can ask our team for an exception; the team looks at every request. I\'ve passed your message to our team and they will get back to you here. Nothing has been changed on your appointment yet.'],
    ['the policy itself (NL)', POLICY_REPLY],
    ['the running-late sentence', 'Thank you for letting us know! Please note that if you arrive late for your appointment, we may need to adjust the treatment time accordingly to ensure we can accommodate all scheduled appointments. Please come as soon as you can.'],
    ['a booking confirmation', 'Please confirm your booking:\n\n✅ Float Journey\n📅 Sunday 8 November at 14:45\n👤 Shanta\n\nBy confirming, you declare that you are in good health, have disclosed any relevant medical conditions, and understand that you participate at your own risk.\nCancelling or rescheduling is free of charge up to 24 hours before your scheduled start time. After that, the full amount will be charged.\n\nShall I confirm this booking?'],
    ['the late-cancel confirmation', 'Are you sure you want to cancel Tailored Massage on Sunday 1 November at 09:00? This is within 24 hours of your appointment, so per our cancellation policy the full amount is charged. Someone else is welcome to come in your place, and in case of illness or a medical emergency you can provide medical proof to request an exception — our team decides on that. Do you still want to cancel?'],
    ['the reschedule policy line (NL)', 'Even ter info — je afspraak verzetten kan kosteloos tot 24 uur van tevoren. Binnen 24 uur wordt het volledige bedrag alsnog in rekening gebracht.'],
    ['the reschedule hand-over (NL)', 'Dank je! Ik heb je verzoek om te verzetten doorgegeven aan ons team. Zij bekijken de mogelijkheden en nemen hier contact met je op 🌿'],
    ['opening hours', 'Ja, we zijn op zondag open van 09:00 tot 18:00 uur.'],
    ['a photo acknowledgement', 'Bedankt voor je foto! 📸 Ik heb deze met ons team gedeeld. Kan ik je verder ergens mee helpen?'],
    ['choosing a massage', 'Dat klinkt goed! Welk type massage wil je boeken? We hebben massages op maat, prenatale massages en lymfedrainage.'],
    ['a gift-card hand-over', 'Dank je! Ik heb je aanvraag met de cadeaubon doorgestuurd naar ons team; zij bevestigen je boeking zo snel mogelijk. 🌿'],
    ['the team takes over a booking', 'Ons team neemt het van hier over en regelt je boeking voor de massage van 80 minuten persoonlijk. Ze laten je hier weten zodra alles is ingepland. 🌿'],
    ['a pay-at-reception confirmation', '✅ Float Journey is booked for Sunday 8 November at 14:45!\n\nNo online payment needed — please pay €80 at reception when you arrive. Would you like to add another treatment?'],
    ['a time list', 'Here are the available times for Tailored Massage on 8 november:'],
    ['a cancellation confirmed', 'Je afspraak voor de Tailored Massage op zondag 29 november om 10:00 is geannuleerd.'],
    ['nothing to check', ''],
    // Found in review of the fix. Answers the new prompt section asks for, in
    // the model's own words — the exception is left to the team:
    ['NL: the team looks at whether', 'Binnen 24 uur wordt je afspraak volledig in rekening gebracht. Met een medisch bewijs bekijkt ons team of we een uitzondering kunnen maken.'],
    ['NL: the team decides whether', 'Het team beslist of we voor je afspraak een uitzondering maken.'],
    ['NL: whether, at the start', 'Of we een uitzondering maken, beslist ons team. Je afspraak blijft tot die tijd staan.'],
    ['NL: I ask the team whether', 'Ik vraag het team of we een uitzondering kunnen maken voor je afspraak.'],
    ['NL: proof is needed', 'We hebben een medisch bewijs nodig om een uitzondering te kunnen maken voor je afspraak.'],
    ['NL: I would like to, but', 'Ik zou graag een uitzondering maken voor je afspraak, maar alleen ons team kan daarover beslissen.'],
    ['NL: whether we can be flexible', 'Het team bekijkt of we hier flexibel mee om kunnen gaan; binnen 24 uur wordt een afspraak normaal volledig in rekening gebracht.'],
    ['NL: whether they can be flexible', 'Ons team bekijkt of ze flexibel kunnen zijn met je afspraak, maar dat kan ik niet beloven.'],
    ['NL: perhaps', 'Misschien kunnen we je afspraak verzetten, maar dat beslist het team.'],
    ['NL: possibly', 'Mogelijk kunnen we je afspraak nog verzetten; het team laat het je weten.'],
    ['EN: maybe', 'We can maybe move your appointment, but that is up to the team.'],
    ['NL: cannot promise', 'Ik kan niet beloven dat we flexibel kunnen zijn met je afspraak.'],
    ['NL: only the team can move it', 'Alleen ons team kan je afspraak nog verzetten.'],
    ['EN: proof would be needed', 'We would need medical proof to make an exception for your appointment.'],
    ['EN: may be able to', 'We may be able to make an exception for your appointment if you provide medical proof.'],
    ['EN: I wish I could', 'I wish I could make an exception for your appointment, but only our team can decide that.'],
    ['EN: the team decides whether', 'The team decides whether we can make an exception for your appointment.'],
    ['EN: the team will say if we can', 'The team will let you know if we can move your appointment.'],
    ['EN: I\'ll ask the team', 'I\'ll ask the team to make an exception for your appointment.'],
    ['EN: only the team can make one', 'Only the team can make an exception for your appointment.'],
    ['EN: only with proof', 'We can only make an exception for your appointment with medical proof.'],
    ['NL: only with proof', 'Alleen met een medisch bewijs kunnen we een uitzondering maken voor je afspraak.'],
    ['EN: not able to', 'We are not able to make an exception for your appointment.'],
    // …and ordinary answers that happen to use the same words:
    ['availability: "the most flexibility"', 'For an 80-minute massage session we have the most flexibility on weekday mornings. Which day suits you best?'],
    ['availability: the guest is flexible', 'We have more availability for this treatment when you\'re flexible on the day.'],
    ['availability: the guest is flexible (NL)', 'Voor deze behandeling is zaterdag vol. Ik kan ook naar andere dagen kijken als je flexibel bent in je planning.'],
    ['flexible passes', 'We offer flexible passes for 1, 3 or 6 months. Each tech treatment can be booked once per day, one session at a time.'],
    ['a class builds flexibility (NL)', 'In Vinyasa Flow werken we aan kracht en flexibiliteit. De sessie duurt 60 minuten en kost €22.'],
    ['a class builds flexibility (EN)', 'In our Vinyasa Flow class we build strength and flexibility. A session is €22.'],
    ['a flexible layout', 'We can set up the Studio with a flexible layout for your session.'],
    ['planning a journey', 'If you\'d rather start later, we can move the sauna session to 15:45 and keep the float at 14:45. Which do you prefer?'],
    ['planning a journey ("I can")', 'I can move the Hydrowave session to 12:00 so it follows straight after your sauna.'],
    ['planning a journey (NL)', 'Als je liever later begint, kunnen we de sauna sessie verplaatsen naar 15:45.'],
    ['planning a journey (NL, as a question)', 'Zullen we de Hydrowave behandeling verplaatsen naar 12:00, zodat die direct aansluit op je sauna?'],
    ['an exception the team has already made', 'Yes, as my colleague wrote above, we made an exception and cancelled your appointment free of charge.'],
    // The check only looks at replies that mention an appointment, booking,
    // treatment or session at all.
    ['flexible, but not about an appointment', 'We are flexible about when your membership starts.'],
  ])('does not fire — %s', (_label, message) => {
    expect(verdict(message)).toBeNull();
  });

  // Found in review of the fix: on a false alarm the model could not tell
  // which words were meant, and either repeated the reply or called the team.
  test('the objection quotes the words it is about', () => {
    const v = verdict('Wat vervelend! Geen zorgen, we kunnen je afspraak *kosteloos* verschuiven. Sterkte!');
    expect(v.message).toMatch(/^NOT sent\. Your reply tells the customer that a late arrival, a cancellation or a move is fine, flexible, free or an exception\./);
    expect(v.message).toMatch(/Then call respond again\. The words in question: "we kunnen je afspraak kosteloos verschuiven"\.$/);
  });

  test('the patterns are one small exported table', () => {
    expect(PROMISE_PATTERNS.length).toBeGreaterThan(0);
    expect(PROMISE_PATTERNS.length).toBeLessThanOrEqual(10);
    for (const p of PROMISE_PATTERNS) {
      expect(typeof p.name).toBe('string');
      expect(p.re).toBeInstanceOf(RegExp);
    }
  });

  test('a reply that cannot be read is no objection — the check never throws', () => {
    expect(checkReply(PHONE, undefined, {})).toBeNull();
    expect(checkReply(PHONE, { message: { not: 'a string' } }, {})).toBeNull();
    expect(checkReply(PHONE, { message: REPLY_OF_1_NOV }, null)).toMatchObject({ kind: 'promise' });
  });
});

// ── 3. Alerting the team without an email ────────────────────────────────────

describe('a missing email never blocks the team alert on WhatsApp', () => {
  test('request_human_handoff: chat flagged, team mailed, sent: true', async () => {
    const r = await tools.toolHumanHandoff(PHONE, 'Shanta', { reason: HANDOFF_REASON });
    expect(r).toEqual({ sent: true });
    expect(needsReplyReasons()).toEqual([expect.stringMatching(/^Handoff: Can't come \/ late change:/)]);
    expect(email.sendEscalationEmail).toHaveBeenCalledWith({ customerName: 'Shanta', customerPhone: PHONE, customerEmail: null, message: HANDOFF_REASON });
  });

  test('"running late" reaches the front desk with nothing but the reason', async () => {
    const r = await tools.toolHumanHandoff(PHONE, 'Shanta', { reason: 'running late' });
    expect(r).toEqual({ sent: true });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
  });

  test('forward_reschedule_request and an old gift card go through without one too', async () => {
    const moved = await tools.toolForwardReschedule(PHONE, 'Shanta', { new_date: 'zondag 29 november', treatment: 'Tailored Massage 80 min' });
    expect(moved).toEqual({ sent: true });
    expect(email.sendRescheduleRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: PHONE, customerEmail: null, newDate: 'zondag 29 november' }));

    const card = await tools.toolForwardGiftCard(PHONE, 'Shanta', { gift_card_number: 'OLD9', treatment: 'Tailored Massage', preferred_day: 'zondag', old_system: true });
    expect(card).toEqual({ sent: true });
    expect(email.sendGiftCardRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: PHONE, customerEmail: null, oldSystem: true }));
  });

  test('an address the guest did type is still passed on', async () => {
    conversations.addMessage(PHONE, 'user', 'guest@guest.fixture'); // typed by the guest (Touriya, 27 Sep 2026: nothing else is forwarded)
    await tools.toolHumanHandoff(PHONE, 'Shanta', { reason: 'complaint', customer_email: 'guest@guest.fixture' });
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: 'guest@guest.fixture' }));
  });

  test('website chat still needs the email — the team cannot write back there', async () => {
    const handoff = await tools.toolHumanHandoff(WEB, null, { reason: HANDOFF_REASON });
    expect(handoff).toMatchObject({ sent: false, error: 'email_required' });
    const moved = await tools.toolForwardReschedule(WEB, null, { new_date: 'Sunday 29 November', treatment: 'Tailored Massage' });
    expect(moved).toMatchObject({ sent: false, error: 'email_required' });
    const card = await tools.toolForwardGiftCard(WEB, null, { gift_card_number: 'OLD9', treatment: 'Tailored Massage', preferred_day: 'Sunday', old_system: true });
    expect(card).toMatchObject({ sent: false, error: 'email_required' });

    expect(db.markConversationEscalated).not.toHaveBeenCalled();
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
    expect(email.sendRescheduleRequestEmail).not.toHaveBeenCalled();
    expect(email.sendGiftCardRequestEmail).not.toHaveBeenCalled();

    conversations.addMessage(WEB, 'user', 'guest@guest.fixture'); // the visitor typed it
    const withEmail = await tools.toolHumanHandoff(WEB, null, { reason: HANDOFF_REASON, customer_email: 'guest@guest.fixture' });
    expect(withEmail).toEqual({ sent: true });
  });

  test('an unpaid pay-first link is still closed by the handoff', async () => {
    payFirst.closeOpenCheckoutsForHandoff.mockResolvedValueOnce(['Tailored Massage 60 min']);
    const r = await tools.toolHumanHandoff(PHONE, 'Shanta', { reason: HANDOFF_REASON });
    expect(r).toMatchObject({ sent: true, payment_link_cancelled: ['Tailored Massage 60 min'] });
    expect(r.message).toMatch(/nothing is booked or charged/);
  });

  // Found in review of the fix: these two tool messages still told the model
  // that the team "will confirm the new time" — the promise the reschedule
  // texts no longer make.
  test('a repeated or refused reschedule forward does not promise that the new time will be confirmed', async () => {
    db.hasRecentTeamNotification.mockResolvedValueOnce(true);
    const again = await tools.toolForwardReschedule(PHONE, 'Shanta', { new_date: 'zondag 29 november', treatment: 'Tailored Massage' });
    expect(again).toMatchObject({ sent: true, already_sent: true });
    expect(again.message).not.toMatch(/confirm the new time/);
    expect(again.message).toMatch(/get back to them/);

    const web = await tools.toolForwardReschedule(WEB, null, { new_date: 'Sunday 29 November', treatment: 'Tailored Massage' });
    expect(web).toMatchObject({ sent: false, error: 'email_required' });
    expect(web.message).not.toMatch(/confirm the new time/);
  });

  test('the tool schemas no longer demand an email, and say never to invent one', () => {
    const fn = (name) => TOOLS.find(t => t.function.name === name).function;
    expect(fn('request_human_handoff').parameters.required).toEqual(['reason']);
    expect(fn('forward_reschedule_request').parameters.required).toEqual(['new_date', 'treatment']);
    for (const name of ['request_human_handoff', 'forward_reschedule_request', 'forward_gift_card_request']) {
      expect(fn(name).parameters.required).not.toContain('customer_email');
      expect(fn(name).parameters.properties.customer_email.description).toBe('Only an address the customer typed in this chat; leave it out otherwise. Never invent one.');
    }
    expect(fn('request_human_handoff').description).not.toMatch(/Always collect the customer email first/);
  });

  test('the team emails read sensibly without an address', async () => {
    const bodies = await renderedEmails(async (real) => {
      await real.sendEscalationEmail({ customerName: 'Shanta', customerPhone: PHONE, customerEmail: null, message: HANDOFF_REASON });
      await real.sendRescheduleRequestEmail({ customerName: 'Shanta', customerPhone: PHONE, customerEmail: null, newDate: 'zondag 29 november', treatment: 'Tailored Massage' });
      await real.sendGiftCardRequestEmail({ customerName: 'Shanta', customerPhone: PHONE, customerEmail: null, giftCardNumber: 'OLD9', treatment: 'Tailored Massage', preferredDay: 'zondag', oldSystem: true });
    });
    expect(bodies).toHaveLength(3);
    for (const html of bodies) {
      expect(html).toContain(`wa.me/${PHONE}`);
      expect(html).not.toMatch(/mailto:|null|undefined|Email/);
    }
  });
});

// ── 4. Cancelling ────────────────────────────────────────────────────────────

describe('cancel_appointments: the server decides what "inside 24 hours" is', () => {
  const PAID_ROW = { id: 501, customer_name: 'Shanta', service_name: 'Tailored Massage 60 min', amount_cents: 13000, start_date_time: 'zondag 1 november 08:55' };
  const REFUND_TEXT = /terugbetaling binnen 7 werkdagen|refund within 7 business days/;
  const paid = () => db.query.mockImplementation(async (sql) => (String(sql).includes("status = 'paid'") ? { rows: [PAID_ROW] } : { rows: [] }));
  /** The handler's effect of a "Yes, cancel it" tap. */
  // Since the ownership gate (25 Nov 2026) only appointments of this guest can
  // be cancelled: here they were booked in this chat, so the server has no
  // start time for them (the fallbacks below are about exactly that case).
  const BOOKED_HERE = [9001, 9002, 9003].map(id => ({ appointment_id: id }));
  const tapYesCancel = (extra = {}) => conversations.set(PHONE, { lang: 'nl', cancelConfirmedAt: Date.now(), pendingBookings: BOOKED_HERE, ...extra });
  const mindbodySays = (startDateTime) => mindbody.cancelAppointment.mockResolvedValue({ Status: 'Cancelled', StartDateTime: startDateTime });

  test('without the "Yes, cancel it" tap nothing happens, however close the appointment is', async () => {
    conversations.set(PHONE, { lang: 'nl', knownAppointments: { 9001: { dateTime: '2026-11-01T08:55:00', serviceName: 'Tailored Massage 60 min' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], is_within_24h: true });
    expect(r.error).toBe('confirmation_required');
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
    expect(db.markConversationEscalated).not.toHaveBeenCalled();
    expect(email.sendCancellationNotificationEmail).not.toHaveBeenCalled();
  });

  test('a paid appointment two hours away, flag forgotten by the model: no refund, no refund promise, the team checks the fee', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-11-01T08:55:00');
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], service_name: 'Tailored Massage 60 min', date_time: 'zondag 1 november 08:55' });

    expect(r).toEqual({
      cancelled: [9001],
      failed: [],
      within24h: true,
      policy_note: 'Cancelled inside 24 hours: per the cancellation policy the full amount is charged. Do not promise a refund, a credit or an exception — only the team can decide that.',
    });
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();
    expect(sentTexts().filter(t => REFUND_TEXT.test(t))).toEqual([]);
    expect(needsReplyReasons()).toEqual(['Late cancellation (inside 24h): Tailored Massage 60 min — check the fee']);
    expect(email.sendCancellationNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({ isWithin24h: true }));
  });

  test('an appointment that started three hours ago is a late cancellation too', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-11-01T03:50:00');
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], is_within_24h: false });
    expect(r.within24h).toBe(true);
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();
  });

  test('pay at reception (no paid row) inside 24 hours is flagged for the team as well', async () => {
    tapYesCancel();
    mindbodySays('2026-11-01T14:45:00');
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9002], service_name: 'Float Journey' });
    expect(r.within24h).toBe(true);
    expect(needsReplyReasons()).toEqual(['Late cancellation (inside 24h): Float Journey — check the fee']);
  });

  test('three days away with the flag wrongly true: the refund runs as it always did', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-11-04T10:00:00');
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], is_within_24h: true });

    expect(r).toEqual({ cancelled: [9001], failed: [] });
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sentTexts().filter(t => REFUND_TEXT.test(t))).toHaveLength(1);
    expect(needsReplyReasons()).toEqual(['Refund to process: Tailored Massage 60 min']);
    expect(email.sendCancellationNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({ isWithin24h: false }));
  });

  test('wall clock, not UTC: 23h38 ahead is inside, 24h08 ahead is not', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-11-02T06:30:00');
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).within24h).toBe(true);

    tapYesCancel();
    mindbodySays('2026-11-02T07:00:00');
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).within24h).toBeUndefined();
  });

  test('an appointment the server knows nothing about falls back to the model\'s flag', async () => {
    paid();
    tapYesCancel();
    mindbody.cancelAppointment.mockResolvedValue({ Status: 'Cancelled' }); // no start time in the reply
    const late = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], is_within_24h: true });
    expect(late.within24h).toBe(true);
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();

    tapYesCancel();
    const early = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] });
    expect(early).toEqual({ cancelled: [9001], failed: [] });
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);
  });

  // Found in review of the fix. Before it, get_appointments called every past
  // appointment "within 24 hours", the model passed that on, and nothing was
  // refunded. With past appointments no longer "within 24 hours" and the flag
  // deciding, cancelling a paid no-show from yesterday morning sent finance a
  // refund request and promised the guest a refund within 7 business days.
  test.each([
    ['yesterday morning, flag left out', '2026-10-31T10:00:00', {}],
    ['12 hours and 1 minute ago, flag left out', '2026-10-31T18:51:00', {}],
    ['last week, flag left out', '2026-10-25T10:35:00', {}],
    ['last week, flag false', '2026-10-25T10:35:00', { is_within_24h: false }],
    ['last week, flag true', '2026-10-25T10:35:00', { is_within_24h: true }],
  ])('an appointment that already took place is never refunded automatically — %s', async (_label, start, flag) => {
    paid();
    tapYesCancel({ knownAppointments: { 9001: { dateTime: start, serviceName: 'Tailored Massage 60 min' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001], ...flag });

    expect(r.cancelled).toEqual([9001]);
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();
    expect(sentTexts().filter(t => REFUND_TEXT.test(t))).toEqual([]);
    // Not "inside 24 hours" (that is: up to 12 hours after the start) — but
    // not free either, and a human looks at it.
    expect(r.within24h).toBeUndefined();
    expect(r.policy_note).toMatch(/^Cancelled after the appointment had started: per the cancellation policy the full amount is charged/);
    expect(r.policy_note).toMatch(/Do not promise a refund, a credit or an exception/);
    expect(needsReplyReasons()).toEqual(['Cancelled after its start time: Tailored Massage 60 min — check the fee']);
    expect(email.sendCancellationNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({ isWithin24h: true }));
  });

  test('…also when only Mindbody\'s cancel reply knows the start (state gone)', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-10-31T10:00:00');
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] });
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();
    expect(sentTexts().filter(t => REFUND_TEXT.test(t))).toEqual([]);
    expect(r.policy_note).toMatch(/^Cancelled after the appointment had started/);
  });

  test('11 hours and 59 minutes after the start is still "inside 24 hours"', async () => {
    paid();
    tapYesCancel({ knownAppointments: { 9001: { dateTime: '2026-10-31T18:53:00', serviceName: 'Tailored Massage 60 min' } } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] });
    expect(r.within24h).toBe(true);
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();
  });

  // The next three were not pinned (review of the fix: the mutations survived).
  test('exactly 24 hours ahead is outside: the refund runs; one minute less is inside', async () => {
    paid();
    tapYesCancel();
    mindbodySays('2026-11-02T06:52:00');
    expect(await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).toEqual({ cancelled: [9001], failed: [] });
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);

    tapYesCancel();
    mindbodySays('2026-11-02T06:51:00');
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).within24h).toBe(true);
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);
  });

  test('what get_appointments showed goes before the start time in Mindbody\'s cancel reply', async () => {
    paid();
    tapYesCancel({ knownAppointments: { 9001: { dateTime: '2026-11-01T08:55:00', serviceName: 'Tailored Massage 60 min' } } });
    mindbodySays('2026-11-04T10:00:00');
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).within24h).toBe(true);
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled();

    tapYesCancel({ knownAppointments: { 9001: { dateTime: '2026-11-04T10:00:00', serviceName: 'Tailored Massage 60 min' } } });
    mindbodySays('2026-11-01T08:55:00');
    expect(await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).toEqual({ cancelled: [9001], failed: [] });
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);
  });

  test('one "Yes, cancel it" tap covers exactly one cancel call', async () => {
    tapYesCancel();
    mindbodySays('2026-11-29T10:00:00');
    expect((await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001] })).cancelled).toEqual([9001]);
    const second = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9003] });
    expect(second.error).toBe('confirmation_required');
    expect(mindbody.cancelAppointment).toHaveBeenCalledTimes(1);
  });

  test('two appointments in one cancellation, one of them late: the note names the late one', async () => {
    paid();
    tapYesCancel({ knownAppointments: {
      9001: { dateTime: '2026-11-01T08:55:00', serviceName: 'Tailored Massage 60 min' },
      9003: { dateTime: '2026-11-29T10:00:00', serviceName: 'Hydrowave Massage' },
    } });
    const r = await tools.toolCancelAppointments(PHONE, { appointment_ids: [9001, 9003] });
    expect(r.cancelled).toEqual([9001, 9003]);
    expect(r.within24h).toBe(true);
    expect(r.policy_note).toMatch(/^Cancelled inside 24 hours: per the cancellation policy the full amount is charged\./);
    expect(r.policy_note).toMatch(/9001/);
    expect(r.policy_note).not.toMatch(/9003/);
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1); // only for the one on 29 November
    // Found in review of the fix: the dashboard keeps one reason per guest, so
    // two separate writes left only the last — either the late cancel or the
    // refund was lost. Both now stand in one line.
    expect(needsReplyReasons()).toEqual(['Late cancellation (inside 24h): Tailored Massage 60 min — check the fee · Refund to process: Tailored Massage 60 min']);
  });

  test('is_within_24h is described to the model as a hint', () => {
    const cancel = TOOLS.find(t => t.function.name === 'cancel_appointments').function;
    expect(cancel.parameters.properties.is_within_24h.description).toMatch(/hint/i);
    expect(cancel.parameters.properties.is_within_24h.description).toMatch(/server/i);
  });
});

// ── 5. Looking up appointments ───────────────────────────────────────────────

describe('get_appointments', () => {
  const LAST_WEEK = { Id: 8001, StartDateTime: '2026-10-25T10:35:00', SessionType: { Name: 'Tailored Massage 60 min' } };
  const IN_THREE_HOURS = { Id: 8002, StartDateTime: '2026-11-01T09:50:00', SessionType: { Name: 'Tailored Massage 80 min' } };
  const END_OF_MONTH = { Id: 8003, StartDateTime: '2026-11-29T10:00:00', SessionType: { Name: 'Hydrowave Massage' } };

  beforeEach(() => {
    mindbody.getClientByPhone.mockResolvedValue({ Id: 7, MobilePhone: PHONE }); // her WhatsApp number is on it
    mindbody.getStaffAppointments.mockResolvedValue([LAST_WEEK, IN_THREE_HOURS, END_OF_MONTH]);
  });
  const lookUp = async () => (await tools.toolGetAppointments(PHONE, { client_email: 'guest@example.com' })).appointments;

  test('last week\'s visit is past and NOT "within 24 hours"', async () => {
    const [lastWeek] = await lookUp();
    expect(lastWeek).toMatchObject({ id: 8001, isPast: true, isWithin24h: false });
    expect(lastWeek.late_change_policy).toBeUndefined();
  });

  test('an appointment in three hours carries the policy the model must give', async () => {
    const [, soon, later] = await lookUp();
    expect(soon).toMatchObject({ id: 8002, isPast: false, isWithin24h: true });
    expect(soon.late_change_policy).toBe('Starts within 24 hours. If the customer wants to cancel or move it: that is charged in full — tell them exactly that plus both options (someone else may come in their place; with medical proof they can ask the team for an exception). Never say it is free and never promise an exception.');
    expect(later).toMatchObject({ id: 8003, isPast: false, isWithin24h: false });
    expect(later.late_change_policy).toBeUndefined();
  });

  // Found in review of the fix: an appointment that has started is no longer
  // "within 24 hours" for the model, so nothing told it to warn the guest —
  // while the cancel after the tap is charged in full.
  test('an appointment that has already started carries its own note: cancelling it now is not free', async () => {
    const THIS_MORNING = { Id: 8004, StartDateTime: '2026-11-01T05:30:00', SessionType: { Name: 'Float Journey' } };
    mindbody.getStaffAppointments.mockResolvedValue([LAST_WEEK, THIS_MORNING, END_OF_MONTH]);
    const [lastWeek, thisMorning, later] = await lookUp();
    for (const started of [lastWeek, thisMorning]) {
      expect(started).toMatchObject({ isPast: true, isWithin24h: false });
      expect(started.late_change_policy).toBeUndefined();
      expect(started.already_started_policy).toBe('Already started. Only if the customer wants to cancel or move it: that is charged in full, as for a no-show — say so before they confirm. Never say it is free and never promise a refund or an exception; only the team can decide that.');
    }
    expect(later.already_started_policy).toBeUndefined();
  });

  test('what it showed is remembered, and decides the cancel when the model and Mindbody say nothing', async () => {
    await lookUp();
    expect(conversations.get(PHONE).knownAppointments).toMatchObject({
      8002: { dateTime: '2026-11-01T09:50:00', serviceName: 'Tailored Massage 80 min' },
      8003: { dateTime: '2026-11-29T10:00:00', serviceName: 'Hydrowave Massage' },
    });

    conversations.update(PHONE, { cancelConfirmedAt: Date.now() });
    const late = await tools.toolCancelAppointments(PHONE, { appointment_ids: [8002] });
    expect(late.within24h).toBe(true);
    expect(needsReplyReasons()).toEqual(['Late cancellation (inside 24h): Tailored Massage 80 min — check the fee']);

    // …and it beats a wrong flag for the appointment at the end of the month.
    db.query.mockImplementation(async (sql) => (String(sql).includes("status = 'paid'") ? { rows: [{ id: 502, customer_name: 'Shanta', service_name: 'Hydrowave Massage', amount_cents: 3500 }] } : { rows: [] }));
    conversations.update(PHONE, { cancelConfirmedAt: Date.now() });
    const early = await tools.toolCancelAppointments(PHONE, { appointment_ids: [8003], is_within_24h: true });
    expect(early).toEqual({ cancelled: [8003], failed: [] });
    expect(email.sendRefundNotificationEmail).toHaveBeenCalledTimes(1);
  });

  // Integration review of the five November fixes: the lookup of the Tara fix
  // reads the guest's own words as "what she says is booked" when they name
  // another person — except for a cancel or a move. A guest who can't come
  // and names her husband was not excepted: the server's "I can't confirm
  // that everything you described is booked, I've asked my colleagues to
  // check" replaced the policy reply of this section, and the team got a
  // booking-check email on top of the handoff.
  test.each([
    ['Dutch', 'Goedemorgen, mijn man en ik gaan het niet redden vandaag om 9 uur, hij is ziek.'],
    ['Dutch, "we kunnen niet komen"', 'We kunnen vandaag helaas niet komen, mijn man is ziek.'],
    ['English', "My husband and I can't make it today, he is ill."],
    ['English, "won\'t make it"', "We won't make it to our massage this morning, sorry."],
  ])('a guest who can\'t come and names someone else gets the policy reply, not a booking check (%s)', async (_label, message) => {
    script(
      [call('g', 'get_appointments', { client_email: 'guest@example.com', customer_expects: '' })],
      [call('h', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r', POLICY_REPLY)],
    );
    await agent.run(PHONE, 'Shanta', message);
    expect(toolResults().g.check).toBe('not_requested');
    expect(sentTexts()[sentTexts().length - 1]).toBe(POLICY_REPLY);
    expect(sentTexts().join('\n')).not.toMatch(/asked my colleagues to check|collega's gevraagd/);
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(needsReplyReasons()).toEqual([expect.stringMatching(/^Handoff: Can't come \/ late change:/)]);
  });

  // Same review: when the model DID pass her words ("massage today at 9"), the
  // lookup matched and the server's list replaced the policy reply — she read
  // her appointment and "if that's not what you expected…", but never that it
  // is charged in full or that she may ask for an exception. On a turn where
  // the guest can't come or wants to change something, the list goes first
  // and the model's reply still goes out.
  test('a guest who can\'t come gets the policy reply also when the lookup matched what she said', async () => {
    script(
      [call('g', 'get_appointments', { client_email: 'guest@example.com', customer_expects: 'massage today at 09:00' })],
      [call('h', 'request_human_handoff', { reason: HANDOFF_REASON }), respond('r', POLICY_REPLY)],
    );
    await agent.run(PHONE, 'Shanta', 'Goedemorgen, ik ga het niet redden vandaag om 9 uur.');
    expect(toolResults().g.server_reply).toBeUndefined();
    expect(sentTexts()[sentTexts().length - 1]).toBe(POLICY_REPLY);
  });
});

// ── 6. The words ─────────────────────────────────────────────────────────────

describe('prompt, knowledge base and guest texts tell one story', () => {
  const prompt = () => buildSystemPrompt(PHONE, 'Shanta');
  const HEADING = '## Can\'t come, ill, or a change within 24 hours — the team decides (this is NOT "running late")';
  const sectionAt = (p, heading) => {
    const start = p.indexOf(heading);
    return p.slice(start, p.indexOf('\n## ', start + 1));
  };

  // The section as the team's policy was written down for this fix — whole, so
  // that a softened step ("with medical proof our team makes an exception")
  // fails here instead of slipping past a few keyword checks. Found in review:
  // seven meaning-changing edits left every test green.
  const SECTION = [
    '## Can\'t come, ill, or a change within 24 hours — the team decides (this is NOT "running late")',
    'Applies when a customer says they will NOT come to an existing appointment ("I can\'t make it", "I won\'t make it today", "ik ga het niet redden", "ik kan niet komen"), says they are ill, in pain or have an emergency that affects an appointment, or asks to cancel or move an appointment that is today or that starts within 24 hours.',
    'A plain request to cancel or move an appointment on another day, or without naming a day ("ik moet afzeggen", "can I cancel my massage on Friday?", "I\'d like to move tomorrow\'s appointment"), is NOT this section: follow the Cancellation flow or the Reschedule flow. The lookup in the Cancellation flow shows whether it starts within 24 hours (isWithin24h); more than 24 hours ahead cancelling is free and you simply do it.',
    'Someone who is not coming at all is NOT running late: never give them the running-late sentence and never ask them to "come as soon as you can". If it is unclear whether they are still coming, ask that one question first and promise nothing.',
    '',
    'The policy, in the team\'s words — never soften it: appointments cancelled or rescheduled within 24 hours of the start time are charged in full. Someone else may come in their place, or — in case of illness or a medical emergency — they can provide medical proof to REQUEST an exception. Only the team decides on an exception.',
    '',
    'What you do:',
    '1. Reply warmly (you may say you are sorry and wish them a good recovery) and give the policy above in the customer\'s language: within 24 hours the appointment is charged in full; someone else is welcome to come in their place; with medical proof they can ask our team for an exception; the team looks at every request. If you do not know whether it starts within 24 hours (it is tomorrow, or they named no day), give both halves: free of charge up to 24 hours before the start, charged in full within 24 hours.',
    '2. In the same turn call request_human_handoff with a reason that starts with "Can\'t come / late change:" followed by what they wrote, the day and time of the appointment if they said it, and whether illness is the reason. Do NOT ask for an email first and do not look the appointment up first.',
    '3. Tell them you have passed it to the team and that the team will get back to them here. Nothing has been changed on their appointment yet — say so.',
    '4. Only when they clearly say the appointment is more than 24 hours away: the change is free of charge — continue with the Cancellation flow or the Reschedule flow instead.',
    '5. An unpaid payment link is not an appointment: nothing is booked or charged, the link simply expires. Say so; no handoff needed.',
    '',
    'Hard rules — in that reply and in every later message:',
    '- NEVER say or imply that it is fine ("no worries", "geen zorgen", "geen probleem"), that we will be flexible, or that the appointment can or will be moved, cancelled free of charge, refunded, credited or waived, or that an exception will be made — however sympathetic the reason. You cannot grant any of this. Only the team can.',
    '- Kindness is welcome; promises are not. The server checks your reply: a promise of this kind is not sent.',
    '- If they ask again, say kindly that the team looks at every request and will get back to them here.',
  ].join('\n');

  test('the section is in the prompt word for word', () => {
    expect(sectionAt(prompt(), HEADING).trimEnd()).toBe(SECTION);
    expect(sectionAt(buildSystemPrompt(WEB, null), HEADING).trimEnd()).toBe(SECTION);
  });

  test('the late-cancel confirmation gives the charge, both options and who decides — in full', () => {
    expect(sectionAt(prompt(), '## Cancellation flow')).toContain('5. Within 24 hours (isWithin24h true): the cancellation is charged in full, paid online or not. Put this in the step-4 message: "This is within 24 hours of your appointment, so per our cancellation policy the full amount is charged. Someone else is welcome to come in your place, and in case of illness or a medical emergency you can provide medical proof to request an exception — our team decides on that. Do you still want to cancel?" Never say a cancellation within 24 hours is free. If they would rather send someone else or ask for an exception, do NOT cancel: follow "Can\'t come, ill, or a change within 24 hours".');
  });

  // Found in review of the fix: "Maximum 2-3 sentences per message" stood
  // next to a section that needs about six (the charge, someone else, medical
  // proof, passed on, nothing changed) — an invitation to drop one option.
  test('the sentence limit does not apply to a policy that has to be given whole', () => {
    expect(sectionAt(prompt(), '## Style')).toMatch(/- Maximum 2-3 sentences per message — except when a policy has to be given in full \(such as "Can't come, ill, or a change within 24 hours"\): never leave part of it out to stay short/);
  });

  test('the new section sits before "Running late" and in the static part of the prompt', () => {
    const p = prompt();
    const at = p.indexOf(HEADING);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(p.indexOf('## Running late'));
    expect(at).toBeLessThan(p.indexOf('## Service catalog'));
    expect(at).toBeLessThan(p.lastIndexOf('\n## Session\n'));
    // …and nothing in it is dated or per guest.
    expect(sectionAt(p, HEADING)).toBe(sectionAt(buildSystemPrompt('31600000099', 'Somebody Else', true, true), HEADING));
  });

  test('it gives the charge, both options, who decides, and the handoff step', () => {
    const s = sectionAt(prompt(), HEADING);
    expect(s).toMatch(/cancelled or rescheduled within 24 hours of the start time are charged in full/);
    expect(s).toMatch(/Someone else may come in their place/);
    expect(s).toMatch(/medical proof to REQUEST an exception/);
    expect(s).toMatch(/Only the team decides on an exception/);
    expect(s).toMatch(/call request_human_handoff with a reason that starts with "Can't come \/ late change:"/);
    expect(s).toMatch(/Do NOT ask for an email first/);
    expect(s).toMatch(/Nothing has been changed on their appointment yet/);
    expect(s).toMatch(/NEVER say or imply that it is fine \("no worries", "geen zorgen", "geen probleem"\)/);
    expect(s).toMatch(/An unpaid payment link is not an appointment/);
    expect(s).toMatch(/ask that one question first and promise nothing/);
    // Nothing about HOW to hand in the proof: the channel is not decided.
    expect(s).not.toMatch(/send (us |it |a photo|the proof)|upload|per e-?mail|by e-?mail/i);
  });

  test('"Running late" is only for guests who are still coming, and needs no email', () => {
    const s = sectionAt(prompt(), '## Running late');
    expect(s).toMatch(/they are still coming, only later/);
    expect(s).toMatch(/is NOT running late: follow "Can't come, ill, or a change within 24 hours" above/);
    // Found in review: "is ill, or wants to move the appointment" sent a guest
    // who was on her way and asked to start ten minutes later to "charged in full".
    expect(s).toMatch(/on the way and asks whether they can start a little later IS running late/);
    expect(s).not.toMatch(/can't come at all, is ill, or wants to cancel or move/);
    expect(s).toMatch(/request_human_handoff with reason "running late" \(no email needed\)/);
    expect(s).not.toMatch(/name\/phone/);
  });

  test('the cancellation flow no longer calls a late cancel free, and leaves the 24 hours to the server', () => {
    const p = prompt();
    const s = sectionAt(p, '## Cancellation flow');
    expect(p).not.toMatch(/can always cancel for free/);
    expect(s).toMatch(/Within 24 hours \(isWithin24h true\): the cancellation is charged in full, paid online or not/);
    expect(s).toMatch(/Never say a cancellation within 24 hours is free/);
    expect(s).toMatch(/The server works out whether it is within 24 hours — you do not decide that/);
    expect(s).toMatch(/within24h: true, relay its policy_note — never a refund, a credit or an exception/);
    expect(s).not.toMatch(/pass is_within_24h: true if/);
  });

  test('rescheduling: no promise that the team will arrange it, the email is optional, today goes to the team, tomorrow is not assumed to be late', () => {
    const p = prompt();
    const s = sectionAt(p, '## Reschedule flow');
    expect(p).not.toMatch(/They'll arrange the new time/);
    expect(p).not.toMatch(/Zij regelen de nieuwe tijd/);
    expect(s).toMatch(/0\. If the appointment they want to move is today, or they say it starts within 24 hours, follow "Can't come, ill, or a change within 24 hours" instead/);
    expect(p).not.toMatch(/today or tomorrow/);
    expect(s).toMatch(/rescheduling is free of charge up to 24 hours before your appointment\. Within 24 hours the full session fee still applies\./);
    expect(s).toMatch(/They'll look at the options and get back to you here/);
    expect(s).toMatch(/Zij bekijken de mogelijkheden en nemen hier contact met je op/);
    expect(s).toMatch(/never invent one/);
    expect(s).not.toMatch(/the team needs it to reach them/);
  });

  test('the policy answer and the booking confirmation cover rescheduling too', () => {
    const p = prompt();
    expect(sectionAt(p, '## Refund & cancellation policy')).toMatch(/Cancelling or rescheduling is \*\*free up to 24 hours\*\* before the scheduled start time\. Within 24 hours, and for no-shows, the full session fee \(100%\) is charged — also when the appointment is moved\./);
    expect(p).toContain('Cancelling or rescheduling is free of charge up to 24 hours before your scheduled start time. After that, the full amount will be charged.');
    expect(p).not.toContain('Cancellations are free of charge up to 24 hours before your scheduled start time');
  });

  test('"the team will follow up" needs a tool that confirmed it; a handoff needs no email on WhatsApp', () => {
    const p = prompt();
    expect(sectionAt(p, '## Style')).toMatch(/Only say the team will follow up, or that you have reported something, after a tool in this turn confirmed it \(sent: true\)\./);
    const handoff = sectionAt(p, '## Human handoff flow');
    expect(handoff).toMatch(/1\. Call request_human_handoff with the reason right away — on WhatsApp no email is needed \(the team answers here\)/);
    expect(handoff).toMatch(/never invent one/);
    expect(handoff).not.toMatch(/1\. FIRST ask for their email address/);
  });

  test('website chat keeps asking for the email first', () => {
    const web = buildSystemPrompt(WEB, null);
    expect(sectionAt(web, '## Human handoff flow')).toMatch(/[Ww]ebsite chat/);
    const tail = web.slice(web.lastIndexOf('\n## Session\n'));
    expect(tail).toMatch(/## Web chat/);
    expect(tail).toMatch(/ask for the customer's email/);
  });

  test('the knowledge base: free until 24 hours before, then charged in full — moving included, no credits, two options', () => {
    const kb = require('../src/data/knowledge-base.json');
    const c = kb.policies.cancellation;
    expect(c.free_cancel_window).toMatch(/annuleren of verzetten tot 24 uur/i);
    expect(c.late_cancel_or_no_show).toMatch(/annuleren of verzetten binnen 24 uur/i);
    expect(c.late_cancel_or_no_show).toMatch(/100%/);
    expect(c.late_change_options).toMatch(/iemand anders in jouw plaats/);
    expect(c.late_change_options).toMatch(/medisch bewijs/);
    expect(c.late_change_options).toMatch(/uitzondering aan te vragen/);
    expect(c.late_change_options).toMatch(/team beslist/);
    expect(c.never_promise).toBeUndefined(); // instructions belong in the prompt
    expect(c.how_to_reschedule_or_cancel).toMatch(/Tot 24 uur voor aanvang/);
    expect(c.how_to_reschedule_or_cancel).toMatch(/Binnen 24 uur gelden de volledige kosten; over een uitzondering beslist alleen het team\./);
    expect(c.refund).toMatch(/annuleren of verzetten binnen 24 uur/i);
    expect(c.credit_on_cancel).toMatch(/uiterlijk 24 uur voor aanvang/);
    expect(c.credit_on_cancel).toMatch(/binnen 24 uur of no-show: geen credits/i);
    expect(kb.faq.cancellation).toMatch(/annuleren of verzetten tot 24 uur/i);
    expect(kb.faq.cancellation).toMatch(/ook bij verzetten/);
    expect(kb.faq.cancellation).toMatch(/iemand anders/);
    expect(kb.faq.cancellation).toMatch(/medisch bewijs/);
    expect(kb.faq.cancellation_credit).toMatch(/uiterlijk 24 uur voor aanvang/);
    expect(kb.faq.cancellation_credit).toMatch(/geen credits/);
    // The bot reads these very answers (they are not team-editable).
    const p = prompt();
    expect(p).toContain(c.late_change_options);
    expect(p).toContain(kb.faq.cancellation);
    // Nowhere does the knowledge base tell guests HOW to hand in the proof.
    expect(JSON.stringify(c)).not.toMatch(/foto|upload|WhatsApp/i);
  });

  test('the 24-hour reminder says "cancelling or rescheduling" in both languages', async () => {
    const { sendReminderIfNotSent } = require('../src/services/reminder.service');
    const appointment = (id, mobile) => ({ Id: id, StartDateTime: '2026-11-02T18:00:00', Client: { MobilePhone: mobile }, SessionType: { Name: 'Float Journey' } });

    await sendReminderIfNotSent(appointment(1, '+31600000071'), '24h');
    expect(sentTexts().at(-1)).toContain('_Cancelling or rescheduling is free of charge up to 24 hours before your appointment. Within 24 hours, and for no-shows, 100% of the session fee is charged._');

    conversations.set('31600000072', { lang: 'nl' });
    await sendReminderIfNotSent(appointment(2, '+31600000072'), '24h');
    expect(sentTexts().at(-1)).toContain('_Annuleren of verzetten is gratis tot 24 uur voor aanvang. Bij annuleren of verzetten binnen 24 uur of bij no-show wordt 100% van de sessiekosten in rekening gebracht._');
    conversations.clear('31600000072');
  });

  test('the confirmation email says the same', async () => {
    const [html] = await renderedEmails(real => real.sendBookingConfirmationEmail({ customerEmail: 'guest@example.com', customerName: 'Shanta', serviceName: 'Float Journey', date: 'Sunday 8 November', time: '14:45' }));
    expect(html).toContain('Cancelling or rescheduling is free of charge up to 24 hours before your appointment. Within 24 hours, and for no-shows, 100% of the session fee is charged.');
    expect(html).not.toMatch(/Cancellations are free of charge/);
  });
});
