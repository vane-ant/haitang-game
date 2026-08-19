// ============ 海龟汤身份局 · 前端逻辑 ============
const $ = (id) => document.getElementById(id);
let STATE = null; // 当前快照
let ME = null;    // 我的信息
let es = null;
let DEMO = false; // 演示模式（GitHub Pages 静态预览，无后端时启用）

const ROLE_NAME = { detective: '侦探', innocent: '无辜者', killer: '杀手', transfered: '原侦探' };
const ROLE_ICON = { detective: '🕵️', innocent: '😇', killer: '🔪', transfered: '👻' };

// ---------- API（演示模式拦截） ----------
async function api(url, body) {
  if (DEMO) return { err: '🧪 演示模式：仅静态预览 UI，完整功能需本地运行 node server.js' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (e) { return { err: '网络错误' }; }
}

// ---------- 登录 ----------
$('btnCreate').onclick = async () => {
  if (DEMO) return enterDemo();
  const name = $('nick').value.trim() || '玩家';
  const r = await api('/api/room/create', { name });
  if (r.err) return showErr(r.err);
  enter(r);
};
$('btnJoin').onclick = async () => {
  if (DEMO) return enterDemo();
  $('joinCode').style.display = 'block';
  $('joinCode').focus();
};
$('joinCode').onkeydown = async (e) => {
  if (e.key === 'Enter') {
    if (DEMO) return enterDemo();
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

// ============ 演示模式（GitHub Pages 静态预览） ============
function enterDemo() {
  DEMO = true;
  $('login').hidden = true;
  $('game').hidden = false;
  $('demoBanner').hidden = false;
  STATE = {
    id: 'DEMO',
    host: 'p1',
    phase: 'playing',
    T: 40, perQuota: 8, penalty: 4, killerUses: 2,
    soupFace: '深夜，狼嚎了，大地又见红了。\n天亮，鸡鸣了，屋子又染白了。',
    players: [
      { id: 'p1', name: '我', isHost: true, role: 'detective', quota: 6, alive: true },
      { id: 'p2', name: '阿K', isHost: false, role: null, quota: null, alive: true },
      { id: 'p3', name: '小美', isHost: false, role: null, quota: null, alive: true },
      { id: 'p4', name: '老六', isHost: false, role: null, quota: null, alive: true },
      { id: 'p5', name: '大壮', isHost: false, role: null, quota: null, alive: false },
    ],
    me: { id: 'p1', name: '我', role: 'detective', quota: 6, alive: true, isHost: true },
    messages: [
      { id: 'm1', type: 'system', from: null, text: '游戏开始！总猜测次数 T=40，每人 8 次。次数保密，自己记账。' },
      { id: 'm2', type: 'soup', from: null, text: '深夜，狼嚎了，大地又见红了。天亮，鸡鸣了，屋子又染白了。' },
      { id: 'm3', type: 'chat', from: 'p3', text: '这汤面也太文艺了吧，翻译翻译？' },
      { id: 'm4', type: 'question', from: 'p2', text: '狼嚎是真的狼在叫吗？' },
      { id: 'm5', type: 'answer', from: null, text: '否' },
      { id: 'm6', type: 'question', from: 'p1', text: '“大地见红”指的是血吗？' },
      { id: 'm7', type: 'answer', from: null, text: '是' },
      { id: 'm8', type: 'soup', from: null, text: '📜 主持人补充：那晚的嚎叫，不是狼。' },
      { id: 'm9', type: 'chat', from: 'p4', text: '卧槽，那是什么在叫？' },
      { id: 'm10', type: 'private', from: null, text: '🔒 你是侦探：可私下向主持人申请提示（演示数据）', to: 'p1' },
      { id: 'm11', type: 'kill', from: null, text: '🔪 杀手出手！大壮的全部猜汤底次数被清空，出局！' },
    ],
  };
  render();
}

// 后端探测：静态托管（如 GitHub Pages）下自动进入演示模式
(async function probe() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/api/room/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'probe' }), signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return enterDemo();
    // 后端在：探测房间会残留，直接清理不了，但无碍
  } catch (e) {
    enterDemo();
  }
})();

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
