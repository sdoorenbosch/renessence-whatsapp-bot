/**
 * The one place that knows which weekday a date is.
 *
 * Melanie, 23 Nov 2026: she asked for "Saturday". The model turned that into
 * 25 November by itself — a Saturday in 2023, a Wednesday in 2026 — and showed
 * Wednesday's times six times as "Saturday, 25th November". Nothing in code
 * knew which weekday a date is at the point where text leaves for the guest.
 * The calendar in the prompt, the day labels in tool results, the weekday
 * argument of check_availability and the check on every reply
 * (reply-guards.js) all read it from here.
 *
 * Naive Amsterdam-local dates only (the server runs with TZ=Europe/Amsterdam):
 * a calendar day is "local noon of that day", so no summer-time switch and no
 * UTC offset can move it to another date.
 */

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NL_DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NL_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const EN_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_TOKENS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
  zo: 0, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6,
};
const MONTH_TOKENS = {
  january: 0, jan: 0, januari: 0, february: 1, feb: 1, februari: 1, march: 2, mar: 2, maart: 2, mrt: 2,
  april: 3, apr: 3, may: 4, mei: 4, june: 5, jun: 5, juni: 5, july: 6, jul: 6, juli: 6,
  august: 7, aug: 7, augustus: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, oktober: 9, okt: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};

