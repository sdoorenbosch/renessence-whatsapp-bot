// Regression for "Tara" (4 and 19 Nov 2026), the part about a colleague's
// conversation. On 4 Nov a colleague was answering her; the chat was handed
// back to the bot while she was still reacting ("Oh!", six minutes after the
// colleague's message). The bot answered from general knowledge, contradicted
// the colleague and ended with "Our team will arrange … 9:00 to 11:00". She
// was never told the AI was answering again. The colleague's clarifying
// question afterwards stayed unanswered for 15 days; on 19 Nov, the evening
// before her visit, "I missed your last message by accident" was answered
// with a recap of the bot's own earlier line, not the colleague's question.
//
// Each block pins one part of the fix:
//  1. a reply that arrives within TEAM_REPLY_HOLD_MIN (30) minutes of a
//     colleague's message stays with the team, even though the bot was
//     switched back on — text, photo or sticker alike
//  2. later, the bot's first reply says it is the AI assistant again, and a
//     question of the colleague's that was never answered is put back in
//     front of the guest with its date; the team is flagged
//  3. restored history marks a colleague's lines as written by staff, with
//     their date, and the bot can't pose as a colleague
//  4. a database error leaves the bot answering exactly as before

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
const mockPgQuery = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn().mockImplementation(() => ({ query: mockPgQuery, on: jest.fn() })) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}), sendCTAButton: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/outage-alert.service', () => ({
  recordAgentFailure: jest.fn(), recordAgentSuccess: jest.fn().mockResolvedValue(), holdingMessage: () => 'hold', HOLDING_TEXTS: [],
}));
jest.mock('../src/agents/renessence.agent', () => ({ run: jest.fn(), decodeInput: jest.fn(), deliverPendingPayFirstLink: jest.fn() }));
jest.mock('../src/services/intro-promo.service', () => ({ maybeSendIntroPromo: jest.fn().mockResolvedValue(false), isPromoMessage: jest.fn(() => false) }));
jest.mock('../src/services/team-queue.service', () => ({ deliverQueuedTeamMessages: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/routes/dashboard.routes', () => ({ isBotPaused: jest.fn(() => false) }));
jest.mock('../src/data/database', () => ({
  logConversation: jest.fn(), logMessage: jest.fn().mockResolvedValue(undefined),
  isBlocked: jest.fn().mockResolvedValue(false), isPaused: jest.fn().mockResolvedValue(false),
  unarchiveConversation: jest.fn().mockResolvedValue(undefined), setNeedsReply: jest.fn(),
  pauseConversation: jest.fn().mockResolvedValue(undefined),
  getLastOutboundMessage: jest.fn().mockResolvedValue(null),
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  setConversationLanguage: jest.fn().mockResolvedValue(),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const teamQueue = require('../src/services/team-queue.service');
const introPromo = require('../src/services/intro-promo.service');
const agent = require('../src/agents/renessence.agent');
const conversations = require('../src/services/conversation.service');
const tools = require('../src/agents/tool-implementations');
const teamContext = require('../src/agents/team-context');
const { handle, handleNonText } = require('../src/handlers/message.handler');

const PHONE = '31600000123';
const AI_AGAIN = 'You\'re chatting with the Renessence AI assistant again.';
const AI_AGAIN_NL = 'Je praat nu weer met de AI-assistent van Renessence.';

// The colleague's lines of 4 Nov (first name only).
const AT_0935 = new Date(2026, 10, 4, 9, 35, 27);
const AT_0952 = new Date(2026, 10, 4, 9, 52, 50);
const AT_0954 = new Date(2026, 10, 4, 9, 54, 55);
const DONE_BY_10 = { role: 'team', content: 'Both the facial and the massage last 60 mins! Depending on if you wish to shower afterwards you can be done by 10 :)', created_at: AT_0935, guest_replies_after: 0, previous: null };
const TAKEOVER = 'Thank you for your patience! You\'re now speaking with a real person from the Renessence team 🌿 How can we help you?';
const QUESTION_OF_4_NOV = 'Hi Tara, maybe we understood each other wrong, would you like to book the 2 appointments that you wanted to cancel for tomorrow to after the massage and facial of the 20? so all your bookings on the same day?';
const QUESTION = { role: 'team', content: QUESTION_OF_4_NOV, created_at: AT_0954, guest_replies_after: 0, previous: { role: 'team', content: TAKEOVER, created_at: AT_0952, guest_replies_after: 0 } };

const at = (d) => { jest.setSystemTime(d); };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  delete process.env.TEAM_REPLY_HOLD_MIN;
  conversations.clear(PHONE);
  db.isPaused.mockResolvedValue(false);
  db.isBlocked.mockResolvedValue(false);
  db.getLastOutboundMessage.mockResolvedValue(null);
  agent.run.mockResolvedValue();
  require('../src/routes/dashboard.routes').isBotPaused.mockReturnValue(false);
});
afterEach(() => jest.useRealTimers());

// ── 1. A reaction to a colleague stays with the team ─────────────────────────

describe('1. a reply within 30 minutes of a colleague\'s message stays with the team', () => {
  test('six minutes after the colleague: the bot does not answer, the chat is paused again and flagged', async () => {
    at(new Date(2026, 10, 4, 9, 41, 44));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handle({ from: PHONE, name: 'Tara', text: 'Oh!' });

    expect(agent.run).not.toHaveBeenCalled();
    expect(db.pauseConversation).toHaveBeenCalledWith(PHONE, 'Tara');
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'user', 'Oh!');
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest replied 6 min after your message — bot paused again');
    // No takeover notice again, no reply of any kind.
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(teamQueue.deliverQueuedTeamMessages).toHaveBeenCalledWith(PHONE);
  });

  test('a photo reply is held too', async () => {
    at(new Date(2026, 10, 4, 9, 41, 44));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handleNonText({ from: PHONE, name: 'Tara', type: 'photo', alreadyLogged: true, ack: 'Thanks for your photo!' });
    expect(db.pauseConversation).toHaveBeenCalledWith(PHONE, 'Tara');
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest replied 6 min after your message — bot paused again');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(teamQueue.deliverQueuedTeamMessages).toHaveBeenCalledWith(PHONE);
  });

  test('the takeover notice alone counts as the colleague\'s message for the hold', async () => {
    at(new Date(2026, 10, 4, 9, 55, 0));
    db.getLastOutboundMessage.mockResolvedValue({ role: 'team', content: TAKEOVER, created_at: AT_0952, guest_replies_after: 0, previous: null });
    await handle({ from: PHONE, name: 'Tara', text: 'Hi!' });
    expect(agent.run).not.toHaveBeenCalled();
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest replied 2 min after your message — bot paused again');
  });

  test('TEAM_REPLY_HOLD_MIN=0 switches the hold off', async () => {
    process.env.TEAM_REPLY_HOLD_MIN = '0';
    at(new Date(2026, 10, 4, 9, 41, 44));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handle({ from: PHONE, name: 'Tara', text: 'Oh!' });
    expect(agent.run).toHaveBeenCalledWith(PHONE, 'Tara', 'Oh!');
    expect(db.pauseConversation).not.toHaveBeenCalled();
  });
});

// ── 2. Later: the bot says who is answering, and what is still open ──────────

describe('2. the bot\'s first reply after a colleague', () => {
  test('after 30 minutes the bot answers, says it is the AI assistant again, and the team is flagged', async () => {
    at(new Date(2026, 10, 4, 10, 6, 0));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handle({ from: PHONE, name: 'Tara', text: 'Will we be done by 12?' });

    expect(agent.run).toHaveBeenCalledWith(PHONE, 'Tara', 'Will we be done by 12?');
    expect(db.pauseConversation).not.toHaveBeenCalled();
    expect(conversations.get(PHONE).replyPrefix).toEqual({ en: AI_AGAIN, nl: AI_AGAIN_NL });
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest wrote after a colleague\'s message of Wed 4 Nov 2026, 09:35 — the bot answered, please check');
  });

  test('fifteen days later the colleague\'s unanswered question is put back in front of the guest, with its date', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue(QUESTION);
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });

    const prefix = conversations.get(PHONE).replyPrefix;
    expect(prefix.en).toBe(`${AI_AGAIN} On Wednesday 4 November my colleague asked you: “${QUESTION_OF_4_NOV}” They haven't had your answer yet. You can answer here and I'll make sure they see it.`);
    expect(prefix.nl).toBe(`${AI_AGAIN_NL} Op woensdag 4 november vroeg mijn collega je: “${QUESTION_OF_4_NOV}” Daar is nog geen antwoord op gekomen. Je kunt hier antwoorden, dan zorg ik dat mijn collega het ziet.`);
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest wrote after a colleague\'s message of Wed 4 Nov 2026, 09:54 — the bot answered, please check');
    expect(agent.run).toHaveBeenCalled();
  });

  test('a sign-off without a question mark is not treated as an open question', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue({ role: 'team', content: 'You\'re very welcome, Tara! Thank you, and see you soon at Renessence!', created_at: new Date(2026, 9, 31, 11, 42, 37), guest_replies_after: 0, previous: null });
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });
    expect(conversations.get(PHONE).replyPrefix).toEqual({ en: AI_AGAIN, nl: AI_AGAIN_NL });
    expect(db.setNeedsReply).not.toHaveBeenCalled();
  });

  test('a question the guest already answered is not put back', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue({ ...QUESTION, guest_replies_after: 1 });
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });
    expect(conversations.get(PHONE).replyPrefix.en).toBe(AI_AGAIN);
    expect(db.setNeedsReply).not.toHaveBeenCalled();
  });

  test('a question older than 30 days is not put back', async () => {
    at(new Date(2026, 11, 6, 10, 0, 0));
    db.getLastOutboundMessage.mockResolvedValue(QUESTION);
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });
    expect(conversations.get(PHONE).replyPrefix.en).toBe(AI_AGAIN);
  });

  test('the takeover notice is not the colleague\'s question: the colleague\'s line before it is', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    // The notice is the last team line; its "How can we help you?" is not a question to put back.
    db.getLastOutboundMessage.mockResolvedValue({ role: 'team', content: TAKEOVER, created_at: AT_0952, guest_replies_after: 0, previous: { role: 'assistant', content: 'Thank you! Our team will arrange…', created_at: AT_0935, guest_replies_after: 0 } });
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });
    expect(conversations.get(PHONE).replyPrefix.en).toBe(AI_AGAIN);

    conversations.clear(PHONE);
    db.getLastOutboundMessage.mockResolvedValue({ role: 'team', content: TAKEOVER, created_at: AT_0954, guest_replies_after: 0, previous: { role: 'agent', content: QUESTION_OF_4_NOV, created_at: AT_0952, guest_replies_after: 0 } });
    await handle({ from: PHONE, name: 'Tara', text: 'Hello' });
    expect(conversations.get(PHONE).replyPrefix.en).toMatch(/^You're chatting with the Renessence AI assistant again\. On Wednesday 4 November my colleague asked you: “Hi Tara, maybe/);
  });

  test('when the bot spoke last nothing changes', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue({ role: 'assistant', content: 'Hello Tara! Welcome to Renessence', created_at: new Date(2026, 10, 19, 21, 32, 0), guest_replies_after: 0, previous: null });
    await handle({ from: PHONE, name: 'Tara', text: 'I missed your last message by accident' });
    expect(agent.run).toHaveBeenCalled();
    expect(conversations.get(PHONE)?.replyPrefix).toBeUndefined();
    expect(db.setNeedsReply).not.toHaveBeenCalled();
  });

  test('the line goes out once, at the start of the bot\'s first reply, in the chat\'s language', async () => {
    conversations.set(PHONE, { lang: 'en', replyPrefix: { en: AI_AGAIN, nl: AI_AGAIN_NL } });
    await tools.executeRespond(PHONE, { message: 'Hello Tara! How can I help?', ui_type: 'none', detected_language: 'nl' });
    await tools.executeRespond(PHONE, { message: 'Graag gedaan!', ui_type: 'none', detected_language: 'nl' });
    expect(whatsapp.sendText.mock.calls.map(c => c[1])).toEqual([`${AI_AGAIN_NL}\n\nHello Tara! How can I help?`, 'Graag gedaan!']);
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', `${AI_AGAIN_NL}\n\nHello Tara! How can I help?`);
  });
});

