/* ═══════════════════════════════════════════════════════════
   e2e/full-flow.spec.js — сквозные Playwright-тести Customs X-Ray.
   Два реальных браузера (хост + гость) проходят весь игровой цикл.
   ═══════════════════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');

/** Ждёт, пока хоть один из селекторов не станет видимым (union-ожидание без .first()). */
async function waitForAny(page, selectors, timeout = 15000) {
  await Promise.race(selectors.map(sel =>
    page.locator(sel).waitFor({ state: 'visible', timeout })
  ));
}

/** Создать комнату хостом и вернуть код комнаты. */
async function createRoom(hostPage, name = 'Хост') {
  await hostPage.goto('/');
  await hostPage.locator('#screen-menu').waitFor({ state: 'visible' });
  await hostPage.locator('#btnCreate').click();
  await hostPage.locator('#inputNameCreate').fill(name);
  await hostPage.locator('#inputNameCreate').press('Enter');
  await hostPage.locator('#screen-lobby').waitFor({ state: 'visible' });
  const code = (await hostPage.locator('#lobbyCode').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);
  return code;
}

/** Гость подключается по коду. */
async function joinRoom(guestPage, code, name = 'Гость') {
  await guestPage.goto('/');
  await guestPage.locator('#screen-menu').waitFor({ state: 'visible' });
  await guestPage.locator('#btnJoin').click();
  await guestPage.locator('#inputRoomId').fill(code);
  await guestPage.locator('#inputNameJoin').fill(name);
  await guestPage.locator('#btnJoinConfirm').click();
  await guestPage.locator('#screen-lobby').waitFor({ state: 'visible' });
}

/** Определяет, кто контрабандист в текущем раунде, по появившемуся экрану. */
async function resolveRoles(hostPage, guestPage) {
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

/** Таможенник перебирает предметы на ленте и изымает, пока раунд не завершится.
 *  Предметы едут по конвейеру — поэтому циклически кликаем по нескольким точкам ленты,
 *  пока не зацепим контрабанду (или фаза не закончится по таймеру). */
async function seizeUntilRoundEnd(customsPage) {
  const canvas = customsPage.locator('#scanCanvas');
  await canvas.waitFor({ state: 'visible' });
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    if (await customsPage.locator('#screen-round-result').isVisible()) return;
    if (await customsPage.locator('#screen-game-over').isVisible()) return;
    const box = await canvas.boundingBox();
    const beltY = box.y + box.height / 2;
    for (let i = 1; i <= 6; i++) {
      if (await customsPage.locator('#screen-round-result').isVisible()) return;
      const x = box.x + (box.width * i) / 7;
      await customsPage.mouse.move(x, beltY);
      await customsPage.mouse.down();
      await customsPage.mouse.up();
      const menu = customsPage.locator('#seizeMenu');
      const visible = await menu.isVisible().catch(() => false);
      if (visible) {
        await customsPage.locator('#btnSeize').click({ force: true });
        await customsPage.waitForTimeout(250);
        if (await customsPage.locator('#screen-round-result').isVisible()) return;
      } else {
        await customsPage.waitForTimeout(40);
      }
    }
    await customsPage.waitForTimeout(80);
  }
  // Если контрабанду не нашли — ждём завершения фазы по серверному таймеру.
  await waitForAny(customsPage, ['#screen-round-result', '#screen-game-over'], 8000);
}

/** Играет один раунд: укладка → рентген → результат. */
async function playRound(hostPage, guestPage, seizeMode) {
  const { contrabandist, customs } = await resolveRoles(hostPage, guestPage);

  // Контрабандист сразу отправляет плейсмент (match ~ 0 → контрабанда ярко видна).
  await contrabandist.locator('#btnReady').click();

  // Оба ждут фазу рентгена.
  await Promise.all([
    hostPage.locator('#screen-scan').waitFor({ state: 'visible' }),
    guestPage.locator('#screen-scan').waitFor({ state: 'visible' })
  ]);

  if (seizeMode === 'seize') {
    await seizeUntilRoundEnd(customs);
  } else {
    // режим «бездействие» — ждём окончания фазы по таймеру
    await waitForAny(customs, ['#screen-round-result', '#screen-game-over'], 15000);
  }

  // Оба видят результат раунда.
  await Promise.all([
    waitForAny(hostPage, ['#screen-round-result', '#screen-game-over']),
    waitForAny(guestPage, ['#screen-round-result', '#screen-game-over'])
  ]);
}

/** Ждёт либо следующего раунда (экран укладки), либо финала. */
async function nextRoundOrGameOver(hostPage, guestPage) {
  await Promise.all([
    waitForAny(hostPage, ['#screen-hide', '#screen-hide-wait', '#screen-game-over'], 10000),
    waitForAny(guestPage, ['#screen-hide', '#screen-hide-wait', '#screen-game-over'], 10000)
  ]);
}

/** Прогон всей игры (3 раунда) и проверка финала. */
async function playFullGame(hostPage, guestPage, seizeMode) {
  const code = await createRoom(hostPage);
  await joinRoom(guestPage, code);

  // Хост видит гостя и жмёт Старт.
  await hostPage.locator('#btnStart').waitFor({ state: 'visible' });
  await hostPage.locator('#btnStart').click();

  for (let r = 0; r < 3; r++) {
    await playRound(hostPage, guestPage, seizeMode);
    if (r < 2) await nextRoundOrGameOver(hostPage, guestPage);
  }

  // Финал.
  await Promise.all([
    hostPage.locator('#screen-game-over').waitFor({ state: 'visible', timeout: 10000 }),
    guestPage.locator('#screen-game-over').waitFor({ state: 'visible', timeout: 10000 })
  ]);
  await expect(hostPage.locator('#winnerBox')).toBeVisible();
  await expect(guestPage.locator('#winnerBox')).toBeVisible();
  await expect(hostPage.locator('#finalScores')).toContainText(/Вы:/);
}

// ─────────────────────────────────────────────────────────────
//  Тесты
// ─────────────────────────────────────────────────────────────

test.describe('Customs X-Ray — полный игровой цикл', () => {

  test('3 раунда, таможенник изымает предметы', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      await playFullGame(hostPage, guestPage, 'seize');
    } finally {
      await ctx.close();
    }
  });

  test('3 раунда, таможенник бездействует (контрабандист побеждает в раундах)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const hostPage = await ctx.newPage();
    const guestPage = await ctx.newPage();
    try {
      await playFullGame(hostPage, guestPage, 'idle');
    } finally {
      await ctx.close();
    }
  });
});