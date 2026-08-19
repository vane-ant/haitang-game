// ============================================================
// 海龟汤身份局 · 零依赖实时服务器
// 原生 Node http + SSE 推送，无任何第三方包
// 运行: node server.js  (默认端口 3000, 可用 PORT 环境变量覆盖)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// ---------- 工具 ----------
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const uid = () => rnd(8);
const roomId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};
const now = () => Date.now();

// ---------- 数据 ----------
const rooms = new Map(); // roomId -> room

function createRoom() {
  let id;
  do { id = roomId(); } while (rooms.has(id));
  const room = {
    id,
    host: null,                 // 房主 playerId
    players: {},                // playerId -> player
    order: [],                  // 玩家顺序
    phase: 'lobby',             // lobby | playing | ended
    T: 40,                      // 总猜测次数
    perQuota: 8,                // 每人次数
    penalty: 4,                 // 非本身份惩罚
    killerUses: 2,              // 杀手清空剩余次数
    soupFace: '',
    soupBottom: '',
    messages: [],               // 消息数组
    pendingQuestions: [],       // 待主持人回答的提问
    sseClients: new Map(),      // playerId -> res
    roles: ['detective', 'innocent', 'innocent', 'innocent', 'killer'],
    roleAssigned: {},
    lastEventId: 0,
  };
  rooms.set(id, room);
  return room;
}

