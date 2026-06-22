/* ═══════════════════════════════════════════════════════════
   game.js — клиентская логика «Таможня: Рентген-Контроль»
   SPA: переключение экранов, Canvas-рендер, Socket.IO-клиент.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const socket = io();

  // ───────── Глобальное состояние клиента ─────────
  const G = {
    roomId: null,
    isHost: false,
    myId: null,
    myName: '',
    role: null,            // 'contrabandist' | 'customs'
    // фаза укладки
    hide: {
      item: null, cavity: null,
      placement: { dx: 120, dy: 0, rot: 0 },
      dragging: false, dragOffset: { x: 0, y: 0 },
      rotating: false, rotLastX: 0,
      match: 0,
      endTimeMs: 0
    },
    // фаза сканирования
    scan: {
      scanItems: [],       // [{id, kind}]
      itemsById: {},       // кэш предметов по id
      contrabandItemId: null,
      placement: null, cavity: null, match: 0,
      hoveredIndex: -1,
      conveyorX: 0,
      layout: null,        // [{cx, scale}] — позиции предметов без перекрытий
      endTimeMs: 0,
      active: false,       // таможенник может действовать
      seizedSet: new Set()
    },
    roundIndex: 0,
    timerInt: null
  };

  // Кэш всех предметов по id
  ITEMS.forEach(it => G.scan.itemsById[it.id] = it);

  // ───────── Утилиты экранов ─────────
  const screens = ['menu', 'lobby', 'hide', 'hide-wait', 'scan', 'round-result', 'game-over'];
  function showScreen(name) {
    screens.forEach(s => {
      document.getElementById('screen-' + s).classList.toggle('active', s === name);
    });
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function overlay(title, text) {
    document.getElementById('overlayTitle').textContent = title;
    document.getElementById('overlayText').textContent = text;
    document.getElementById('overlay').classList.remove('hidden');
  }
  document.getElementById('btnOverlayClose').onclick = () => {
    document.getElementById('overlay').classList.add('hidden');
    showScreen('menu');
  };

  // ───────── Звук ─────────
  const soundBtn = document.getElementById('soundToggle');
  function unlockAudio() { Audio.init(); Audio.resume(); }
  document.body.addEventListener('pointerdown', unlockAudio, { once: true });
  soundBtn.onclick = () => {
    Audio.init();
    Audio.resume();
    const next = !Audio.enabled;
    Audio.setEnabled(next);
    soundBtn.textContent = next ? '🔊' : '🔇';
    // если включаем звук прямо во время рентгена — перезапустить гул сканера
    if (next && document.getElementById('screen-scan').classList.contains('active') && G.scan.active) {
      Audio.startScannerHum();
    }
  };

  // ───────── Таймер ─────────
  function startTimer(elId, endTimeMs, onEnd) {
    stopTimer();
    const el = document.getElementById(elId);
    G.timerInt = setInterval(() => {
      const remain = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 1000));
      if (el) {
        el.textContent = remain;
        el.classList.toggle('warn', remain <= 10);
      }
      if (remain <= 0) {
        stopTimer();
        if (onEnd) onEnd();
      }
    }, 250);
    if (el) el.textContent = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 1000));
  }
  function stopTimer() { if (G.timerInt) { clearInterval(G.timerInt); G.timerInt = null; } }

  // ═══════════════════════════════════════════════════════════
  //  МЕНЮ
  // ═══════════════════════════════════════════════════════════
  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');
  const joinForm = document.getElementById('joinForm');
  const nameCreate = document.getElementById('inputNameCreate');

  btnCreate.onclick = () => {
    nameCreate.classList.remove('hidden');
    nameCreate.focus();
    nameCreate.scrollIntoView({ block: 'center' });
    // повторный клик после ввода имени — создаём
    if (nameCreate.dataset.armed === '1') {
      doCreate();
    } else {
      nameCreate.dataset.armed = '1';
      btnCreate.textContent = 'Создать →';
    }
  };
  nameCreate.onkeydown = (e) => { if (e.key === 'Enter') doCreate(); };

  function doCreate() {
    const name = nameCreate.value.trim() || 'Хост';
    G.myName = name;
    socket.emit('create_room', { name }, (res) => {
      if (res && res.ok) {
        G.isHost = true;
        G.roomId = res.roomId;
        showScreen('lobby');
      } else {
        toast('Не удалось создать комнату');
      }
    });
  }

  btnJoin.onclick = () => {
    joinForm.classList.remove('hidden');
    document.getElementById('inputRoomId').focus();
  };
  document.getElementById('btnJoinConfirm').onclick = doJoin;
  function doJoin() {
    const roomId = document.getElementById('inputRoomId').value.trim().toUpperCase();
    const name = document.getElementById('inputNameJoin').value.trim() || 'Гость';
    if (!roomId) { toast('Введите код комнаты'); return; }
    G.myName = name;
    socket.emit('join_room', { roomId, name }, (res) => {
      const err = document.getElementById('joinError');
      if (res && res.ok) {
        G.isHost = false;
        G.roomId = res.roomId;
        err.classList.add('hidden');
      } else {
        err.textContent = res && res.error ? res.error : 'Ошибка подключения';
        err.classList.remove('hidden');
      }
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
    const hostSlot = document.getElementById('slotHost');
    const guestSlot = document.getElementById('slotGuest');
    hostSlot.classList.toggle('connected', state.hostConnected);
    guestSlot.classList.toggle('connected', !!state.guestName);
    document.getElementById('hostStatus').textContent = state.hostConnected ? '●' : '○';
    document.getElementById('guestStatus').textContent = state.guestName ? '●' : '○';
    // Старт только у хоста и при двух игроках
    const btnStart = document.getElementById('btnStart');
    if (G.isHost && state.hostConnected && state.guestName) {
      btnStart.classList.remove('hidden');
    } else {
      btnStart.classList.add('hidden');
    }
    showScreen('lobby');
  }

  document.getElementById('btnStart').onclick = () => {
    socket.emit('start_game');
  };
  document.getElementById('btnCopy').onclick = () => {
    navigator.clipboard?.writeText(G.roomId || '');
    toast('Код скопирован');
  };
  document.getElementById('btnLeaveLobby').onclick = () => {
    // мягкий выход: просто перезагрузка страницы (сокет-сервер обработает disconnect)
    location.reload();
  };

  // ═══════════════════════════════════════════════════════════
  //  ФАЗА УКЛАДКИ (контрабандист)
  // ═══════════════════════════════════════════════════════════
  const hideCanvas = document.getElementById('hideCanvas');
  const hideCtx = hideCanvas.getContext('2d');

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    // CSS-размер задаётся статически (position:absolute; inset:0; 100%/100%),
    // inline-стиль не выставляем — иначе возникает петля роста высоты stage.
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function centroid(poly) {
    const bb = Geometry.polygonBBox(poly);
    return { x: bb.minX + bb.w / 2, y: bb.minY + bb.h / 2 };
  }

  // Трансформ в координаты canvas: legal центр = (LX, LY)
  function placedContrabandPoly(item, placement, LX, LY) {
    const c = centroid(item.contraband);
    return Geometry.transformPolygon(item.contraband, LX + placement.dx, LY + placement.dy, placement.rot, c.x, c.y);
  }
  function cavityPoly(item, cavity, LX, LY) {
    const c = centroid(item.contraband);
    return Geometry.transformPolygon(item.contraband, LX + cavity.dx, LY + cavity.dy, cavity.rot, c.x, c.y);
  }

  function renderHide() {
    const { w, h } = fitCanvas(hideCanvas);
    const ctx = hideCtx;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h);

    const item = G.hide.item;
    if (!item) return;
    const LX = w / 2, LY = h / 2;

    // 1. Легальный предмет (силуэт)
    const legal = Geometry.transformPolygon(item.legal, LX, LY, 0, 0, 0);
    ctx.fillStyle = 'rgba(0, 240, 255, 0.08)';
    ctx.strokeStyle = '#00F0FF';
    ctx.lineWidth = 2;
    fillPoly(ctx, legal);
    strokePoly(ctx, legal);

    // 2. Полость (цель) — пунктирный контур внутри
    const cav = cavityPoly(item, G.hide.cavity, LX, LY);
    ctx.fillStyle = 'rgba(0, 240, 255, 0.05)';
    fillPoly(ctx, cav);
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    strokePoly(ctx, cav);
    ctx.setLineDash([]);

    // 3. Контрабанда (двигаемый силуэт) — цвет по match
    const contra = placedContrabandPoly(item, G.hide.placement, LX, LY);
    const m = G.hide.match;
    const color = m >= 0.85 ? '#00ff88' : (m >= 0.5 ? '#ffcc00' : '#FF6B00');
    ctx.fillStyle = hexA(color, 0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    fillPoly(ctx, contra);
    strokePoly(ctx, contra);
    // подпись
    ctx.fillStyle = color;
    ctx.font = '12px Consolas, monospace';
    ctx.fillText(item.contrabandName, contra[0][0], contra[0][1] - 8);

    // 4. Ручка поворота на самом силуэте (предложение: тяну мышкой влево/вправо — вращение)
    drawRotateHandle(ctx, contra);
  }

  function contrabandHandlePos(contraPoly) {
    const bb = Geometry.polygonBBox(contraPoly);
    return { x: bb.minX + bb.w / 2, y: bb.minY - 22 };
  }
  function drawRotateHandle(ctx, contraPoly) {
    const hp = contrabandHandlePos(contraPoly);
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 240, 255, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#00F0FF';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#00F0FF';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↻', hp.x, hp.y + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function fillPoly(ctx, poly) {
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.fill();
  }
  function strokePoly(ctx, poly) {
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.stroke();
  }
  function hexA(hex, a) {
    // #RRGGBB -> rgba
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  function drawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.06)';
    ctx.lineWidth = 1;
    const step = 36;
    for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }

  function updateMatchMeter() {
    const m = G.hide.match;
    document.getElementById('matchFill').style.width = (m * 100).toFixed(0) + '%';
    document.getElementById('matchValue').textContent = (m * 100).toFixed(0) + '%';
  }

  function recomputeHideMatch() {
    const item = G.hide.item; if (!item) return;
    // Используем origin-пространство (legal центр = 0,0) — как на сервере
    const c = centroid(item.contraband);
    const placed = Geometry.transformPolygon(item.contraband, G.hide.placement.dx, G.hide.placement.dy, G.hide.placement.rot, c.x, c.y);
    const cav = Geometry.transformPolygon(item.contraband, G.hide.cavity.dx, G.hide.cavity.dy, G.hide.cavity.rot, c.x, c.y);
    const prev = G.hide.match;
    G.hide.match = Geometry.computeMatch(placed, cav);
    updateMatchMeter();
    // бип при переходе через порог 85%
    if (prev < 0.85 && G.hide.match >= 0.85) Audio.matchBeep();
  }

  // Pointer Drag для контрабанды
  function hidePointerPos(e) {
    const rect = hideCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  hideCanvas.addEventListener('pointerdown', (e) => {
    if (G.role !== 'contrabandist') return;
    const p = hidePointerPos(e);
    const item = G.hide.item;
    const LX = hideCanvas.clientWidth / 2, LY = hideCanvas.clientHeight / 2;
    const contra = placedContrabandPoly(item, G.hide.placement, LX, LY);
    // 1) Ручка поворота на силуэте — тяну влево/вправо для вращения.
    const hp = contrabandHandlePos(contra);
    if ((p.x - hp.x) ** 2 + (p.y - hp.y) ** 2 <= 16 * 16) {
      G.hide.rotating = true;
      G.hide.rotLastX = p.x;
      hideCanvas.setPointerCapture(e.pointerId);
      return;
    }
    // 2) Тело силуэта — перетаскивание.
    if (Geometry.pointInPolygon(p.x, p.y, contra)) {
      G.hide.dragging = true;
      // смещение между курсором и центром контрабанды
      const cWorld = { x: LX + G.hide.placement.dx, y: LY + G.hide.placement.dy };
      G.hide.dragOffset = { x: p.x - cWorld.x, y: p.y - cWorld.y };
      hideCanvas.setPointerCapture(e.pointerId);
    }
  });
  hideCanvas.addEventListener('pointermove', (e) => {
    if (G.hide.rotating) {
      const p = hidePointerPos(e);
      // вправо — по часовой, влево — против часовой
      G.hide.placement.rot += (p.x - G.hide.rotLastX) * 0.015;
      G.hide.rotLastX = p.x;
      recomputeHideMatch();
      renderHide();
      return;
    }
    if (!G.hide.dragging) return;
    const p = hidePointerPos(e);
    const LX = hideCanvas.clientWidth / 2, LY = hideCanvas.clientHeight / 2;
    G.hide.placement.dx = (p.x - G.hide.dragOffset.x) - LX;
    G.hide.placement.dy = (p.y - G.hide.dragOffset.y) - LY;
    recomputeHideMatch();
    renderHide();
  });
  function endHideDrag(e) {
    if (G.hide.dragging) { G.hide.dragging = false; try { hideCanvas.releasePointerCapture(e.pointerId); } catch (_) {} }
    if (G.hide.rotating) { G.hide.rotating = false; try { hideCanvas.releasePointerCapture(e.pointerId); } catch (_) {} }
  }
  hideCanvas.addEventListener('pointerup', endHideDrag);
  hideCanvas.addEventListener('pointercancel', endHideDrag);

  // Поворот кнопкой / клавишами
  document.getElementById('btnRotate').onclick = () => {
    if (G.role !== 'contrabandist') return;
    G.hide.placement.rot += Math.PI / 12; // 15°
    recomputeHideMatch();
    renderHide();
  };
  window.addEventListener('keydown', (e) => {
    if (document.getElementById('screen-hide').classList.contains('active') && G.role === 'contrabandist') {
      if (e.key === 'ArrowLeft') { G.hide.placement.rot -= Math.PI / 24; recomputeHideMatch(); renderHide(); }
      if (e.key === 'ArrowRight') { G.hide.placement.rot += Math.PI / 24; recomputeHideMatch(); renderHide(); }
    }
  });

  document.getElementById('btnReady').onclick = () => {
    if (G.role !== 'contrabandist') return;
    socket.emit('hide_item', { dx: G.hide.placement.dx, dy: G.hide.placement.dy, rot: G.hide.placement.rot });
  };

  function startHidePhase(payload) {
    G.role = payload.role;
    G.hide.item = payload.item;
    G.hide.cavity = payload.cavity;
    // стартовая позиция контрабанды — сбоку от предмета
    const bb = Geometry.polygonBBox(payload.item.legal);
    G.hide.placement = { dx: bb.w / 2 + 80, dy: 0, rot: 0 };
    G.hide.match = 0;
    document.getElementById('hideRole').textContent = 'Контрабандист';
    document.getElementById('hideRound').textContent = `Раунд ${payload.round}/${payload.totalRounds}`;
    showScreen('hide');
    recomputeHideMatch();
    renderHide();
    startTimer('hideTimer', payload.endTimeMs, () => {
      // авто-отправка по таймеру
      socket.emit('hide_item', { dx: G.hide.placement.dx, dy: G.hide.placement.dy, rot: G.hide.placement.rot });
    });
  }

  function startHideWait(payload) {
    G.role = payload.role;
    showScreen('hide-wait');
    startTimer('hideWaitTimer', payload.endTimeMs);
  }

  // ═══════════════════════════════════════════════════════════
  //  ФАЗА РЕНТГЕНА (таможенник сканирует; контрабандист наблюдает)
  // ═══════════════════════════════════════════════════════════
  const scanCanvas = document.getElementById('scanCanvas');
  const scanCtx = scanCanvas.getContext('2d');
  const scanStage = document.getElementById('scanStage');
  const seizeMenu = document.getElementById('seizeMenu');

  function renderScan() {
    const { w, h } = fitCanvas(scanCanvas);
    const ctx = scanCtx;
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, w, h);

    const items = G.scan.scanItems;
    if (!items.length) return;

    // Лента конвейера
    const beltY = h / 2;
    ctx.fillStyle = 'rgba(0, 240, 255, 0.04)';
    ctx.fillRect(0, beltY - 90, w, 180);
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, beltY - 90); ctx.lineTo(w, beltY - 90); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, beltY + 90); ctx.lineTo(w, beltY + 90); ctx.stroke();
    // движущиеся полосы ленты
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.10)';
    for (let x = -((G.scan.conveyorX) % 40); x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, beltY - 90); ctx.lineTo(x + 20, beltY + 90); ctx.stroke();
    }

    // Предметы едут по ленте (конвейер с обёрткой) и качаются — «машина с товарами».
    const layout = ensureScanLayout(w);
    for (let i = 0; i < items.length; i++) {
      drawScanItem(ctx, i, items[i], w);
    }
  }

  /**
   * Конвейерная раскладка: предметы равномерно размещены на петле длиной L = w + maxWS,
     перемещаются вправо и заворачиваются. Масштаб подбирается так, чтобы соседи не перекрывались.
   * Возвращает { L, slot, scale, maxWS, n }.
   */
  function computeScanLayout(items, w) {
    const n = items.length;
    const widths = items.map(si => Geometry.polygonBBox(G.scan.itemsById[si.id].legal).w);
    const maxW = Math.max.apply(null, widths);
    const gap = 24;
    // Условие без перекрытий на петле: maxWS <= slot - gap, где slot = L/n = (w + maxWS)/n.
    // => (n-1)*maxWS <= w - n*gap => maxWS <= (w - n*gap)/(n-1).
    let scale = 1;
    if (n > 1) {
      const maxWS_cap = Math.max(40, (w - n * gap) / (n - 1));
      scale = Math.min(1, maxWS_cap / Math.max(1, maxW));
      scale = Math.max(0.3, scale); // не уменьшаем слишком сильно
    }
    const maxWS = maxW * scale;
    const L = w + maxWS;          // длина петли (видимая часть w + запас на обёртку)
    const slot = L / n;           // шаг между предметами по петле
    return { L, slot, scale, maxWS, n };
  }
  function ensureScanLayout(w) {
    if (!G.scan.layout) G.scan.layout = computeScanLayout(G.scan.scanItems, w);
    return G.scan.layout;
  }

  /** Трансформ i-го предмета в координатах канваса в данный момент (конвейер + качание). */
  function scanItemTransform(i) {
    const layout = ensureScanLayout(scanCanvas.clientWidth);
    const L = layout.L, scale = layout.scale;
    const slot = layout.slot;
    const cx = ((i * slot + G.scan.conveyorX) % L + L) % L;
    const t = performance.now() / 1000;
    const phase = i * 1.37;
    const rot = 0.07 * Math.sin(t * 1.15 + phase);       // качание корпуса
    const bob = 5 * Math.sin(t * 1.6 + phase * 1.7);       // вертикальное покачивание
    const cy = scanCanvas.clientHeight / 2 + bob;
    // Болтанка контрабанды внутри полости (груз ехал и качается → даже идеальная укладка выглядит):
    const wdx = 9 * Math.sin(t * 2.3 + phase + 0.6);
    const wdy = 6 * Math.cos(t * 2.7 + phase);
    return { cx, cy, rot, scale, wdx, wdy };
  }

  /** Полигоны i-го предмета в координатах канваса (legal +, для контрабанды, wobbled contraband). */
  function scanItemPolygons(i) {
    const def = G.scan.itemsById[G.scan.scanItems[i].id];
    const tr = scanItemTransform(i);
    const s = tr.scale;
    const legalLocal = def.legal.map(([x, y]) => [x * s, y * s]);
    const legal = Geometry.transformPolygon(legalLocal, tr.cx, tr.cy, tr.rot, 0, 0);
    const polys = { legal };
    if (def.id === G.scan.contrabandItemId && G.scan.placement) {
      const c = centroid(def.contraband);
      const contraLocal = def.contraband.map(([x, y]) => [x * s, y * s]);
      const pl = G.scan.placement;
      const contra = Geometry.transformPolygon(
        contraLocal, tr.cx + (pl.dx + tr.wdx) * s, tr.cy + (pl.dy + tr.wdy) * s, pl.rot + tr.rot, c.x * s, c.y * s
      );
      polys.contraband = contra;
    }
    return polys;
  }

  function drawScanItem(ctx, index, scanItem, canvasW) {
    const def = G.scan.itemsById[scanItem.id];
    if (!def) return;
    const hovered = (index === G.scan.hoveredIndex);
    const isContraband = (scanItem.id === G.scan.contrabandItemId);
    const seized = G.scan.seizedSet.has(index);

    const tr = scanItemTransform(index);
    const s = tr.scale;
    const cx = tr.cx, cy = tr.cy, rot = tr.rot;

    const legalLocal = def.legal.map(([x, y]) => [x * s, y * s]);
    const legal = Geometry.transformPolygon(legalLocal, cx, cy, rot, 0, 0);

    // корпус предмета
    ctx.fillStyle = hovered ? 'rgba(0, 240, 255, 0.10)' : 'rgba(0, 240, 255, 0.05)';
    ctx.strokeStyle = hovered ? '#00F0FF' : 'rgba(0, 240, 255, 0.5)';
    ctx.lineWidth = hovered ? 2.5 : 1.5;
    fillPoly(ctx, legal);
    strokePoly(ctx, legal);

    // рентген-сетка внутри при наведении
    if (hovered && !seized) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(legal[0][0], legal[0][1]);
      for (let i = 1; i < legal.length; i++) ctx.lineTo(legal[i][0], legal[i][1]);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
      ctx.lineWidth = 1;
      const bb = Geometry.polygonBBox(legal);
      for (let gx = bb.minX; gx <= bb.maxX; gx += 12) { ctx.beginPath(); ctx.moveTo(gx, bb.minY); ctx.lineTo(gx, bb.maxY); ctx.stroke(); }
      for (let gy = bb.minY; gy <= bb.maxY; gy += 12) { ctx.beginPath(); ctx.moveTo(bb.minX, gy); ctx.lineTo(bb.maxX, gy); ctx.stroke(); }
      ctx.restore();

      // если это контрабандный предмет — показать красный силуэт (с болтанкой → curMatch)
      if (isContraband && G.scan.placement && G.scan.cavity) {
        // curMatch — в локальных координатах (вращение корпуса взаимно сокращается).
        const c = centroid(def.contraband);
        const pl = G.scan.placement, cav = G.scan.cavity;
        const contraLoc = Geometry.transformPolygon(def.contraband, pl.dx + tr.wdx, pl.dy + tr.wdy, pl.rot, c.x, c.y);
        const cavLoc = Geometry.transformPolygon(def.contraband, cav.dx, cav.dy, cav.rot, c.x, c.y);
        const curMatch = Geometry.computeMatch(contraLoc, cavLoc, 240);
        const contra = scanItemPolygons(index).contraband;
        const opacity = Math.min(0.95, (1 - curMatch) * 0.95);
        if (opacity > 0.04 && contra) {
          const blink = 0.65 + 0.35 * Math.sin(Date.now() / 120);
          ctx.fillStyle = hexA('#FF6B00', opacity * blink);
          ctx.strokeStyle = hexA('#FF6B00', Math.min(1, opacity * blink + 0.2));
          ctx.lineWidth = 2;
          fillPoly(ctx, contra);
          strokePoly(ctx, contra);
        }
      }
    }

    // метка изъятого
    if (seized) {
      ctx.strokeStyle = '#FF6B00';
      ctx.lineWidth = 3;
      strokePoly(ctx, legal);
      ctx.fillStyle = '#FF6B00';
      ctx.font = '14px Consolas, monospace';
      ctx.fillText('ИЗЪЯТО', cx - 28, cy + 4);
    }

    // подпись
    ctx.fillStyle = hovered ? '#00F0FF' : 'rgba(216,227,255,0.5)';
    ctx.font = '12px Consolas, monospace';
    ctx.fillText(def.legalName, cx - def.legalName.length * 3.2, cy + 110);
  }

  let scanRAF = null;
  function scanLoop() {
    G.scan.conveyorX += 3.0; // скорость ленты (предметы едут)
    renderScan();
    scanRAF = requestAnimationFrame(scanLoop);
  }

  function scanPointerPos(e) {
    const rect = scanCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function itemAtPoint(p) {
    const items = G.scan.scanItems;
    for (let i = 0; i < items.length; i++) {
      if (G.scan.seizedSet.has(i)) continue;
      const polys = scanItemPolygons(i);
      if (Geometry.pointInPolygon(p.x, p.y, polys.legal)) return i;
      // Баг 2: выступающая за легальный силуэт контрабанда (с учётом болтанки) тоже кликабельна.
      if (polys.contraband && Geometry.pointInPolygon(p.x, p.y, polys.contraband)) return i;
    }
    return -1;
  }

  scanCanvas.addEventListener('pointermove', (e) => {
    const p = scanPointerPos(e);
    G.scan.hoveredIndex = itemAtPoint(p);
  });
  scanCanvas.addEventListener('pointerleave', () => { G.scan.hoveredIndex = -1; });
  scanCanvas.addEventListener('pointerdown', (e) => {
    if (!G.scan.active) return; // действует только таможенник
    const p = scanPointerPos(e);
    const idx = itemAtPoint(p);
    if (idx < 0 || G.scan.seizedSet.has(idx)) return;
    // показать меню «Изъять» у курсора
    seizeMenu.style.left = p.x + 'px';
    seizeMenu.style.top = p.y + 'px';
    seizeMenu.dataset.index = idx;
    seizeMenu.classList.remove('hidden');
  });

  document.getElementById('btnSeize').onclick = () => {
    const idx = parseInt(seizeMenu.dataset.index, 10);
    seizeMenu.classList.add('hidden');
    if (!isNaN(idx)) {
      G.scan.seizedSet.add(idx); // локальная пометка до серверного фидбека
      socket.emit('scan_item', { index: idx });
    }
  };
  document.getElementById('btnCancelSeize').onclick = () => {
    seizeMenu.classList.add('hidden');
  };

  function startScanPhase(payload) {
    G.role = payload.role;
    G.scan.scanItems = payload.scanItems;
    G.scan.active = !!payload.active; // таможенник — active=true
    G.scan.hoveredIndex = -1;
    G.scan.conveyorX = 0;
    G.scan.layout = null;
    G.scan.seizedSet = new Set();
    document.getElementById('scanRole').textContent = payload.role === 'customs' ? 'Таможенник' : 'Контрабандист (наблюдение)';
    document.getElementById('scanRound').textContent = `Раунд ${payload.round}/${payload.totalRounds}`;
    document.getElementById('scanHint').textContent = payload.active
      ? 'Наведи курсор на предмет для рентгена. Кликни → «Изъять», если видишь контрабанду.'
      : 'Таможенник сканирует предметы. Наблюдай.';
    showScreen('scan');
    if (!scanRAF) scanLoop();
    startTimer('scanTimer', payload.endTimeMs);
    if (payload.role === 'customs') Audio.startScannerHum();
  }

  function applyScanScene(payload) {
    G.scan.contrabandItemId = payload.contrabandItemId;
    G.scan.placement = payload.placement;
    G.scan.cavity = payload.cavity;
    G.scan.match = payload.match;
  }

  // фидбек изъятия
  socket.on('scan_feedback', (data) => {
    if (data.result === 'hit') {
      Audio.alarm();
      G.scan.seizedSet.add(data.index);
      document.getElementById('scanStatus').textContent = 'Контрабанда обнаружена!';
    } else {
      Audio.beep(180, 0.2, 'square', 0.25);
      G.scan.seizedSet.add(data.index);
      document.getElementById('scanStatus').textContent = 'Чистый предмет. Штраф −1.';
      toast('Ложное изъятие: −1 очко');
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  РЕЗУЛЬТАТ РАУНДА / ФИНАЛ
  // ═══════════════════════════════════════════════════════════
  socket.on('round_result', (r) => {
    stopTimer();
    Audio.stopScannerHum();
    if (r.contrabandSeized) Audio.alarm(); else Audio.scoreDing();

    const myIsContra = (socket.id === r.contrabandistId);
    // подсветка ролей
    document.getElementById('resultTitle').textContent = `Раунд ${r.round} завершён`;
    const contraDelta = document.getElementById('contraDelta');
    const customsDelta = document.getElementById('customsDelta');
    contraDelta.textContent = (r.contrabandistDelta >= 0 ? '+' : '') + r.contrabandistDelta;
    customsDelta.textContent = (r.customsDelta >= 0 ? '+' : '') + r.customsDelta;
    contraDelta.className = 'result-delta ' + (r.contrabandistDelta > 0 ? 'pos' : r.contrabandistDelta < 0 ? 'neg' : 'zero');
    customsDelta.className = 'result-delta ' + (r.customsDelta > 0 ? 'pos' : r.customsDelta < 0 ? 'neg' : 'zero');

    const detail = r.contrabandSeized
      ? 'Таможенник нашёл контрабанду!'
      : 'Контрабандист пронёс товар незамеченным!';
    document.getElementById('resultDetail').textContent = detail +
      ` Совпадение силуэтов: ${(r.match * 100).toFixed(0)}%.`;

    // мини-счёт
    const scores = r.scores;
    document.getElementById('resultScores').innerHTML =
      `<span>Хост: ${scores[G.myId === undefined ? '' : '']}</span>`;
    // упростим: покажем оба счёта по id
    const ids = Object.keys(scores);
    document.getElementById('resultScores').innerHTML = ids.map(id =>
      `<span>${id === socket.id ? 'Вы' : 'Соперник'}: ${scores[id]}</span>`).join('');

    showScreen('round-result');
  });

  socket.on('game_over', (data) => {
    stopTimer();
    Audio.stopScannerHum();
    Audio.scoreDing();
    const scores = data.scores;
    const ids = Object.keys(scores);
    const myScore = scores[socket.id] || 0;
    const otherId = ids.find(id => id !== socket.id);
    const otherScore = scores[otherId] || 0;

    const winnerBox = document.getElementById('winnerBox');
    if (data.winner === 'draw') {
      winnerBox.className = 'winner-box draw';
      winnerBox.textContent = '🤝 Дружеская ничья!';
    } else if (data.winner === socket.id) {
      winnerBox.className = 'winner-box win';
      winnerBox.textContent = '🏆 Победа!';
    } else {
      winnerBox.className = 'winner-box lose';
      winnerBox.textContent = 'Поражение…';
    }
    document.getElementById('finalScores').innerHTML =
      `<span>Вы: ${myScore}</span><span>Соперник: ${otherScore}</span>`;

    // история раундов
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

  // ═══════════════════════════════════════════════════════════
  //  Socket-события
  // ═══════════════════════════════════════════════════════════
  socket.on('connect', () => { G.myId = socket.id; });
  socket.on('lobby_state', (st) => renderLobby(st));
  socket.on('phase_hide', (p) => startHidePhase(p));
  socket.on('phase_hide_wait', (p) => startHideWait(p));
  socket.on('phase_scan', (p) => startScanPhase(p));
  socket.on('scan_scene', (p) => applyScanScene(p));
  socket.on('error_msg', (d) => toast(d.message || 'Ошибка'));
  socket.on('opponent_left', (d) => {
    stopTimer();
    Audio.stopScannerHum();
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    overlay('Игра прервана', d.message || 'Противник покинул игру');
  });
  socket.on('disconnect', () => {
    stopTimer();
    overlay('Соединение потеряно', 'Проверьте интернет и перезагрузите страницу.');
  });

  // ресайз канвасов
  window.addEventListener('resize', () => {
    if (document.getElementById('screen-hide').classList.contains('active')) renderHide();
    if (document.getElementById('screen-scan').classList.contains('active')) {
      G.scan.layout = null; // пересчитать раскладку под новую ширину
    }
  });

  // Тестовый хук: exposing состояния только при ?test в URL (для e2e).
  if (new URL(location.href).searchParams.has('test')) {
    window.__CXG = G;
    window.__CXG_helpers = { scanItemPolygons, scanItemTransform, ensureScanLayout };
  }

  // старт
  showScreen('menu');
})();