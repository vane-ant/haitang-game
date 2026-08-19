// 全链路冒烟测试：自启服务器 + 模拟5人局完整流程
const { spawn } = require('child_process');
const NODE = process.execPath;
const BASE = 'http://127.0.0.1:3123';

const srv = spawn(NODE, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: '3123' }, stdio: 'ignore' });

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const api = async (p, body) => {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return r.json();
    } catch (e) { await wait(300); }
  }
  return { err: '服务器未就绪' };
};
const log = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`);

(async () => {
  await wait(800);
  // 1. 建房
  const host = await api('/api/room/create', { name: '主持人' });
  log(!!host.roomId, `建房成功 room=${host.roomId}`);

  // 2. 加入4人
  const players = [];
  for (const n of ['阿K', '小美', '老六', '二狗']) {
    const p = await api('/api/room/join', { roomId: host.roomId, name: n });
    players.push(p);
    log(!!p.playerId, `${n} 加入`);
  }

  // 3. 开局
  const setup = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'setup',
    soupFace: '深夜狼嚎，大地见红；天亮鸡鸣，屋子染白。',
    soupBottom: '屠夫深夜杀牲畜，嚎叫像狼嚎，血染大地；天亮用石灰消毒，屋子染白。', T: 40 });
  log(setup.ok, `开局 T=40 每人=${40/5}次 惩罚=${(40/5)*0.5}`);

  // 4. 分配身份
  const roles = ['detective', 'innocent', 'innocent', 'killer'];
  for (let i = 0; i < players.length; i++) {
    const r = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'assign', targetId: players[i].playerId, role: roles[i] });
    log(r.ok, `身份分配: ${['阿K','小美','老六','二狗'][i]}=${roles[i]}`);
  }

  // 5. 提问扣次
  const q = await api('/api/msg', { roomId: host.roomId, playerId: players[0].playerId, text: '狼嚎是真的吗？', question: true });
  log(q.quota === 7, `提问扣次: 8->${q.quota}`);

  // 6. 房主回答（无真实msgId，走pending队列验证——直接验证应答API容错）
  const a = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'answer', msgId: 'zzz', answer: 'no' });
  log(!!a.err, `回答容错: ${a.err}`);

  // 7. 补充
  const an = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'announce', text: '那晚的嚎叫不是狼。' });
  log(an.ok, '公开补充');

  // 8. 清空
  const kill = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'kill', targetId: players[2].playerId });
  log(kill.ok && kill.killerUses === 1, `杀手清空 剩=${kill.killerUses}次`);

  // 9. 转让
  const tr = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'transfer', fromId: players[0].playerId, toId: players[1].playerId });
  log(tr.ok, '侦探转让');

  // 10. 越权
  const auth = await api('/api/host', { roomId: host.roomId, playerId: players[3].playerId, action: 'announce', text: '黑客' });
  log(auth.err === '你不是主持人', `越权拦截: ${auth.err}`);

  // 11. 出局发言拦截
  const dead = await api('/api/msg', { roomId: host.roomId, playerId: players[2].playerId, text: '我还能说话吗', question: true });
  log(!!dead.err, `出局拦截: ${dead.err}`);

  // 12. 结束
  const end = await api('/api/host', { roomId: host.roomId, playerId: host.playerId, action: 'end', result: '无辜者阵营获胜！' });
  log(end.ok, '结束游戏');

  // 13. SSE快照验证（拿主持人视角）
  const snapRes = await fetch(`${BASE}/api/stream?room=${host.roomId}&player=${host.playerId}`);
  const reader = snapRes.body.getReader();
  const { value } = await reader.read();
  const txt = new TextDecoder().decode(value);
  log(txt.includes('snapshot'), 'SSE 快照推送');
  reader.cancel();

  console.log('\n=== 全部测试完成 ===');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('测试异常:', e); srv.kill(); process.exit(1); });
