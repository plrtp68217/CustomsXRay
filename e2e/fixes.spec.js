/* ═══════════════════════════════════════════════════════════
   e2e/fixes.spec.js — точечные тесты сценария «Досмотр машины».
   Хук window.__CXG доступен только при ?test в URL.
   ═══════════════════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');

const Q = '/?test';
const SLOT_X = [-135, 0, 135, -135, 0, 135];
const SLOT_Y = [22, 22, 22, -22, -22, -22];

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
async function startToPack(hostPage, guestPage) {
  const code = await createRoom(hostPage);
  await joinRoom(guestPage, code);
  await hostPage.locator('#btnStart').waitFor({ state: 'visible' });
  await hostPage.locator('#btnStart').click();
  await Promise.all([
    waitForAny(hostPage, ['#screen-pack', '#screen-pack-wait']),
    waitForAny(guestPage, ['#screen-pack', '#screen-pack-wait'])
  ]);
  const hostIsContra = await hostPage.locator('#screen-pack').isVisible();
  return { contrabandist: hostIsContra ? hostPage : guestPage, customs: hostIsContra ? guestPage : hostPage };
}
async function packIntoSlot(page, slotIndex) {
  const canvas = page.locator('#packCanvas');
  const box = await canvas.boundingBox();
  const carCx = box.x + box.width / 2, carCy = box.y + box.height / 2;
  const startX = carCx + 280, startY = carCy;
  const targetX = carCx + SLOT_X[slotIndex], targetY = carCy + SLOT_Y[slotIndex];
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * i / 8, startY + (targetY - startY) * i / 8);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
  await page.locator('#btnPackReady').click();
}
async function clickInspectSlot(page, slotIndex) {
  const canvas = page.locator('#inspectCanvas');
  const box = await canvas.boundingBox();
  const x = box.x + box.width / 2 + SLOT_X[slotIndex];
  const y = box.y + box.height / 2 + SLOT_Y[slotIndex];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
async function waitForInspect(hostPage, guestPage, contrabandistPage) {
  await Promise.all([
    hostPage.locator('#screen-inspect').waitFor({ state: 'visible' }),
    guestPage.locator('#screen-inspect').waitFor({ state: 'visible' })
  ]);
  // isContraband есть только в раскладке контрабандиста.
  const contra = contrabandistPage || hostPage;
  await contra.waitForFunction(() => window.__CXG && window.__CXG.inspect && window.__CXG.inspect.layout && window.__CXG.inspect.layout.some(e => e.isContraband));
}

test.describe('Customs X-Ray — точечные тесты досмотра', () => {

  test('укладка: drag-ручка поворота вращает контрабанду', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist } = await startToPack(hostPage, guestPage);
      await contrabandist.locator('#screen-pack').waitFor({ state: 'visible' });
      await contrabandist.waitForFunction(() => window.__CXG && window.__CXG.pack.contraband);
      const handle = await contrabandist.evaluate(() => {
        const G = window.__CXG;
        const c = G.pack.contraPos;
        const canvas = document.getElementById('packCanvas');
        const r = canvas.getBoundingClientRect();
        const poly = G.pack.contraband.shape;
        const bb = window.Geometry.polygonBBox(poly);
        // ручка над силуэтом (вращение не влияет на bbox-центр по x)
        return { x: r.left + c.x, y: r.top + c.y + bb.minY - 22 };
      });
      const rotBefore = await contrabandist.evaluate(() => window.__CXG.pack.rot);
      await contrabandist.mouse.move(handle.x, handle.y);
      await contrabandist.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await contrabandist.mouse.move(handle.x + i * 25, handle.y);
        await contrabandist.waitForTimeout(20);
      }
      await contrabandist.mouse.up();
      const rotAfter = await contrabandist.evaluate(() => window.__CXG.pack.rot);
      expect(Math.abs(rotAfter - rotBefore)).toBeGreaterThan(0.2);
    } finally { await ctx.close(); }
  });

  test('взвешивание: Δ = контрабанда − заменённый товар', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToPack(hostPage, guestPage);
      const slot = 0;
      await packIntoSlot(contrabandist, slot);
      await waitForInspect(hostPage, guestPage, contrabandist);
      const expected = await contrabandist.evaluate(() => {
        const G = window.__CXG;
        return G.pack.contraband.weight - G.pack.fillers[G.pack.selectedSlot].weight;
      });
      await customs.locator("#btnWeigh").click();
      await customs.waitForFunction(() => window.__CXG && window.__CXG.inspect.weigh != null, null, { timeout: 3000 });
      const weigh = await customs.evaluate(() => window.__CXG.inspect.weigh);
      expect(weigh).not.toBeNull();
      expect(weigh.diff).toBe(expected);
    } finally { await ctx.close(); }
  });

  test('покачать: позиция контрабанды меняется (с ретраями)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToPack(hostPage, guestPage);
      await packIntoSlot(contrabandist, 0);
      await waitForInspect(hostPage, guestPage, contrabandist);
      const pos0 = await contrabandist.evaluate(() => {
        const e = window.__CXG.inspect.layout.find(x => x.isContraband); return e ? e.posIndex : null;
      });
      let changed = false;
      for (let i = 0; i < 3 && !changed; i++) {
        if (await customs.locator('#btnShake').isDisabled()) break;
        await customs.locator('#btnShake').click();
        await customs.waitForTimeout(150);
        const pos1 = await contrabandist.evaluate(() => {
          const e = window.__CXG.inspect.layout.find(x => x.isContraband); return e ? e.posIndex : null;
        });
        if (pos1 !== pos0) changed = true;
      }
      expect(changed).toBe(true);
    } finally { await ctx.close(); }
  });

  test('изъятие по текущей позиции после покачивания → попадание', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToPack(hostPage, guestPage);
      await packIntoSlot(contrabandist, 0);
      await waitForInspect(hostPage, guestPage, contrabandist);
      // Покачаем, пока позиция не сменится (контрабандист видит новую позицию).
      let pos = await contrabandist.evaluate(() => { const e = window.__CXG.inspect.layout.find(x => x.isContraband); return e ? e.posIndex : null; });
      const pos0 = pos;
      for (let i = 0; i < 3 && pos === pos0; i++) {
        if (await customs.locator('#btnShake').isDisabled()) break;
        await customs.locator('#btnShake').click();
        await customs.waitForTimeout(150);
        pos = await contrabandist.evaluate(() => { const e = window.__CXG.inspect.layout.find(x => x.isContraband); return e ? e.posIndex : null; });
      }
      expect(pos).not.toBeNull();
      await clickInspectSlot(customs, pos);
      await customs.locator('#btnSeizeSlot').click();

      // Раунд должен завершиться попаданием — проверим через round_result текст.
      await customs.locator('#screen-round-result').waitFor({ state: 'visible', timeout: 5000 });
      const detail = (await customs.locator('#resultDetail').textContent()).trim();
      expect(detail).toContain('изъял контрабанду');
    } finally { await ctx.close(); }
  });

  test('звук: mute глушит гул и возвращается', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      const { contrabandist, customs } = await startToPack(hostPage, guestPage);
      await packIntoSlot(contrabandist, 0);
      await waitForInspect(hostPage, guestPage, contrabandist);
      await customs.evaluate(() => { window.Audio.init(); window.Audio.resume(); window.Audio.startScannerHum(); });
      const before = await customs.evaluate(() => ({ enabled: window.Audio.enabled, hum: !!window.Audio.scannerHum }));
      expect(before.enabled).toBe(true); expect(before.hum).toBe(true);
      await customs.locator('#soundToggle').click();
      const after = await customs.evaluate(() => ({ enabled: window.Audio.enabled, humStopped: !window.Audio.scannerHum }));
      expect(after.enabled).toBe(false); expect(after.humStopped).toBe(true);
      await customs.locator('#soundToggle').click();
      const on = await customs.evaluate(() => ({ enabled: window.Audio.enabled, hum: !!window.Audio.scannerHum }));
      expect(on.enabled).toBe(true); expect(on.hum).toBe(true);
    } finally { await ctx.close(); }
  });
});