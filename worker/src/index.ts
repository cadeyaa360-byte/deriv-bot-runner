// ============================================================================
// DERIV BOT — CONTROL LAYER (Cloudflare Worker)
//
// Responsibilities:
//   1. Telegram bot - remote control (pause/resume, mode switch, status, report)
//   2. Live state store (KV) - mode, paused flag, daily P&L, loss limit
//   3. Safety rails - kill switch, daily loss circuit breaker, two-step real
//      account switch (5-min expiry), watchdog heartbeat check
//   4. Trade history (D1) - every trade GitHub Actions places gets logged here
//   5. Candle-coverage tracking (KV) - lets liveRun.ts catch up on signals
//      missed between cron runs, instead of only checking the latest candle
//   6. Generic alert relay - lets liveRun.ts push ad hoc Telegram warnings
//      (execution latency, symbol health) without needing its own bot token
//
// GitHub Actions calls this Worker before AND after every trading run:
//   GET  /state          -> should I trade right now? (mode, paused, loss limit hit)
//   GET  /last-candles    -> map of symbol -> last processed candle epoch
//   POST /last-candles    -> overwrite that map (single KV write per run)
//   POST /alert           -> relay an ad hoc warning to Telegram
//   POST /heartbeat       -> "I ran successfully at time T"
//   POST /log-trade       -> "here's what happened this run"
// All require: Authorization: Bearer <API_SHARED_SECRET>
//
// A Cloudflare Cron Trigger (defined in wrangler.toml) calls this Worker's
// scheduled() handler every minute to check whether GitHub Actions has gone
// silent (watchdog), independent of whether GitHub Actions itself is healthy.
// ============================================================================

export interface Env {
  STATE_KV: KVNamespace;
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  CONFIRM_PHRASE: string;
  API_SHARED_SECRET: string;
  HEARTBEAT_STALE_MINUTES?: string;
}

type Mode = 'demo' | 'real';

interface BotState {
  mode: Mode;
  paused: boolean;
  pendingRealConfirm: boolean;
  pendingRealConfirmExpiry: number;
  dailyLossLimit: number;
  dailyLoss: number;
  dailyWins: number;
  dailyWinPnl: number;
  dailyLossDate: string;
  lastHeartbeat: number;
  balance: number;
}

