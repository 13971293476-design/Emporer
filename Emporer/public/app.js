const $ = selector => document.querySelector(selector);
const state = { mode: 'login', me: null, room: null, pollTimer: null, timer: null, clockOffset: 0 };

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2800); }
function setAuthMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('#auth-title').textContent = mode === 'login' ? '进入宫廷' : '建立身份';
  $('#auth-caption').textContent = mode === 'login' ? '登录后寻找一位对手，开始你的第一局。' : '创建一个玩家名，保存你的战绩与身份。';
  $('#auth-submit-label').textContent = mode === 'login' ? '进入游戏' : '创建玩家';
  $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

function enterApp(player) {
  state.me = player;
  $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  $('#top-player').textContent = player.username; $('#welcome-name').textContent = player.username; $('#profile-name').textContent = player.username;
  $('#wins').textContent = player.stats.wins; $('#losses').textContent = player.stats.losses;
  window.scrollTo(0, 0);
  refreshLobby();
}

function leaveApp() {
  clearInterval(state.pollTimer); clearInterval(state.timer); state.room = null; state.me = null;
  $('#app-view').classList.add('hidden'); $('#auth-view').classList.remove('hidden'); $('#top-player').textContent = '';
}

async function refreshLobby() {
  try {
    const data = await request('/api/lobby');
    if (data.room) openRoom(data.room); else if (data.queued) { showQueueState(); startLobbyPolling(); } else resetMatchCard();
  } catch (error) { showToast(error.message); }
}

function resetMatchCard() {
  state.room = null; state.clockOffset = 0; $('#lobby-grid').classList.remove('hidden'); $('#room-view').classList.add('hidden'); $('#room-view').innerHTML = '';
  $('#match-title').textContent = '寻找对手'; $('#match-caption').textContent = '匹配一位在线玩家，立即开始一局。';
  $('#match-button').classList.remove('hidden'); $('#create-room-button').classList.remove('hidden'); $('#create-room-button').disabled = false; $('#join-code-button').disabled = false; $('#room-code-input').disabled = false; $('#queue-state').classList.add('hidden'); $('#match-button').disabled = false;
}

function showQueueState() {
  $('#match-title').textContent = '正在匹配';
  $('#match-caption').textContent = '找到对手后会自动进入牌局。';
  $('#match-button').disabled = true;
  $('#match-button').classList.add('hidden');
  $('#create-room-button').classList.add('hidden');
  $('#queue-state').classList.remove('hidden');
}

function refreshProfile(player) {
  state.me = player;
  $('#top-player').textContent = player.username;
  $('#welcome-name').textContent = player.username;
  $('#profile-name').textContent = player.username;
  $('#wins').textContent = player.stats.wins;
  $('#losses').textContent = player.stats.losses;
}

function joinMatch() {
  showQueueState();
  request('/api/match/join', { method: 'POST' }).then(data => { if (data.room) openRoom(data.room); startLobbyPolling(); }).catch(error => { showToast(error.message); resetMatchCard(); });
}

async function cancelMatch() {
  await request('/api/match/cancel', { method: 'POST' }).catch(() => {});
  clearInterval(state.pollTimer); resetMatchCard();
}

async function createRoom() {
  $('#match-button').disabled = true; $('#create-room-button').disabled = true; $('#join-code-button').disabled = true; $('#room-code-input').disabled = true;
  try { const data = await request('/api/rooms/create', { method: 'POST' }); openRoom(data.room); } catch (error) { showToast(error.message); resetMatchCard(); }
}

async function joinRoomByCode() {
  const code = $('#room-code-input').value.trim().toUpperCase();
  if (code.length !== 6) return showToast('请输入 6 位房间码');
  $('#join-code-button').disabled = true;
  try { const data = await request('/api/rooms/join-code', { method: 'POST', body: JSON.stringify({ code }) }); openRoom(data.room); } catch (error) { showToast(error.message); $('#join-code-button').disabled = false; }
}

async function startRematch() {
  const button = $('#rematch-button');
  if (button) { button.disabled = true; button.textContent = '准备中…'; }
  try {
    const data = await request(`/api/rooms/${state.room.id}/rematch`, { method: 'POST' });
    openRoom(data.room);
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = '再来一局'; }
  }
}

function startLobbyPolling() { clearInterval(state.pollTimer); state.pollTimer = setInterval(async () => { try { const data = await request('/api/lobby'); if (data.room) openRoom(data.room); else if (data.queued) showQueueState(); } catch {} }, 1000); }

