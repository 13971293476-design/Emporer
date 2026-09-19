const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'), clock = Date.now } = {}) {
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(dataDir);
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TURN_MS = 60_000;
const QUEUE_TTL = 30_000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map();
const seen = new Map();
const authAttempts = new Map();
let db = loadDb();
// Waiting players are ephemeral: a process restart cannot restore their browser sessions.
// Clear the persisted queue so a fresh process never matches someone who is no longer online.
if (db.queue.length) {
  db.queue = [];
  saveDb();
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return { players: {}, rooms: {}, queue: [] };
  // Never silently replace a damaged database with an empty one.
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, ''));
  if (!parsed.players || !parsed.rooms || !Array.isArray(parsed.queue)) throw new Error('数据库格式错误，请恢复备份后再启动');
  for (const room of Object.values(parsed.rooms)) {
    room.revision = Number.isInteger(room.revision) ? room.revision : 1;
    room.phase ||= room.status === 'playing' ? 'choosing' : room.status === 'finished' ? 'finished' : 'waiting';
    room.dismissedBy ||= [];
  }
  return parsed;
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() { return clock(); }

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}

async function verifyPassword(password, player) {
  const candidate = await scrypt(password, player.salt, 64);
  const expected = Buffer.from(player.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key) { try { out[key] = decodeURIComponent(value.join('=')); } catch {} }
  }
  return out;
}

function currentPlayer(req) {
  const token = parseCookies(req).emperor_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= now()) { if (token) sessions.delete(token); return null; }
  return db.players[session.playerId] || null;
}

function setSession(res, playerId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { playerId, expiresAt: now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `emperor_session=${token}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
}

function clearSession(req, res) {
  const token = parseCookies(req).emperor_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `emperor_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) { reject(new Error('请求内容过长')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch { reject(new Error('请求格式不正确')); }
    });
    req.on('error', reject);
  });
}

function activeRoomFor(playerId) {
  return Object.values(db.rooms).find(room =>
    room.players.some(player => player.id === playerId) && room.status !== 'finished'
  );
}

function latestRoomFor(playerId) {
  return activeRoomFor(playerId) || Object.values(db.rooms).reverse().find(room =>
    participant(room, playerId) && !(room.dismissedBy || []).includes(playerId)
  );
}

function dismissFinished(playerId) {
  for (const room of Object.values(db.rooms)) {
    if (room.status === 'finished' && participant(room, playerId)) {
      room.dismissedBy ||= [];
      if (!room.dismissedBy.includes(playerId)) room.dismissedBy.push(playerId);
    }
  }
}

function makeHand(role) {
  const special = role === 'emperor'
    ? { id: 'emperor', type: 'emperor', label: '皇帝', symbol: '♛' }
    : { id: 'slave', type: 'slave', label: '奴隶', symbol: '⚒' };
  return [special, ...Array.from({ length: 4 }, (_, index) => ({
    id: `citizen-${index + 1}`,
    type: 'citizen',
    label: '平民',
    symbol: '●',
  }))].map(card => ({ ...card, played: false }));
}

function startRoom(room, firstId, secondId) {
  const first = db.players[firstId];
  const second = db.players[secondId];
  const slaveFirst = crypto.randomInt(0, 2) === 0;
  const roles = slaveFirst ? ['slave', 'emperor'] : ['emperor', 'slave'];
  room.status = 'playing';
  room.phase = 'choosing';
  room.updatedAt = now();
  room.round = 1;
  room.turnRole = 'slave';
  room.deadlineAt = now() + TURN_MS;
  room.players = [
    { id: first.id, username: first.username, role: roles[0], cards: makeHand(roles[0]), selectedCard: null },
    { id: second.id, username: second.username, role: roles[1], cards: makeHand(roles[1]), selectedCard: null },
  ];
  room.log = [{ at: now(), text: '牌局开始，奴隶方先出牌。' }];
  return room;
}

