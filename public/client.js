// ============ 海龟汤身份局 · 前端逻辑 ============
const $ = (id) => document.getElementById(id);
let STATE = null; // 当前快照
let ME = null;    // 我的信息
let es = null;

const ROLE_NAME = { detective: '侦探', innocent: '无辜者', killer: '杀手', transfered: '原侦探' };
const ROLE_ICON = { detective: '🕵️', innocent: '😇', killer: '🔪', transfered: '👻' };

// ---------- 登录 ----------
$('btnCreate').onclick = async () => {
  const name = $('nick').value.trim() || '玩家';
  const r = await api('/api/room/create', { name });
  if (r.err) return showErr(r.err);
  enter(r);
};
$('btnJoin').onclick = async () => {
  $('joinCode').style.display = 'block';
  $('joinCode').focus();
};
$('joinCode').onkeydown = async (e) => {
  if (e.key === 'Enter') {
    const name = $('nick').value.trim() || '玩家';
    const r = await api('/api/room/join', { roomId: $('joinCode').value, name });
    if (r.err) return showErr(r.err);
    enter(r);
  }
};
function showErr(t) { $('loginErr').textContent = t; setTimeout(() => $('loginErr').textContent = '', 2500); }

async function enter(r) {
  localStorage.setItem('ht_room', r.roomId);
  localStorage.setItem('ht_player', r.playerId);
  $('login').hidden = true;
  $('game').hidden = false;
  connect(r.roomId, r.playerId);
}

async function api(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (e) { return { err: '网络错误' }; }
}

// ---------- SSE 连接 ----------
function connect(roomId, playerId) {
  if (es) es.close();
  es = new EventSource(`/api/stream?room=${roomId}&player=${playerId}`);
  es.addEventListener('snapshot', e => { STATE = JSON.parse(e.data); render(); });
  es.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    renderMsg(m);
    autoScroll();
  });
  es.onerror = () => {};
}

// ---------- 渲染 ----------
function render() {
  if (!STATE) return;
  ME = STATE.me;
  $('roomId').textContent = STATE.id;
  $('phaseTag').textContent =
    STATE.phase === 'lobby' ? '等待中' :
    STATE.phase === 'playing' ? '游戏进行中' : '已结束';
  $('phaseTag').className = 'phase-tag ' + STATE.phase;
  renderPlayers();
  renderSoup();
  renderQuota();
  renderMsgs();
  renderHostPanel();
}

function renderPlayers() {
  const box = $('players');
  box.innerHTML = '';
  for (const p of STATE.players) {
    const el = document.createElement('div');
    el.className = 'pchip';
    const role = p.role && p.id === STATE.me.id ? ROLE_ICON[p.role] : '';
    el.innerHTML = `
      <div class="avatar ${p.id === STATE.me.id ? 'me' : ''} ${p.isHost ? 'host' : ''} ${p.alive ? '' : 'dead'}">
        ${p.name.slice(0, 1)}
        <span class="role">${role}</span>
      </div>
      <div class="pname">${p.name}${p.isHost ? '👑' : ''}</div>
      ${p.id === STATE.me.id ? `<div class="pquota">剩 ${p.quota} 次</div>` : ''}
    `;
    box.appendChild(el);
  }
}

function renderSoup() {
  const card = $('soupCard');
  if (STATE.soupFace) {
    $('soupFace').textContent = STATE.soupFace;
    card.hidden = false;
  } else card.hidden = true;
}

function renderQuota() {
  if (ME) $('myQuota').textContent = `我的次数：${ME.quota}`;
}

function renderMsgs() {
  const box = $('msgs');
  box.innerHTML = '';
  for (const m of STATE.messages) {
    const el = buildMsg(m);
    if (el) box.appendChild(el);
  }
  autoScroll();
}

function buildMsg(m) {
  const el = document.createElement('div');
  let cls = 'msg';
  let meta = '';
  if (m.type === 'system' || m.type === 'kill') {
    cls += ' system' + (m.type === 'kill' ? ' kill' : '');
    meta = '';
  } else if (m.type === 'soup') {
    cls += ' soup';
    el.innerHTML = `<div class="bubble">📜 ${escapeHtml(m.text)}</div>`;
    return el;
  } else if (m.type === 'private') {
    cls += ' private';
    el.innerHTML = `<div class="bubble">🔒 ${escapeHtml(m.text)}</div>`;
    return el;
  } else if (m.type === 'question') {
    cls += ' question ' + (m.from === ME.id ? 'me' : 'other');
    meta = `<div class="meta">${nameOf(m.from)} 提问</div>`;
  } else if (m.type === 'answer') {
    cls += ' answer';
    meta = '';
  } else {
    cls += ' ' + (m.from === ME.id ? 'me' : 'other');
    meta = `<div class="meta">${nameOf(m.from)}</div>`;
  }
  el.className = cls;
  el.innerHTML = meta + `<div class="bubble">${escapeHtml(m.text)}</div>`;
  return el;
}

function renderMsg(m) {
  const el = buildMsg(m);
  if (el) $('msgs').appendChild(el);
}

