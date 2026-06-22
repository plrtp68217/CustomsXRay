/**
 * server.js — Express + Socket.IO сервер «Таможня: Досмотр машины».
 *
 * Сценарий: подъезжает машина с грузом (6 слотов, 2 ряда × 3 колонки).
 *  - Фаза укладки: контрабандист заменяет один слот на контрабанду.
 *  - Фаза досмотра: таможенник пользуется инструментами
 *    (рентген / покачать / взвесить / допрос) и решает: изъять слот или пропустить.
 *  - Машина напрямую не вскрывается. 3 раунда, роли меняются.
 *
 * Сервер авторитарен: хранит реальное содержимое слотов, считает вес,
 * генерирует «стресс-tell» при допросе, валидирует действия.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Cargo = require('./public/js/items.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Customs X-Ray server: http://localhost:${PORT}`));

// ───────────────────────── Константы ─────────────────────────
const TOTAL_ROUNDS = process.env.TOTAL_ROUNDS ? +process.env.TOTAL_ROUNDS : 3;
const PACK_TIME_MS = process.env.PACK_TIME_MS ? +process.env.PACK_TIME_MS : 30000;
const INSPECT_TIME_MS = process.env.INSPECT_TIME_MS ? +process.env.INSPECT_TIME_MS : 45000;
const ROUND_RESULT_TIME_MS = process.env.ROUND_RESULT_TIME_MS ? +process.env.ROUND_RESULT_TIME_MS : 6000;
const XRAY_USES = 3;        // лимит рентгенов
const SHAKE_USES = 3;       // лимит покачиваний
const INTERROGATIONS = 3;   // лимит допросов
const STRESS_HIT_PROB = 0.7;  // вероятность стресс-tell на слоте с контрабандой
const STRESS_FALSE_PROB = 0.15; // вероятность ложного стресс-tell на чистом слоте

// ───────────────────────── Хранилище комнат ─────────────────────────
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [r[i],r[j]]=[r[j],r[i]]; } return r; }

// ───────────────────── Создание раунда ─────────────────────
function buildRound(roundIndex, hostId, guestId) {
  const contraband = pick(Cargo.CONTRABAND);
  // 6 легальных товаров (с повторами) — заполняют все слоты изначально.
  const fillers = Cargo.CAR_SLOTS.map(() => pick(Cargo.LEGAL_GOODS));
  const declaredWeight = fillers.reduce((s, g) => s + g.weight, 0);

  // manifest (декларация) = исходные fillers (контрабандист «по бумагам» везёт это).
  const manifest = Cargo.CAR_SLOTS.map((s, i) => ({ slot: s.slot, goodId: fillers[i].id, name: fillers[i].name }));

  // реальная раскладка (пока без контрабанды — контрабандист задаст слот в укладке)
  const layout = Cargo.CAR_SLOTS.map((s, i) => ({
    slot: s.slot, posIndex: i, itemId: fillers[i].id, isContraband: false,
    row: s.row, col: s.col, x: s.x, y: s.y, rot: 0, dx: 0, dy: 0
  }));

  const hostIsContrabandist = (roundIndex % 2 === 0);
  return {
    contraband,
    fillers,
    manifest,
    declaredWeight,
    layout,
    contrabandSlot: null,
    placement: null,
    actualWeight: declaredWeight,
    xrayUsesLeft: XRAY_USES,
    shakeUsesLeft: SHAKE_USES,
    interrogationsLeft: INTERROGATIONS,
    pendingInterrogation: null,
    contrabandistId: hostIsContrabandist ? hostId : guestId,
    customsId: hostIsContrabandist ? guestId : hostId,
    hostIsContrabandist,
    packTimer: null,
    inspectTimer: null,
    resultTimer: null
  };
}

// ───────────────────── Хелперы рассылки ─────────────────────
function emitRoom(room, event, payload, exceptId) {
  for (const sid of [room.hostId, room.guestId]) {
    if (sid && sid !== exceptId) io.to(sid).emit(event, payload);
  }
}
function bothPresent(room) { return room.hostId && room.guestId; }
function publicRoomState(room) {
  return {
    roomId: room.id,
    hostName: room.hostName,
    guestName: room.guestName,
    hostConnected: !!room.hostId,
    guestConnected: !!room.guestId
  };
}

// ───────────────────── Машина состояний ─────────────────────
function startGame(room) {
  if (!bothPresent(room)) return;
  room.scores = { [room.hostId]: 0, [room.guestId]: 0 };
  room.roundIndex = 0;
  room.history = [];
  beginRound(room);
}

function beginRound(room) {
  clearRoundTimers(room);
  const r = buildRound(room.roundIndex, room.hostId, room.guestId);
  room.current = r;
  room.phase = 'pack';

  const endTime = Date.now() + PACK_TIME_MS;
  room.packEndTime = endTime;

  // Контрабандисту — слоты с легальным товаром + контрабанду (для замены слота).
  io.to(r.contrabandistId).emit('phase_pack', {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    role: 'contrabandist',
    slots: Cargo.CAR_SLOTS,
    fillers: r.fillers.map((g, i) => ({ slot: i, goodId: g.id, name: g.name, shape: g.shape, weight: g.weight })),
    contraband: { id: r.contraband.id, name: r.contraband.name, shape: r.contraband.shape, weight: r.contraband.weight },
    endTimeMs: endTime
  });
  // Таможенник ждёт.
  io.to(r.customsId).emit('phase_pack_wait', {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    role: 'customs',
    endTimeMs: endTime
  });

  r.packTimer = setTimeout(() => endPackPhase(room), PACK_TIME_MS + 250);
}

function endPackPhase(room) {
  const r = room.current;
  if (!r || room.phase !== 'pack') return;
  if (r.packTimer) { clearTimeout(r.packTimer); r.packTimer = null; }

  // Если контрабандист не прислал укладку — кладём контрабанду в случайный слот.
  if (r.contrabandSlot === null) {
    r.contrabandSlot = randInt(0, 5);
    r.placement = { dx: 0, dy: 0, rot: 0 };
  }
  // Применяем замену слота на контрабанду в layout и пересчёт веса.
  const replaced = r.fillers[r.contrabandSlot];
  const slotDef = Cargo.CAR_SLOTS[r.contrabandSlot];
  r.layout[r.contrabandSlot] = {
    slot: slotDef.slot, posIndex: r.contrabandSlot, itemId: r.contraband.id, isContraband: true,
    row: slotDef.row, col: slotDef.col, x: slotDef.x, y: slotDef.y,
    rot: r.placement.rot, dx: r.placement.dx, dy: r.placement.dy
  };
  r.actualWeight = r.declaredWeight - replaced.weight + r.contraband.weight;

  room.phase = 'inspect';
  const endTime = Date.now() + INSPECT_TIME_MS;
  room.inspectEndTime = endTime;

  const base = {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    endTimeMs: endTime,
    manifest: r.manifest,            // декларация (6 товаров по слотам)
    carBody: Cargo.CAR_BODY,
    slots: Cargo.CAR_SLOTS,
    xrayUsesLeft: r.xrayUsesLeft,
    shakeUsesLeft: r.shakeUsesLeft,
    interrogationsLeft: r.interrogationsLeft
  };
  io.to(r.customsId).emit('phase_inspect', { ...base, role: 'customs', active: true });
  io.to(r.contrabandistId).emit('phase_inspect', { ...base, role: 'contrabandist', active: false });

  // Контрабандисту — его раскладка (он видит, где контрабанда, и отвечает на допросы).
  io.to(r.contrabandistId).emit('inspect_layout', { layout: privateLayout(r, true) });

  r.inspectTimer = setTimeout(() => endInspectPhase(room, { reason: 'timeout' }), INSPECT_TIME_MS + 250);
}

/** layout для клиента: с фигурами. contrabandist видит isContraband; customs — нет (только фигуры). */
function privateLayout(r, revealContraband) {
  return r.layout.map(entry => {
    const def = entry.isContraband ? Cargo.contrabandById(entry.itemId) : Cargo.goodById(entry.itemId);
    return {
      slot: entry.slot, posIndex: entry.posIndex,
      itemId: entry.itemId,
      shape: def ? def.shape : null,
      row: entry.row, col: entry.col, x: entry.x, y: entry.y,
      rot: entry.rot || 0, dx: entry.dx || 0, dy: entry.dy || 0,
      isContraband: revealContraband ? entry.isContraband : false
    };
  });
}