function createRoom(firstId, secondId) {
  dismissFinished(firstId);
  if (secondId) dismissFinished(secondId);
  let roomCode;
  do { roomCode = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (findWaitingRoomByCode(roomCode));
  const room = {
    id: id('room'),
    roomCode,
    revision: 1,
    status: 'waiting',
    createdAt: now(),
    updatedAt: now(),
    round: 0,
    turnRole: null,
    deadlineAt: null,
    players: [{ id: firstId, username: db.players[firstId].username, role: null, cards: [], selectedCard: null }],
    lastRound: null,
    winnerId: null,
    resultText: null,
    rematchOf: null,
    expectedPlayerId: null,
    expectedPlayerName: null,
    rematchRoomId: null,
    log: [{ at: now(), text: '房间已创建，等待好友加入。' }],
  };
  db.rooms[room.id] = room;
  if (secondId) startRoom(room, firstId, secondId);
  return room;
}

function rematchRoomFor(room, playerId) {
  const rematch = room.rematchRoomId && db.rooms[room.rematchRoomId];
  if (!rematch || rematch.status === 'finished') return null;
  if (rematch.players.some(player => player.id === playerId)) return rematch;
  if (rematch.expectedPlayerId === playerId) return rematch;
  return null;
}

function createRematch(room, playerId) {
  const opponent = opponentOf(room, playerId);
  const rematch = createRoom(playerId);
  rematch.rematchOf = room.id;
  rematch.expectedPlayerId = opponent ? opponent.id : null;
  rematch.expectedPlayerName = opponent ? opponent.username : null;
  room.rematchRoomId = rematch.id;
  room.revision = (room.revision || 0) + 1;
  return rematch;
}

function opponentOf(room, playerId) { return room.players.find(player => player.id !== playerId); }
function participant(room, playerId) { return room.players.find(player => player.id === playerId); }

function cardById(player, cardId) {
  return player.cards.find(card => card.id === cardId);
}

function compareCards(first, second) {
  if (first.type === second.type) return 0;
  if ((first.type === 'emperor' && second.type === 'citizen') ||
      (first.type === 'citizen' && second.type === 'slave') ||
      (first.type === 'slave' && second.type === 'emperor')) return 1;
  return -1;
}

function finishRoom(room, winnerId, firstCard, secondCard, timedOut = false) {
  room.status = 'finished';
  room.phase = 'finished';
  room.turnRole = null;
  room.deadlineAt = null;
  room.winnerId = winnerId;
  const slave = room.players.find(player => player.role === 'slave');
  const emperor = room.players.find(player => player.role === 'emperor');
  const winner = participant(room, winnerId);
  let text;
  if (firstCard.type === 'emperor' && secondCard.type === 'slave' || firstCard.type === 'slave' && secondCard.type === 'emperor') {
    text = `皇帝与奴隶相遇，奴隶方获胜。`;
  } else if (firstCard.type === 'emperor' || secondCard.type === 'emperor') {
    text = `${winner.username} 的皇帝牌压过平民，赢得牌局。`;
  } else {
    text = `${winner.username} 的平民牌击败奴隶，赢得牌局。`;
  }
  if (timedOut) text += '（超时已自动出牌）';
  room.resultText = text;
  room.lastRound = { round: room.round, slaveCard: slave.selectedCard, emperorCard: emperor.selectedCard, winnerId };
  room.log.push({ at: now(), text });
  const loserId = room.players.find(player => player.id !== winnerId).id;
  if (db.players[winnerId]) db.players[winnerId].stats.wins += 1;
  if (db.players[loserId]) db.players[loserId].stats.losses += 1;
}

function resolveRound(room, timedOut = false) {
  const slave = room.players.find(player => player.role === 'slave');
  const emperor = room.players.find(player => player.role === 'emperor');
  const slaveCard = cardById(slave, slave.selectedCard);
  const emperorCard = cardById(emperor, emperor.selectedCard);
  if (!slaveCard || !emperorCard) return;
  const comparison = compareCards(slaveCard, emperorCard);
  if (slaveCard.type !== 'citizen' || emperorCard.type !== 'citizen') {
    const winnerId = comparison > 0 ? slave.id : emperor.id;
    finishRoom(room, winnerId, slaveCard, emperorCard, timedOut);
    return;
  }
  room.lastRound = { round: room.round, slaveCard: slaveCard.id, emperorCard: emperorCard.id, winnerId: null };
  room.log.push({ at: now(), text: `第 ${room.round} 轮双方均出平民，继续下一轮。` });
  room.phase = 'revealing';
  room.revealUntil = now() + 2500;
  room.turnRole = null;
  room.deadlineAt = null;
}

function applyPlay(room, playerId, cardId, timedOut = false) {
  const player = participant(room, playerId);
  if (!player || room.status !== 'playing' || player.role !== room.turnRole) return { ok: false, message: '现在还不能出牌' };
  const card = cardById(player, cardId);
  if (!card || card.played) return { ok: false, message: '这张牌已经使用或不存在' };
  card.played = true;
  player.selectedCard = card.id;
  room.updatedAt = now();
  room.revision = (room.revision || 0) + 1;
  if (timedOut) room.log.push({ at: now(), text: `${player.username} 超时，系统自动打出一张牌。` });
  if (player.role === 'slave') {
    room.turnRole = 'emperor';
    room.deadlineAt = now() + TURN_MS;
  } else {
    resolveRound(room, timedOut);
  }
  return { ok: true };
}

function tickRooms() {
  let changed = false;
  const queueBefore = db.queue.length;
  for (const room of Object.values(db.rooms)) {
    if (room.status === 'waiting' && room.createdAt + 30 * 60_000 <= now()) {
      room.status = 'finished'; room.phase = 'finished'; room.turnRole = null; room.deadlineAt = null; room.resultText = '房间等待超过 30 分钟，已关闭。'; room.revision++;
      changed = true;
    }
    if (room.status === 'playing' && room.phase === 'revealing' && room.revealUntil <= now()) {
      room.players.forEach(player => { player.selectedCard = null; });
      room.round++;
      room.phase = 'choosing';
      room.turnRole = 'slave';
      room.deadlineAt = now() + TURN_MS;
      room.revision++;
      changed = true;
    }
    if (room.status !== 'playing' || !room.deadlineAt || room.deadlineAt > now()) continue;
    const player = room.players.find(item => item.role === room.turnRole);
    const available = player && player.cards.filter(card => !card.played);
    if (player && available && available.length) {
      const selected = available[crypto.randomInt(0, available.length)].id;
      applyPlay(room, player.id, selected, true);
      changed = true;
    }
  }
  cleanQueue();
  if (db.queue.length !== queueBefore) changed = true;
  if (changed) saveDb();
  for (const [token, session] of sessions) if (session.expiresAt <= now()) sessions.delete(token);
  for (const [key, entry] of authAttempts) if (entry.expiresAt <= now()) authAttempts.delete(key);
}

function publicCard(card, reveal = true) {
  if (!card) return null;
  return reveal ? { id: card.id, type: card.type, label: card.label, symbol: card.symbol } : { id: card.id, label: '未知', symbol: '?' };
}

function publicRoom(room, viewerId) {
  const me = participant(room, viewerId);
  if (!me) return null;
  const opponent = opponentOf(room, viewerId);
  if (!opponent) {
    return {
      id: room.id,
      revision: room.revision,
      serverNow: now(),
      roomCode: room.roomCode,
      rematchOf: room.rematchOf,
      waitingFor: room.expectedPlayerName,
      status: room.status,
      round: room.round,
      turnRole: room.turnRole,
      deadlineAt: room.deadlineAt,
      resultText: room.resultText,
      winnerId: room.winnerId,
      lastRound: room.lastRound,
      log: room.log.slice(-12),
      me: { id: me.id, username: me.username, role: null, cards: [], selectedCard: null },
      opponent: null,
      canPlay: false,
    };
  }
  const revealOpponent = room.status === 'finished' || room.phase === 'revealing';
  const mySelected = me.selectedCard ? cardById(me, me.selectedCard) : null;
  const opponentSelected = opponent.selectedCard ? cardById(opponent, opponent.selectedCard) : null;
  return {
    id: room.id,
    revision: room.revision,
    serverNow: now(),
    phase: room.phase || 'choosing',
    roomCode: room.roomCode,
    status: room.status,
    round: room.round,
    turnRole: room.turnRole,
    deadlineAt: room.deadlineAt,
    resultText: room.resultText,
    winnerId: room.winnerId,
    lastRound: room.lastRound,
    log: room.log.slice(-12),
    me: {
      id: me.id,
      username: me.username,
      role: me.role,
      cards: me.cards.map(card => ({ ...publicCard(card), played: card.played })),
      selectedCard: publicCard(mySelected),
    },
    opponent: {
      id: opponent.id,
      username: opponent.username,
      role: opponent.role,
      cardCount: opponent.cards.filter(card => !card.played).length,
      hasPlayed: Boolean(opponentSelected),
      selectedCard: revealOpponent ? publicCard(opponentSelected) : null,
    },
    canPlay: room.status === 'playing' && me.role === room.turnRole,
  };
}

function playerSummary(player) {
  return { id: player.id, username: player.username, stats: player.stats };
}

function cleanQueue() {
  db.queue = db.queue.filter(playerId => db.players[playerId] && !activeRoomFor(playerId) && seen.get(playerId) > now() - QUEUE_TTL);
  for (const [playerId, lastSeen] of seen) if (lastSeen <= now() - QUEUE_TTL) seen.delete(playerId);
}

function joinMatch(player) {
  const existing = activeRoomFor(player.id);
  if (existing) return existing;
  cleanQueue();
  seen.set(player.id, now());
  dismissFinished(player.id);
  db.queue = db.queue.filter(playerId => playerId !== player.id);
  const opponentId = db.queue.shift();
  if (opponentId && db.players[opponentId]) return createRoom(opponentId, player.id);
  db.queue.push(player.id);
  return null;
}

function cancelMatch(playerId) {
  db.queue = db.queue.filter(id => id !== playerId);
}

function findWaitingRoomByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return Object.values(db.rooms).find(room => room.status === 'waiting' && room.roomCode === normalized);
}

