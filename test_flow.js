/**
 * test_flow.js — end-to-end smoke-тест нового сценария «Досмотр машины».
 * Запускать при работающем сервере (npm start) на :3000.
 * Симулирует хост + гость, 3 раунда, прогоняет инструменты досмотра.
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const host = io(URL, { forceNew: true });
const guest = io(URL, { forceNew: true });

const log = (...a) => console.log('[test]', ...a);
const ep = (s, ev, p) => new Promise(r => s.emit(ev, p, a => r(a)));

let hostRoom = null;
let packCount = 0, inspectCount = 0, resultsCount = 0;
let xrayed = false, weighed = false, shook = false, interrogated = false, answered = false;
let hostStarted = false;

host.on('connect', async () => {
  log('host connected', host.id);
  const r = await ep(host, 'create_room', { name: 'Хост' });
  hostRoom = r.roomId; log('room', hostRoom);
  await new Promise(res => { if (guest.connected) res(); else guest.once('connect', res); });
  const g = await ep(guest, 'join_room', { roomId: hostRoom, name: 'Гость' });
  log('guest joined', g);
});
guest.on('connect', () => log('guest connected'));

function onLobby(s, st) {
  if (st.guestName && !hostStarted) { hostStarted = true; host.emit('start_game'); log('start_game'); }
}
host.on('lobby_state', st => onLobby('host', st));
guest.on('lobby_state', st => log('guest lobby', st.guestName));

function onPack(s, who, p) {
  log(`${who} phase_pack role=${p.role} round${p.round} contra=${p.contraband.id}`);
  packCount++;
  if (p.role === 'contrabandist') {
    // выбрать слот с ближайшим весом
    let best = 0, bd = 99;
    p.fillers.forEach((f, i) => { const d = Math.abs(f.weight - p.contraband.weight); if (d < bd) { bd = d; best = i; } });
    s.emit('pack_item', { slot: best, dx: 0, dy: 0, rot: 0.2 });
    log(`${who} pack slot=${best}`);
  }
}
host.on('phase_pack', p => onPack(host, 'host', p));
guest.on('phase_pack', p => onPack(guest, 'guest', p));
host.on('phase_pack_wait', () => log('host pack_wait'));
guest.on('phase_pack_wait', () => log('guest pack_wait'));

function onInspect(s, who, p) {
  log(`${who} phase_inspect role=${p.role} active=${p.active} round${p.round}`);
  inspectCount++;
  if (p.role === 'customs') {
    setTimeout(() => s.emit('inspect_xray'), 80);
    setTimeout(() => s.emit('inspect_weigh'), 200);
    setTimeout(() => s.emit('inspect_shake'), 320);
    setTimeout(() => s.emit('inspect_interrogate', { slot: 0 }), 440);
    // изымаем сразу слот 0 (может быть неверным — но поток проверяем)
    setTimeout(() => s.emit('inspect_seize', { slot: 0 }), 1300);
  }
}
host.on('phase_inspect', p => onInspect(host, 'host', p));
guest.on('phase_inspect', p => onInspect(guest, 'guest', p));
host.on('inspect_layout', p => log('host inspect_layout', p.layout.length));
guest.on('inspect_layout', p => log('guest inspect_layout', p.layout.length));
host.on('xray_result', p => { xrayed = true; log('host xray', p.usesLeft); });
guest.on('xray_result', p => { xrayed = true; log('guest xray', p.usesLeft); });
host.on('weigh_result', p => { weighed = true; log('host weigh', p); });
guest.on('weigh_result', p => { weighed = true; log('guest weigh', p); });
host.on('shake_result', p => { shook = true; log('host shake', p.usesLeft); });
guest.on('shake_result', p => { shook = true; log('guest shake', p.usesLeft); });
host.on('interrogate_pending', p => log('host interrogate_pending', p));
guest.on('interrogate_pending', p => log('guest interrogate_pending', p));
host.on('interrogate_request', p => { interrogated = true; log('host interrogate_request', p); host.emit('interrogate_answer', { textId: 'calm' }); });
guest.on('interrogate_request', p => { interrogated = true; log('guest interrogate_request', p); guest.emit('interrogate_answer', { textId: 'calm' }); });
host.on('interrogate_result', p => { answered = true; log('host interrogate_result', p); });
guest.on('interrogate_result', p => { answered = true; log('guest interrogate_result', p); });
host.on('inspect_action', p => log('host inspect_action', p));
guest.on('inspect_action', p => log('guest inspect_action', p));

function onResult(who, r) {
  resultsCount++;
  log(`${who} round_result round${r.round} reason=${r.reason} seized=${r.contrabandSeized} contraPos=${r.contrabandPos} scores`, r.scores);
}
host.on('round_result', r => onResult('host', r));
guest.on('round_result', r => onResult('guest', r));

host.on('game_over', d => {
  log('host game_over winner', d.winner, 'scores', d.scores);
  log('=== ИТОГ === pack:', packCount, 'inspect:', inspectCount, 'results:', resultsCount,
    'xray:', xrayed, 'weigh:', weighed, 'shake:', shook, 'interrog:', interrogated, 'answered:', answered);
  const ok = packCount === 3 && inspectCount === 6 && resultsCount === 6 && xrayed && weighed && shook && interrogated && answered;
  log(ok ? 'PASS ✅' : 'FAIL ❌');
  process.exit(ok ? 0 : 1);
});
guest.on('game_over', d => log('guest game_over', d.winner));

host.on('error_msg', d => log('host err', d));
guest.on('error_msg', d => log('guest err', d));
host.on('opponent_left', d => log('host opponent_left', d.message));
guest.on('opponent_left', d => log('guest opponent_left', d.message));

setTimeout(() => { log('TIMEOUT — игра не завершилась за 60с'); process.exit(2); }, 60000);