// ───────────────────── Действия досмотра ─────────────────────
function handleXray(room, socket) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  if (r.xrayUsesLeft <= 0) { socket.emit('error_msg', { message: 'Рентген больше недоступен' }); return; }
  r.xrayUsesLeft -= 1;
  // Таможенник видит силуэты содержимого (без флага isContraband), задний ряд будет перекрыт клиентом.
  socket.emit('xray_result', {
    layout: privateLayout(r, false),
    usesLeft: r.xrayUsesLeft
  });
}

function handleShake(room, socket) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  if (r.shakeUsesLeft <= 0) { socket.emit('error_msg', { message: 'Больше нельзя качать' }); return; }
  r.shakeUsesLeft -= 1;
  // Перетасовать позиции (posIndex/row/col/x/y) среди 6 слотов — груз «пересыпался».
  const positions = shuffle(Cargo.CAR_SLOTS);
  r.layout = r.layout.map((entry, i) => {
    const p = positions[i];
    return { ...entry, posIndex: p.slot, row: p.row, col: p.col, x: p.x, y: p.y };
  });
  const payload = { layout: privateLayout(r, false), usesLeft: r.shakeUsesLeft };
  io.to(r.customsId).emit('shake_result', payload);
  io.to(r.contrabandistId).emit('shake_result', { layout: privateLayout(r, true), usesLeft: r.shakeUsesLeft });
}