function leaveRoom(room, playerId) {
  if (!room) return;
  if (room.status === 'waiting') {
    room.status = 'finished';
    room.phase = 'finished';
    room.turnRole = null;
    room.resultText = '房间已关闭。';
  } else if (room.status === 'playing' && room.phase === 'revealing') {
    const other = opponentOf(room, playerId);
    room.status = 'finished';
    room.phase = 'finished';
    room.revealUntil = null;
    room.deadlineAt = null;
    room.winnerId = other ? other.id : null;
    room.resultText = other ? `对手离开，${other.username} 获胜。` : '对局结束。';
    if (other && db.players[other.id]) db.players[other.id].stats.wins += 1;
    if (db.players[playerId]) db.players[playerId].stats.losses += 1;
  } else if (room.status === 'playing') {
    const other = opponentOf(room, playerId);
    room.status = 'finished';
    room.phase = 'finished';
    room.winnerId = other ? other.id : null;
    room.deadlineAt = null;
    room.resultText = other ? `对手离开，${other.username} 获胜。` : '对局结束。';
    if (other && db.players[other.id]) db.players[other.id].stats.wins += 1;
    if (db.players[playerId]) db.players[playerId].stats.losses += 1;
  }
  room.revision = (room.revision || 0) + 1;
  room.dismissedBy ||= [];
  if (!room.dismissedBy.includes(playerId)) room.dismissedBy.push(playerId);
  db.queue = db.queue.filter(id => id !== playerId);
}

