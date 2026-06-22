/* ═══════════════════════════════════════════════════════════
   e2e/fixes.spec.js — точечные тесты на исправления багов и предложение.
   Хук window.__CXG / __CXG_helpers доступен только при ?test в URL.
   ═══════════════════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');

const Q = '/?test';

async function createRoom(hostPage, name = 'Хост') {
  await hostPage.goto(Q);
  await hostPage.locator('#screen-menu').waitFor({ state: 'visible' });
  await hostPage.locator('#btnCreate').click();
  await hostPage.locator('#inputNameCreate').fill(name);
  await hostPage.locator('#inputNameCreate').press('Enter');
  await hostPage.locator('#screen-lobby').waitFor({ state: 'visible' });
  return (await hostPage.locator('#lobbyCode').textContent()).trim();
}

async function joinRoom(guestPage, code, name = 'Гость') {
  await guestPage.goto(Q);
  await guestPage.locator('#btnJoin').click();
  await guestPage.locator('#inputRoomId').fill(code);
  await guestPage.locator('#inputNameJoin').fill(name);
  await guestPage.locator('#btnJoinConfirm').click();
  await guestPage.locator('#screen-lobby').waitFor({ state: 'visible' });
}

async function waitForAny(page, selectors, timeout = 15000) {
  await Promise.race(selectors.map(s => page.locator(s).waitFor({ state: 'visible', timeout })));
}

async function startToHide(hostPage, guestPage) {
  const code = await createRoom(hostPage);
  await joinRoom(guestPage, code);
  await hostPage.locator('#btnStart').waitFor({ state: 'visible' });
  await hostPage.locator('#btnStart').click();
  await Promise.all([
    waitForAny(hostPage, ['#screen-hide', '#screen-hide-wait']),
    waitForAny(guestPage, ['#screen-hide', '#screen-hide-wait'])
  ]);
  const hostIsContra = await hostPage.locator('#screen-hide').isVisible();
  return {
    contrabandist: hostIsContra ? hostPage : guestPage,
    customs: hostIsContra ? guestPage : hostPage
  };
}

/** Текущая выступающая точка контрабанды (в viewport-координатах) или null. */
function findProtrusion(page) {
  return page.evaluate(() => {
    const G = window.__CXG, H = window.__CXG_helpers;
    if (!G || !H) return null;
    const idx = G.scan.scanItems.findIndex(si => si.id === G.scan.contrabandItemId);
    if (idx < 0) return null;
    const polys = H.scanItemPolygons(idx);
    if (!polys.contraband) return null;
    const r = document.getElementById('scanCanvas').getBoundingClientRect();
    const bb = window.Geometry.polygonBBox(polys.contraband);
    for (let y = bb.minY; y <= bb.maxY; y += 3) {
      for (let x = bb.minX; x <= bb.maxX; x += 3) {
        if (window.Geometry.pointInPolygon(x, y, polys.contraband) &&
            !window.Geometry.pointInPolygon(x, y, polys.legal)) {
          return { x: r.left + x, y: r.top + y };
        }
      }
    }
    return null;
  });
}