function handleWeigh(room, socket) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  socket.emit('weigh_result', {
    actual: r.actualWeight,
    declared: r.declaredWeight,
    diff: r.actualWeight - r.declaredWeight
  });
}

function handleInterrogate(room, socket, payload) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  if (r.interrogationsLeft <= 0) { socket.emit('error_msg', { message: 'Допросы исчерпаны' }); return; }
  const slot = payload && typeof payload.slot === 'number' ? Math.floor(payload.slot) : -1;
  if (slot < 0 || slot > 5) return;
  if (r.pendingInterrogation) { socket.emit('error_msg', { message: 'Уже ждём ответа' }); return; }
  r.interrogationsLeft -= 1;
  r.pendingInterrogation = { slot, customsUsesLeft: r.interrogationsLeft };
  // Контрабандисту — запрос: какой слот допрашивают.
  io.to(r.contrabandistId).emit('interrogate_request', {
    slot,
    manifestName: r.manifest[slot].name, // по бумагам там это
    interrogationsLeft: r.interrogationsLeft
  });
  // Таможенник видит, что идёт допрос.
  socket.emit('interrogate_pending', { slot, interrogationsLeft: r.interrogationsLeft });
}

function handleInterrogateAnswer(room, socket, payload) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || !r.pendingInterrogation) return;
  if (socket.id !== r.contrabandistId) return;
  const slot = r.pendingInterrogation.slot;
  const textId = (payload && typeof payload.textId === 'string') ? payload.textId : 'manifest';
  const texts = {
    manifest: `Здесь ${r.manifest[slot].name}.`,
    nothing:  'Ничего особенного.',
    dontknow: 'Я не знаю, это не моё.',
    calm:     'Всё по документам, проверяйте.'
  };
  const text = texts[textId] || texts.manifest;
  // Стресс-tell: на слоте с контрабандой — высокий с большой вероятностью.
  const isContrabandSlot = (slot === r.contrabandSlot);
  const prob = isContrabandSlot ? STRESS_HIT_PROB : STRESS_FALSE_PROB;
  const stress = Math.random() < prob ? 'high' : 'low';
  r.pendingInterrogation = null;
  io.to(r.customsId).emit('interrogate_result', { slot, text, stress });
}

