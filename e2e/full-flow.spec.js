/* ═══════════════════════════════════════════════════════════
   e2e/full-flow.spec.js — сквозные тесты «Таможня: Досмотр машины».
   Два браузера (хост + гость) проходят весь цикл из 3 раундов.
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

/** Перетащить контрабанду в слот slotIndex и нажать «Готово». */
async function packIntoSlot(contrabandistPage, slotIndex) {
  const canvas = contrabandistPage.locator('#packCanvas');
  await canvas.waitFor({ state: 'visible' });
  const box = await canvas.boundingBox();
  const carCx = box.x + box.width / 2, carCy = box.y + box.height / 2;
  const startX = carCx + 280, startY = carCy;
  const targetX = carCx + SLOT_X[slotIndex], targetY = carCy + SLOT_Y[slotIndex];
  await contrabandistPage.mouse.move(startX, startY);
  await contrabandistPage.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await contrabandistPage.mouse.move(startX + (targetX - startX) * i / 8, startY + (targetY - startY) * i / 8);
    await contrabandistPage.waitForTimeout(15);
  }
  await contrabandistPage.mouse.up();
  await contrabandistPage.waitForTimeout(80);
  await contrabandistPage.locator('#btnPackReady').click();
}

/** Кликнуть по слоту на канвасе досмотра (открывает меню). */
async function clickInspectSlot(customsPage, slotIndex) {
  const canvas = customsPage.locator('#inspectCanvas');
  const box = await canvas.boundingBox();
  const x = box.x + box.width / 2 + SLOT_X[slotIndex];
  const y = box.y + box.height / 2 + SLOT_Y[slotIndex];
  await customsPage.mouse.move(x, y);
  await customsPage.mouse.down();
  await customsPage.mouse.up();
}

/** Текущая позиция контрабанды (posIndex) со страницы контрабандиста. */
function contrabandPosIndex(contrabandistPage) {
  return contrabandistPage.evaluate(() => {
    const lay = window.__CXG && window.__CXG.inspect && window.__CXG.inspect.layout;
    if (!lay) return null;
    const e = lay.find(x => x.isContraband);
    return e ? e.posIndex : null;
  });
}

async function playRound(hostPage, guestPage, mode) {
  // Роли в этом раунде определяем по экрану укладки.
  await Promise.all([
    waitForAny(hostPage, ['#screen-pack', '#screen-pack-wait']),
    waitForAny(guestPage, ['#screen-pack', '#screen-pack-wait'])
  ]);
  const hostIsContra = await hostPage.locator('#screen-pack').isVisible();
  const contrabandist = hostIsContra ? hostPage : guestPage;
  const customs = hostIsContra ? guestPage : hostPage;

  if (mode === 'seize') {
    await packIntoSlot(contrabandist, 0);
    await Promise.all([
      hostPage.locator('#screen-inspect').waitFor({ state: 'visible' }),
      guestPage.locator('#screen-inspect').waitFor({ state: 'visible' })
    ]);
    await contrabandist.waitForFunction(() => window.__CXG && window.__CXG.inspect && window.__CXG.inspect.layout && window.__CXG.inspect.layout.some(e => e.isContraband));
    await customs.locator('#btnXray').click();
    await customs.locator('#btnWeigh').click();
    await clickInspectSlot(customs, 0);
    await customs.locator('#btnInterrogateSlot').click();
    await contrabandist.locator('#answerOverlay').waitFor({ state: 'visible', timeout: 3000 });
    await contrabandist.locator('#ansCalm').click();
    await customs.locator('#interrogLog').waitFor({ state: 'visible', timeout: 3000 });
    const pos = await contrabandPosIndex(contrabandist);
    expect(pos).not.toBeNull();
    await clickInspectSlot(customs, pos);
    await customs.locator('#btnSeizeSlot').click();
  } else {
    await packIntoSlot(contrabandist, 1);
    await Promise.all([
      hostPage.locator('#screen-inspect').waitFor({ state: 'visible' }),
      guestPage.locator('#screen-inspect').waitFor({ state: 'visible' })
    ]);
    await customs.locator('#btnPass').click();
  }

  await Promise.all([
    waitForAny(hostPage, ['#screen-round-result', '#screen-game-over']),
    waitForAny(guestPage, ['#screen-round-result', '#screen-game-over'])
  ]);
}

async function playFullGame(hostPage, guestPage, mode) {
  const code = await createRoom(hostPage);
  await joinRoom(guestPage, code);
  await hostPage.locator('#btnStart').waitFor({ state: 'visible' });
  await hostPage.locator('#btnStart').click();
  for (let r = 0; r < 3; r++) {
    await playRound(hostPage, guestPage, mode);
  }
  await Promise.all([
    hostPage.locator('#screen-game-over').waitFor({ state: 'visible', timeout: 12000 }),
    guestPage.locator('#screen-game-over').waitFor({ state: 'visible', timeout: 12000 })
  ]);
  await expect(hostPage.locator('#winnerBox')).toBeVisible();
  await expect(guestPage.locator('#winnerBox')).toBeVisible();
}

test.describe('Customs X-Ray — полный игровой цикл (досмотр машины)', () => {
  test('3 раунда: таможенник находит контрабанду по позиции', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try { await playFullGame(hostPage, guestPage, 'seize'); }
    finally { await ctx.close(); }
  });
  test('3 раунда: таможенник пропускает машину', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try { await playFullGame(hostPage, guestPage, 'pass'); }
    finally { await ctx.close(); }
  });
});