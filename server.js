/**
 * server.js — Express + Socket.IO сервер игры «Таможня: Рентген-Контроль».
 *
 * Ответственности:
 *  - Раздача статики (public/).
 *  - Управление комнатами и подключениями.
 *  - Машина состояний игры (лобби → укладка → рентген → результат → ... → финал).
 *  - Авторитарные таймеры фаз (30с).
 *  - Валидация всех данных клиента (защита от читерства).
 *  - Серверный расчёт % совпадения силуэтов (клиент не может врать).
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Geometry = require('./public/js/geometry.js');
const ITEMS = require('./public/js/items.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Customs X-Ray server: http://localhost:${PORT}`));

// ───────────────────────── Константы игры ─────────────────────────
const TOTAL_ROUNDS = process.env.TOTAL_ROUNDS ? +process.env.TOTAL_ROUNDS : 3;
const HIDE_TIME_MS = process.env.HIDE_TIME_MS ? +process.env.HIDE_TIME_MS : 30000;
const SCAN_TIME_MS = process.env.SCAN_TIME_MS ? +process.env.SCAN_TIME_MS : 30000;
const ROUND_RESULT_TIME_MS = process.env.ROUND_RESULT_TIME_MS ? +process.env.ROUND_RESULT_TIME_MS : 5000;
const MATCH_IDEAL = 0.85; // порог «идеально спрятано»
const SCAN_ITEMS_MIN = 3, SCAN_ITEMS_MAX = 5;

// ───────────────────────── Хранилище комнат ─────────────────────────
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * Генерация кода комнаты (6 символов).
 */
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Создать состояние раунда: выбрать предмет, случайную полость, собрать набор для сканирования.
 */
function buildRound(roundIndex, hostId, guestId) {
  const item = pick(ITEMS);
  // Случайная полость внутри легального предмета (с разумными смещениями/поворотом)
  const legalBB = Geometry.polygonBBox(item.legal);
  const maxDX = Math.max(10, legalBB.w / 2 - 40);
  const maxDY = Math.max(10, legalBB.h / 2 - 40);
  const cavity = {
    dx: randInt(-maxDX, maxDX),
    dy: randInt(-maxDY, maxDY),
    rot: +(Math.random() * Math.PI * 0.8 - Math.PI * 0.4).toFixed(3)
  };

  // Роли: в нечётных раундах хост — контрабандист, в чётных — гость.
  const hostIsContrabandist = (roundIndex % 2 === 0);
  const contrabandistId = hostIsContrabandist ? hostId : guestId;
  const customsId = hostIsContrabandist ? guestId : hostId;

  // Набор предметов для сканирования (3–5), один — модифицированный.
  const count = randInt(SCAN_ITEMS_MIN, SCAN_ITEMS_MAX);
  const fillers = [];
  const pool = ITEMS.filter(it => it.id !== item.id);
  for (let i = 0; i < count - 1; i++) fillers.push(pick(pool));
  const contrabandSlot = randInt(0, count - 1);
  const scanItems = fillers.map(it => ({ id: it.id, kind: 'clean' }));
  scanItems.splice(contrabandSlot, 0, { id: item.id, kind: 'contraband' });

  return {
    item,
    cavity,
    contrabandistId,
    customsId,
    hostIsContrabandist,
    scanItems,
    contrabandSlot,
    // placement присылает клиент в фазе укладки
    placement: null,
    match: 0,
    wrongSeizures: 0,
    contrabandSeized: false,
    hideTimer: null,
    scanTimer: null,
    resultTimer: null
  };
}

// ───────────────────────── Хелперы рассылки ─────────────────────────
function emitRoom(room, event, payload, exceptId) {
  for (const sid of [room.hostId, room.guestId]) {
    if (sid && sid !== exceptId) io.to(sid).emit(event, payload);
  }
}

function bothPresent(room) {
  return room.hostId && room.guestId;
}

function publicRoomState(room) {
  return {
    roomId: room.id,
    hostName: room.hostName,
    guestName: room.guestName,
    hostConnected: !!room.hostId,
    guestConnected: !!room.guestId
  };
}

// ───────────────────────── Машина состояний ─────────────────────────

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
  room.phase = 'hide';

  // Контрабандисту — данные для укладки (предмет, полость, время).
  // Таможеннику — экран ожидания (без полости/плейсмента).
  const endTime = Date.now() + HIDE_TIME_MS;
  room.hideEndTime = endTime;

  io.to(r.contrabandistId).emit('phase_hide', {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    role: 'contrabandist',
    item: r.item,
    cavity: r.cavity,
    endTimeMs: endTime
  });
  io.to(r.customsId).emit('phase_hide_wait', {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    role: 'customs',
    endTimeMs: endTime
  });

  // Авторитарный таймер фазы укладки.
  r.hideTimer = setTimeout(() => endHidePhase(room), HIDE_TIME_MS + 250);
}