const DEFAULT_STATE: BotState = {
  mode: 'demo',
  paused: false,
  pendingRealConfirm: false,
  pendingRealConfirmExpiry: 0,
  dailyLossLimit: 0,
  dailyLoss: 0,
  dailyWins: 0,
  dailyWinPnl: 0,
  dailyLossDate: todayStr(),
  lastHeartbeat: 0,
  balance: 0,
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getState(env: Env): Promise<BotState> {
  const raw = await env.STATE_KV.get('bot_state');
  if (!raw) return { ...DEFAULT_STATE };
  const state = JSON.parse(raw) as BotState;
  if (state.dailyLossDate !== todayStr()) {
    state.dailyLoss = 0;
    state.dailyWins = 0;
    state.dailyWinPnl = 0;
    state.dailyLossDate = todayStr();
  }
  return state;
}

async function setState(env: Env, state: BotState): Promise<void> {
  await env.STATE_KV.put('bot_state', JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function sendTelegram(env: Env, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

function fmtState(s: BotState): string {
  const statusLine = s.paused ? '[PAUSED]' : '[RUNNING]';
  const modeLine = s.mode === 'real' ? '[REAL]' : '[demo]';
  const lossLine = s.dailyLossLimit > 0
    ? `Daily loss: ${s.dailyLoss.toFixed(2)} / ${s.dailyLossLimit.toFixed(2)} limit`
    : `Daily loss: ${s.dailyLoss.toFixed(2)} (no limit set)`;
  const hbAge = s.lastHeartbeat
    ? `${Math.round((Date.now() - s.lastHeartbeat) / 60000)} min ago`
    : 'never';
  return `${statusLine} - ${modeLine}\n${lossLine}\nLast run: ${hbAge}`;
}

function canTrade(s: BotState): boolean {
  if (s.paused) return false;
  if (s.dailyLossLimit > 0 && s.dailyLoss >= s.dailyLossLimit) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Telegram command handling
// ---------------------------------------------------------------------------

async function handleTelegramUpdate(update: any, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;

  const text: string = msg.text.trim();
  const state = await getState(env);

  if (text === '/start') {
    await sendTelegram(env,
      '*Deriv bot control*\n\n' +
      '/status - current state\n' +
      '/stop - pause trading (kill switch)\n' +
      '/resume - resume trading\n' +
      '/switchreal - begin switch to real account (requires confirmation, expires in 5 min)\n' +
      '/switchdemo - switch back to demo (instant, no confirmation)\n' +
      '/setlimit <amount> - set daily loss limit (0 disables)\n' +
      '/report - last 10 trades'
    );
    return;
  }

  if (text === '/status') {
    await sendTelegram(env, fmtState(state));
    return;
  }

  if (text === '/stop') {
    state.paused = true;
    await setState(env, state);
    await sendTelegram(env, '[PAUSED] Trading paused. No new orders will be placed until /resume.');
    return;
  }

  if (text === '/resume') {
    state.paused = false;
    await setState(env, state);
    await sendTelegram(env, '[RUNNING] Trading resumed.');
    return;
  }

  if (text === '/switchdemo') {
    state.mode = 'demo';
    state.pendingRealConfirm = false;
    state.pendingRealConfirmExpiry = 0;
    await setState(env, state);
    await sendTelegram(env, '[demo] Switched to demo mode.');
    return;
  }

  if (text === '/switchreal') {
    state.pendingRealConfirm = true;
    state.pendingRealConfirmExpiry = Date.now() + 5 * 60 * 1000;
    await setState(env, state);
    await sendTelegram(env,
      'WARNING: this will switch to REAL money trading.\n\n' +
      `To confirm within 5 minutes, send:\n/confirm ${env.CONFIRM_PHRASE}\n\n` +
      'Send anything else to cancel.'
    );
    return;
  }

  if (text.startsWith('/confirm')) {
    if (!state.pendingRealConfirm) {
      await sendTelegram(env, 'No pending real-account switch. Use /switchreal first.');
      return;
    }
    if (Date.now() > state.pendingRealConfirmExpiry) {
      state.pendingRealConfirm = false;
      state.pendingRealConfirmExpiry = 0;
      await setState(env, state);
      await sendTelegram(env, 'Confirmation window expired (5 min). Use /switchreal again if you still want to switch to real.');
      return;
    }
    const phrase = text.replace('/confirm', '').trim();
    if (phrase === env.CONFIRM_PHRASE) {
      state.mode = 'real';
      state.pendingRealConfirm = false;
      state.pendingRealConfirmExpiry = 0;
      await setState(env, state);
      await sendTelegram(env, '[REAL] Switched to REAL account. Trading live money now.');
    } else {
      state.pendingRealConfirm = false;
      state.pendingRealConfirmExpiry = 0;
      await setState(env, state);
      await sendTelegram(env, 'Confirmation phrase did not match. Real-account switch cancelled.');
    }
    return;
  }

  if (text.startsWith('/setlimit')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount < 0) {
      await sendTelegram(env, 'Usage: /setlimit <amount>  (e.g. /setlimit 5, or /setlimit 0 to disable)');
      return;
    }
    state.dailyLossLimit = amount;
    await setState(env, state);
    await sendTelegram(env, amount === 0
      ? 'Daily loss limit disabled.'
      : `Daily loss limit set to ${amount.toFixed(2)}.`);
    return;
  }

  if (text === '/report') {
    try {
      const { results } = await env.DB.prepare(
        'SELECT opened_at, symbol, direction, result, pnl, mode FROM trades ORDER BY opened_at DESC LIMIT 10'
      ).all();
      if (!results || results.length === 0) {
        await sendTelegram(env, 'No trades logged yet.');
        return;
      }
      const lines = results.map((r: any) =>
        `${new Date(r.opened_at).toISOString().slice(0, 16).replace('T', ' ')} | ${r.symbol} ${r.direction} | ${r.result} | ${Number(r.pnl).toFixed(2)} | ${r.mode}`
      );
      await sendTelegram(env, '*Last 10 trades:*\n' + lines.join('\n'));
    } catch (err: any) {
      await sendTelegram(env, `Failed to read trade history: ${err.message}`);
    }
    return;
  }

  await sendTelegram(env, 'Unknown command. Send /start for the command list.');
}

// ---------------------------------------------------------------------------
// GitHub Actions endpoints (require API_SHARED_SECRET)
// ---------------------------------------------------------------------------

function checkAuth(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') || '';
  return auth === `Bearer ${env.API_SHARED_SECRET}`;
}

async function handleGetState(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });
  const state = await getState(env);
  return Response.json({
    mode: state.mode,
    paused: state.paused,
    canTrade: canTrade(state),
    dailyLoss: state.dailyLoss,
    dailyLossLimit: state.dailyLossLimit,
  });
}

async function handleGetLastCandles(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });
  const raw = await env.STATE_KV.get('last_candles');
  return new Response(raw ?? '{}', { headers: { 'Content-Type': 'application/json' } });
}

async function handleSetLastCandles(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json body', { status: 400 });
  }
  await env.STATE_KV.put('last_candles', JSON.stringify(body));
  return new Response('ok');
}

