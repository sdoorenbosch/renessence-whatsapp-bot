const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { runWeb } = require('../agents/renessence.agent');
const db = require('../data/database');
const logger = require('../utils/logger');

// H13: active server-issued session IDs — only these are accepted in /message
// Uses a Set so stale sessions don't accumulate forever (capped and auto-expired)
const activeSessions = new Map(); // sessionId → createdAt
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SESSIONS = 500;

function pruneOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, createdAt] of activeSessions.entries()) {
    if (createdAt < cutoff) activeSessions.delete(id);
  }
}

// Daily budget per IP (security audit, 25 Nov 2026), on top of the per-minute
// rate limit in server.js: every session can make paid model calls, so one
// address gets at most WEBCHAT_SESSIONS_PER_IP_DAY new sessions per day.
// In memory: a restart resets it, which is acceptable for a cost cap.
const SESSIONS_PER_IP_DAY = Number(process.env.WEBCHAT_SESSIONS_PER_IP_DAY) || 30;
const sessionsPerIp = new Map(); // ip → count, for budgetDay
let budgetDay = null;

function overDailyBudget(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (budgetDay !== today) {
    sessionsPerIp.clear();
    budgetDay = today;
  }
  const key = ip || 'unknown';
  const used = sessionsPerIp.get(key) || 0;
  if (used >= SESSIONS_PER_IP_DAY) return true;
  sessionsPerIp.set(key, used + 1);
  return false;
}

// GET /webchat/init — returns a server-generated session ID
router.get('/init', (req, res) => {
  pruneOldSessions();
  if (overDailyBudget(req.ip)) {
    logger.warn('Webchat: daily session budget reached for an IP');
    return res.status(429).json({ error: 'Too many chat sessions today. Please try again tomorrow or contact us by email.' });
  }
  if (activeSessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'Too many active sessions' });
  }
  const sessionId = crypto.randomBytes(16).toString('hex');
  activeSessions.set(sessionId, Date.now());
  res.json({ sessionId });
});

// POST /webchat/message
router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message required' });
  }

  // H13: only accept server-issued session IDs
  pruneOldSessions();
  if (!activeSessions.has(sessionId)) {
    return res.status(403).json({ error: 'Invalid or expired session' });
  }
  // Refresh TTL on activity
  activeSessions.set(sessionId, Date.now());

  try {
    db.logMessage(`web_${sessionId}`, 'user', message);
    const response = await runWeb(sessionId, message);
    res.json(response);
  } catch (err) {
    logger.error('Webchat error:', err.message);
    res.status(500).json({ message: 'Something went wrong. Please try again.', ui_type: 'text' });
  }
});

module.exports = router;
module.exports._resetDailyBudget = () => { sessionsPerIp.clear(); budgetDay = null; };
