// OpenAI bills cached input tokens at half price, but only for the longest
// prefix that is byte-identical between calls. With the customer line at the
// top of the system prompt nothing beyond it was ever shared. This pins the
// layout: everything session-specific sits at the END.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));

const { buildSystemPrompt } = require('../src/agents/system-prompt');

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

test('two different customers share ≥ 98% of the prompt as an identical prefix', () => {
  const alice = buildSystemPrompt('31611111111', 'Alice');
  const bob = buildSystemPrompt('31622222222', 'Bob', true, false);
  const shared = commonPrefixLength(alice, bob);
  expect(shared / Math.min(alice.length, bob.length)).toBeGreaterThan(0.98);
});

test('the session facts are at the end and still complete', () => {
  const p = buildSystemPrompt('31611111111', 'Alice', true, true);
  const session = p.lastIndexOf('\n## Session\n');
  expect(session).toBeGreaterThan(p.length * 0.9);
  const tail = p.slice(session);
  expect(tail).toMatch(/Customer: Alice \| Phone: 31611111111/);
  expect(tail).toMatch(/Today: \d{4}-\d{2}-\d{2} \| Tomorrow: \d{4}-\d{2}-\d{2}/);
  expect(tail).toMatch(/CONTINUING CONVERSATION/);
  expect(tail).toMatch(/HISTORY UNAVAILABLE/);
  expect(p.indexOf('Customer: Alice')).toBeGreaterThan(p.indexOf('## Knowledge base'));
});

// Melanie, 23 Nov 2026: the model worked out "Saturday" by itself and landed on
// a Wednesday; Session now carries a 28-day calendar. It is dated, so it must
// not sit earlier in the prompt — and it comes BEFORE the customer line, so
// every guest of the day still shares it as part of the cached prefix.
test('the day calendar sits in the Session tail, before the customer line', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  const session = p.lastIndexOf('\n## Session\n');
  const tail = p.slice(session);
  const calendar = tail.match(/^\w+day \d{1,2} \w+ \d{4} = \d{4}-\d{2}-\d{2}.*$/gm);
  expect(calendar).toHaveLength(28);
  expect(calendar[0]).toMatch(/\(today/);
  expect(tail.indexOf(calendar[27])).toBeLessThan(tail.indexOf('Customer:'));
  expect(tail).toMatch(/\| In 30 days: \d{4}-\d{2}-\d{2}\nCustomer: Alice/);
  expect(p.slice(0, session)).not.toMatch(/^\w+day \d{1,2} \w+ \d{4} = \d{4}-\d{2}-\d{2}/m);
});

test('date-dependent rules point at the Session section, not "the top"', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  expect(p).not.toMatch(/top of this prompt/);
  expect(p).toMatch(/Session section at the end of this prompt/i);
});

test('web sessions get the web-chat block in the tail', () => {
  const p = buildSystemPrompt('web_abc', 'Guest');
  expect(p.slice(p.lastIndexOf('\n## Session\n'))).toMatch(/## Web chat/);
  expect(p.startsWith('You are the website assistant')).toBe(true);
});

// Tara, 4 Nov 2026: a colleague's lines come back labelled in the history; the
// rule for them is static text, so it sits before the catalog like every rule.
// The dead "__RESUME__" hand-back section is gone (nothing feeds it any more).
test('the colleague rule is static and sits before the catalog; no __RESUME__ section', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  const colleagues = p.indexOf('\n## Messages from human colleagues\n');
  expect(colleagues).toBeGreaterThan(0);
  expect(colleagues).toBeLessThan(p.indexOf('\n## Service catalog'));
  expect(p).not.toMatch(/__RESUME__/);
});