function nameOf(pid) {
  if (!pid) return '系统';
  const p = STATE.players.find(x => x.id === pid);
  return p ? p.name : '?';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function autoScroll() {
  const box = $('msgs');
  box.scrollTop = box.scrollHeight;
}

// ---------- 发送 ----------
let mode = 'chat'; // chat | ask
$('modeChat').onclick = () => setMode('chat');
$('modeAsk').onclick = () => setMode('ask');
function setMode(m) {
  mode = m;
  $('modeChat').classList.toggle('active', m === 'chat');
  $('modeAsk').classList.toggle('active', m === 'ask');
  $('msgInput').placeholder = m === 'ask' ? '输入你的是/否提问…（扣1次）' : '说点什么…';
}
$('btnSend').onclick = send;
$('msgInput').onkeydown = (e) => { if (e.key === 'Enter') send(); };
async function send() {
  const text = $('msgInput').value.trim();
  if (!text || !STATE) return;
  const r = await api('/api/msg', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), text, question: mode === 'ask' });
  if (r.err) { $('inputHint').textContent = r.err; setTimeout(() => $('inputHint').textContent = '', 2000); return; }
  if (r.quota !== undefined && ME) ME.quota = r.quota;
  $('msgInput').value = '';
  setMode('chat');
}

// ---------- 房主面板 ----------
$('btnPanel').onclick = () => { $('drawer').hidden = false; };
$('btnClosePanel').onclick = () => { $('drawer').hidden = true; };

function renderHostPanel() {
  if (!STATE || !ME || !ME.isHost) return;
  const inGame = STATE.phase === 'playing';
  $('secAssign').hidden = !inGame;
  $('secAnswer').hidden = !inGame;
  $('secKill').hidden = !inGame;
  $('secTransfer').hidden = !inGame;
  $('secEnd').hidden = !inGame;
  $('killLeft').textContent = STATE.killerUses;
  renderAssignList();
  renderPendingList();
  renderSelects();
}

function renderAssignList() {
  const box = $('assignList');
  const assigned = {};
  for (const p of STATE.players) if (p.role) assigned[p.id] = p.role;
  box.innerHTML = '';
  for (const p of STATE.players) { // 房主也是玩家，同样需要分配身份
    const row = document.createElement('div');
    row.className = 'assign-row';
    row.innerHTML = `
      <span class="aname">${p.name}</span>
      <select data-t="${p.id}">
        <option value="">未分配</option>
        <option value="detective" ${assigned[p.id] === 'detective' ? 'selected' : ''}>侦探</option>
        <option value="innocent" ${assigned[p.id] === 'innocent' ? 'selected' : ''}>无辜者</option>
        <option value="killer" ${assigned[p.id] === 'killer' ? 'selected' : ''}>杀手</option>
      </select>`;
    row.querySelector('select').onchange = (e) => {
      api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'assign', targetId: p.id, role: e.target.value });
    };
    box.appendChild(row);
  }
}

function renderPendingList() {
  const box = $('pendingList');
  const pend = STATE.messages.filter(m => m.type === 'question' && !m.answered);
  $('pendingEmpty').style.display = pend.length ? 'none' : 'block';
  box.innerHTML = '';
  for (const q of pend) {
    const el = document.createElement('div');
    el.className = 'pq';
    el.innerHTML = `
      <div class="pq-text">${nameOf(q.from)}：${escapeHtml(q.text)}</div>
      <div class="pq-ans">
        <button class="yes">是</button>
        <button class="no">否</button>
        <button class="na">无关</button>
      </div>`;
    el.querySelector('.yes').onclick = () => answer(q.id, 'yes');
    el.querySelector('.no').onclick = () => answer(q.id, 'no');
    el.querySelector('.na').onclick = () => answer(q.id, 'irrelevant');
    box.appendChild(el);
  }
}
function answer(msgId, ans) {
  api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'answer', msgId, answer: ans });
}

function renderSelects() {
  // 清空目标
  const killSel = $('killTarget');
  killSel.innerHTML = '';
  for (const p of STATE.players) if (p.alive && p.id !== ME.id) {
    killSel.innerHTML += `<option value="${p.id}">${p.name}</option>`;
  }
  // 转让
  const f = $('transFrom'); f.innerHTML = '';
  const t = $('transTo'); t.innerHTML = '';
  for (const p of STATE.players) if (p.alive && p.role === 'detective') f.innerHTML += `<option value="${p.id}">${p.name}（侦探）</option>`;
  for (const p of STATE.players) if (p.alive && p.id !== f.value) t.innerHTML += `<option value="${p.id}">${p.name}</option>`;
}

// 开局
$('btnSetup').onclick = async () => {
  const r = await api('/api/host', {
    roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'setup',
    soupFace: $('inpFace').value, soupBottom: $('inpBottom').value, T: parseInt($('inpT').value, 10) || 40,
  });
  if (r.err) alert(r.err);
};

// 补充
$('btnAnnounce').onclick = async () => {
  const r = await api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'announce', text: $('inpAnnounce').value });
  if (!r.err) $('inpAnnounce').value = '';
};

// 清空
$('btnKill').onclick = async () => {
  const r = await api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'kill', targetId: $('killTarget').value });
  if (r.err) alert(r.err);
};

// 转让
$('btnTransfer').onclick = async () => {
  const r = await api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'transfer', fromId: $('transFrom').value, toId: $('transTo').value });
  if (r.err) alert(r.err);
};

// 结束
$('btnEnd').onclick = async () => {
  if (!confirm('确定结束游戏并公布身份？')) return;
  await api('/api/host', { roomId: STATE.id, playerId: localStorage.getItem('ht_player'), action: 'end', result: $('inpResult').value });
};

// 恢复上次会话
(function () {
  const r = localStorage.getItem('ht_room');
  const p = localStorage.getItem('ht_player');
  if (r && p) {
    $('login').hidden = true;
    $('game').hidden = false;
    connect(r, p);
  }
})();
