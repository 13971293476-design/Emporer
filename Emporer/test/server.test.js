const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-test-'));
  let time = Date.now();
  const server = createApp({ dataDir, clock: () => time });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dataDir, server, base, advance: ms => { time += ms; } };
}

function client() { return { cookie: '' }; }

async function api(testServer, browser, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (browser.cookie) headers.cookie = browser.cookie;
  if (options.body || options.method === 'POST') headers['content-type'] = headers['content-type'] || 'application/json';
  const response = await fetch(testServer.base + pathname, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) browser.cookie = setCookie.split(';', 1)[0];
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

test('register, match, privacy, round reveal and stale-play protection', async t => {
  const s = await startTestServer();
  t.after(() => { s.server.close(); fs.rmSync(s.dataDir, { recursive: true, force: true }); });
  const alice = client();
  const bob = client();
  await api(s, alice, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret1' }) });
  await api(s, bob, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'secret2' }) });
  const waiting = await api(s, alice, '/api/match/join', { method: 'POST', body: '{}' });
  assert.equal(waiting.matched, false);
  const matched = await api(s, bob, '/api/match/join', { method: 'POST', body: '{}' });
  assert.equal(matched.matched, true);
  const roomId = matched.room.id;
  let aliceRoom = (await api(s, alice, `/api/rooms/${roomId}`)).room;
  let bobRoom = (await api(s, bob, `/api/rooms/${roomId}`)).room;
  const slave = aliceRoom.me.role === 'slave' ? alice : bob;
  const emperor = aliceRoom.me.role === 'emperor' ? alice : bob;
  const slaveRoom = aliceRoom.me.role === 'slave' ? aliceRoom : bobRoom;
  const emperorRoom = aliceRoom.me.role === 'emperor' ? aliceRoom : bobRoom;
  const slaveCitizen = slaveRoom.me.cards.find(card => card.type === 'citizen');
  const emperorCitizen = emperorRoom.me.cards.find(card => card.type === 'citizen');
  const afterSlave = await api(s, slave, `/api/rooms/${roomId}/play`, { method: 'POST', body: JSON.stringify({ cardId: slaveCitizen.id, round: 1 }) });
  assert.equal(afterSlave.room.turnRole, 'emperor');
  assert.equal(afterSlave.room.opponent.selectedCard, null);
  await assert.rejects(api(s, slave, `/api/rooms/${roomId}/play`, { method: 'POST', body: JSON.stringify({ cardId: slaveCitizen.id, round: 1 }) }), error => error.status === 400);
  const afterBoth = await api(s, emperor, `/api/rooms/${roomId}/play`, { method: 'POST', body: JSON.stringify({ cardId: emperorCitizen.id, round: 1 }) });
  assert.equal(afterBoth.room.phase, 'revealing');
  assert.ok(afterBoth.room.opponent.selectedCard);
  s.advance(3_000);
  const nextRound = await api(s, alice, `/api/rooms/${roomId}`);
  assert.equal(nextRound.room.round, 2);
  assert.equal(nextRound.room.phase, 'choosing');
  assert.equal(nextRound.room.me.selectedCard, null);
});

test('timeout automatically plays for the active role', async t => {
  const s = await startTestServer();
  t.after(() => { s.server.close(); fs.rmSync(s.dataDir, { recursive: true, force: true }); });
  const one = client();
  const two = client();
  await api(s, one, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'one', password: 'secret1' }) });
  await api(s, two, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'two', password: 'secret2' }) });
  await api(s, one, '/api/match/join', { method: 'POST', body: '{}' });
  const joined = await api(s, two, '/api/match/join', { method: 'POST', body: '{}' });
  const roomId = joined.room.id;
  s.advance(61_000);
  const afterTimeout = await api(s, one, `/api/rooms/${roomId}`);
  assert.equal(afterTimeout.room.turnRole, 'emperor');
  assert.ok(afterTimeout.room.log.some(item => item.text.includes('超时')));
});

test('finished rooms support a coordinated rematch', async t => {
  const s = await startTestServer();
  t.after(() => { s.server.close(); fs.rmSync(s.dataDir, { recursive: true, force: true }); });
  const first = client();
  const second = client();
  await api(s, first, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'first', password: 'secret1' }) });
  await api(s, second, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'second', password: 'secret2' }) });
  await api(s, first, '/api/match/join', { method: 'POST', body: '{}' });
  const matched = await api(s, second, '/api/match/join', { method: 'POST', body: '{}' });
  const roomId = matched.room.id;
  const firstRoom = (await api(s, first, `/api/rooms/${roomId}`)).room;
  const secondRoom = (await api(s, second, `/api/rooms/${roomId}`)).room;
  const slave = firstRoom.me.role === 'slave' ? first : second;
  const emperor = firstRoom.me.role === 'emperor' ? first : second;
  const slaveRoom = firstRoom.me.role === 'slave' ? firstRoom : secondRoom;
  const emperorRoom = firstRoom.me.role === 'emperor' ? firstRoom : secondRoom;
  await api(s, slave, `/api/rooms/${roomId}/play`, { method: 'POST', body: JSON.stringify({ cardId: slaveRoom.me.cards.find(card => card.type === 'slave').id, round: 1 }) });
  const finished = await api(s, emperor, `/api/rooms/${roomId}/play`, { method: 'POST', body: JSON.stringify({ cardId: emperorRoom.me.cards.find(card => card.type === 'citizen').id, round: 1 }) });
  assert.equal(finished.room.status, 'finished');
  const waiting = await api(s, slave, `/api/rooms/${roomId}/rematch`, { method: 'POST' });
  assert.equal(waiting.room.status, 'waiting');
  assert.equal(waiting.room.rematchOf, roomId);
  const rematch = await api(s, emperor, `/api/rooms/${roomId}/rematch`, { method: 'POST' });
  assert.equal(rematch.room.status, 'playing');
  assert.equal(rematch.room.round, 1);
});