function openRoom(room) {
  state.clockOffset = Number(room.serverNow || Date.now()) - Date.now();
  state.room = room; clearInterval(state.pollTimer); $('#lobby-grid').classList.add('hidden'); $('#room-view').classList.remove('hidden'); $('#match-button').classList.add('hidden'); $('#create-room-button').classList.add('hidden'); $('#queue-state').classList.add('hidden'); $('#join-code-button').disabled = true; $('#room-code-input').disabled = true;
  renderRoom(); startRoomPolling();
}

function startRoomPolling() { clearInterval(state.pollTimer); state.pollTimer = setInterval(async () => { if (!state.room) return; try { const data = await request(`/api/rooms/${state.room.id}`); state.clockOffset = Number(data.room.serverNow || Date.now()) - Date.now(); state.room = data.room; renderRoom(); if (state.room.status === 'finished') clearInterval(state.pollTimer); } catch (error) { clearInterval(state.pollTimer); showToast(error.message); } }, 900); }

function cardMarkup(card, extra = '') { if (!card) return `<div class="empty-slot">·</div>`; return `<div class="card-face ${extra}"><span class="symbol">${card.symbol}</span><span class="label">${card.label}</span></div>`; }
function renderTimer() {
  const timer = $('#turn-timer'); if (!timer || !state.room || !state.room.deadlineAt || state.room.status !== 'playing') return;
  const remaining = Math.max(0, state.room.deadlineAt - (Date.now() + state.clockOffset)); const seconds = Math.ceil(remaining / 1000); timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; timer.classList.toggle('warn', seconds <= 10);
}