// ---------- 推送 (SSE) ----------
function push(room, targetId, event, data) {
  room.lastEventId++;
  const payload = `id: ${room.lastEventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (targetId) {
    const res = room.sseClients.get(targetId);
    if (res) { try { res.write(payload); } catch (e) {} }
    return;
  }
  for (const [pid, res] of room.sseClients) {
    try { res.write(payload); } catch (e) { room.sseClients.delete(pid); }
  }
}

function broadcast(room, event, data) { push(room, null, event, data); }

// 全量快照（发给某个玩家，私密字段过滤）
function snapshot(room, playerId) {
  const me = room.players[playerId];
  return {
    id: room.id,
    host: room.host,
    phase: room.phase,
    T: room.T,
    perQuota: room.perQuota,
    penalty: room.penalty,
    killerUses: room.killerUses,
    soupFace: room.soupFace,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, isHost: p.id === room.host,
      role: p.id === playerId ? p.role : (p.roleRevealed ? p.role : null),
      quota: p.id === playerId ? p.quota : null, // 次数保密，只看自己
      alive: p.alive,
    })),
    me: me ? { id: me.id, name: me.name, role: me.role, quota: me.quota, alive: me.alive } : null,
    messages: room.messages.filter(m => m.to === undefined || m.to === playerId || m.to === null),
    pendingCount: room.host === playerId ? room.pendingQuestions.length : 0,
  };
}

function pushSnapshot(room, playerId) {
  push(room, playerId, 'snapshot', snapshot(room, playerId));
}
function pushAllSnapshots(room) {
  for (const pid of room.order) pushSnapshot(room, pid);
}

// ---------- 消息 ----------
function addMsg(room, type, from, text, opts = {}) {
  const msg = { id: rnd(4), type, from, text, ts: now(), ...opts };
  room.messages.push(msg);
  if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
  broadcast(room, 'message', msg);
  // 提问进待答队列
  if (type === 'question') room.pendingQuestions.push(msg.id);
  return msg;
}

function hostMsg(room, from, text, type = 'system') {
  return addMsg(room, type, from, text);
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 请求体解析 ----------
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// 必须房间存在 + 玩家在房间
function guard(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return { err: '房间不存在' };
  const p = room.players[playerId];
  if (!p) return { err: '玩家不存在' };
  return { room, p };
}

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // SSE 推送流
  if (p === '/api/stream') {
    const roomId = u.searchParams.get('room');
    const playerId = u.searchParams.get('player');
    const g = guard(roomId, playerId);
    if (g.err) { json(res, 400, { err: g.err }); return; }
    const room = g.room;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    room.sseClients.set(playerId, res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(room, playerId))}\n\n`);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(hb); room.sseClients.delete(playerId); });
    return;
  }

  // API
  if (p.startsWith('/api/')) {
    const body = await readBody(req);

    // 建房
    if (p === '/api/room/create' && req.method === 'POST') {
      const name = (body.name || '').trim().slice(0, 12) || '玩家';
      const room = createRoom();
      const pid = uid();
      room.players[pid] = { id: pid, name, isHost: true, role: null, quota: 0, alive: true, roleRevealed: false };
      room.host = pid;
      room.order = [pid];
      json(res, 200, { roomId: room.id, playerId: pid, isHost: true });
      return;
    }

    // 加入
    if (p === '/api/room/join' && req.method === 'POST') {
      const room = rooms.get((body.roomId || '').toUpperCase());
      if (!room) { json(res, 404, { err: '房间不存在' }); return; }
      if (room.phase !== 'lobby') { json(res, 400, { err: '游戏已开始，无法加入' }); return; }
      if (Object.keys(room.players).length >= 5) { json(res, 400, { err: '房间已满（5人）' }); return; }
      const name = (body.name || '').trim().slice(0, 12) || '玩家';
      const pid = uid();
      room.players[pid] = { id: pid, name, isHost: false, role: null, quota: 0, alive: true, roleRevealed: false };
      room.order.push(pid);
      hostMsg(room, null, `${name} 加入了房间`);
      pushAllSnapshots(room);
      json(res, 200, { roomId: room.id, playerId: pid, isHost: false });
      return;
    }

    // 发消息（聊天 / 提问）
    if (p === '/api/msg' && req.method === 'POST') {
      const g = guard(body.roomId, body.playerId);
      if (g.err) { json(res, 400, { err: g.err }); return; }
      const { room, p: pl } = g;
      const text = (body.text || '').trim();
      if (!text) { json(res, 400, { err: '消息为空' }); return; }
      if (!pl.alive && pl.quota <= 0) { json(res, 400, { err: '你已出局，不能发言' }); return; }
      const isQuestion = !!body.question; // 提问模式（消耗次数）
      if (isQuestion) {
        if (pl.quota <= 0) { json(res, 400, { err: '猜汤底次数用完了' }); return; }
        pl.quota--;
        addMsg(room, 'question', pl.id, text);
        pushAllSnapshots(room);
        json(res, 200, { ok: true, quota: pl.quota });
        return;
      }
      addMsg(room, 'chat', pl.id, text);
      json(res, 200, { ok: true });
      return;
    }

    // 房主操作
    if (p === '/api/host' && req.method === 'POST') {
      const g = guard(body.roomId, body.playerId);
      if (g.err) { json(res, 400, { err: g.err }); return; }
      const { room, p: pl } = g;
      if (pl.id !== room.host) { json(res, 403, { err: '你不是主持人' }); return; }
      const act = body.action;

      // 开局设置：汤面 + 汤底 + T
      if (act === 'setup') {
        room.soupFace = (body.soupFace || '').trim();
        room.soupBottom = (body.soupBottom || '').trim();
        const t = parseInt(body.T, 10);
        if (t >= 10 && t <= 999) room.T = t;
        const n = room.order.length;
        room.perQuota = Math.floor(room.T / n);
        room.penalty = Math.floor((room.T / n) * 0.5);
        room.killerUses = Math.floor((n - 1) / 2);
        for (const pid of room.order) { room.players[pid].quota = room.perQuota; room.players[pid].alive = true; room.players[pid].role = null; }
        room.phase = 'playing';
        room.roleAssigned = {};
        room.pendingQuestions = [];
        hostMsg(room, null, `游戏开始！总猜测次数 T=${room.T}，每人 ${room.perQuota} 次。身份已隐藏，请自行确认。`);
        hostMsg(room, 'system-soup', room.soupFace, 'soup');
        pushAllSnapshots(room);
        json(res, 200, { ok: true });
        return;
      }

      // 分配身份（房主秘密分配）
      if (act === 'assign') {
        const target = room.players[body.targetId];
        if (!target) { json(res, 400, { err: '目标不存在' }); return; }
        const role = body.role;
        if (!['detective', 'innocent', 'killer'].includes(role)) { json(res, 400, { err: '身份非法' }); return; }
        target.role = role;
        room.roleAssigned[body.targetId] = role;
        pushSnapshot(room, body.targetId); // 只让本人知道自己身份（通过 me.role）
        json(res, 200, { ok: true });
        return;
      }

      // 回答待答提问
      if (act === 'answer') {
        const mid = body.msgId;
        const q = room.messages.find(m => m.id === mid && m.type === 'question');
        if (!q) { json(res, 400, { err: '提问不存在' }); return; }
        q.answered = true;
        const answer = body.answer; // yes | no | irrelevant | custom
        const extra = (body.text || '').trim();
        const map = { yes: '是', no: '否', irrelevant: '无关', custom: extra || '……' };
        const text = map[answer] || '……';
        addMsg(room, 'answer', null, text, { refId: mid });
        room.pendingQuestions = room.pendingQuestions.filter(id => id !== mid);
        pushAllSnapshots(room);
        json(res, 200, { ok: true });
        return;
      }

      // 公开补充汤面（含暗号）
      if (act === 'announce') {
        const text = (body.text || '').trim();
        if (!text) { json(res, 400, { err: '内容为空' }); return; }
        addMsg(room, 'soup', null, text);
        json(res, 200, { ok: true });
        return;
      }

      // 杀手清空：房主代操作（或杀手申请后房主确认）
      if (act === 'kill') {
        if (room.phase !== 'playing') { json(res, 400, { err: '游戏未开始' }); return; }
        const target = room.players[body.targetId];
        if (!target || !target.alive) { json(res, 400, { err: '目标无效' }); return; }
        // 找到杀手
        const killer = room.order.map(id => room.players[id]).find(p => p.role === 'killer' && p.alive);
        if (!killer) { json(res, 400, { err: '场上没有存活杀手' }); return; }
        if (room.killerUses <= 0) { json(res, 400, { err: '杀手清空次数已用完' }); return; }
        room.killerUses--;
        // 下一轮开始公布（简化：立即公布受害者昵称）
        hostMsg(room, null, `🔪 杀手出手！${target.name} 的全部猜汤底次数被清空，出局！`);
        target.alive = false;
        target.quota = 0;
        pushAllSnapshots(room);
        json(res, 200, { ok: true, killerUses: room.killerUses });
        return;
      }

      // 转让身份（主持人自行转让给任意玩家 —— 房主操作）
      if (act === 'transfer') {
        const from = room.players[body.fromId];
        const to = room.players[body.toId];
        if (!from || !to) { json(res, 400, { err: '玩家不存在' }); return; }
        if (from.role !== 'detective') { json(res, 400, { err: '转让方不是侦探' }); return; }
        const half = Math.floor(from.quota / 2);
        to.role = 'detective';
        from.role = 'transfered'; // 原侦探
        from.quota = 0;
        from.alive = false;
        to.quota += half;
        hostMsg(room, null, `🕵️ 侦探完成了身份转让（细节保密）。`);
        // 私密通知
        addMsg(room, 'private', null, `你成为了新的侦探，获得能力：可向主持人私下申请提示；原侦探是 ${from.name}（不能公开）。`, { to: to.id });
        pushAllSnapshots(room);
        json(res, 200, { ok: true });
        return;
      }

      // 结束游戏 / 判定
      if (act === 'end') {
        room.phase = 'ended';
        const result = (body.result || '').trim();
        if (result) hostMsg(room, null, `🏁 ${result}`);
        for (const pid of room.order) {
          const p = room.players[pid];
          if (p.role) p.roleRevealed = true; // 结束时公开身份
        }
        pushAllSnapshots(room);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 400, { err: '未知操作' });
      return;
    }

    json(res, 404, { err: 'API不存在' });
    return;
  }

  // 静态文件
  serveStatic(req, res, p);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`海龟汤身份局服务器已启动: http://0.0.0.0:${PORT}`);
  console.log(`局域网访问: http://<本机IP>:${PORT}`);
});
