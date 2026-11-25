// Security audit, 25 Nov 2026: the webchat daily budget per IP, the
// constant-time webhook verify token, and no /diag routes.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/agents/renessence.agent', () => ({ runWeb: jest.fn().mockResolvedValue({ message: 'hi', ui_type: 'text' }) }));
jest.mock('../src/handlers/message.handler', () => ({}));
jest.mock('../src/services/voice.service', () => ({}));
jest.mock('../src/data/database', () => ({ logMessage: jest.fn(), isWebhookProcessed: jest.fn(), markWebhookProcessed: jest.fn() }));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const webchat = require('../src/routes/webchat.routes');
const webhook = require('../src/routes/webhook');

function appWith(router, mount) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(mount, router);
  return app;
}

describe('webchat /init: at most 30 new sessions per IP per day', () => {
  beforeEach(() => webchat._resetDailyBudget());

  test('the 31st session of the same IP is refused, another IP still gets one', async () => {
    const app = appWith(webchat, '/webchat');
    for (let i = 0; i < 30; i++) {
      const r = await request(app).get('/webchat/init').set('X-Forwarded-For', '203.0.113.5');
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).get('/webchat/init').set('X-Forwarded-For', '203.0.113.5');
    expect(blocked.status).toBe(429);
    expect(blocked.body.sessionId).toBeUndefined();

    const other = await request(app).get('/webchat/init').set('X-Forwarded-For', '203.0.113.6');
    expect(other.status).toBe(200);
    expect(other.body.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('webhook verify token', () => {
  const app = appWith(webhook, '/webhook');
  const verify = (token) => request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' });

  test('the right token gets the challenge back as plain text', async () => {
    const r = await verify(process.env.WHATSAPP_VERIFY_TOKEN);
    expect(r.status).toBe(200);
    expect(r.text).toBe('12345');
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
  });

  test.each([['wrong'], [''], ['x'.repeat(200)]])('a wrong token is refused (%#)', async (token) => {
    expect((await verify(token)).status).toBe(403);
  });

  test('safeEqual: equal, unequal, other length, non-strings', () => {
    const { safeEqual } = webhook;
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abd', 'abc')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual(['abc'], 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(false); // an unset secret never matches
  });
});

test('server.js has no /diag routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  expect(src).not.toMatch(/\/diag/);
});
