/**
 * What counts as a guest's own email address. Pure helpers, no I/O.
 *
 * Touriya, 27 Sep 2026: the model filled book_appointment with an address at
 * example.com that nobody had typed; a Mindbody profile "Touriya WhatsApp" was
 * created with it and the team could not email her about a failed payment.
 * An address only counts when it is well-formed, not reserved, and came from
 * the guest.
 */

// Endings that can never be a real mailbox (RFC 2606 / 6762).
const RESERVED_ENDINGS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);

const LOCAL_CHARS = "A-Za-z0-9.!#$%&'*+/=?^_`{|}~-";
const LOCAL_PART = new RegExp(`^[${LOCAL_CHARS}]{1,64}$`);
const ADDRESS_IN_TEXT = new RegExp(`[${LOCAL_CHARS}]+@[A-Za-z0-9.-]+`, 'g');

/** Trimmed, without "mailto:", angle brackets or a trailing . , ; — null when nothing is left. */
function clean(value) {
  if (value == null) return null;
  const s = String(value).trim()
    .replace(/^mailto:/i, '')
    .replace(/^</, '')
    .replace(/>$/, '')
    .replace(/[.,;]+$/, '');
  return s || null;
}

/** Plain ASCII, one "@", a domain whose ending is two or more letters. */
function isWellFormed(email) {
  const e = String(email || '');
  if (!e || e.length > 254) return false;
  const at = e.split('@');
  if (at.length !== 2) return false;
  const [local, domain] = at;
  if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(l => /^[A-Za-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
}

/**
 * An address that can never be the guest's own: a domain label "example"
 * (example.com, example.nl), a reserved ending, or one of our own mailboxes.
 * Deliberately short. Lists of "dummy" domains and names (test.nl, na@, none@)
 * refuse real guests, and an invented address is already stopped by the rule
 * that the guest must have typed it.
 */
function isReserved(email, ownAddresses = []) {
  const e = String(email || '').toLowerCase();
  const labels = (e.split('@')[1] || '').split('.');
  if (RESERVED_ENDINGS.has(labels[labels.length - 1])) return true;
  if (labels.includes('example')) return true;
  return ownAddresses.some(own => String(own || '').trim().toLowerCase() === e);
}

function isUsable(email, ownAddresses = []) {
  const e = clean(email);
  return !!e && isWellFormed(e) && !isReserved(e, ownAddresses);
}

/**
 * Every address written in a text; "anna @ mail.nl" counts as one address.
 * Guests wrap an address in quotes or WhatsApp's *bold* / _italic_ marks, or
 * glue it to a label ("email=anna@mail.nl", "Anna Smit/anna@mail.nl"). Those
 * signs are legal inside an address, so the text is read both ways: as it
 * stands, and without signs in front and anything up to a "=" or "/". Only
 * the front is stripped — "o'brien@mail.nl" never becomes "brien@mail.nl".
 */
function addressesIn(text) {
  const found = String(text || '').replace(/\s*@\s*/g, '@').match(ADDRESS_IN_TEXT) || [];
  const out = [];
  for (const raw of found) {
    const whole = clean(raw);
    if (whole) out.push(whole);
    const bare = clean(raw.replace(/^.*[=/]/, '').replace(/^[^A-Za-z0-9]+/, ''));
    if (bare && bare !== whole) out.push(bare);
  }
  return out;
}

/**
 * Did the guest type exactly this address (capitals aside) in one of these
 * messages? Equality with a whole address, never "the text contains it":
 * "smith@mail.nl" is not what a guest gave who typed "anna.smith@mail.nl".
 * An address split over two lines is not recognised; the guest is asked to
 * type it once more.
 */
function typedByGuest(email, texts) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  return (texts || []).some(text => addressesIn(text).some(a => a.toLowerCase() === e));
}

module.exports = { clean, isWellFormed, isReserved, isUsable, addressesIn, typedByGuest };
