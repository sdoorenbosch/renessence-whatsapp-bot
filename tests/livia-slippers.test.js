// Regression for "Livia" (26 Oct 2026): asked "Do you have a hairdryer? Towel
// and slippers are provided?", the bot answered "we do offer all of our sauna
// guests complimentary towels and slippers. Additionally, hairdryers are
// available for use." The team: slippers are not complimentary, they are for
// sale at reception for €4.50. Nothing the bot read said slippers cost money —
// the house rules said "Slippers zijn verkrijgbaar bij de receptie" and "what
// to bring" was the fragment "Slippers en een waterfles. Handdoek en badjas
// worden verstrekt." — and hairdryers were not written anywhere: the model
// answered a yes/no amenity question from what spas usually have.
//
// These tests pin the texts the bot reads. What the model then says can only
// be checked against the real model.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { slippersPrice } = require('../src/config/amenities');
const kb = require('../src/data/knowledge-base.json');

const by = 'Fabiana';
const clone = (v) => JSON.parse(JSON.stringify(v));
const KB_START = '## Knowledge base';
const KB_END = '## Opening hours, closures and notices';
const SECTION = '## Towels, bathrobe and slippers';
const build = () => buildSystemPrompt('31634000000', 'Livia');
const kbOf = (p) => JSON.parse(p.slice(p.indexOf(KB_START) + KB_START.length, p.indexOf(KB_END)).trim());
const section = (p) => p.slice(p.indexOf(SECTION), p.indexOf('## Retail products'));

function strings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') Object.values(node).forEach(v => strings(v, out));
  return out;
}

beforeEach(async () => {
  mockDb.rows.length = 0;
  await settings.load();
});

test('every knowledge-base text about slippers says they are not included and what a pair costs', () => {
  const texts = strings(kbOf(build())).filter(s => /slipper/i.test(s));
  expect(texts.length).toBeGreaterThanOrEqual(2);
  for (const t of texts) {
    expect(t).toContain('niet inbegrepen');
    expect(t).toContain(slippersPrice(','));
  }
});

test('the two sentences the bot read on 26 Oct are gone', () => {
  const p = build();
  expect(p).not.toContain('Slippers zijn verkrijgbaar bij de receptie.');
  expect(p).not.toContain('Slippers en een waterfles. Handdoek en badjas worden verstrekt.');
  expect(p).not.toMatch(/niets mee te nemen|nothing to bring|no need to bring anything/i);
});

test('the prompt rule: slippers are never complimentary, a pair costs €4.50 at reception', () => {
  expect(slippersPrice()).toBe('€4.50');
  const rule = section(build());
  expect(rule).toContain('Slippers are NOT provided and are never complimentary');
  expect(rule).toContain(`buy a pair at reception for ${slippersPrice()}`);
  // The retail rule right below says "Do NOT quote prices": this one is the exception.
  expect(rule).toContain('the one in-store price you may quote');
});

test('outside the knowledge base, slippers are only mentioned in that rule', () => {
  const p = build();
  const outsideKb = p.slice(0, p.indexOf(KB_START)) + p.slice(p.indexOf(KB_END));
  expect(outsideKb.replace(section(p), '')).not.toMatch(/slipper/i);
});

test('the house rules and the "what to bring" answer use the same price as the prompt rule', () => {
  const houseRule = kb.house_rules.find(r => /slipper/i.test(r));
  const faqAnswer = settings.DEFAULTS.faq.items.find(i => i.key === 'what_to_bring').answer;
  for (const dutch of [houseRule, faqAnswer]) expect(dutch).toContain(`receptie voor ${slippersPrice(',')}`);
});

test('a towel and a bathrobe are still provided', () => {
  expect(section(build())).toMatch(/A towel and a bathrobe are provided/);
  expect(kbOf(build()).faq.what_to_bring).toMatch(/handdoek en badjas krijg je van ons/i);
});

test('the bot only confirms amenities that are written down (the hairdryer was invented)', () => {
  const rule = section(build());
  expect(rule).toMatch(/hairdryer/);
  expect(rule).toMatch(/ONLY when this prompt or the knowledge base says so/);
  expect(rule).toMatch(/not sure/);
});

test('the rule is the same for every guest: it sits in the static part of the prompt', () => {
  const p = build();
  expect(p.indexOf(SECTION)).toBeGreaterThan(0);
  expect(p.indexOf(SECTION)).toBeLessThan(p.indexOf('## Service catalog'));
});

describe('once the team edits the FAQ in the dashboard, their saved list replaces the code defaults', () => {
  test('"What to bring" removed: the bot still knows slippers are for sale, with the price', async () => {
    const faq = clone(settings.DEFAULTS.faq);
    faq.items.splice(faq.items.findIndex(i => i.key === 'what_to_bring'), 1);
    expect((await settings.save('faq', faq, { by })).ok).toBe(true);
    const p = build();
    expect(kbOf(p).faq.what_to_bring).toBeUndefined();
    expect(section(p)).toContain(`buy a pair at reception for ${slippersPrice()}`);
    expect(kbOf(p).house_rules.join(' ')).toContain(slippersPrice(','));
  });

  test('a list saved with the old "what to bring" answer keeps that answer; the rule still holds', async () => {
    const faq = clone(settings.DEFAULTS.faq);
    faq.items.find(i => i.key === 'what_to_bring').answer = 'Slippers en een waterfles. Handdoek en badjas worden verstrekt.';
    await settings.save('faq', faq, { by });
    const p = build();
    expect(kbOf(p).faq.what_to_bring).toBe('Slippers en een waterfles. Handdoek en badjas worden verstrekt.');
    expect(section(p)).toContain('Slippers are NOT provided and are never complimentary');
  });

  test('the team\'s own wording reaches the bot unchanged', async () => {
    const faq = clone(settings.DEFAULTS.faq);
    faq.items.find(i => i.key === 'what_to_bring').answer = 'Bring your own slippers or buy a pair at reception for €4.50. We give you a towel and a bathrobe.';
    await settings.save('faq', faq, { by });
    expect(kbOf(build()).faq.what_to_bring).toBe('Bring your own slippers or buy a pair at reception for €4.50. We give you a towel and a bathrobe.');
  });
});