function requirePlayer(req, res) {
  const player = currentPlayer(req);
  if (!player) sendError(res, 401, '请先登录');
  return player;
}

async function handleApi(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(pathname)) {
    const key = req.socket.remoteAddress;
    let entry = authAttempts.get(key);
    if (!entry || entry.expiresAt <= now()) { entry = { count: 0, expiresAt: now() + 60_000 }; authAttempts.set(key, entry); }
    if (++entry.count > 30) return sendError(res, 429, '尝试过于频繁，请稍后重试');
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendError(res, 400, error.message); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(username)) return sendError(res, 400, '玩家名需为 2-20 位中文、字母、数字或下划线');
    if (password.length < 6 || password.length > 64) return sendError(res, 400, '密码长度需为 6-64 位');
    if (Object.values(db.players).some(player => player.username.toLowerCase() === username.toLowerCase())) return sendError(res, 409, '这个玩家名已经被使用');
    const credentials = await hashPassword(password);
    if (Object.values(db.players).some(player => player.username.toLowerCase() === username.toLowerCase())) return sendError(res, 409, '这个玩家名已经被使用');
    const player = { id: id('player'), username, salt: credentials.salt, passwordHash: credentials.hash, createdAt: now(), stats: { wins: 0, losses: 0 } };
    db.players[player.id] = player;
    saveDb();
    setSession(res, player.id);
    return sendJson(res, 201, { player: playerSummary(player) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendError(res, 400, error.message); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const player = Object.values(db.players).find(item => item.username.toLowerCase() === username.toLowerCase());
    if (password.length < 6 || password.length > 64 || !player || !await verifyPassword(password, player)) return sendError(res, 401, '玩家名或密码不正确');
    setSession(res, player.id);
    return sendJson(res, 200, { player: playerSummary(player) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const player = currentPlayer(req);
    if (player) { cancelMatch(player.id); saveDb(); }
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const player = currentPlayer(req);
    return player ? sendJson(res, 200, { player: playerSummary(player) }) : sendError(res, 401, '未登录');
  }

  const player = requirePlayer(req, res);
  if (!player) return;

  if (req.method === 'GET' && pathname === '/api/lobby') {
    cleanQueue();
    if (db.queue.includes(player.id)) seen.set(player.id, now());
    const room = latestRoomFor(player.id);
    return sendJson(res, 200, { player: playerSummary(player), queued: db.queue.includes(player.id), queueSize: db.queue.length, room: room ? publicRoom(room, player.id) : null });
  }

  if (req.method === 'POST' && pathname === '/api/match/join') {
    const room = joinMatch(player);
    saveDb();
    return sendJson(res, 200, { matched: Boolean(room), room: room ? publicRoom(room, player.id) : null, queueSize: db.queue.length });
  }

  if (req.method === 'POST' && pathname === '/api/match/cancel') {
    cancelMatch(player.id);
    saveDb();
    const room = activeRoomFor(player.id);
    return sendJson(res, 200, { ok: true, room: room ? publicRoom(room, player.id) : null, queueSize: db.queue.length });
  }

  if (req.method === 'POST' && pathname === '/api/rooms/create') {
    const existing = activeRoomFor(player.id);
    if (existing) return sendJson(res, 200, { room: publicRoom(existing, player.id) });
    cancelMatch(player.id);
    const room = createRoom(player.id);
    saveDb();
    return sendJson(res, 201, { room: publicRoom(room, player.id) });
  }

  if (req.method === 'POST' && pathname === '/api/rooms/join-code') {
    let body;
    try { body = await readBody(req); } catch (error) { return sendError(res, 400, error.message); }
    const existing = activeRoomFor(player.id);
    if (existing) return sendJson(res, 200, { room: publicRoom(existing, player.id) });
    const room = findWaitingRoomByCode(body.code);
    if (!room) return sendError(res, 404, '房间码无效或房间已关闭');
    const owner = room.players[0];
    if (owner.id === player.id) return sendError(res, 400, '不能加入自己创建的房间');
    cancelMatch(player.id);
    dismissFinished(player.id);
    startRoom(room, owner.id, player.id);
    room.revision++;
    saveDb();
    return sendJson(res, 200, { room: publicRoom(room, player.id) });
  }

  const rematchMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/rematch$/);
  if (req.method === 'POST' && rematchMatch) {
    const original = db.rooms[rematchMatch[1]];
    if (!original || original.status !== 'finished' || !participant(original, player.id)) return sendError(res, 404, '这局牌还不能重新开始');
    let rematch = rematchRoomFor(original, player.id);
    if (rematch && rematch.status === 'waiting' && !rematch.players.some(item => item.id === player.id)) {
      startRoom(rematch, rematch.players[0].id, player.id);
      rematch.revision = (rematch.revision || 0) + 1;
    } else if (!rematch) {
      rematch = createRematch(original, player.id);
    }
    saveDb();
    return sendJson(res, 200, { room: publicRoom(rematch, player.id) });
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([a-z]+))?$/);
  if (roomMatch) {
    const room = db.rooms[roomMatch[1]];
    if (!room || !participant(room, player.id)) return sendError(res, 404, '找不到这个房间');
    const action = roomMatch[2];
    if (req.method === 'GET' && !action) return sendJson(res, 200, { room: publicRoom(room, player.id) });
    if (req.method === 'POST' && action === 'play') {
      let body;
      try { body = await readBody(req); } catch (error) { return sendError(res, 400, error.message); }
      // Check again after awaiting the body: a slow request cannot bypass the deadline.
      tickRooms();
      if (body.round !== room.round) return sendError(res, 409, '回合已变化，请刷新后重试');
      const result = applyPlay(room, player.id, String(body.cardId || ''));
      if (!result.ok) return sendError(res, 400, result.message);
      saveDb();
      return sendJson(res, 200, { room: publicRoom(room, player.id) });
    }
    if (req.method === 'POST' && action === 'leave') {
      leaveRoom(room, player.id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendError(res, 404, '接口不存在');
}

function serveStatic(req, res, pathname) {
  const assets = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg' };
  if (!Object.hasOwn(assets, pathname)) return sendError(res, 404, '页面不存在');
  const filePath = path.join(PUBLIC_DIR, assets[pathname]);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendError(res, 415, '请使用 JSON 请求');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return sendError(res, 403, '请求来源不正确');
    }
    tickRooms();
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname, url);
    else serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, '服务器发生错误');
  }
});

let timer;
server.once('listening', () => { timer = setInterval(tickRooms, 250); timer.unref(); });
server.once('close', () => clearInterval(timer));
return server;
}

if (require.main === module) {
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请关闭已有服务或设置其他 PORT。' : error); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log(`Emperor server running at http://localhost:${server.address().port}`));
  process.on('SIGINT', () => server.close(() => process.exit()));
  process.on('SIGTERM', () => server.close(() => process.exit()));
}
module.exports = { createApp };
