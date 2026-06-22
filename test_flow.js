/**
 * test_flow.js — end-to-end smoke-тест полного игрового цикла.
 * Запускать при уже работающем сервере (npm start) на :3000.
 * Симулирует хост + гость, 3 раунда, проверяет корректность событий и очков.
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const host = io(URL, { forceNew: true });
const guest = io(URL, { forceNew: true });

let hostRoom = null;
const log = (...a) => console.log('[test]', ...a);

let hostGot = {}, guestGot = {};
let hideCount = 0, scanCount = 0, resultsCount = 0;

function emitP(sock, ev, payload) {
  return new Promise((res) => sock.emit(ev, payload, (ack) => res(ack)));
}

host.on('connect', async () => {
  log('host connected', host.id);
  const r = await emitP(host, 'create_room', { name: 'Хост' });
  hostRoom = r.roomId;
  log('host created room', hostRoom);
  // guest joins
  const g = await emitP(guest, 'join_room', { roomId: hostRoom, name: 'Гость' });
  log('guest join ack', g);
});

guest.on('lobby_state', (st) => {
  log('lobby_state guest', st.guestName);
});
host.on('lobby_state', (st) => {
  log('lobby_state host', st.guestName);
  if (st.guestName && !hostGot.started) {
    hostGot.started = true;
    host.emit('start_game');
    log('host -> start_game');
  }
});

// фаза укладки: кто контрабандист — шлёт плейсмент
function handleHide(sock, who, payload) {
  log(`${who} phase_hide (role=${payload.role}) round ${payload.round}`);
  hideCount++;
  if (payload.role === 'contrabandist') {
    // отправим идеальный плейсмент (совпадение 100%)
    const cav = payload.cavity;
    sock.emit('hide_item', { dx: cav.dx, dy: cav.dy, rot: cav.rot });
    log(`${who} -> hide_item (perfect placement)`);
  }
}
host.on('phase_hide', (p) => handleHide(host, 'host', p));
guest.on('phase_hide', (p) => handleHide(guest, 'guest', p));
host.on('phase_hide_wait', () => log('host hide_wait'));
guest.on('phase_hide_wait', () => log('guest hide_wait'));

function handleScan(sock, who, payload) {
  log(`${who} phase_scan (role=${payload.role}) round ${payload.round} active=${payload.active}`);
  scanCount++;
}
host.on('phase_scan', handleScan.bind(null, host, 'host'));
guest.on('phase_scan', handleScan.bind(null, guest, 'guest'));

// Запоминаем, кто таможенник в текущем раунде и найден ли уже hit
let customsSock = null, scanHit = false, scanTryIdx = 0;

function driveCustoms(sock, s) {
  customsSock = sock;
  scanHit = false;
  scanTryIdx = 0;
  log('customs will try to seize (round ' + (s.round) + ')');
  // Перебираем предметы по одному с интервалом, пока не попадём в контрабанду.
  const tryNext = () => {
    if (scanHit || !customsSock) return;
    const n = (lastScanItemsCount) || 5;
    if (scanTryIdx >= n) return; // не нашли за весь проход — ждём таймаут фазы
    log(`customs -> scan_item index=${scanTryIdx}`);
    customsSock.emit('scan_item', { index: scanTryIdx });
    scanTryIdx++;
    setTimeout(tryNext, 400);
  };
  setTimeout(tryNext, 200);
}
let lastScanItemsCount = 5;
host.on('phase_scan', (p) => { lastScanItemsCount = p.scanItems.length; if (p.active) driveCustoms(host, p); });
guest.on('phase_scan', (p) => { lastScanItemsCount = p.scanItems.length; if (p.active) driveCustoms(guest, p); });

host.on('scan_scene', (s) => log('host scan_scene match=', s.match.toFixed(2), 'contraband=', s.contrabandItemId));
guest.on('scan_scene', (s) => log('guest scan_scene match=', s.match.toFixed(2)));

function onFeedback(who, d) {
  log(`${who} scan_feedback`, d);
  if (d.result === 'hit') { scanHit = true; customsSock = null; }
}
host.on('scan_feedback', (d) => onFeedback('host', d));
guest.on('scan_feedback', (d) => onFeedback('guest', d));

function handleResult(who, r) {
  resultsCount++;
  log(`${who} round_result round ${r.round} contraΔ=${r.contrabandistDelta} customsΔ=${r.customsDelta} seized=${r.contrabandSeized} match=${r.match.toFixed(2)} scores=`, r.scores);
}
host.on('round_result', (r) => handleResult('host', r));
guest.on('round_result', (r) => handleResult('guest', r));

function handleGameOver(who, d) {
  log(`${who} game_over winner=${d.winner} scores=`, d.scores);
  if (who === 'host') {
    setTimeout(() => {
      log('=== ИТОГ ТЕСТА ===');
      log('hide phases:', hideCount, '(ожид. 3)');
      log('scan phases:', scanCount, '(ожид. 6, по 2 на раунд)');
      log('round results:', resultsCount, '(ожид. 6, по 2 на раунд)');
      const ok = hideCount === 3 && scanCount === 6 && resultsCount === 6;
      log(ok ? 'PASS ✅' : 'FAIL ❌');
      process.exit(ok ? 0 : 1);
    }, 500);
  }
}
host.on('game_over', (d) => handleGameOver('host', d));
guest.on('game_over', (d) => handleGameOver('guest', d));

host.on('opponent_left', (d) => log('host opponent_left', d.message));
guest.on('opponent_left', (d) => log('guest opponent_left', d.message));
host.on('error_msg', (d) => log('host error', d));
guest.on('error_msg', (d) => log('guest error', d));

// страховка по таймауту (3 раунда: ~3*(hide+scan+result); таймеры короткие в тесте не ускоряем)
setTimeout(() => { log('TIMEOUT — игра не завершилась за 120с'); process.exit(2); }, 120000);