// ── 3. History restored from the database ────────────────────────────────────

describe('3. a colleague\'s lines come back labelled and dated', () => {
  const realAgent = jest.requireActual('../src/agents/renessence.agent');
  const ROWS = [
    { role: 'user', content: 'Will we be done by 12?', created_at: new Date(2026, 10, 4, 9, 31, 11) },
    DONE_BY_10,
    { role: 'user', content: 'Oh!', created_at: new Date(2026, 10, 4, 9, 41, 44) },
    { role: 'assistant', content: 'Would you like to add any other treatments?', created_at: new Date(2026, 10, 4, 9, 41, 47) },
    { role: 'team', content: '📨 Re-open request sent (WhatsApp template). Bot paused for this chat.', created_at: new Date(2026, 10, 4, 9, 50, 0) },
    { role: 'agent', content: QUESTION_OF_4_NOV, created_at: AT_0954 },
    { role: 'team', content: 'Sent without a date' },
  ];

  test('labelled, dated, the dashboard note left out, and the restore stays at 10 rows', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getMessagesByPhone.mockResolvedValue(ROWS);
    mockCreate.mockReset();
    let sentToModel = null; // a copy: the loop appends to the same array afterwards
    mockCreate.mockImplementationOnce(async ({ messages }) => {
      sentToModel = messages.slice(1).map(m => [m.role, m.content]);
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'respond', arguments: JSON.stringify({ message: 'Hi Tara!', ui_type: 'none' }) } }] } }] };
    });
    // The first row "is" a campaign intro, so the check goes on to the colleague's row.
    introPromo.isPromoMessage.mockImplementationOnce(() => true);
    await realAgent.run(PHONE, 'Tara', 'Hello');

    expect(db.getMessagesByPhone).toHaveBeenCalledWith(PHONE, 10, { strict: true });
    expect(sentToModel).toEqual([
      ['user', '[USER MESSAGE START]\nWill we be done by 12?\n[USER MESSAGE END]'],
      ['assistant', `[Written by a human colleague of the Renessence team, Wed 4 Nov 2026, 09:35]\n${DONE_BY_10.content}`],
      ['user', '[USER MESSAGE START]\nOh!\n[USER MESSAGE END]'],
      ['assistant', 'Would you like to add any other treatments?'],
      ['assistant', `[Written by a human colleague of the Renessence team, Wed 4 Nov 2026, 09:54]\n${QUESTION_OF_4_NOV}`],
      ['assistant', '[Written by a human colleague of the Renessence team]\nSent without a date'],
      ['user', '[USER MESSAGE START]\nHello\n[USER MESSAGE END]'],
    ]);
    // The campaign-intro check still sees the rows as they are stored.
    expect(introPromo.isPromoMessage).toHaveBeenCalledWith(DONE_BY_10.content, undefined);
  });

  test('the prompt tells the model what the label means', () => {
    const { buildSystemPrompt } = require('../src/agents/system-prompt');
    const p = buildSystemPrompt(PHONE, 'Tara');
    const section = p.slice(p.indexOf('## Messages from human colleagues'));
    expect(section).toMatch(/^## Messages from human colleagues\nEarlier messages that start with '\[Written by a human colleague of the Renessence team, <date>\]' were typed by staff, not by you\./);
    expect(section).toMatch(/Never contradict, correct or reinterpret what a colleague told the customer/);
  });

  test('the bot cannot pose as a colleague: an imitated label is stripped before sending', async () => {
    conversations.set(PHONE, { lang: 'en' });
    await tools.executeRespond(PHONE, { message: '[Written by a human colleague of the Renessence team, Wed 4 Nov 2026, 09:54]\nYes, 9 to 11 works.', ui_type: 'none' });
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Yes, 9 to 11 works.');
    expect(teamContext.stripColleagueLabel('  [written by a human colleague of the Renessence team] Hi')).toBe('Hi');
    expect(teamContext.stripColleagueLabel('I asked [Written by a human colleague of the Renessence team]')).toBe('I asked [Written by a human colleague of the Renessence team]');
  });
});

