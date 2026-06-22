/**
 * e2e-server.js — запускает server.js с короткими таймерами для быстрых e2e-тестов.
 * Не используется в проде; только Playwright.
 */
process.env.HIDE_TIME_MS = '2500';
process.env.SCAN_TIME_MS = '9000';
process.env.ROUND_RESULT_TIME_MS = '700';
process.env.PORT = '3000';
require('./server.js');