function handleSeize(room, socket, payload) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  const slot = payload && typeof payload.slot === 'number' ? Math.floor(payload.slot) : -1;
  if (slot < 0 || slot > 5) return;
  // Изъятие по текущей позиции: контрабанда найдена, если её entry сейчас на позиции `slot`.
  const contraEntry = r.layout.find(e => e.isContraband);
  const hit = !!(contraEntry && contraEntry.posIndex === slot);
  emitRoom(room, 'inspect_action', { action: 'seize', slot, hit, by: socket.id });
  endInspectPhase(room, { reason: 'seize', slot, hit });
}

function handlePass(room, socket) {
  const r = room.current;
  if (!r || room.phase !== 'inspect' || socket.id !== r.customsId) return;
  emitRoom(room, 'inspect_action', { action: 'pass', by: socket.id });
  endInspectPhase(room, { reason: 'pass' });
}

function endInspectPhase(room, info) {
  const r = room.current;
  if (!r || room.phase !== 'inspect') return;
  if (r.inspectTimer) { clearTimeout(r.inspectTimer); r.inspectTimer = null; }
  room.phase = 'round_result';

  let customsDelta = 0, contrabandistDelta = 0;
  let contrabandSeized = false;
  if (info.reason === 'seize' && info.hit) {
    customsDelta += 1; contrabandSeized = true;
  } else if (info.reason === 'seize' && !info.hit) {
    customsDelta -= 1; contrabandistDelta += 1; // ложное изъятие → контрабанда прошла
  } else { // pass / timeout → контрабанда прошла
    contrabandistDelta += 1;
  }

  room.scores[r.contrabandistId] += contrabandistDelta;
  room.scores[r.customsId] += customsDelta;

  const result = {
    round: room.roundIndex + 1,
    contrabandistId: r.contrabandistId,
    customsId: r.customsId,
    contrabandistDelta, customsDelta,
    contrabandSeized,
    reason: info.reason,
    seizedSlot: info.slot != null ? info.slot : null,
    contrabandSlot: r.contrabandSlot,
    contrabandPos: (r.layout.find(e => e.isContraband) || {}).posIndex,
    contraband: { id: r.contraband.id, name: r.contraband.name },
    actualWeight: r.actualWeight,
    declaredWeight: r.declaredWeight,
    layout: r.layout.map(e => ({ slot: e.slot, itemId: e.itemId, isContraband: e.isContraband, row: e.row, col: e.col })),
    scores: { [room.hostId]: room.scores[room.hostId], [room.guestId]: room.scores[room.guestId] }
  };
  room.history.push(result);
  emitRoom(room, 'round_result', result);

  r.resultTimer = setTimeout(() => {
    if (room.roundIndex + 1 >= TOTAL_ROUNDS) finishGame(room);
    else { room.roundIndex += 1; beginRound(room); }
  }, ROUND_RESULT_TIME_MS);
}

function finishGame(room) {
  clearRoundTimers(room);
  room.phase = 'game_over';
  const hostScore = room.scores[room.hostId], guestScore = room.scores[room.guestId];
  let winner;
  if (hostScore > guestScore) winner = room.hostId;
  else if (guestScore > hostScore) winner = room.guestId;
  else winner = 'draw';
  emitRoom(room, 'game_over', {
    scores: { [room.hostId]: hostScore, [room.guestId]: guestScore },
    winner, history: room.history
  });
  room.phase = 'finished';
}

function clearRoundTimers(room) {
  const r = room.current;
  if (r) {
    if (r.packTimer) clearTimeout(r.packTimer);
    if (r.inspectTimer) clearTimeout(r.inspectTimer);
    if (r.resultTimer) clearTimeout(r.resultTimer);
    r.packTimer = r.inspectTimer = r.resultTimer = null;
  }
}

function handleDisconnectWin(room, leavingId) {
  clearRoundTimers(room);
  const winnerId = room.hostId === leavingId ? room.guestId : room.hostId;
  if (winnerId) io.to(winnerId).emit('opponent_left', { message: 'Противник покинул игру, победа присуждена вам!' });
  rooms.delete(room.id);
}