// ── 4. The database ──────────────────────────────────────────────────────────

describe('4. the last outbound message, and a database error', () => {
  const realDb = jest.requireActual('../src/data/database');

  test('dashboard notes and guest messages are not outbound; the line before the newest comes along', async () => {
    mockPgQuery.mockReset();
    mockPgQuery.mockResolvedValueOnce({ rows: [{ role: 'team', content: QUESTION_OF_4_NOV, created_at: AT_0954, guest_replies_after: 0 }, { role: 'team', content: TAKEOVER, created_at: AT_0952, guest_replies_after: 0 }] });
    const last = await realDb.getLastOutboundMessage(PHONE);
    expect(last).toEqual({ role: 'team', content: QUESTION_OF_4_NOV, created_at: AT_0954, guest_replies_after: 0, previous: { role: 'team', content: TAKEOVER, created_at: AT_0952, guest_replies_after: 0 } });
    const [sql, params] = mockPgQuery.mock.calls[0];
    // The automatic answer to a photo or sticker is not a reply to the colleague.
    expect(params).toEqual([PHONE, require('../src/config/non-text').NON_TEXT_ACKS]);
    expect(sql).toMatch(/content <> ALL\(\$2::text\[\]\)/);
    expect(sql).toMatch(/role <> 'user'/);
    expect(sql).toMatch(/NOT LIKE '📨 %'/);
    expect(sql).toMatch(/LIMIT 2/);

    mockPgQuery.mockResolvedValueOnce({ rows: [] });
    expect(await realDb.getLastOutboundMessage(PHONE)).toBeNull();
    mockPgQuery.mockRejectedValueOnce(new Error('connection refused'));
    expect(await realDb.getLastOutboundMessage(PHONE)).toBeNull();
  });

  test('a database error leaves the bot answering as before', async () => {
    at(new Date(2026, 10, 4, 9, 41, 44));
    db.getLastOutboundMessage.mockRejectedValue(new Error('connection refused'));
    await handle({ from: PHONE, name: 'Tara', text: 'Oh!' });
    expect(agent.run).toHaveBeenCalledWith(PHONE, 'Tara', 'Oh!');
    expect(db.pauseConversation).not.toHaveBeenCalled();
    expect(conversations.get(PHONE)?.replyPrefix).toBeUndefined();

    jest.clearAllMocks();
    await handleNonText({ from: PHONE, name: 'Tara', type: 'sticker', ack: 'Sorry, I can only process text messages.' });
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Sorry, I can only process text messages.');
  });
});