// A day written without its year is read as its one occurrence from 60 days
// back to about 10 months ahead (a visit just behind us, or the coming one).
const LOOK_BACK_DAYS = 60;
// Labels written by code carry the year outside that window, so they are read
// back as the day they were written for.
const LABEL_YEAR_AHEAD_DAYS = 300;
// Code only REPLACES a wrong weekday for a day close to today; further away
// the weekday word is removed instead (correctWeekdays).
const REPLACE_BACK_DAYS = 7;
const REPLACE_AHEAD_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const noon = (y, m, d) => new Date(y, m, d, 12, 0, 0, 0);
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local noon of a day that exists (31 November does not), else null. */
function realDay(y, m, d) {
  const x = noon(y, m, d);
  return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d ? x : null;
}
/** 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM:SS' or a Date → local noon of that calendar day; null when it is no date. */
function localDay(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : noon(v.getFullYear(), v.getMonth(), v.getDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? realDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
const plusDays = (d, n) => noon(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysApart = (from, to) => Math.round((to - from) / DAY_MS);

/** 0 = Sunday … 6 = Saturday, or null when the value is no date. */
function weekdayOf(v) {
  const d = localDay(v);
  return d ? d.getDay() : null;
}

/** "saturday", "Zaterdag", "sat" → 6; null for anything else. */
function weekdayIndex(word) {
  const wd = DAY_TOKENS[String(word ?? '').trim().toLowerCase().replace(/\.$/, '')];
  return wd === undefined ? null : wd;
}

/** Every day from start to end (YYYY-MM-DD, inclusive), at most `cap`; [] when either is no date. */
function rangeDays(start, end, cap = 31) {
  const first = localDay(start);
  const last = localDay(end ?? start);
  if (!first || !last) return [];
  const out = [];
  for (let d = first; d <= last && out.length < cap; d = plusDays(d, 1)) out.push(toYmd(d));
  return out;
}

/**
 * "Wednesday 25 November" / "woensdag 25 november". The year is added when
 * asked for ({ year: true }), and by itself for a day far from today.
 */
function dayLabel(v, lang = 'en', { year, now } = {}) {
  const d = localDay(v);
  if (!d) return String(v ?? '');
  const nl = lang === 'nl';
  const text = `${(nl ? NL_DAYS : EN_DAYS)[d.getDay()]} ${d.getDate()} ${(nl ? NL_MONTHS : EN_MONTHS)[d.getMonth()]}`;
  let withYear = !!year;
  if (year === undefined) {
    const ahead = daysApart(localDay(now || new Date()), d);
    withYear = ahead < -LOOK_BACK_DAYS || ahead > LABEL_YEAR_AHEAD_DAYS;
  }
  return withYear ? `${text} ${d.getFullYear()}` : text;
}

/** The calendar for the prompt: one line per day from today, "Monday 23 November 2026 = 2026-11-23 (today)". */
function calendarLines(now = new Date(), days = 28) {
  const today = localDay(now);
  const toSaturday = (6 - today.getDay() + 7) % 7;
  const lines = [];
  for (let i = 0; i < days; i++) {
    const d = plusDays(today, i);
    const tags = [];
    if (i === 0) tags.push('today');
    if (i === 1) tags.push('tomorrow');
    if (i === 2) tags.push('the day after tomorrow / overmorgen');
    // On a Sunday the weekend is today; otherwise the first Saturday and its Sunday.
    if (today.getDay() === 0 ? i === 0 : (i === toSaturday || i === toSaturday + 1)) tags.push('this weekend');
    lines.push(`${dayLabel(d, 'en', { year: true })} = ${toYmd(d)}${tags.length ? ` (${tags.join('; ')})` : ''}`);
  }
  return lines;
}

/**
 * Where a weekday falls around a date: `near` = that weekday just before and
 * just after the date (days already past are left out), `coming` = the first
 * one after today, `today` = today's date when today is that weekday.
 */
function weekdaysAround(wd, ymd, now = new Date()) {
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { near: [], coming: null, today: null };
  const today = localDay(now);
  const day = localDay(ymd) || today;
  const step = (from, dir) => {
    let d = plusDays(from, dir);
    while (d.getDay() !== wd) d = plusDays(d, dir);
    return d;
  };
  return {
    near: [step(day, -1), step(day, 1)].filter(d => d >= today).map(toYmd),
    coming: toYmd(step(today, 1)),
    today: today.getDay() === wd ? toYmd(today) : null,
  };
}

// ---- Finding "<weekday> + <date>" in a text ----
// One weekday word next to one date, in either order. Built to be tolerant:
// the first version of this check missed 19 of 53 ways of writing the pair
// (bold marks, a dash or colon in between, the date first, Dutch compounds).
// Every run of spaces or marks is bounded: an open-ended run after a weekday
// once made one reply with 1,500 spaces block the whole server for 14 s.

const FULL = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag';
const ABBR = 'thurs|tues|weds|thur|sun|mon|tue|wed|thu|fri|sat';
const NL2 = 'zo|ma|di|wo|do|vr|za';
const NL2_DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MONTHS = Object.keys(MONTH_TOKENS).sort((a, b) => b.length - a.length).join('|');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const WS = '[ \\t\\u00a0\\u202f]';                                  // a space, a tab, a no-break space
const MK = '[*_~]{0,3}';                                          // WhatsApp bold / italic / strike-through marks
const DAYPART = '(?:ochtend|morgen|middag|avond|nacht)?';         // zaterdagochtend, zaterdagmiddag …
const DAYWORD = '(?:morning|afternoon|evening|night|ochtend|middag|avond)';   // as a word of its own ("morgen" alone is tomorrow)
const ORD = '(?:st|nd|rd|th|ste|de|e)';
// After a date or a weekday that closes the pair: the end, punctuation or a time ("at 12:00", "om 12:00").
const CLOSES = `(?=\\s{0,4}(?:[).,;:!?\\]\\n]|$|(?:at|om)${E}))`;
// Weekday → date: spaces, one of , ( [ : – — - · | •, at most one line break, the marks, and "the" / "de" / "which is" / "is (the)" / "a.s.".
// Never a full stop: "Every Saturday. 25 November is full" is two sentences.
const GAP = `${MK}(?:${WS}{1,3}${DAYWORD}${E})?${WS}{0,4}[,(\\[:–—\\-·|•]?${WS}{0,4}\\n?${WS}{0,4}${MK}(?:(?:the|de|den|which is|is the|is de|is|a\\.s\\.|aanstaande|=)${WS}{1,3})?${MK}`;
// Between two days that share one month: "Saturday 25 and Sunday 26 November", "Mon 24 – Fri 28 Nov".
const LINK = `(?:${WS}{0,3}[,&/–—-]${WS}{0,3}|${WS}{1,3}(?:and|or|en|of|to|through|till|until|tot|t/m)${WS}{1,3})`;

/** The date half of the pattern. */
function datePattern(weekdayFirst, two) {
  const day = `(?:(?:${FULL})${DAYPART}|(?:${ABBR}${two ? `|${NL2}` : ''})\\.?)`;
  return '(?:'
    + `(?<d1>\\d{1,2})${ORD}?\\.?\\s{1,3}(?:of\\s{1,3})?(?<m1>${MONTHS})\\.?${E}(?:,?\\s{1,3}(?<y1>\\d{4})${E})?`     // 25th November [2026]
    + `|(?<m2>${MONTHS})\\.?\\s{1,3}(?<d2>\\d{1,2})${ORD}?${E}(?!\\s{0,3}[:.]\\d)(?:,?\\s{1,3}(?<y2>\\d{4})${E})?`    // November 25th[, 2026]
    + `|(?<y3>\\d{4})-(?<m3>\\d{2})-(?<d3>\\d{2})${E}`                                                    // 2026-11-25
    + `|(?<d4>\\d{1,2})\\/(?<m4>\\d{1,2})(?:\\/(?<y4>\\d{4}))?${E}`                                       // 25/11[/2026]
    + `|(?<d5>\\d{1,2})[.-](?<m5>\\d{1,2})[.-](?<y5>\\d{4})${E}`                                          // 25-11-2026 · 25.11.2026
    + `|(?<d6>2[5-9]|3[01])[.-](?<m6>0?[1-9]|1[0-2])${E}(?![.:-]?\\d)`                                    // 25.11 · 25-11 (a day above 24 is never a time)
    // "Saturday 25 and Sunday 26 November": the 25th borrows the month (and year) written after the next day.
    + (weekdayFirst ? `|(?<d8>\\d{1,2})${ORD}?${E}(?=${LINK}${MK}${day}?${MK}${WS}{0,3}(?:(?:the|de)${WS}{1,3})?${MK}\\d{1,2}${ORD}?\\.?\\s{1,3}(?:of\\s{1,3})?(?<m8>${MONTHS})\\.?${E}(?:,?\\s{1,3}(?<y8>\\d{4})${E})?)` : '')
    // "the 25th": after a weekday when the pair closes there; date first only in brackets (checked in scan).
    + (weekdayFirst ? `|(?<d7>\\d{1,2})${ORD}${E}${CLOSES}` : `|(?<d7>\\d{1,2})${ORD}${E}`)
    + ')';
}
const weekdayPattern = (two) => `(?:(?<full>${FULL})(?<part>${DAYPART})|(?<abbr>${ABBR}${two ? `|${NL2}` : ''})(?<dot>\\.?))(?!\\p{L})`;
// A weekday that ends a range or a list ("Monday to Friday", "Saturday and
// Sunday", "maandag t/m vrijdag") is not the weekday of the date after it:
// "runs Monday to Friday, 30 November to 4 December" once became "Monday to Monday".
const rangeEnd = (two) => new RegExp(`${B}(?:${FULL}|${ABBR}${two ? `|${NL2}` : ''})${DAYPART}\\.?${MK}${LINK}${MK}$`, 'iu');
const PATTERNS = new Map();
/** [weekday first, date first, range end] — with or without the two-letter Dutch abbreviations. */
function patterns(two) {
  if (!PATTERNS.has(two)) {
    PATTERNS.set(two, [
      new RegExp(`${B}(?<lead>${MK})${weekdayPattern(two)}(?<gap>${GAP})${datePattern(true, two)}`, 'giud'),
      new RegExp(`${B}${datePattern(false, two)}(?<time>${WS}{1,3}(?:at|om)${WS}{1,3}\\d{1,2}[:.]\\d{2})?(?<sep>${MK}(?:${WS}{0,4}[,(\\[–—-]?${WS}{0,4}|${WS}{1,3}(?:is|falls on|valt op)${WS}{1,3}(?:(?:a|an|een|on|op)${WS}{1,3})?)${MK})${weekdayPattern(two)}(?<post>${MK})${CLOSES}`, 'giud'),
      rangeEnd(two),
    ]);
  }
  return PATTERNS.get(two);
}

/**
 * The day(s) a written date can mean: `cands` (the first is the reading used
 * when the weekday fits none), [] when it does not exist (31 November), or
 * null when the numbers are no date at all. `known`: read from a day that
 * was checked in this turn.
 * A written year wins. Without one it is the single occurrence from 60 days
 * back to about 10 months ahead: "Saturday 2 January" said on 28 December is
 * next year's, "Wednesday 30 December" said on 3 January last year's.
 */
function datesOf(g, now, knownDays) {
  const today = localDay(now);
  const num = (v) => (v === undefined ? null : Number(v));
  const month = (name) => MONTH_TOKENS[String(name).toLowerCase()];
  let day; let mon; let year = null;
  if (g.d1 !== undefined) { day = num(g.d1); mon = month(g.m1); year = num(g.y1); }
  else if (g.d2 !== undefined) { day = num(g.d2); mon = month(g.m2); year = num(g.y2); }
  else if (g.d3 !== undefined) { day = num(g.d3); mon = num(g.m3) - 1; year = num(g.y3); }
  else if (g.d4 !== undefined) { day = num(g.d4); mon = num(g.m4) - 1; year = num(g.y4); }
  else if (g.d5 !== undefined) { day = num(g.d5); mon = num(g.m5) - 1; year = num(g.y5); }
  else if (g.d6 !== undefined) { day = num(g.d6); mon = num(g.m6) - 1; }
  else if (g.d8 !== undefined) { day = num(g.d8); mon = month(g.m8); year = num(g.y8); }
  else {
    // "the 25th" names no month. A day this turn checked with that number is
    // the one meant ("Friday the 1st" after checking 1 January). Otherwise
    // the next day with that number — or the last one, up to a month back:
    // "yesterday, Sunday the 22nd" is right, not 22 December.
    day = num(g.d7);
    if (!(day >= 1 && day <= 31)) return null;
    const known = [...(knownDays || [])].map(localDay).filter(d => d && d.getDate() === day);
    if (known.length === 1) return { cands: known, known: true };
    let next = null;
    for (let i = 0; i < 12 && !next; i++) {
      const d = realDay(today.getFullYear() + Math.floor((today.getMonth() + i) / 12), (today.getMonth() + i) % 12, day);
      if (d && d >= today) next = d;
    }
    let last = null;
    for (let i = 0; i <= 2 && !last; i++) {
      const d = realDay(today.getFullYear(), today.getMonth() - i, day) || null;
      const d2 = d || (() => { const x = new Date(today.getFullYear(), today.getMonth() - i, 1, 12); return realDay(x.getFullYear(), x.getMonth(), day); })();
      if (d2 && d2 < today && daysApart(d2, today) <= 31) last = d2;
    }
    return { cands: [next, last].filter(Boolean), known: false };
  }
  if (!(day >= 1 && day <= 31) || !(mon >= 0 && mon <= 11)) return null;
  if (year !== null) { const d = realDay(year, mon, day); return { cands: d ? [d] : [], known: false, year: true }; }
  const from = plusDays(today, -LOOK_BACK_DAYS);
  // (A few years on, for 29 February.)
  for (let y = from.getFullYear(); y <= from.getFullYear() + 8; y++) {
    const d = realDay(y, mon, day);
    if (d && d >= from) return { cands: [d], known: false, year: false };
  }
  return { cands: [], known: false, year: false };
}

/**
 * Every "<weekday> + <date>" written in a text, checked against the calendar.
 * `ok` is false when the date falls on another weekday or does not exist
 * (`date` null). Two-letter Dutch abbreviations (za, zo, do …) count only with
 * { lang: 'nl', shortField: true } — a button or list field — never in a
 * sentence: "zo 1 dec kan ook" and "ik kan do 26 nov" are ordinary Dutch.
 * `knownDays`: the days this turn's availability checks fetched (YYYY-MM-DD).
 * @returns {{index:number,end:number,text:string,token:string,weekday:number,date:string|null,actual:number|null,ok:boolean}[]}
 *   (each with `fix`, which only correctWeekdays and the reply guard read)
 */
function findWeekdayDates(text, now = new Date(), { lang = 'en', shortField = false, knownDays = null } = {}) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const two = lang === 'nl' && !!shortField;
  const [weekdayFirst, dateFirst, endsRange] = patterns(two);
  const today = localDay(now);
  const hits = [];
  const scan = (re, isDateFirst) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const g = m.groups;
      const end = m.index + m[0].length;
      const skip = () => { re.lastIndex = m.index + 1; };
      if (hits.some(h => m.index < h.end && end > h.index)) { skip(); continue; }   // already part of a pair
      // "Saturday 2 may work better": the verb, not the month — unless a time, a year or the end follows.
      if (g.m1 === 'may' && g.y1 === undefined && new RegExp(`^\\s{1,3}(?!(?:at|om)${E})\\p{Ll}`, 'u').test(s.slice(m.indices.groups.m1[1]))) { skip(); continue; }
      // "open Sunday 24/7" is round the clock, not 24 July; "12/5" can be 5
      // December or 12 May and "(1/2)" is a counter: day/month without a year
      // counts only for a day above 12.
      if (g.d4 !== undefined && g.y4 === undefined && (Number(g.d4) <= 12 || (g.d4 === '24' && g.m4 === '7'))) { skip(); continue; }
      if (isDateFirst) {
        const bracket = /[(\[]/.test(g.sep);
        // "the 25th (Saturday)" and "25 November at 12:00 (Saturday)": only in brackets.
        if ((g.d7 !== undefined || g.time !== undefined) && !bracket) { skip(); continue; }
        // "25 November, Saturday, and Monday" / "until 2 November – Saturday, Sunday and holidays" are lists:
        // after a comma or a dash the weekday must end the sentence or the line, or be followed by a time.
        if (!bracket && /[,–—-]/.test(g.sep) && !new RegExp(`^${WS}{0,4}(?:\\n|$|[.!](?=\\s|$)|(?:at|om)${E})`, 'u').test(s.slice(end))) { skip(); continue; }
      } else {
        if (endsRange.test(s.slice(Math.max(0, m.index - 40), m.index))) { skip(); continue; }
        // "Saturday:\n1. April – 09:00" is a heading over a numbered item.
        const dateStart = m.indices.groups.gap[1];
        if (g.gap.includes('\n') && /^\d{1,2}\.\s/.test(s.slice(dateStart))) { skip(); continue; }
      }
      const read = datesOf(g, now, knownDays);
      if (read === null) { skip(); continue; }
      const token = g.full || g.abbr;
      const weekday = DAY_TOKENS[token.toLowerCase()];
      const fit = read.cands.find(d => d.getDay() === weekday);
      const day = fit || read.cands[0] || null;
      // Right for the same day one year earlier ("bought on Saturday 2 May",
      // said in November): code must not write the coming year's weekday over
      // it. Not for a day within the four weeks of the prompt calendar — that
      // is a day the bot offers, written with last year's weekday.
      let guess = false;
      if (!fit && day && read.year === false && daysApart(today, day) > 28) {
        const before = realDay(day.getFullYear() - 1, day.getMonth(), day.getDate());
        guess = !!before && before.getDay() === weekday && daysApart(before, today) <= 366;
      }
      const [tokenStart, tokenEnd] = m.indices.groups[g.full ? 'full' : 'abbr'];
      const cut = isDateFirst ? cutAfterDate(s, m) : cutBeforeDate(s, m);
      hits.push({
        index: m.index,
        end,
        text: m[0],
        token,
        weekday,
        date: day ? toYmd(day) : null,
        actual: day ? day.getDay() : null,
        ok: !!fit,
        // For correctWeekdays and the reply guard: where the weekday word is,
        // what goes when it is removed, whether the month was written ("the
        // 25th" has none), and whether code may write another weekday there.
        fix: {
          tokenStart,
          tokenEnd,
          hasMonth: g.d7 === undefined,
          sure: (g.d7 === undefined || read.known) && !guess,
          pairFrom: isDateFirst ? m.index : tokenStart,
          pairTo: end,
          cut,
        },
      });
    }
  };
  scan(weekdayFirst, false);
  scan(dateFirst, true);
  return hits.sort((a, b) => a.index - b.index);
}

const marksIn = (str) => (String(str).match(/[*_~]/g) || []).join('');
const mirrored = (str) => [...str].reverse().join('');
/** Where a bracket that the removed part opened is closed again, right after `at` (or -1). */
function closerAfter(s, at, opened) {
  if (!/[(\[]/.test(opened)) return -1;
  const m = /^[ \t]{0,4}[)\]]/.exec(s.slice(at));
  return m ? at + m[0].length : -1;
}
// What belonged to a weekday that is removed: "a Saturday", "next Saturday",
// "this Saturday", "aanstaande zaterdag". ("I booked you in for a 4 July.")
const DETERMINER = /(?<![\p{L}\p{N}])(?:a|an|next|this coming|this|coming|upcoming|last|aanstaande|komende|volgende|vorige|afgelopen|deze|een)[ \t]{1,3}$/iu;

/**
 * Removing the weekday of "<weekday> <date>": everything from the weekday up
 * to the date goes — the part of the day with it ("Saturday afternoon, 4
 * July" → "4 July", not "afternoon 4 July") and a word that only belonged to
 * the weekday ("next", "a") — except an article ("the 25th") and marks that
 * belong to the date ("Saturday *25 Nov*").
 */
function cutBeforeDate(s, m) {
  const g = m.groups;
  const [, dateStart] = m.indices.groups.gap;
  const lead = g.lead || '';
  const marks = marksIn(g.gap);
  const closed = !!lead && marks.startsWith(mirrored(lead));            // *Saturday* 25 November
  const article = /(?:^|[^\p{L}])(the|de|den)\s+[*_~]*$/iu.exec(g.gap)?.[1];
  const keep = (closed ? '' : lead)
    + (article ? `${article} ` : '')
    + (closed ? marks.slice(lead.length) : marks);
  const det = DETERMINER.exec(s.slice(Math.max(0, m.index - 20), m.index));
  const end = m.index + m[0].length;
  return { from: det ? m.index - det[0].length : m.index, to: dateStart, keep, closer: closerAfter(s, end, g.gap), closerFrom: end };
}

/** Removing the weekday of "<date>, <weekday>" / "<date> (<weekday>)": everything after the date goes. */
function cutAfterDate(s, m) {
  const g = m.groups;
  const [dateEnd] = m.indices.groups.sep;
  const pre = marksIn(g.sep);
  const post = g.post || '';
  const keep = pre && post === mirrored(pre) ? '' : `${pre}${post}`;     // 25 November (*Saturday*)
  const end = m.index + m[0].length;
  return { from: dateEnd, to: end, keep, closer: closerAfter(s, end, g.sep), closerFrom: end };
}

/** The right weekday in the form the wrong one was written: Saturday → Wednesday, Sat → Wed, zaterdag → woensdag. */
function sameForm(token, wd) {
  const t = token.toLowerCase();
  let out = EN_SHORT[wd];
  if (NL_DAYS.includes(t)) out = NL_DAYS[wd];
  else if (EN_DAYS.some(d => d.toLowerCase() === t)) out = EN_DAYS[wd];
  if (token.length > 1 && token === token.toUpperCase()) return out.toUpperCase();
  return token[0] === token[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out.toLowerCase();
}

/** "Wed 25 Nov" / "wo 25 nov": a day that fits a row or button title next to its time. */
function shortDayLabel(v, lang = 'en') {
  const d = localDay(v);
  if (!d) return String(v ?? '');
  return lang === 'nl'
    ? `${NL2_DAYS[d.getDay()]} ${d.getDate()} ${NL_MONTHS[d.getMonth()].slice(0, 3)}`
    : `${EN_SHORT[d.getDay()]} ${d.getDate()} ${EN_MONTHS[d.getMonth()].slice(0, 3)}`;
}

/**
 * The text with every wrong weekday made true. The weekday is REPLACED only
 * when the day is close to today (7 days back to 180 ahead), the date is
 * certain (its month is written, or it is the day this turn checked) and the
 * word is a full name or an English abbreviation. In every other case — a
 * date further away, one that does not exist, "the 5th" without a month
 * (which month is a guess: "Saturday the 5th" of next month must not become
 * "Thursday the 5th"), a pair that was right one year earlier, a two-letter
 * Dutch abbreviation — the weekday word is removed: a date without a weekday
 * is never false. (Replacing everywhere once turned "Friday 3 October", a
 * visit in the past, into "Sunday 3 October".) Text without a wrong pair
 * comes back unchanged.
 */
function correctWeekdays(text, now = new Date(), opts = {}) {
  let s = typeof text === 'string' ? text : '';
  if (!s) return s;
  const today = localDay(now);
  const wrong = findWeekdayDates(s, now, opts).filter(h => !h.ok).sort((a, b) => b.index - a.index);
  for (const h of wrong) {
    const ahead = h.date ? daysApart(today, localDay(h.date)) : null;
    const near = ahead !== null && ahead >= -REPLACE_BACK_DAYS && ahead <= REPLACE_AHEAD_DAYS;
    if (near && h.fix.sure && h.token.length > 2) {
      s = s.slice(0, h.fix.tokenStart) + sameForm(h.token, h.actual) + s.slice(h.fix.tokenEnd);
      continue;
    }
    const { from, to, keep, closer, closerFrom } = h.fix.cut;
    if (closer > 0) s = s.slice(0, closerFrom) + s.slice(closer);
    s = s.slice(0, from) + keep + s.slice(to);
  }
  return s;
}

/**
 * Weekday names that stand on their own in a text ("next Friday", "zaterdag"),
 * not part of a weekday + date pair. Full names only; "Saturdays" is no day.
 * @returns {{index:number,token:string,weekday:number}[]}
 */
function loneWeekdays(text, now = new Date()) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const pairs = findWeekdayDates(s, now);
  const re = new RegExp(`${B}(${FULL})${DAYPART}${E}`, 'giu');
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    if (pairs.some(p => m.index >= p.index && m.index < p.end)) continue;
    out.push({ index: m.index, token: m[1], weekday: DAY_TOKENS[m[1].toLowerCase()] });
  }
  return out;
}

module.exports = {
  EN_DAYS,
  localDay,
  toYmd,
  weekdayOf,
  weekdayIndex,
  rangeDays,
  dayLabel,
  shortDayLabel,
  calendarLines,
  weekdaysAround,
  findWeekdayDates,
  correctWeekdays,
  loneWeekdays,
};
