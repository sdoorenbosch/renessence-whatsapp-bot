// Regression for "Lin" (8 Nov 2026): running 10 minutes late for an Infrared
// Sauna, the bot answered "Our grace period for the Infrared Sauna is 15
// minutes, which includes the time you'll be arriving late." The team found
// "grace period" confusing for guests and asked for one plain sentence
// instead, with no minutes quoted per treatment.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const TEAM_SENTENCE = 'Please note that if you arrive late for your appointment, we may need to adjust the treatment time accordingly to ensure we can accommodate all scheduled appointments.';

let prompt;
beforeAll(async () => {
  await settings.load();
  prompt = buildSystemPrompt('31634000000', 'Lin');
});

test('a guest running late gets the team\'s sentence', () => {
  const section = prompt.slice(prompt.indexOf('## Running late'), prompt.indexOf('## Gift cards'));
  expect(section).toContain(TEAM_SENTENCE);
  expect(section).toMatch(/request_human_handoff with reason "running late"/);
});

test('"grace period" only appears where the bot is told never to say it', () => {
  const lines = prompt.split('\n').filter(l => /grace[ _-]?period/i.test(l));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/never|nooit/i);
});

test('no minutes are quoted per treatment for arriving late', () => {
  expect(prompt).not.toMatch(/\*\*(5|10|15) minutes\*\*/);
  const kb = require('../src/data/knowledge-base.json');
  expect(JSON.stringify(kb.policies.late_arrival)).not.toMatch(/\d+[ _]?minut/i);
});
