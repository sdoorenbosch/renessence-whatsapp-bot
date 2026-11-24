/**
 * A colleague's messages in a chat the bot also answers. Pure: no I/O.
 *
 * Tara, 4 Nov 2026: the chat was handed back to the bot six minutes after a
 * colleague's message; the guest's reaction was answered by the bot, which
 * contradicted the colleague, and she was never told the AI was answering
 * again. The colleague's question afterwards stayed unanswered for 15 days,
 * and on 19 Nov the bot recapped its own earlier line instead. Restored
 * history showed the colleague's words as if the bot had written them, with
 * no date.
 *
 * Used by the message handler (hold a reply that reacts to a colleague, and
 * the line the bot's first reply starts with) and by the agent's history
 * restore (label and date a colleague's lines).
 */

const { dayLabel, shortDayLabel } = require('../utils/calendar');

// Roles the dashboard logs a colleague's message under: 'team' (pause notice,
// chat sends, payment links, queued replies) and 'agent' (send-message).
const TEAM_ROLES = new Set(['team', 'agent']);
// The dashboard's own notes ("📨 Re-open request sent …") are not messages
// anybody wrote to the guest.
const isDashboardNote = (content) => String(content || '').startsWith('📨 ');
// The notice the pause button sends (dashboard.routes.js). It ends with "How
// can we help you?" — never a colleague's question waiting for an answer.
const TAKEOVER_NOTICE = /^(?:Thank you for your patience! You're now speaking with a real person|Bedankt voor je geduld! Je spreekt nu met een echt persoon)/;
const isTakeoverNotice = (content) => TAKEOVER_NOTICE.test(String(content || ''));

const OPEN_QUESTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const QUOTE_MAX = 500;

const AI_AGAIN = {
  en: 'You\'re chatting with the Renessence AI assistant again.',
  nl: 'Je praat nu weer met de AI-assistent van Renessence.',
};

const pad = (n) => String(n).padStart(2, '0');
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "Wed 4 Nov 2026, 09:54" in the process timezone (Europe/Amsterdam). A stored
 * instant (created_at), not slot logic. '' when it can't be read.
 */
function stamp(createdAt) {
  const d = toDate(createdAt);
  if (!d) return '';
  return `${shortDayLabel(d, 'en')} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LABEL_START = '[Written by a human colleague of the Renessence team';
const label = (createdAt) => {
  const s = stamp(createdAt);
  return `${LABEL_START}${s ? `, ${s}` : ''}]`;
};

/**
 * Stored rows (getMessagesByPhone) → model history. A colleague's row becomes
 * an assistant turn that starts with a dated label; dashboard notes are left
 * out; every other row is passed on unchanged.
 */
function toHistory(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (row.role !== 'user' && isDashboardNote(row.content)) continue;
    if (TEAM_ROLES.has(row.role)) {
      out.push({ role: 'assistant', content: `${label(row.created_at)}\n${row.content}` });
    } else {
      out.push({ role: row.role, content: row.content });
    }
  }
  return out;
}

/** A reply that starts with the colleague label is the model imitating it: the label goes. */
function stripColleagueLabel(text) {
  if (typeof text !== 'string') return text;
  const stripped = text.replace(/^\s*\[Written by a human colleague[^\]]*\]\s*/i, '');
  return stripped || text;
}

/**
 * The newest outbound message (database getLastOutboundMessage) when it is a
 * colleague's, or null. `question` is set when the colleague asked something
 * the guest has not answered since (a question mark, no guest message after
 * it, under 30 days old). When the newest line is only the takeover notice,
 * the colleague's line before it is the one that may hold a question; the
 * notice itself still counts for the time since the colleague wrote.
 * @returns {null | {at: Date, minutesAgo: number, recent: boolean, question: null | {text: string, at: Date}}}
 */
function colleagueThread(last, now = new Date()) {
  if (!last || !TEAM_ROLES.has(last.role) || isDashboardNote(last.content)) return null;
  const at = toDate(last.created_at);
  if (!at) return null;
  const ms = now.getTime() - at.getTime();

  let q = last;
  if (isTakeoverNotice(last.content)) {
    const prev = last.previous;
    q = prev && TEAM_ROLES.has(prev.role) && !isTakeoverNotice(prev.content) && !isDashboardNote(prev.content) ? prev : null;
  }
  let question = null;
  const qAt = q ? toDate(q.created_at) : null;
  if (q && qAt && String(q.content || '').includes('?')
    && Number(q.guest_replies_after) === 0
    && now.getTime() - qAt.getTime() < OPEN_QUESTION_MAX_AGE_MS) {
    question = { text: String(q.content), at: qAt };
  }
  return { at, minutesAgo: ms / 60000, recent: ms < RECENT_MS, question };
}

function quote(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1).trimEnd()}…` : flat;
}

/** The line the bot's first reply after a colleague starts with, in both languages. */
function replyPrefix(thread) {
  if (!thread?.question) return { ...AI_AGAIN };
  const q = quote(thread.question.text);
  return {
    en: `${AI_AGAIN.en} On ${dayLabel(thread.question.at, 'en')} my colleague asked you: “${q}” They haven't had your answer yet. You can answer here and I'll make sure they see it.`,
    nl: `${AI_AGAIN.nl} Op ${dayLabel(thread.question.at, 'nl')} vroeg mijn collega je: “${q}” Daar is nog geen antwoord op gekomen. Je kunt hier antwoorden, dan zorg ik dat mijn collega het ziet.`,
  };
}

module.exports = {
  TEAM_ROLES,
  AI_AGAIN,
  stamp,
  toHistory,
  stripColleagueLabel,
  colleagueThread,
  replyPrefix,
  isTakeoverNotice,
};