function endHidePhase(room) {
  const r = room.current;
  if (!r || room.phase !== 'hide') return;
  if (r.hideTimer) { clearTimeout(r.hideTimer); r.hideTimer = null; }

  // Если контрабандист ничего не прислал — placement остаётся null (match = 0).
  if (r.placement) {
    // Серверный пересчёт % совпадения (валидация).
    const contra = r.item.contraband;
    const bb = Geometry.polygonBBox(contra);
    const cx = bb.minX + bb.w / 2, cy = bb.minY + bb.h / 2;
    const placed = Geometry.transformPolygon(
      contra, r.placement.dx, r.placement.dy, r.placement.rot, cx, cy
    );
    const cavityPoly = Geometry.transformPolygon(
      contra, r.cavity.dx, r.cavity.dy, r.cavity.rot, cx, cy
    );
    r.match = Geometry.computeMatch(placed, cavityPoly);
  } else {
    r.match = 0;
  }

  room.phase = 'scan';
  const endTime = Date.now() + SCAN_TIME_MS;
  room.scanEndTime = endTime;

  // Обоим — фаза сканирования. Контрабандист наблюдает.
  const scanPayload = {
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    scanItems: r.scanItems,
    endTimeMs: endTime,
    // каждому — его роль
  };
  io.to(r.customsId).emit('phase_scan', { ...scanPayload, role: 'customs', active: true });
  io.to(r.contrabandistId).emit('phase_scan', { ...scanPayload, role: 'contrabandist', active: false });

  // Контрабандисту также нужен плейсмент, чтобы видеть/понимать (но он не действует).
  // Таможенник получает плейсмент для рендера контрабанды на рентгене.
  io.to(r.customsId).emit('scan_scene', {
    contrabandItemId: r.item.id,
    placement: r.placement,
    cavity: r.cavity,
    match: r.match
  });
  io.to(r.contrabandistId).emit('scan_scene', {
    contrabandItemId: r.item.id,
    placement: r.placement,
    cavity: r.cavity,
    match: r.match
  });

  r.scanTimer = setTimeout(() => endScanPhase(room), SCAN_TIME_MS + 250);
}

function endScanPhase(room) {
  const r = room.current;
  if (!r || room.phase !== 'scan') return;
  if (r.scanTimer) { clearTimeout(r.scanTimer); r.scanTimer = null; }
  room.phase = 'round_result';

  // Подсчёт очков раунда.
  let contrabandistDelta = 0, customsDelta = 0;
  if (r.contrabandSeized) {
    customsDelta += 1; // таможенник нашёл контрабанду
  } else {
    contrabandistDelta += 1; // контрабандист пронёс
  }
  customsDelta -= r.wrongSeizures; // штрафы за ложные изъятия

  room.scores[r.contrabandistId] += contrabandistDelta;
  room.scores[r.customsId] += customsDelta;

  const result = {
    round: room.roundIndex + 1,
    contrabandistId: r.contrabandistId,
    customsId: r.customsId,
    contrabandistDelta,
    customsDelta,
    contrabandSeized: r.contrabandSeized,
    wrongSeizures: r.wrongSeizures,
    match: r.match,
    item: r.item,
    cavity: r.cavity,
    placement: r.placement,
    contrabandSlot: r.contrabandSlot,
    scores: {
      [room.hostId]: room.scores[room.hostId],
      [room.guestId]: room.scores[room.guestId]
    }
  };
  room.history.push(result);
  emitRoom(room, 'round_result', result);

  r.resultTimer = setTimeout(() => {
    if (room.roundIndex + 1 >= TOTAL_ROUNDS) {
      finishGame(room);
    } else {
      room.roundIndex += 1;
      beginRound(room);
    }
  }, ROUND_RESULT_TIME_MS);
}

function finishGame(room) {
  clearRoundTimers(room);
  room.phase = 'game_over';
  const hostScore = room.scores[room.hostId];
  const guestScore = room.scores[room.guestId];
  let winner;
  if (hostScore > guestScore) winner = room.hostId;
  else if (guestScore > hostScore) winner = room.guestId;
  else winner = 'draw';
  emitRoom(room, 'game_over', {
    scores: { [room.hostId]: hostScore, [room.guestId]: guestScore },
    winner,
    history: room.history
  });
  room.phase = 'finished';
}

function clearRoundTimers(room) {
  const r = room.current;
  if (r) {
    if (r.hideTimer) clearTimeout(r.hideTimer);
    if (r.scanTimer) clearTimeout(r.scanTimer);
    if (r.resultTimer) clearTimeout(r.resultTimer);
    r.hideTimer = r.scanTimer = r.resultTimer = null;
  }
}

/**
 * Присудить победу оставшемуся игроку при отключении соперника.
 */