function renderRoom() {
  const room = state.room;
  if (room.status === 'finished' && !room.opponent) {
    $('#room-view').innerHTML = `<div class="panel room-code-card"><p class="section-kicker">ROOM CLOSED</p><h2>${room.resultText || '房间已关闭。'}</h2><button id="back-lobby" class="quiet-button">返回大厅</button></div>`;
    $('#back-lobby').addEventListener('click', async () => { try { await request(`/api/rooms/${room.id}/leave`, { method: 'POST' }); } catch {} resetMatchCard(); });
    clearInterval(state.timer);
    return;
  }
  if (room.status === 'waiting') {
    const isRematch = Boolean(room.rematchOf);
    const waitingTitle = isRematch ? '等待对手再来一局' : '把这串房间码发给好友';
    const waitingHint = isRematch && room.waitingFor ? `等待 ${room.waitingFor} 点击「再来一局」后自动开始。` : '好友在大厅输入房间码后，会自动进入同一局。';
    $('#room-view').innerHTML = `<div class="panel room-code-card ${isRematch ? 'rematch-waiting' : ''}"><p class="section-kicker">${isRematch ? 'REMATCH READY' : 'PRIVATE ROOM'}</p><h2>${waitingTitle}</h2><div class="room-code">${room.roomCode}</div><p class="room-code-hint">${waitingHint}</p><button id="copy-room-code" class="quiet-button">复制房间码</button><button id="cancel-room" class="quiet-button cancel-button">${isRematch ? '取消重赛' : '关闭房间'}</button></div>`;
    $('#copy-room-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText(room.roomCode); showToast('房间码已复制'); } catch { showToast(`房间码：${room.roomCode}`); } });
    $('#cancel-room').addEventListener('click', async () => { try { await request(`/api/rooms/${room.id}/leave`, { method: 'POST' }); } catch {} resetMatchCard(); });
    clearInterval(state.timer);
    return;
  }
  const myTurn = room.canPlay && room.phase !== 'revealing'; const roleLabel = room.me.role === 'slave' ? '奴隶方' : '皇帝方'; const opponentRole = room.opponent.role === 'slave' ? '奴隶方' : '皇帝方';
  const timerText = room.status === 'finished' ? '—' : room.phase === 'revealing' ? '揭示中' : '--:--';
  const statusText = room.status === 'finished' ? '本局已结束' : room.phase === 'revealing' ? '双方牌面揭示，正在结算' : myTurn ? '轮到你出牌' : `等待 ${room.opponent.username} 出牌`;
  const hand = room.me.cards.map(card => `<button class="play-card ${card.type !== 'citizen' ? 'special' : ''} ${card.played || !myTurn ? 'disabled' : ''}" data-card="${card.id}" ${card.played || !myTurn ? 'disabled' : ''}><span class="symbol">${card.symbol}</span><span class="card-label">${card.label}</span><span class="used-label">${card.played ? '已使用' : myTurn ? '点击出牌' : '等待中'}</span></button>`).join('');
  const logs = (room.log || []).slice().reverse().map(item => `<div class="log-item"><span class="log-dot"></span><span>${item.text}</span></div>`).join('');
  const resultClass = room.winnerId === room.me.id ? 'win' : room.winnerId ? 'loss' : 'neutral';
  const resultTitle = room.winnerId === room.me.id ? '本局胜利' : room.winnerId ? '本局结束' : '本局结束';
  const result = room.resultText ? `<div class="result-box ${resultClass}"><div class="result-kicker">${resultTitle}</div><div class="result-copy">${room.resultText}</div><div class="result-actions"><button id="rematch-button" class="primary-button compact">再来一局 <span class="button-arrow">↻</span></button><button id="back-lobby" class="quiet-button back-lobby">返回大厅</button></div></div>` : '';
  $('#room-view').innerHTML = `<div class="game-shell"><section class="game-board"><div class="game-top"><div><div class="opponent-info"><div class="mini-avatar">${room.opponent.role === 'emperor' ? '♛' : '⚒'}</div><div><div class="player-name">${room.opponent.username}</div><div class="role-text">${opponentRole} · ${room.opponent.cardCount} 张待出</div></div></div><div class="opponent-hand">${Array.from({ length: room.opponent.cardCount }, () => '<span class="card-back-mini"></span>').join('')}</div></div><span class="turn-badge ${myTurn ? '' : 'waiting'}">第 ${room.round} 轮 · ${myTurn ? '你的回合' : '对手回合'}</span></div><div class="arena"><div class="played-slot">${cardMarkup(room.opponent.selectedCard)}</div><span class="versus">VS</span><div class="played-slot">${cardMarkup(room.me.selectedCard)}</div></div><div class="game-status"><div id="turn-timer" class="timer">${timerText}</div><div class="timer-label">${room.status === 'finished' ? '胜负已定' : '本回合剩余时间'}</div><div class="status-message">${statusText}</div></div>${result}<div class="hand-area"><div class="hand-header"><span class="hand-title">你的手牌 · ${roleLabel}</span><span class="hand-hint">特殊牌出现时，本局立即结束</span></div><div class="hand">${hand}</div></div></section><aside class="panel game-side"><p class="section-kicker">THE THREE LAWS</p><h3>胜负规则</h3><div class="side-rule"><span>♛</span><strong>皇帝 <small>击败平民</small></strong></div><div class="side-rule"><span>●</span><strong>平民 <small>击败奴隶</small></strong></div><div class="side-rule"><span>⚒</span><strong>奴隶 <small>击败皇帝</small></strong></div><div class="side-divider"></div><p class="section-kicker">MATCH LOG</p><div class="log">${logs || '<div class="log-item"><span class="log-dot"></span><span>牌局刚刚开始</span></div>'}</div></aside></div>`;
  document.querySelectorAll('.play-card:not(.disabled)').forEach(button => button.addEventListener('click', () => playCard(button.dataset.card)));
  if ($('#rematch-button')) $('#rematch-button').addEventListener('click', startRematch);
  if ($('#back-lobby')) $('#back-lobby').addEventListener('click', async () => { try { await request(`/api/rooms/${room.id}/leave`, { method: 'POST' }); } catch {} resetMatchCard(); try { const data = await request('/api/me'); refreshProfile(data.player); } catch {} });
  clearInterval(state.timer); state.timer = setInterval(renderTimer, 250); renderTimer();
}

async function playCard(cardId) { try { const data = await request(`/api/rooms/${state.room.id}/play`, { method: 'POST', body: JSON.stringify({ cardId, round: state.room.round }) }); openRoom(data.room); } catch (error) { showToast(error.message); } }

$('#auth-form').addEventListener('submit', async event => { event.preventDefault(); $('#auth-error').textContent = ''; const body = { username: $('#username').value, password: $('#password').value }; try { const data = await request(`/api/auth/${state.mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(body) }); enterApp(data.player); } catch (error) { $('#auth-error').textContent = error.message; } });
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
$('#match-button').addEventListener('click', joinMatch);
$('#cancel-match').addEventListener('click', cancelMatch);
$('#create-room-button').addEventListener('click', createRoom);
$('#join-code-button').addEventListener('click', joinRoomByCode);
$('#room-code-input').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoomByCode(); });
$('#logout-button').addEventListener('click', async () => { await request('/api/match/cancel', { method: 'POST' }).catch(() => {}); await request('/api/auth/logout', { method: 'POST' }).catch(() => {}); leaveApp(); });

(async function init() { try { const data = await request('/api/me'); enterApp(data.player); } catch {} })();