// ── 5. Found in review ───────────────────────────────────────────────────────

describe('5. found in review', () => {
  const { isBotPaused } = require('../src/routes/dashboard.routes');
  const PHOTO_ACK = require('../src/config/non-text').PHOTO_ACK;

  test('a photo two weeks after the colleague\'s question: the team is told, the ack goes out', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue(QUESTION);
    await handleNonText({ from: PHONE, name: 'Tara', type: 'photo', alreadyLogged: true, ack: PHOTO_ACK });
    expect(db.pauseConversation).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, PHOTO_ACK);
    expect(db.setNeedsReply).toHaveBeenCalledWith(PHONE, 'Guest sent a photo after a colleague\'s message of Wed 4 Nov 2026, 09:54 — the bot answered, please check');
  });

  test('during the global bot pause a sticker never pauses this one chat', async () => {
    isBotPaused.mockReturnValue(true);
    at(new Date(2026, 10, 4, 9, 41, 44));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handleNonText({ from: PHONE, name: 'Tara', type: 'sticker', ack: 'Sorry, I can only process text messages.' });
    expect(db.pauseConversation).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('a second message that arrives while the first reply is being sent does not get the line again', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    db.getLastOutboundMessage.mockResolvedValue(QUESTION);
    conversations.set(PHONE, { lang: 'en' });
    await handle({ from: PHONE, name: 'Tara', text: 'Oh!' });
    // Reply A takes the line; its row is not logged yet when B arrives.
    await tools.executeRespond(PHONE, { message: 'reply to Oh!', ui_type: 'none' });
    await handle({ from: PHONE, name: 'Tara', text: 'They happen at the same time?' });
    await tools.executeRespond(PHONE, { message: 'reply to They happen at the same time?', ui_type: 'none' });
    const sent = whatsapp.sendText.mock.calls.map(c => c[1]);
    expect(sent[0]).toMatch(/^You're chatting with the Renessence AI assistant again\. On Wednesday 4 November/);
    expect(sent[1]).toBe('reply to They happen at the same time?');
  });

  test('in front of buttons the line goes as its own message (WhatsApp\'s 1024-character limit)', async () => {
    const prefix = teamContext.replyPrefix({ question: { text: 'x'.repeat(600) + '?', at: AT_0954 } });
    conversations.set(PHONE, { lang: 'en', replyPrefix: prefix });
    const buttons = [{ id: 'confirm_booking', title: 'Confirm' }];
    await tools.executeRespond(PHONE, { message: 'Massage on Friday 20 November at 09:00, €120. Confirm?', ui_type: 'buttons', buttons });
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, prefix.en);
    expect(whatsapp.sendButtons).toHaveBeenCalledWith(PHONE, 'Massage on Friday 20 November at 09:00, €120. Confirm?', buttons);
  });

  test('a quoted question is capped at 500 characters', () => {
    const prefix = teamContext.replyPrefix({ question: { text: 'y'.repeat(600) + '?', at: AT_0954 } });
    const quoted = prefix.en.match(/“([^”]*)”/)[1];
    expect(quoted).toHaveLength(500);
    expect(quoted.endsWith('…')).toBe(true);
  });

  test('a line left unused is dropped once the bot spoke last', async () => {
    at(new Date(2026, 10, 19, 21, 32, 15));
    conversations.set(PHONE, { lang: 'en', replyPrefix: { en: AI_AGAIN, nl: AI_AGAIN_NL } });
    db.getLastOutboundMessage.mockResolvedValue({ role: 'assistant', content: 'Here is your payment link.', created_at: new Date(2026, 10, 19, 21, 30, 0), guest_replies_after: 0, previous: null });
    await handle({ from: PHONE, name: 'Tara', text: 'Thanks' });
    expect(conversations.get(PHONE).replyPrefix).toBeNull();
  });

  test('at exactly 30 minutes the bot answers; an unreadable TEAM_REPLY_HOLD_MIN means 30', async () => {
    at(new Date(AT_0935.getTime() + 30 * 60 * 1000));
    db.getLastOutboundMessage.mockResolvedValue(DONE_BY_10);
    await handle({ from: PHONE, name: 'Tara', text: 'Hi' });
    expect(agent.run).toHaveBeenCalled();

    jest.clearAllMocks();
    conversations.clear(PHONE);
    process.env.TEAM_REPLY_HOLD_MIN = 'abc';
    at(new Date(2026, 10, 4, 9, 41, 44));
    await handle({ from: PHONE, name: 'Tara', text: 'Oh!' });
    expect(agent.run).not.toHaveBeenCalled();
    expect(db.pauseConversation).toHaveBeenCalled();
  });
});