async function handleAlert(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json body', { status: 400 });
  }
  if (!body.text) return new Response('missing text field', { status: 400 });
  await sendTelegram(env, `[ALERT] ${body.text}`);
  return new Response('ok');
}

async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });
  const state = await getState(env);
  state.lastHeartbeat = Date.now();
  try {
    const body = await req.json() as { balance?: number };
    if (typeof body.balance === 'number' && !isNaN(body.balance)) {
      state.balance = body.balance;
    }
  } catch {
    // no body or invalid json -- fine, heartbeat still counts
  }
  await setState(env, state);
  await env.STATE_KV.delete('watchdog_alerted');
  return new Response('ok');
}

interface LogTradeBody {
  contract_id?: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry_price?: number;
  exit_price?: number;
  stake: number;
  payout?: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  opened_at: number;
  closed_at?: number;
}

async function handleLogTrade(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return new Response('unauthorized', { status: 401 });

  let body: LogTradeBody;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json body', { status: 400 });
  }
  if (!body.symbol || !body.direction || !body.result || typeof body.pnl !== 'number' || typeof body.stake !== 'number' || !body.opened_at) {
    return new Response('missing required fields: symbol, direction, result, pnl, stake, opened_at', { status: 400 });
  }

  const state = await getState(env);

  try {
    await env.DB.prepare(
      'INSERT INTO trades (contract_id, symbol, direction, entry_price, exit_price, stake, payout, result, pnl, mode, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      body.contract_id ?? null,
      body.symbol,
      body.direction,
      body.entry_price ?? null,
      body.exit_price ?? null,
      body.stake,
      body.payout ?? null,
      body.result,
      body.pnl,
      state.mode,
      body.opened_at,
      body.closed_at ?? null
    ).run();
  } catch (err: any) {
    return new Response(`db insert failed: ${err.message}`, { status: 500 });
  }

  if (body.result === 'LOSS') {
    state.dailyLoss += Math.abs(body.pnl);
  } else if (body.result === 'WIN') {
    state.dailyWins += 1;
    state.dailyWinPnl += body.pnl;
  }
  await setState(env, state);

  const modeTag = state.mode === 'real' ? '[REAL]' : '[demo]';
  const resultTag = body.result === 'WIN' ? 'WIN' : 'LOSS';
  await sendTelegram(env,
    `${resultTag} ${modeTag}\n` +
    `${body.symbol} ${body.direction}\n` +
    `P&L: ${body.pnl.toFixed(2)}\n` +
    `Daily loss: ${state.dailyLoss.toFixed(2)}${state.dailyLossLimit > 0 ? ' / ' + state.dailyLossLimit.toFixed(2) : ''}`
  );

  if (state.dailyLossLimit > 0 && state.dailyLoss >= state.dailyLossLimit && !state.paused) {
    state.paused = true;
    await setState(env, state);
    await sendTelegram(env,
      `[PAUSED] Daily loss limit reached (${state.dailyLoss.toFixed(2)} / ${state.dailyLossLimit.toFixed(2)}). Trading auto-paused. Use /resume to continue.`
    );
  }

  return new Response('ok');
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

async function checkWatchdog(env: Env): Promise<void> {
  const state = await getState(env);
  if (state.paused) return;
  if (!state.lastHeartbeat) return;

  const staleMinutes = env.HEARTBEAT_STALE_MINUTES ? parseFloat(env.HEARTBEAT_STALE_MINUTES) : 10;
  const ageMinutes = (Date.now() - state.lastHeartbeat) / 60000;

  if (ageMinutes > staleMinutes) {
    const alreadyAlerted = await env.STATE_KV.get('watchdog_alerted');
    if (!alreadyAlerted) {
      await sendTelegram(env,
        `WATCHDOG ALERT: no successful run in ${Math.round(ageMinutes)} minutes.\n` +
        `GitHub Actions may have stopped running. Check the Actions tab.`
      );
      await env.STATE_KV.put('watchdog_alerted', '1', { expirationTtl: 3600 });
    }
  } else {
    await env.STATE_KV.delete('watchdog_alerted');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/telegram-webhook' && req.method === 'POST') {
      const update = await req.json();
      await handleTelegramUpdate(update, env);
      return new Response('ok');
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      return handleGetState(req, env);
    }

    if (url.pathname === '/last-candles' && req.method === 'GET') {
      return handleGetLastCandles(req, env);
    }

    if (url.pathname === '/last-candles' && req.method === 'POST') {
      return handleSetLastCandles(req, env);
    }

    if (url.pathname === '/alert' && req.method === 'POST') {
      return handleAlert(req, env);
    }

    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      return handleHeartbeat(req, env);
    }

    if (url.pathname === '/log-trade' && req.method === 'POST') {
      return handleLogTrade(req, env);
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkWatchdog(env));
  },
};