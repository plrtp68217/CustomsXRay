/**
 * e2e-server.js — запускает server.js с короткими таймерами для быстрых e2e.
 */
process.env.PACK_TIME_MS = '3000';
process.env.INSPECT_TIME_MS = '8000';
process.env.ROUND_RESULT_TIME_MS = '700';
process.env.PORT = '3000';
require('./server.js');