function handleDisconnectWin(room, leavingId) {
  clearRoundTimers(room);
  const winnerId = room.hostId === leavingId ? room.guestId : room.hostId;
  if (winnerId) {
    io.to(winnerId).emit('opponent_left', {
      message: 'Противник покинул игру, победа присуждена вам!'
    });
  }
  rooms.delete(room.id);
}

// ───────────────────────── Валидация ─────────────────────────
function isValidPlacement(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.dx !== 'number' || typeof p.dy !== 'number' || typeof p.rot !== 'number') return false;
  if (!isFinite(p.dx) || !isFinite(p.dy) || !isFinite(p.rot)) return false;
  // Разумные пределы (не улетать за пределы сцены).
  if (Math.abs(p.dx) > 500 || Math.abs(p.dy) > 500) return false;
  if (Math.abs(p.rot) > Math.PI * 4) return false;
  return true;
}

// ───────────────────────── Socket.IO ─────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  let currentRoomId = null;
  let isHost = false;

  // Создание комнаты
  socket.on('create_room', (payload, ack) => {
    const name = (payload && typeof payload.name === 'string')
      ? payload.name.slice(0, 24) : 'Хост';
    const id = generateRoomId();
    const room = {
      id,
      hostId: socket.id,
      hostName: name,
      guestId: null,
      guestName: null,
      phase: 'lobby',
      scores: {},
      roundIndex: 0,
      history: [],
      current: null
    };
    rooms.set(id, room);
    currentRoomId = id;
    isHost = true;
    socket.join(id);
    if (typeof ack === 'function') ack({ ok: true, roomId: id });
    socket.emit('lobby_state', publicRoomState(room));
    console.log(`[room] ${id} created by ${socket.id}`);
  });

  // Подключение по коду
  socket.on('join_room', (payload, ack) => {
    const roomId = payload && typeof payload.roomId === 'string' ? payload.roomId.toUpperCase() : '';
    const name = payload && typeof payload.name === 'string' ? payload.name.slice(0, 24) : 'Гость';
    const room = rooms.get(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
      return;
    }
    if (room.guestId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Комната уже заполнена' });
      return;
    }
    room.guestId = socket.id;
    room.guestName = name;
    currentRoomId = roomId;
    isHost = false;
    socket.join(roomId);
    if (typeof ack === 'function') ack({ ok: true, roomId });
    // Оба получают обновлённое состояние лобби
    emitRoom(room, 'lobby_state', publicRoomState(room));
    console.log(`[room] ${socket.id} joined ${roomId}`);
  });

  // Старт игры — только хост и только при двух игроках
  socket.on('start_game', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return; // не хост
    if (!bothPresent(room)) {
      socket.emit('error_msg', { message: 'Нет второго игрока' });
      return;
    }
    if (room.phase !== 'lobby' && room.phase !== 'finished') return;
    startGame(room);
  });

  // Контрабандист шлёт финальный плейсмент (по кнопке «Готово» или концу таймера)
  socket.on('hide_item', (payload) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'hide' || !room.current) return;
    if (socket.id !== room.current.contrabandistId) return; // не та роль
    if (!isValidPlacement(payload)) {
      socket.emit('error_msg', { message: 'Некорректные данные укладки' });
      return;
    }
    room.current.placement = { dx: payload.dx, dy: payload.dy, rot: payload.rot };
    endHidePhase(room);
  });

  // Таможенник кликает «Изъять» по предмету
  socket.on('scan_item', (payload) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'scan' || !room.current) return;
    if (socket.id !== room.current.customsId) return; // не таможенник
    const idx = payload && typeof payload.index === 'number' ? Math.floor(payload.index) : -1;
    if (idx < 0 || idx >= room.current.scanItems.length) return;

    const target = room.current.scanItems[idx];
    if (target.kind === 'contraband') {
      room.current.contrabandSeized = true;
      emitRoom(room, 'scan_feedback', {
        index: idx, result: 'hit', by: socket.id
      });
      endScanPhase(room);
    } else {
      room.current.wrongSeizures += 1;
      emitRoom(room, 'scan_feedback', {
        index: idx, result: 'miss', by: socket.id
      });
      // Предмет помечаем изъятым (чтобы не изъять дважды)
      target.kind = 'seized_clean';
      // Игра продолжается до нахождения контрабанды или таймаута.
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.phase === 'lobby' || room.phase === 'finished' || !bothPresent(room)) {
      // В лобби — просто удаляем игрока
      if (isHost) {
        if (room.guestId) io.to(room.guestId).emit('opponent_left', { message: 'Хост покинул лобби' });
        rooms.delete(currentRoomId);
      } else {
        room.guestId = null;
        room.guestName = null;
        emitRoom(room, 'lobby_state', publicRoomState(room));
      }
      return;
    }
    // В игре — присудить победу оставшемуся
    handleDisconnectWin(room, socket.id);
  });
});