test.describe('Customs X-Ray — исправления багов', () => {

  test('баг 3: предметы на рентгене не перекрываются (конвейерная петля)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist } = await startToHide(hostPage, guestPage);
      await contrabandist.locator('#btnReady').click();
      await Promise.all([
        hostPage.locator('#screen-scan').waitFor({ state: 'visible' }),
        guestPage.locator('#screen-scan').waitFor({ state: 'visible' })
      ]);
      const page = hostPage;
      await page.waitForFunction(() => window.__CXG && window.__CXG.scan.layout && window.__CXG.scan.scanItems.length > 0);
      const ok = await page.evaluate(() => {
        const G = window.__CXG, H = window.__CXG_helpers;
        const canvas = document.getElementById('scanCanvas');
        const lay = H.ensureScanLayout(canvas.clientWidth);
        return lay.slot - lay.maxWS > 0; // шаг петли >= макс. ширины -> нет перекрытий
      });
      expect(ok).toBe(true);
    } finally { await ctx.close(); }
  });

  test('баг 2: выступающую за легальный силуэт контрабанду можно нажать', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToHide(hostPage, guestPage);
      await contrabandist.locator('#btnReady').click();
      await Promise.all([
        hostPage.locator('#screen-scan').waitFor({ state: 'visible' }),
        guestPage.locator('#screen-scan').waitFor({ state: 'visible' })
      ]);
      await customs.waitForFunction(() => {
        const G = window.__CXG;
        return G && G.scan.layout && G.scan.placement && G.scan.cavity && G.scan.contrabandItemId;
      });

      // Предметы едут и качаются — кликаем выступающую точку с ретраями, пока не откроется меню.
      const deadline = Date.now() + 12000;
      let seized = false;
      while (Date.now() < deadline && !seized) {
        if (await customs.locator('#screen-round-result').isVisible()) { seized = true; break; }
        const pt = await findProtrusion(customs);
        if (pt && pt.x > 5 && pt.x < 1275) {
          await customs.mouse.move(pt.x, pt.y);
          await customs.mouse.down();
          await customs.mouse.up();
          if (await customs.locator('#seizeMenu').isVisible().catch(() => false)) {
            await customs.locator('#btnSeize').click({ force: true });
            await customs.waitForTimeout(250);
            seized = await customs.locator('#screen-round-result').isVisible();
          }
        }
        await customs.waitForTimeout(80);
      }
      expect(seized).toBe(true);
    } finally { await ctx.close(); }
  });

  test('предложение: ручка поворота на предмете — drag влево/вправо вращает', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist } = await startToHide(hostPage, guestPage);
      await contrabandist.locator('#screen-hide').waitFor({ state: 'visible' });
      await contrabandist.waitForFunction(() => window.__CXG && window.__CXG.hide.item);

      const handle = await contrabandist.evaluate(() => {
        const G = window.__CXG;
        const item = G.hide.item, pl = G.hide.placement;
        const canvas = document.getElementById('hideCanvas');
        const r = canvas.getBoundingClientRect();
        const LX = canvas.clientWidth / 2, LY = canvas.clientHeight / 2;
        const cb = window.Geometry.polygonBBox(item.contraband);
        const cx = cb.minX + cb.w / 2, cy = cb.minY + cb.h / 2;
        const contra = window.Geometry.transformPolygon(item.contraband, LX + pl.dx, LY + pl.dy, pl.rot, cx, cy);
        const bb = window.Geometry.polygonBBox(contra);
        return { x: r.left + (bb.minX + bb.w / 2), y: r.top + bb.minY - 22 };
      });
      expect(handle).toBeTruthy();

      const rotBefore = await contrabandist.evaluate(() => window.__CXG.hide.placement.rot);
      await contrabandist.mouse.move(handle.x, handle.y);
      await contrabandist.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await contrabandist.mouse.move(handle.x + i * 25, handle.y);
        await contrabandist.waitForTimeout(20);
      }
      await contrabandist.mouse.up();
      const rotAfter = await contrabandist.evaluate(() => window.__CXG.hide.placement.rot);
      expect(Math.abs(rotAfter - rotBefore)).toBeGreaterThan(0.2);
    } finally { await ctx.close(); }
  });

  test('баг 1: кнопка звука глушит гул сканера и возвращается обратно', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToHide(hostPage, guestPage);
      await contrabandist.locator('#btnReady').click();
      await customs.locator('#screen-scan').waitFor({ state: 'visible' });
      await customs.evaluate(() => { window.Audio.init(); window.Audio.resume(); window.Audio.startScannerHum(); });
      const before = await customs.evaluate(() => ({ enabled: window.Audio.enabled, hum: !!window.Audio.scannerHum }));
      expect(before.enabled).toBe(true);
      expect(before.hum).toBe(true);

      await customs.locator('#soundToggle').click();
      const after = await customs.evaluate(() => ({ enabled: window.Audio.enabled, humStopped: !window.Audio.scannerHum }));
      expect(after.enabled).toBe(false);
      expect(after.humStopped).toBe(true);

      await customs.locator('#soundToggle').click();
      const onAgain = await customs.evaluate(() => ({ enabled: window.Audio.enabled, hum: !!window.Audio.scannerHum }));
      expect(onAgain.enabled).toBe(true);
      expect(onAgain.hum).toBe(true);
    } finally { await ctx.close(); }
  });
});