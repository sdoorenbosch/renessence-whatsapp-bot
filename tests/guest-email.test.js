// What counts as "a real email address of this guest" (src/utils/guest-email.js)
// and where the bot remembers it (guest_contacts in src/data/database.js).
//
// Touriya, 27 Sep 2026: the model filled book_appointment with an address at
// example.com that nobody had typed, and a Mindbody profile "Touriya WhatsApp"
// was created with it. The rules pinned here: an address is well-formed, not
// reserved, and — checked by equality, never by "contains" — typed by the
// guest. The incident itself is replayed in tests/touriya-incident.test.js.

const mockQuery = jest.fn();
const mockConnect = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, on: jest.fn(), connect: mockConnect })) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const guestEmail = require('../src/utils/guest-email');
const db = require('../src/data/database');

const TEAM = ['welcome@renessence.com', 'events@renessence.com'];

describe('clean', () => {
  test.each([
    ['  anna@guest.fixture  ', 'anna@guest.fixture'],
    ['mailto:anna@guest.fixture', 'anna@guest.fixture'],
    ['<anna@guest.fixture>', 'anna@guest.fixture'],
    ['anna@guest.fixture.', 'anna@guest.fixture'],
    ['anna@guest.fixture,', 'anna@guest.fixture'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ])('%p → %p', (input, expected) => {
    expect(guestEmail.clean(input)).toBe(expected);
  });
});

describe('isWellFormed', () => {
  test.each([
    'anna@guest.fixture',
    'Anna.Smith+spa@mail.guest.fixture',
    'o\'brien@guest.fixture',
    'a@b.nl',
  ])('%p is an address', (e) => {
    expect(guestEmail.isWellFormed(e)).toBe(true);
  });

  test.each([
    'anna',
    'anna@',
    '@guest.fixture',
    'anna@guest',            // no ending
    'anna@guest.f',          // ending of one letter
    'anna@guest.123',        // ending is not letters
    'anna@@guest.fixture',
    'anna smith@guest.fixture',
    '.anna@guest.fixture',
    'anna..smith@guest.fixture',
    'anna@-guest.fixture',
    'änna@guest.fixture',    // not ASCII: the guest is asked to type another one
    `${'a'.repeat(65)}@guest.fixture`,
  ])('%p is not', (e) => {
    expect(guestEmail.isWellFormed(e)).toBe(false);
  });
});

describe('isReserved — only what can never be a guest\'s own address', () => {
  test.each([
    'touriya@example.com',
    'touriya@example.nl',
    'touriya@mail.example.org',
    'touriya@spa.test',
    'touriya@spa.example',
    'touriya@spa.invalid',
    'touriya@spa.localhost',
    'touriya@spa.local',
    'welcome@renessence.com',   // the team's own mailbox
    'Welcome@Renessence.com',
  ])('%p is reserved', (e) => {
    expect(guestEmail.isReserved(e, TEAM)).toBe(true);
  });

  // The first design refused these too; real guests have such addresses, and
  // the "typed by the guest" rule already keeps inventions out.
  test.each([
    'na@gmail.com',
    'none@gmail.com',
    'anna@test.nl',
    'anna@test.com',
    'anna@sample.com',
    'anna@examples.com',        // "examples" is not the reserved label
    'anna@myexample.nl',
    'bianca@renessence.com',    // staff book with their own address
    'anna@guest.fixture',       // the suite's fixture domain
  ])('%p is NOT reserved', (e) => {
    expect(guestEmail.isReserved(e, TEAM)).toBe(false);
  });
});

describe('isUsable', () => {
  test('clean + well-formed + not reserved', () => {
    expect(guestEmail.isUsable(' <anna@guest.fixture> ', TEAM)).toBe(true);
    expect(guestEmail.isUsable('touriya@example.com', TEAM)).toBe(false);
    expect(guestEmail.isUsable('welcome@renessence.com', TEAM)).toBe(false);
    expect(guestEmail.isUsable('not an address', TEAM)).toBe(false);
    expect(guestEmail.isUsable('', TEAM)).toBe(false);
    expect(guestEmail.isUsable(null, TEAM)).toBe(false);
  });
});

describe('addressesIn', () => {
  test('finds whole addresses in a guest message', () => {
    expect(guestEmail.addressesIn('Anna Smith\nAnna.Smith@guest.fixture')).toEqual(['Anna.Smith@guest.fixture']);
    expect(guestEmail.addressesIn('mine is anna@guest.fixture, hers bo@guest.fixture.')).toEqual(['anna@guest.fixture', 'bo@guest.fixture']);
    expect(guestEmail.addressesIn('(anna@guest.fixture)')).toEqual(['anna@guest.fixture']);
    expect(guestEmail.addressesIn('email:anna@guest.fixture')).toEqual(['anna@guest.fixture']);
  });

  test('spaces around the @ are a typing slip, not two words', () => {
    expect(guestEmail.addressesIn('anna @ guest.fixture')).toEqual(['anna@guest.fixture']);
  });

  test('no address, no result', () => {
    expect(guestEmail.addressesIn('14:00 please')).toEqual([]);
    expect(guestEmail.addressesIn('')).toEqual([]);
    expect(guestEmail.addressesIn(null)).toEqual([]);
  });
});

describe('typedByGuest — equality with an address in a guest message', () => {
  const texts = ['Hi', 'Anna Smith\nAnna.Smith@Guest.Fixture', '14:00'];

  test('the typed address counts, whatever the capitals', () => {
    expect(guestEmail.typedByGuest('anna.smith@guest.fixture', texts)).toBe(true);
    expect(guestEmail.typedByGuest('ANNA.SMITH@GUEST.FIXTURE', texts)).toBe(true);
  });

  test('a tail of a typed address does not ("smith@…" from "anna.smith@…")', () => {
    expect(guestEmail.typedByGuest('smith@guest.fixture', texts)).toBe(false);
  });

  test('nor does a "corrected" or completed one', () => {
    expect(guestEmail.typedByGuest('anna.smith@guest.fixtures', texts)).toBe(false);
    expect(guestEmail.typedByGuest('annasmith@guest.fixture', texts)).toBe(false);
  });

  test('"na@gmail.com" is accepted when the guest typed it', () => {
    expect(guestEmail.typedByGuest('na@gmail.com', ['my mail: na@gmail.com'])).toBe(true);
  });

  // Guests wrap an address in quotes or WhatsApp's *bold* / _italic_ marks, or
  // glue it to a label. Those signs are legal inside an address, so they used
  // to be read as part of it and the guest was asked to type it again.
  test.each([
    "'anna.smith@guest.fixture'",
    '"anna.smith@guest.fixture"',
    '*anna.smith@guest.fixture*',
    '_Anna.Smith@guest.fixture_',
    'email=anna.smith@guest.fixture',
    'Anna Smith/anna.smith@guest.fixture',
  ])('typed as %p counts', (text) => {
    expect(guestEmail.typedByGuest('anna.smith@guest.fixture', [text])).toBe(true);
  });

  test('…but a sign INSIDE an address stays part of it, and a tail still does not count', () => {
    const obrien = ["my mail is o'brien@guest.fixture"];
    expect(guestEmail.typedByGuest("o'brien@guest.fixture", obrien)).toBe(true);
    expect(guestEmail.typedByGuest('brien@guest.fixture', obrien)).toBe(false);
    expect(guestEmail.typedByGuest('anna_smith@guest.fixture', ['anna_smith@guest.fixture'])).toBe(true);
    expect(guestEmail.typedByGuest('smith@guest.fixture', ['_anna_smith@guest.fixture_'])).toBe(false);
    expect(guestEmail.typedByGuest('smith@guest.fixture', ['*anna.smith@guest.fixture*'])).toBe(false);
  });

  test('nothing typed, nothing accepted', () => {
    expect(guestEmail.typedByGuest('anna@guest.fixture', [])).toBe(false);
    expect(guestEmail.typedByGuest('anna@guest.fixture', null)).toBe(false);
    expect(guestEmail.typedByGuest('', texts)).toBe(false);
  });
});

// ── guest_contacts: what a number told us once ───────────────────────────────

describe('guest_contacts helpers never throw into the booking', () => {
  beforeEach(() => mockQuery.mockReset());

  test('getGuestContact returns the row, or null when there is none', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ email: 'anna@guest.fixture', full_name: 'Anna Smith', mindbody_client_id: '42' }] });
    expect(await db.getGuestContact('31600000001')).toEqual({ email: 'anna@guest.fixture', full_name: 'Anna Smith', mindbody_client_id: '42' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['31600000001']);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await db.getGuestContact('31600000001')).toBeNull();
  });

  test('a database failure reads as "nothing stored" and "nothing typed"', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    await expect(db.getGuestContact('31600000001')).resolves.toBeNull();
    await expect(db.getGuestTypedTexts('31600000001')).resolves.toEqual([]);
    await expect(db.saveGuestContact('31600000001', { email: 'anna@guest.fixture' })).resolves.toBeUndefined();
  });

  test('getGuestTypedTexts reads only what the guest wrote, newest first, with an @', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ content: 'anna@guest.fixture' }, { content: 'Anna Smith old@guest.fixture' }] });
    expect(await db.getGuestTypedTexts('31600000001')).toEqual(['anna@guest.fixture', 'Anna Smith old@guest.fixture']);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/role = 'user'/);
    expect(sql).toMatch(/'@'/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params[0]).toBe('31600000001');
  });

  // Personal data does not stay for ever: the conversation history goes after
  // six months, and a contact nobody booked with for two years goes too (every
  // booking refreshes updated_at).
  test('a contact that was not used for 24 months is removed at startup, next to the old messages', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    mockConnect.mockResolvedValueOnce({ query: clientQuery, release: jest.fn() });
    await db.initialize();
    const statements = clientQuery.mock.calls.map(c => String(c[0]));
    expect(statements.some(q => /CREATE TABLE IF NOT EXISTS guest_contacts/.test(q))).toBe(true);
    expect(statements).toContain("DELETE FROM guest_contacts WHERE updated_at < NOW() - INTERVAL '24 months'");
  });

  test('saveGuestContact never overwrites what is stored with nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await db.saveGuestContact('31600000001', { email: null, fullName: 'Anna Smith', mindbodyClientId: 42 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(phone\) DO UPDATE/);
    expect(sql).toMatch(/COALESCE\(EXCLUDED\.email, guest_contacts\.email\)/);
    expect(sql).toMatch(/COALESCE\(EXCLUDED\.full_name, guest_contacts\.full_name\)/);
    expect(sql).toMatch(/COALESCE\(EXCLUDED\.mindbody_client_id, guest_contacts\.mindbody_client_id\)/);
    expect(params).toEqual(['31600000001', null, 'Anna Smith', '42']);
  });
});