// ───────────────────── Валидация ─────────────────────
function isValidPlacement(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.dx !== 'number' || typeof p.dy !== 'number' || typeof p.rot !== 'number') return false;
  if (!isFinite(p.dx) || !isFinite(p.dy) || !isFinite(p.rot)) return false;
  if (Math.abs(p.dx) > 200 || Math.abs(p.dy) > 200) return false;
  if (Math.abs(p.rot) > Math.PI * 4) return false;
  return true;
}

// ───────────────────── Socket.IO ─────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  let currentRoomId = null;
  let isHost = false;

  socket.on('create_room', (payload, ack) => {
    const name = (payload && typeof payload.name === 'string') ? payload.name.slice(0, 24) : 'Хост';
    const id = generateRoomId();
    rooms.set(id, {
      id, hostId: socket.id, hostName: name,
      guestId: null, guestName: null,
      phase: 'lobby', scores: {}, roundIndex: 0, history: [], current: null
    });
    currentRoomId = id; isHost = true;
    socket.join(id);
    if (typeof ack === 'function') ack({ ok: true, roomId: id });
    socket.emit('lobby_state', publicRoomState(rooms.get(id)));
    console.log(`[room] ${id} created by ${socket.id}`);
  });

  socket.on('join_room', (payload, ack) => {
    const roomId = payload && typeof payload.roomId === 'string' ? payload.roomId.toUpperCase() : '';
    const name = payload && typeof payload.name === 'string' ? payload.name.slice(0, 24) : 'Гость';
    const room = rooms.get(roomId);
    if (!room) { if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' }); return; }
    if (room.guestId) { if (typeof ack === 'function') ack({ ok: false, error: 'Комната уже заполнена' }); return; }
    room.guestId = socket.id; room.guestName = name;
    currentRoomId = roomId; isHost = false;
    socket.join(roomId);
    if (typeof ack === 'function') ack({ ok: true, roomId });
    emitRoom(room, 'lobby_state', publicRoomState(room));
    console.log(`[room] ${socket.id} joined ${roomId}`);
  });

  socket.on('start_game', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;
    if (!bothPresent(room)) { socket.emit('error_msg', { message: 'Нет второго игрока' }); return; }
    if (room.phase !== 'lobby' && room.phase !== 'finished') return;
    startGame(room);
  });

  // ── Укладка ──
  socket.on('pack_item', (payload) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'pack' || !room.current) return;
    if (socket.id !== room.current.contrabandistId) return;
    const slot = payload && typeof payload.slot === 'number' ? Math.floor(payload.slot) : -1;
    if (slot < 0 || slot > 5) { socket.emit('error_msg', { message: 'Неверный слот' }); return; }
    if (!isValidPlacement(payload)) { socket.emit('error_msg', { message: 'Некорректная укладка' }); return; }
    room.current.contrabandSlot = slot;
    room.current.placement = { dx: payload.dx, dy: payload.dy, rot: payload.rot };
    endPackPhase(room);
  });

  // ── Досмотр ──
  socket.on('inspect_xray', () => handleXray(rooms.get(currentRoomId), socket));
  socket.on('inspect_shake', () => handleShake(rooms.get(currentRoomId), socket));
  socket.on('inspect_weigh', () => handleWeigh(rooms.get(currentRoomId), socket));
  socket.on('inspect_interrogate', (p) => handleInterrogate(rooms.get(currentRoomId), socket, p));
  socket.on('interrogate_answer', (p) => handleInterrogateAnswer(rooms.get(currentRoomId), socket, p));
  socket.on('inspect_seize', (p) => handleSeize(rooms.get(currentRoomId), socket, p));
  socket.on('inspect_pass', () => handlePass(rooms.get(currentRoomId), socket));

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.phase === 'lobby' || room.phase === 'finished' || !bothPresent(room)) {
      if (isHost) {
        if (room.guestId) io.to(room.guestId).emit('opponent_left', { message: 'Хост покинул лобби' });
        rooms.delete(currentRoomId);
      } else {
        room.guestId = null; room.guestName = null;
        emitRoom(room, 'lobby_state', publicRoomState(room));
      }
      return;
    }
    handleDisconnectWin(room, socket.id);
  });
});