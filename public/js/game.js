/* ═══════════════════════════════════════════════════════════
   game.js — клиент «Таможня: Досмотр машины»
   SPA: меню/лобби/укладка/досмотр/результат/финал, Canvas, Socket.IO.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const socket = io();

  // ───────── Глобальное состояние ─────────
  const G = {
    roomId: null, isHost: false, myId: null, myName: '', role: null,
    pack: {
      slots: [], fillers: [], contraband: null,
      contraPos: { x: 0, y: 0 }, rot: 0,
      dragging: false, rotating: false, dragOffset: { x: 0, y: 0 }, rotLastX: 0,
      selectedSlot: null, endTimeMs: 0
    },
    inspect: {
      manifest: [], carBody: null, slots: [],
      layout: [],                // актуальная раскладка (с фигурами) — для рентгена/contrabandist
      xrayOn: false, xrayUsesLeft: 0, shakeUsesLeft: 0, interrogationsLeft: 0,
      weigh: null, interrogLog: [],
      hoveredSlot: -1, menuSlot: -1, active: false,
      shakeAnim: 0, endTimeMs: 0,
      contrabandistView: false,
      stressSlots: {}            // slot -> {until} для отрисовки блипа
    },
    roundIndex: 0, timerInt: null
  };

  // ───────── Утилиты экранов ─────────
  const screens = ['menu', 'lobby', 'pack', 'pack-wait', 'inspect', 'round-result', 'game-over'];
  function showScreen(name) {
    screens.forEach(s => document.getElementById('screen-' + s).classList.toggle('active', s === name));
  }
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function overlay(title, text) {
    document.getElementById('overlayTitle').textContent = title;
    document.getElementById('overlayText').textContent = text;
    document.getElementById('overlay').classList.remove('hidden');
  }
  document.getElementById('btnOverlayClose').onclick = () => {
    document.getElementById('overlay').classList.add('hidden'); showScreen('menu');
  };

  // ───────── Звук ─────────
  const soundBtn = document.getElementById('soundToggle');
  document.body.addEventListener('pointerdown', () => { Audio.init(); Audio.resume(); }, { once: true });
  soundBtn.onclick = () => {
    Audio.init(); Audio.resume();
    const next = !Audio.enabled;
    Audio.setEnabled(next);
    soundBtn.textContent = next ? '🔊' : '🔇';
    // если включаем звук во время досмотра — перезапустить гул сканера
    if (next && document.getElementById('screen-inspect').classList.contains('active') && G.inspect.active) {
      Audio.startScannerHum();
    }
  };

  // ───────── Таймер ─────────
  function startTimer(elId, endTimeMs, onEnd) {
    stopTimer();
    const el = document.getElementById(elId);
    G.timerInt = setInterval(() => {
      const remain = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 1000));
      if (el) { el.textContent = remain; el.classList.toggle('warn', remain <= 10); }
      if (remain <= 0) { stopTimer(); if (onEnd) onEnd(); }
    }, 250);
    if (el) el.textContent = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 1000));
  }
  function stopTimer() { if (G.timerInt) { clearInterval(G.timerInt); G.timerInt = null; } }

  // ───────── Canvas-хелперы ─────────
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }
  function fillPoly(ctx, poly) {
    ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath(); ctx.fill();
  }
  function strokePoly(ctx, poly) {
    ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath(); ctx.stroke();
  }
  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  function drawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(0,240,255,0.06)'; ctx.lineWidth = 1; const step = 36;
    for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }
  function slotRectPoly(slot, cx, cy, w = 112, h = 84) {
    return [[cx + slot.x - w / 2, cy + slot.y - h / 2], [cx + slot.x + w / 2, cy + slot.y - h / 2],
            [cx + slot.x + w / 2, cy + slot.y + h / 2], [cx + slot.x - w / 2, cy + slot.y + h / 2]];
  }
  function shapeWorld(entry, cx, cy, rowScale) {
    const s = rowScale;
    const local = entry.shape.map(p => [p[0] * s, p[1] * s]);
    return Geometry.transformPolygon(local, cx + entry.x + (entry.dx || 0) * s, cy + entry.y + (entry.dy || 0) * s, entry.rot || 0, 0, 0);
  }

  // ═══════════════════════════════════════════════════════════
  //  МЕНЮ
  // ═══════════════════════════════════════════════════════════
  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');
  const joinForm = document.getElementById('joinForm');
  const nameCreate = document.getElementById('inputNameCreate');

  btnCreate.onclick = () => {
    nameCreate.classList.remove('hidden'); nameCreate.focus();
    if (nameCreate.dataset.armed === '1') doCreate();
    else { nameCreate.dataset.armed = '1'; btnCreate.textContent = 'Создать →'; }
  };
  nameCreate.onkeydown = (e) => { if (e.key === 'Enter') doCreate(); };
  function doCreate() {
    const name = nameCreate.value.trim() || 'Хост';
    G.myName = name;
    socket.emit('create_room', { name }, (res) => {
      if (res && res.ok) { G.isHost = true; G.roomId = res.roomId; showScreen('lobby'); }
      else toast('Не удалось создать комнату');
    });
  }
  btnJoin.onclick = () => { joinForm.classList.remove('hidden'); document.getElementById('inputRoomId').focus(); };
  document.getElementById('btnJoinConfirm').onclick = doJoin;
  function doJoin() {
    const roomId = document.getElementById('inputRoomId').value.trim().toUpperCase();
    const name = document.getElementById('inputNameJoin').value.trim() || 'Гость';
    if (!roomId) { toast('Введите код комнаты'); return; }
    G.myName = name;
    socket.emit('join_room', { roomId, name }, (res) => {
      const err = document.getElementById('joinError');
      if (res && res.ok) { G.isHost = false; G.roomId = res.roomId; err.classList.add('hidden'); }
      else { err.textContent = res && res.error ? res.error : 'Ошибка подключения'; err.classList.remove('hidden'); }
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  ЛОББИ
  // ═══════════════════════════════════════════════════════════
  function renderLobby(state) {
    document.getElementById('lobbyCode').textContent = state.roomId;
    document.getElementById('roomCode').textContent = state.roomId;
    document.getElementById('roomBadge').classList.remove('hidden');
    document.getElementById('hostName').textContent = state.hostName || '—';
    document.getElementById('guestName').textContent = state.guestName || 'Ожидание…';
    document.getElementById('slotHost').classList.toggle('connected', state.hostConnected);
    document.getElementById('slotGuest').classList.toggle('connected', !!state.guestName);
    document.getElementById('hostStatus').textContent = state.hostConnected ? '●' : '○';
    document.getElementById('guestStatus').textContent = state.guestName ? '●' : '○';
    const btnStart = document.getElementById('btnStart');
    btnStart.classList.toggle('hidden', !(G.isHost && state.hostConnected && state.guestName));
    showScreen('lobby');
  }
  document.getElementById('btnStart').onclick = () => socket.emit('start_game');
  document.getElementById('btnCopy').onclick = () => { navigator.clipboard?.writeText(G.roomId || ''); toast('Код скопирован'); };
  document.getElementById('btnLeaveLobby').onclick = () => location.reload();

  // ═══════════════════════════════════════════════════════════
  //  ФАЗА УКЛАДКИ (контрабандист)
  // ═══════════════════════════════════════════════════════════
  const packCanvas = document.getElementById('packCanvas');
  const packCtx = packCanvas.getContext('2d');
  const packSeizeMenu = document.getElementById('packSeizeMenu');

  function contraLocalPoly() {
    const sh = G.pack.contraband.shape;
    const rot = G.pack.rot;
    return Geometry.transformPolygon(sh, 0, 0, rot, 0, 0);
  }
  function contraWorldPoly() {
    const local = contraLocalPoly();
    return local.map(p => [p[0] + G.pack.contraPos.x, p[1] + G.pack.contraPos.y]);
  }
  function contraHandlePos() {
    const poly = contraWorldPoly();
    const bb = Geometry.polygonBBox(poly);
    return { x: bb.minX + bb.w / 2, y: bb.minY - 22 };
  }

  function renderPack() {
    const { w, h } = fitCanvas(packCanvas);
    const ctx = packCtx;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h);
    const carCx = w / 2, carCy = h / 2;

    // кузов машины
    drawCar(ctx, carCx, carCy, G.pack.contraband ? null : null);

    // слоты с легальным товаром
    G.pack.slots.forEach((s, i) => {
      const filler = G.pack.fillers[i];
      const isSel = (G.pack.selectedSlot === i);
      const rectP = slotRectPoly(s, carCx, carCy);
      ctx.fillStyle = isSel ? 'rgba(255,107,0,0.10)' : 'rgba(0,240,255,0.05)';
      ctx.strokeStyle = isSel ? '#FF6B00' : 'rgba(0,240,255,0.35)';
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      fillPoly(ctx, rectP); strokePoly(ctx, rectP);
      // фигура товара
      const sh = Geometry.transformPolygon(filler.shape, carCx + s.x, carCy + s.y, 0, 0, 0);
      ctx.fillStyle = 'rgba(0,240,255,0.15)'; ctx.strokeStyle = 'rgba(0,240,255,0.6)'; ctx.lineWidth = 1.5;
      fillPoly(ctx, sh); strokePoly(ctx, sh);
      // подпись: имя + вес
      ctx.fillStyle = isSel ? '#FF6B00' : 'rgba(216,227,255,0.7)';
      ctx.font = '12px Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${filler.name} ${filler.weight}кг`, carCx + s.x, carCy + s.y + 56);
      ctx.textAlign = 'start';
    });

    // подсказка о весе для выбранного слота
    if (G.pack.selectedSlot != null) {
      const f = G.pack.fillers[G.pack.selectedSlot];
      const c = G.pack.contraband;
      const diff = c.weight - f.weight;
      const good = Math.abs(diff) <= 3;
      ctx.fillStyle = good ? '#00ff88' : '#ffcc00';
      ctx.font = '13px Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`контрабанда ${c.weight}кг vs товар ${f.weight}кг → разница ${diff > 0 ? '+' : ''}${diff}кг${good ? ' (весы обманут)' : ''}`, carCx, carCy + 110);
      ctx.textAlign = 'start';
    }

    // контрабанда (двигаемый силуэт)
    const poly = contraWorldPoly();
    ctx.fillStyle = hexA('#FF6B00', 0.28); ctx.strokeStyle = '#FF6B00'; ctx.lineWidth = 2;
    fillPoly(ctx, poly); strokePoly(ctx, poly);
    // ручка поворота
    const hp = contraHandlePos();
    ctx.beginPath(); ctx.arc(hp.x, hp.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,240,255,0.18)'; ctx.fill();
    ctx.strokeStyle = '#00F0FF'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#00F0FF'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('↻', hp.x, hp.y + 1); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  function drawCar(ctx, cx, cy) {
    const body = Cargo.CAR_BODY.map(p => [p[0] + cx, p[1] + cy]);
    // тень/корпус
    ctx.fillStyle = 'rgba(0,240,255,0.06)'; ctx.strokeStyle = 'rgba(0,240,255,0.5)'; ctx.lineWidth = 2;
    fillPoly(ctx, body); strokePoly(ctx, body);
    // колёса
    ctx.fillStyle = '#0f1830'; ctx.strokeStyle = 'rgba(0,240,255,0.5)'; ctx.lineWidth = 2;
    for (const wx of [-130, 130]) {
      ctx.beginPath(); ctx.arc(cx + wx, cy + 62, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function packPointerPos(e) {
    const r = packCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function slotAtPos(p) {
    const w = packCanvas.clientWidth, h = packCanvas.clientHeight;
    const carCx = w / 2, carCy = h / 2;
    for (let i = 0; i < G.pack.slots.length; i++) {
      const rp = slotRectPoly(G.pack.slots[i], carCx, carCy);
      if (Geometry.pointInPolygon(p.x, p.y, rp)) return i;
    }
    return null;
  }

  packCanvas.addEventListener('pointerdown', (e) => {
    if (G.role !== 'contrabandist') return;
    const p = packPointerPos(e);
    const hp = contraHandlePos();
    if ((p.x - hp.x) ** 2 + (p.y - hp.y) ** 2 <= 16 * 16) {
      G.pack.rotating = true; G.pack.rotLastX = p.x;
      packCanvas.setPointerCapture(e.pointerId); return;
    }
    const poly = contraWorldPoly();
    if (Geometry.pointInPolygon(p.x, p.y, poly)) {
      G.pack.dragging = true;
      G.pack.dragOffset = { x: p.x - G.pack.contraPos.x, y: p.y - G.pack.contraPos.y };
      packCanvas.setPointerCapture(e.pointerId);
    }
  });
  packCanvas.addEventListener('pointermove', (e) => {
    if (G.pack.rotating) {
      const p = packPointerPos(e);
      G.pack.rot += (p.x - G.pack.rotLastX) * 0.015; G.pack.rotLastX = p.x;
      renderPack(); return;
    }
    if (!G.pack.dragging) return;
    const p = packPointerPos(e);
    G.pack.contraPos = { x: p.x - G.pack.dragOffset.x, y: p.y - G.pack.dragOffset.y };
    G.pack.selectedSlot = slotAtPos(G.pack.contraPos);
    renderPack();
  });
  function endPackDrag(e) {
    if (G.pack.dragging) { G.pack.dragging = false; try { packCanvas.releasePointerCapture(e.pointerId); } catch (_) {} }
    if (G.pack.rotating) { G.pack.rotating = false; try { packCanvas.releasePointerCapture(e.pointerId); } catch (_) {} }
  }
  packCanvas.addEventListener('pointerup', endPackDrag);
  packCanvas.addEventListener('pointercancel', endPackDrag);

  document.getElementById('btnPackRotate').onclick = () => { G.pack.rot += Math.PI / 12; renderPack(); };
  document.getElementById('btnPackReady').onclick = () => {
    if (G.role !== 'contrabandist') return;
    if (G.pack.selectedSlot == null) { toast('Выбери слот для контрабанды'); return; }
    const w = packCanvas.clientWidth, h = packCanvas.clientHeight;
    const carCx = w / 2, carCy = h / 2;
    const s = G.pack.slots[G.pack.selectedSlot];
    const dx = G.pack.contraPos.x - (carCx + s.x);
    const dy = G.pack.contraPos.y - (carCy + s.y);
    socket.emit('pack_item', { slot: G.pack.selectedSlot, dx, dy, rot: G.pack.rot });
  };

  function startPackPhase(payload) {
    G.role = payload.role;
    G.pack.slots = payload.slots;
    G.pack.fillers = payload.fillers;
    G.pack.contraband = payload.contraband;
    G.pack.rot = 0;
    G.pack.selectedSlot = null;
    G.pack.dragging = false; G.pack.rotating = false;
    document.getElementById('packRole').textContent = 'Контрабандист';
    document.getElementById('packRound').textContent = `Раунд ${payload.round}/${payload.totalRounds}`;
    showScreen('pack');
    // стартовая позиция контрабанды — справа от машины
    fitCanvas(packCanvas);
    G.pack.contraPos = { x: packCanvas.clientWidth / 2 + 280, y: packCanvas.clientHeight / 2 };
    renderPack();
    startTimer('packTimer', payload.endTimeMs, () => {
      if (G.pack.selectedSlot != null) {
        const w = packCanvas.clientWidth, h = packCanvas.clientHeight;
        const carCx = w / 2, carCy = h / 2; const s = G.pack.slots[G.pack.selectedSlot];
        socket.emit('pack_item', { slot: G.pack.selectedSlot,
          dx: G.pack.contraPos.x - (carCx + s.x), dy: G.pack.contraPos.y - (carCy + s.y), rot: G.pack.rot });
      }
    });
  }
  function startPackWait(payload) {
    G.role = payload.role;
    showScreen('pack-wait');
    startTimer('packWaitTimer', payload.endTimeMs);
  }

  // ═══════════════════════════════════════════════════════════
  //  ФАЗА ДОСМОТРА
  // ═══════════════════════════════════════════════════════════
  const inspectCanvas = document.getElementById('inspectCanvas');
  const inspectCtx = inspectCanvas.getContext('2d');
  const inspectMenu = document.getElementById('inspectMenu');

  function updateToolCounts() {
    document.getElementById('xrayCnt').textContent = G.inspect.xrayUsesLeft;
    document.getElementById('shakeCnt').textContent = G.inspect.shakeUsesLeft;
    const tc = document.getElementById('toolCounts');
    tc.textContent = `📡${G.inspect.xrayUsesLeft} 🚚${G.inspect.shakeUsesLeft} 🗣${G.inspect.interrogationsLeft}`;
    document.getElementById('btnXray').disabled = G.inspect.xrayUsesLeft <= 0 || G.role !== 'customs';
    document.getElementById('btnShake').disabled = G.inspect.shakeUsesLeft <= 0 || G.role !== 'customs';
    document.getElementById('btnWeigh').disabled = G.role !== 'customs';
    document.getElementById('btnPass').disabled = G.role !== 'customs';
  }

  function rowScale(row) { return row === 1 ? 0.78 : 1.0; } // задний ряд меньше/дальше

  function renderInspect() {
    const { w, h } = fitCanvas(inspectCanvas);
    const ctx = inspectCtx;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h);
    const carCx = w / 2, carCy = h / 2;

    // покачивание машины (анимация после shake)
    const shake = G.inspect.shakeAnim;
    ctx.save();
    if (shake > 0) {
      ctx.translate(carCx, carCy);
      ctx.rotate(0.04 * Math.sin(shake * 0.6));
      ctx.translate(-carCx, -carCy);
      G.inspect.shakeAnim = Math.max(0, shake - 0.15);
    }
    drawCar(ctx, carCx, carCy);
    ctx.restore();

    const isContra = G.inspect.contrabandistView;

    // слоты: рамки + декларация (для таможенника) / реальное содержимое (для контрабандиста)
    G.inspect.slots.forEach((s, i) => {
      const rp = slotRectPoly(s, carCx, carCy);
      const hovered = (i === G.inspect.hoveredSlot) && G.inspect.active;
      ctx.fillStyle = hovered ? 'rgba(0,240,255,0.10)' : 'rgba(0,240,255,0.04)';
      ctx.strokeStyle = hovered ? '#00F0FF' : 'rgba(0,240,255,0.3)';
      ctx.lineWidth = hovered ? 2 : 1.2;
      fillPoly(ctx, rp); strokePoly(ctx, rp);
      // подпись слота (номер)
      ctx.fillStyle = 'rgba(216,227,255,0.5)'; ctx.font = '11px Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${i + 1}`, carCx + s.x - 48, carCy + s.y - 32);
      ctx.textAlign = 'start';
    });

    // декларация (таможенник видит «по бумагам»)
    if (!isContra) {
      G.inspect.slots.forEach((s, i) => {
        const m = G.inspect.manifest[i];
        ctx.fillStyle = 'rgba(216,227,255,0.6)'; ctx.font = '11px Consolas, monospace'; ctx.textAlign = 'center';
        ctx.fillText(`по док.: ${m ? m.name : '—'}`, carCx + s.x, carCy + s.y + 56);
        ctx.textAlign = 'start';
      });
    }

    // рентген: размытые силуэты реальной раскладки
    if (!isContra && G.inspect.xrayOn && G.inspect.layout.length) {
      ctx.save();
      // задний ряд (перекрыт) — сначала, сильнее размыт
      ctx.filter = 'blur(7px)';
      G.inspect.layout.filter(e => e.row === 1).forEach(e => {
        const sh = shapeWorld(e, carCx, carCy, rowScale(e.row));
        ctx.fillStyle = 'rgba(255,107,0,0.28)'; ctx.strokeStyle = 'rgba(255,107,0,0.5)'; ctx.lineWidth = 1;
        fillPoly(ctx, sh); strokePoly(ctx, sh);
      });
      // передний ряд — поверх, слабее размыт (перекрывает задний)
      ctx.filter = 'blur(4px)';
      G.inspect.layout.filter(e => e.row === 0).forEach(e => {
        const sh = shapeWorld(e, carCx, carCy, rowScale(e.row));
        ctx.fillStyle = 'rgba(255,107,0,0.4)'; ctx.strokeStyle = 'rgba(255,107,0,0.7)'; ctx.lineWidth = 1;
        fillPoly(ctx, sh); strokePoly(ctx, sh);
      });
      ctx.restore();
      ctx.filter = 'none';
    }

    // контрабандист видит реальную раскладку чётко (контрабанда — красным)
    if (isContra && G.inspect.layout.length) {
      G.inspect.layout.filter(e => e.row === 1).forEach(e => {
        const sh = shapeWorld(e, carCx, carCy, rowScale(e.row));
        const col = e.isContraband ? '#FF6B00' : '#00F0FF';
        ctx.fillStyle = hexA(col, 0.22); ctx.strokeStyle = col; ctx.lineWidth = 2;
        fillPoly(ctx, sh); strokePoly(ctx, sh);
      });
      G.inspect.layout.filter(e => e.row === 0).forEach(e => {
        const sh = shapeWorld(e, carCx, carCy, rowScale(e.row));
        const col = e.isContraband ? '#FF6B00' : '#00F0FF';
        ctx.fillStyle = hexA(col, 0.3); ctx.strokeStyle = col; ctx.lineWidth = 2;
        fillPoly(ctx, sh); strokePoly(ctx, sh);
      });
    }

    // стресс-блипы на слотах (после допроса)
    const now = Date.now();
    Object.keys(G.inspect.stressSlots).forEach(k => {
      const sIdx = +k, info = G.inspect.stressSlots[k];
      if (now > info.until) { delete G.inspect.stressSlots[k]; return; }
      const s = G.inspect.slots[sIdx]; if (!s) return;
      const col = info.stress === 'high' ? '#FF6B00' : '#00ff88';
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      const rp = slotRectPoly(s, carCx, carCy, 116, 88);
      strokePoly(ctx, rp);
      ctx.fillStyle = col; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(info.stress === 'high' ? '😰' : '😌', carCx + s.x, carCy + s.y - 40);
      ctx.textAlign = 'start';
    });
  }

  let inspectRAF = null;
  function inspectLoop() {
    // перерисовка нужна для анимации shake / стресс-блипов
    if (document.getElementById('screen-inspect').classList.contains('active')) renderInspect();
    inspectRAF = requestAnimationFrame(inspectLoop);
  }

  function inspectPointerPos(e) {
    const r = inspectCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function slotAtInspectPos(p) {
    const w = inspectCanvas.clientWidth, h = inspectCanvas.clientHeight;
    const carCx = w / 2, carCy = h / 2;
    for (let i = 0; i < G.inspect.slots.length; i++) {
      const rp = slotRectPoly(G.inspect.slots[i], carCx, carCy);
      if (Geometry.pointInPolygon(p.x, p.y, rp)) return i;
    }
    return -1;
  }
  inspectCanvas.addEventListener('pointermove', (e) => {
    if (!G.inspect.active) return;
    G.inspect.hoveredSlot = slotAtInspectPos(inspectPointerPos(e));
  });
  inspectCanvas.addEventListener('pointerleave', () => { G.inspect.hoveredSlot = -1; });
  inspectCanvas.addEventListener('pointerdown', (e) => {
    if (!G.inspect.active) return;
    const p = inspectPointerPos(e);
    const idx = slotAtInspectPos(p);
    if (idx < 0) return;
    G.inspect.menuSlot = idx;
    inspectMenu.style.left = p.x + 'px'; inspectMenu.style.top = p.y + 'px';
    inspectMenu.classList.remove('hidden');
  });

  document.getElementById('btnInterrogateSlot').onclick = () => {
    const idx = G.inspect.menuSlot; inspectMenu.classList.add('hidden');
    if (idx >= 0) socket.emit('inspect_interrogate', { slot: idx });
  };
  document.getElementById('btnSeizeSlot').onclick = () => {
    const idx = G.inspect.menuSlot; inspectMenu.classList.add('hidden');
    if (idx >= 0) socket.emit('inspect_seize', { slot: idx });
  };
  document.getElementById('btnInspectCancel').onclick = () => inspectMenu.classList.add('hidden');

  document.getElementById('btnXray').onclick = () => {
    if (G.role !== 'customs') return;
    socket.emit('inspect_xray');
  };
  document.getElementById('btnShake').onclick = () => {
    if (G.role !== 'customs') return;
    socket.emit('inspect_shake');
  };
  document.getElementById('btnWeigh').onclick = () => {
    if (G.role !== 'customs') return;
    socket.emit('inspect_weigh');
  };
  document.getElementById('btnPass').onclick = () => {
    if (G.role !== 'customs') return;
    socket.emit('inspect_pass');
  };

  function renderWeighPanel() {
    const p = document.getElementById('weighPanel');
    if (!G.inspect.weigh) { p.classList.add('hidden'); return; }
    const { actual, declared, diff } = G.inspect.weigh;
    const cls = Math.abs(diff) <= 3 ? 'pos' : 'neg';
    const verdict = Math.abs(diff) <= 3 ? 'в пределах нормы' : (diff > 0 ? 'перевес — подозрительно!' : 'недовес — подозрительно!');
    p.classList.remove('hidden');
    p.innerHTML = `<div class="weigh-row"><span>Факт: <b>${actual}кг</b></span>` +
      `<span>По док.: <b>${declared}кг</b></span>` +
      `<span class="${cls}">Δ ${diff > 0 ? '+' : ''}${diff}кг — ${verdict}</span></div>`;
  }
  function renderInterrogLog() {
    const p = document.getElementById('interrogLog');
    if (!G.inspect.interrogLog.length) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    p.innerHTML = G.inspect.interrogLog.map(r =>
      `<div class="log-row">Слот ${r.slot + 1}: "${r.text}" <span class="stress-${r.stress}">${r.stress === 'high' ? '😰 напряжение' : '😌 спокоен'}</span></div>`
    ).join('');
  }

  function startInspectPhase(payload) {
    G.role = payload.role;
    G.inspect.manifest = payload.manifest;
    G.inspect.carBody = payload.carBody;
    G.inspect.slots = payload.slots;
    G.inspect.layout = [];
    G.inspect.xrayOn = false;
    G.inspect.xrayUsesLeft = payload.xrayUsesLeft;
    G.inspect.shakeUsesLeft = payload.shakeUsesLeft;
    G.inspect.interrogationsLeft = payload.interrogationsLeft;
    G.inspect.weigh = null;
    G.inspect.interrogLog = [];
    G.inspect.hoveredSlot = -1; G.inspect.menuSlot = -1;
    G.inspect.stressSlots = {};
    G.inspect.shakeAnim = 0;
    G.inspect.active = !!payload.active;
    G.inspect.contrabandistView = (payload.role === 'contrabandist');
    document.getElementById('inspectRole').textContent = payload.role === 'customs' ? 'Таможенник' : 'Контрабандист (наблюдение)';
    document.getElementById('inspectRound').textContent = `Раунд ${payload.round}/${payload.totalRounds}`;
    document.getElementById('inspectHint').textContent = payload.active
      ? 'Кликни по слоту → Допросить или Изъять. Рентген — размытые силуэты (задний ряд перекрыт). Покачать — груз сместится.'
      : 'Таможенник досматривает машину. Отвечай на допросы спокойно.';
    // контрабандисту прячем инструменты
    document.getElementById('inspectControls').style.display = payload.active ? '' : 'none';
    document.getElementById('weighPanel').classList.add('hidden');
    document.getElementById('interrogLog').classList.add('hidden');
    showScreen('inspect');
    if (!inspectRAF) inspectLoop();
    updateToolCounts();
    renderWeighPanel(); renderInterrogLog();
    startTimer('inspectTimer', payload.endTimeMs);
    if (payload.role === 'customs') Audio.startScannerHum();
  }

  // ── ответы контрабандиста на допрос ──
  const answerOverlay = document.getElementById('answerOverlay');
  ['manifest', 'nothing', 'dontknow', 'calm'].forEach(t => {
    document.getElementById('ansManifest'); // placeholder
  });
  answerOverlay.querySelectorAll('[data-ans]').forEach(btn => {
    btn.onclick = () => {
      socket.emit('interrogate_answer', { textId: btn.dataset.ans });
      answerOverlay.classList.add('hidden');
    };
  });

  // ═══════════════════════════════════════════════════════════
  //  Socket-события
  // ═══════════════════════════════════════════════════════════
  socket.on('connect', () => { G.myId = socket.id; });
  socket.on('lobby_state', (st) => renderLobby(st));
  socket.on('phase_pack', (p) => startPackPhase(p));
  socket.on('phase_pack_wait', (p) => startPackWait(p));
  socket.on('phase_inspect', (p) => startInspectPhase(p));

  // контрабандисту — его реальная раскладка
  socket.on('inspect_layout', (p) => { G.inspect.layout = p.layout; });

  socket.on('xray_result', (p) => {
    G.inspect.layout = p.layout;
    G.inspect.xrayOn = true;
    G.inspect.xrayUsesLeft = p.usesLeft;
    updateToolCounts();
    Audio.beep(220, 0.18, 'sawtooth', 0.2);
  });
  socket.on('shake_result', (p) => {
    G.inspect.layout = p.layout;
    G.inspect.shakeUsesLeft = p.usesLeft;
    G.inspect.shakeAnim = 12;
    if (G.role === 'customs') Audio.beep(120, 0.3, 'square', 0.25);
    updateToolCounts();
  });
  socket.on('weigh_result', (p) => {
    G.inspect.weigh = p;
    renderWeighPanel();
    Audio.beep(440, 0.12, 'sine', 0.2);
  });
  socket.on('interrogate_pending', (p) => {
    G.inspect.interrogationsLeft = p.interrogationsLeft;
    updateToolCounts();
    document.getElementById('inspectStatus').textContent = `Допрос слота ${p.slot + 1}…`;
  });
  socket.on('interrogate_request', (p) => {
    // контрабандист отвечает
    document.getElementById('answerText').textContent =
      `Тебя спрашивают про слот ${p.slot + 1} (по документам: ${p.manifestName}). Что ответишь?`;
    answerOverlay.classList.remove('hidden');
  });
  socket.on('interrogate_result', (p) => {
    G.inspect.interrogLog.push(p);
    renderInterrogLog();
    G.inspect.stressSlots[p.slot] = { stress: p.stress, until: Date.now() + 4000 };
    document.getElementById('inspectStatus').textContent =
      p.stress === 'high' ? `Слот ${p.slot + 1}: напряжение! 😰` : `Слот ${p.slot + 1}: спокоен 😌`;
    if (p.stress === 'high') Audio.beep(180, 0.2, 'square', 0.25);
  });

  socket.on('inspect_action', (d) => {
    if (d.action === 'seize') {
      Audio.alarm();
      document.getElementById('inspectStatus').textContent = d.hit ? 'Контрабанда изъята!' : 'Изъят чистый товар…';
    } else {
      document.getElementById('inspectStatus').textContent = 'Машина пропущена.';
    }
  });

  socket.on('round_result', (r) => {
    stopTimer(); Audio.stopScannerHum();
    if (r.contrabandSeized) Audio.alarm(); else Audio.scoreDing();
    document.getElementById('resultTitle').textContent = `Раунд ${r.round} завершён`;
    const cd = document.getElementById('contraDelta'), ud = document.getElementById('customsDelta');
    cd.textContent = (r.contrabandistDelta >= 0 ? '+' : '') + r.contrabandistDelta;
    ud.textContent = (r.customsDelta >= 0 ? '+' : '') + r.customsDelta;
    cd.className = 'result-delta ' + (r.contrabandistDelta > 0 ? 'pos' : r.contrabandistDelta < 0 ? 'neg' : 'zero');
    ud.className = 'result-delta ' + (r.customsDelta > 0 ? 'pos' : r.customsDelta < 0 ? 'neg' : 'zero');
    let detail;
    if (r.reason === 'seize' && r.contrabandSeized) detail = `Таможенник изъял контрабанду в слоте ${r.seizedSlot + 1}!`;
    else if (r.reason === 'seize') detail = `Таможенник ошибся: изъят слот ${r.seizedSlot + 1}, а контрабанда была в ${(r.contrabandPos != null ? r.contrabandPos : r.contrabandSlot) + 1}.`;
    else detail = `Машина пропущена. Контрабанда была в слоте ${(r.contrabandPos != null ? r.contrabandPos : r.contrabandSlot) + 1}.`;
    detail += ` Контрабанда: ${r.contraband.name}. Вес: факт ${r.actualWeight}кг / по док. ${r.declaredWeight}кг.`;
    document.getElementById('resultDetail').textContent = detail;
    const scores = r.scores, ids = Object.keys(scores);
    document.getElementById('resultScores').innerHTML = ids.map(id =>
      `<span>${id === socket.id ? 'Вы' : 'Соперник'}: ${scores[id]}</span>`).join('');
    showScreen('round-result');
  });

  socket.on('game_over', (data) => {
    stopTimer(); Audio.stopScannerHum(); Audio.scoreDing();
    const scores = data.scores, ids = Object.keys(scores);
    const myScore = scores[socket.id] || 0;
    const otherId = ids.find(id => id !== socket.id);
    const otherScore = scores[otherId] || 0;
    const wb = document.getElementById('winnerBox');
    if (data.winner === 'draw') { wb.className = 'winner-box draw'; wb.textContent = '🤝 Ничья!'; }
    else if (data.winner === socket.id) { wb.className = 'winner-box win'; wb.textContent = '🏆 Победа!'; }
    else { wb.className = 'winner-box lose'; wb.textContent = 'Поражение…'; }
    document.getElementById('finalScores').innerHTML = `<span>Вы: ${myScore}</span><span>Соперник: ${otherScore}</span>`;
    const hist = (data.history || []).map((h, i) => {
      const contra = h.contrabandistId === socket.id ? 'Вы' : 'Соперник';
      const cust = h.customsId === socket.id ? 'Вы' : 'Соперник';
      return `<div class="hist-row"><span>Раунд ${i + 1}</span>` +
        `<span>${contra}(К): ${h.contrabandistDelta >= 0 ? '+' : ''}${h.contrabandistDelta} · ` +
        `${cust}(Т): ${h.customsDelta >= 0 ? '+' : ''}${h.customsDelta}</span></div>`;
    }).join('');
    document.getElementById('finalHistory').innerHTML = hist;
    showScreen('game-over');
  });
  document.getElementById('btnBackMenu').onclick = () => location.reload();

  socket.on('error_msg', (d) => toast(d.message || 'Ошибка'));
  socket.on('opponent_left', (d) => {
    stopTimer(); Audio.stopScannerHum();
    if (inspectRAF) { cancelAnimationFrame(inspectRAF); inspectRAF = null; }
    overlay('Игра прервана', d.message || 'Противник покинул игру');
  });
  socket.on('disconnect', () => { stopTimer(); overlay('Соединение потеряно', 'Проверьте интернет и перезагрузите страницу.'); });

  window.addEventListener('resize', () => {
    if (document.getElementById('screen-pack').classList.contains('active')) renderPack();
  });

  // Тестовый хук (только при ?test).
  if (new URL(location.href).searchParams.has('test')) window.__CXG = G;

  showScreen('menu');
})();