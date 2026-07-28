export default async function (req: Request): Promise<Response> {
  const DERIV_TOKEN = Deno.env.get("DERIV_TOKEN");
  const WORKER_URL = Deno.env.get("WORKER_URL");
  const API_SHARED_SECRET = Deno.env.get("API_SHARED_SECRET");
  const ALLOW_REAL_TRADING = Deno.env.get("ALLOW_REAL_TRADING");

  if (!DERIV_TOKEN || !WORKER_URL || !API_SHARED_SECRET) {
    return Response.json({ error: "Missing DERIV_TOKEN, WORKER_URL, or API_SHARED_SECRET env var" }, { status: 500 });
  }

  const APP_ID = '33UTL66zPwWIqDVfECusS';
  const REST_BASE = 'https://api.derivws.com/trading/v1/options';
  const GRANULARITY_SEC = 60;
  const EXPIRY_MIN = 3;
  const AGREEMENT_WINDOW = 3;
  const ADX_THRESHOLD = 25;
  const BREADTH_WINDOW_MIN = 2;
  const HISTORY_CANDLES = 300;
  const MAX_TRADES_PER_RUN = 8;
  const MIN_STAKE = 0.35;

  const GROUPS: Record<string, string[]> = {
    FOREX: ['frxGBPCHF','frxEURUSD','frxUSDPLN','frxEURNZD','frxEURAUD','frxAUDCHF','frxNZDUSD','frxUSDCHF','frxGBPUSD','frxEURGBP','frxAUDUSD','frxUSDCAD','frxAUDNZD','frxEURCAD','frxNZDJPY','frxAUDJPY','frxGBPAUD','frxEURJPY','frxAUDCAD','frxGBPNZD','frxGBPCAD','frxUSDMXN'],
    INDICES: ['OTC_SSMI','OTC_NDX','OTC_GDAXI','OTC_N225','OTC_SPC','OTC_HSI','OTC_AS51','OTC_DJI','OTC_SX5E','OTC_FCHI','OTC_FTSE','OTC_AEX'],
    COMMODITIES: ['frxXPTUSD','frxXAUUSD','frxXAGUSD'],
    CRYPTO: ['cryETHUSD','cryBTCUSD'],
  };

  const KELLY_TABLE: Record<string, number[]> = {
    FOREX:       [0.0417, 0.0417, 0.0500, 0.0461, 0.0500],
    INDICES:     [0.0450, 0.0450, 0.0450, 0.0460, 0.0500],
    COMMODITIES: [0.0387, 0.0500, 0.0500, 0.0500, 0.0500],
    CRYPTO:      [0.0413, 0.0500, 0.0500, 0.0500, 0.0500],
  };

  interface Candle { time: number; open: number; high: number; low: number; close: number; }
  type Direction = 'BUY' | 'SELL';
  interface Trigger { index: number; dir: Direction; }
  interface CandidateSignal { symbol: string; group: string; index: number; dir: Direction; time: number; adx: number; entryPrice: number; }

  function cmoTriggers(candles: Candle[]): Trigger[] {
    const period = 9;
    const closes = candles.map(c => c.close);
    const cmo: number[] = new Array(closes.length).fill(0);
    for (let i = period; i < closes.length; i++) {
      let up = 0, down = 0;
      for (let k = i - period + 1; k <= i; k++) { const diff = closes[k] - closes[k - 1]; if (diff > 0) up += diff; else down += -diff; }
      cmo[i] = (up + down) === 0 ? 0 : ((up - down) / (up + down)) * 100;
    }
    const out: Trigger[] = [];
    for (let i = period + 1; i < closes.length; i++) {
      if (cmo[i - 1] <= 0 && cmo[i] > 0) out.push({ index: i, dir: 'BUY' });
      else if (cmo[i - 1] >= 0 && cmo[i] < 0) out.push({ index: i, dir: 'SELL' });
    }
    return out;
  }

  function williamsRTriggers(candles: Candle[]): Trigger[] {
    const period = 14;
    const n = candles.length;
    const wr: number[] = new Array(n).fill(-50);
    for (let i = period; i < n; i++) {
      const window = candles.slice(i - period + 1, i + 1);
      const hi = Math.max(...window.map(c => c.high)), lo = Math.min(...window.map(c => c.low));
      wr[i] = hi === lo ? -50 : ((hi - candles[i].close) / (hi - lo)) * -100;
    }
    const out: Trigger[] = [];
    for (let i = period + 1; i < n; i++) {
      if (wr[i - 1] <= -80 && wr[i] > -80) out.push({ index: i, dir: 'BUY' });
      else if (wr[i - 1] >= -20 && wr[i] < -20) out.push({ index: i, dir: 'SELL' });
    }
    return out;
  }

  function findAgreements(triggerSets: Trigger[][]): { index: number; dir: Direction }[] {
    let anchorIdx = 0;
    for (let i = 1; i < triggerSets.length; i++) if (triggerSets[i].length < triggerSets[anchorIdx].length) anchorIdx = i;
    const anchor = triggerSets[anchorIdx];
    const others = triggerSets.filter((_, i) => i !== anchorIdx);
    const agreements: { index: number; dir: Direction }[] = [];
    for (const a of anchor) {
      let allAgree = true;
      for (const otherSet of others) {
        const found = otherSet.some(t => t.dir === a.dir && Math.abs(t.index - a.index) <= AGREEMENT_WINDOW);
        if (!found) { allAgree = false; break; }
      }
      if (allAgree) agreements.push({ index: a.index, dir: a.dir });
    }
    return agreements;
  }

  function applyCooldown(triggers: { index: number; dir: Direction }[], cooldown: number) {
    const sorted = [...triggers].sort((a, b) => a.index - b.index);
    const kept: { index: number; dir: Direction }[] = [];
    let lastKeptIndex = -Infinity;
    for (const t of sorted) {
      if (t.index - lastKeptIndex >= cooldown) { kept.push(t); lastKeptIndex = t.index; }
    }
    return kept;
  }

  function adxSeries(candles: Candle[], period: number): number[] {
    const n = candles.length;
    const plusDM: number[] = new Array(n).fill(0), minusDM: number[] = new Array(n).fill(0), tr: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
      minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
      tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    }
    const smooth = (arr: number[]): number[] => {
      const out: number[] = new Array(n).fill(0);
      let sum = 0;
      for (let i = 1; i <= period && i < n; i++) sum += arr[i];
      if (period < n) out[period] = sum;
      for (let i = period + 1; i < n; i++) out[i] = out[i - 1] - (out[i - 1] / period) + arr[i];
      return out;
    };
    const sTR = smooth(tr), sPlus = smooth(plusDM), sMinus = smooth(minusDM);
    const plusDI: number[] = new Array(n).fill(0), minusDI: number[] = new Array(n).fill(0), dx: number[] = new Array(n).fill(0);
    for (let i = period; i < n; i++) {
      plusDI[i] = sTR[i] === 0 ? 0 : (sPlus[i] / sTR[i]) * 100;
      minusDI[i] = sTR[i] === 0 ? 0 : (sMinus[i] / sTR[i]) * 100;
      const diSum = plusDI[i] + minusDI[i];
      dx[i] = diSum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / diSum) * 100;
    }
    const adx: number[] = new Array(n).fill(0);
    let adxSum = 0;
    const adxStart = period * 2;
    for (let i = period; i < Math.min(adxStart, n); i++) adxSum += dx[i];
    if (adxStart < n) adx[adxStart] = adxSum / period;
    for (let i = adxStart + 1; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    return adx;
  }

  async function getAccounts(token: string) {
    const res = await fetch(`${REST_BASE}/accounts`, { headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Accounts fetch failed: HTTP ${res.status}`);
    return (await res.json()).data;
  }

  async function getOtpWsUrl(accountId: string, token: string) {
    const res = await fetch(`${REST_BASE}/accounts/${accountId}/otp`, { method: 'POST', headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`OTP fetch failed: HTTP ${res.status}`);
    return (await res.json()).data.url;
  }

  function wsSend(ws: WebSocket, payload: any, reqId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout req_id ${reqId}`)), 15000);
      function handler(ev: MessageEvent) {
        const msg = JSON.parse(ev.data);
        if (msg.req_id === reqId) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg);
        }
      }
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  function kellyFractionFor(group: string, breadth: number): number {
    const table = KELLY_TABLE[group];
    if (!table) return 0;
    return table[Math.min(breadth, table.length - 1)];
  }

  async function workerGet(path: string) {
    const res = await fetch(`${WORKER_URL}${path}`, { headers: { Authorization: `Bearer ${API_SHARED_SECRET}` } });
    if (!res.ok) throw new Error(`Worker ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  async function workerPost(path: string, body: any) {
    await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const log: string[] = [];
  const l = (s: string) => log.push(s);

  try {
    const state = await workerGet('/state');
    l(`Worker state: mode=${state.mode} paused=${state.paused} canTrade=${state.canTrade}`);

    if (!state.canTrade) {
      await workerPost('/heartbeat', {});
      return Response.json({ ok: true, log: [...log, 'canTrade false, no trades this run'] });
    }

    const accounts = await getAccounts(DERIV_TOKEN);
    const wantedType = state.mode;

    if (wantedType === 'real' && ALLOW_REAL_TRADING !== 'CONFIRMED') {
      l('SAFETY STOP: mode=real but ALLOW_REAL_TRADING not CONFIRMED locally. Refusing to trade.');
      await workerPost('/heartbeat', {});
      return Response.json({ ok: true, log });
    }

    const account = accounts.find((a: any) => a.account_type === wantedType);
    if (!account) {
      return Response.json({ error: `No ${wantedType} account found` }, { status: 500 });
    }
    l(`Using ${account.account_type} account ${account.account_id}`);

    const wsUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN);
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let reqId = 0;

    const balanceMsg = await wsSend(ws, { balance: 1 }, ++reqId);
    const balance = Number(balanceMsg?.balance?.balance);
    l(`Balance: ${balance}`);

    const lastCandles = await workerGet('/last-candles');
    const symbolToGroup: Record<string, string> = {};
    for (const [group, syms] of Object.entries(GROUPS)) for (const s of syms) symbolToGroup[s] = group;
    const allSymbols = Object.values(GROUPS).flat();

    const candidatesBySymbol = new Map<string, CandidateSignal[]>();
    const newLastCandles: Record<string, number> = { ...lastCandles };

    for (const symbol of allSymbols) {
      try {
        const msg = await wsSend(ws, { ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: HISTORY_CANDLES, end: 'latest' }, ++reqId);
        const hist = (msg.candles || []) as any[];
        const candles: Candle[] = hist.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
        if (candles.length < 60) { l(`[${symbol}] insufficient history, skipping.`); continue; }

        const cmoTrig = cmoTriggers(candles);
        const wrTrig = williamsRTriggers(candles);
        const agreements = applyCooldown(findAgreements([cmoTrig, wrTrig]), EXPIRY_MIN);
        const adx = adxSeries(candles, 14);
        const lastProcessed = lastCandles[symbol] ?? candles[candles.length - 2]?.time ?? 0;

        const fresh = agreements.filter(a => candles[a.index].time > lastProcessed && adx[a.index] >= ADX_THRESHOLD);
        const group = symbolToGroup[symbol];
        const list = fresh.map(a => ({ symbol, group, index: a.index, dir: a.dir, time: candles[a.index].time, adx: adx[a.index], entryPrice: candles[a.index].close }));
        candidatesBySymbol.set(symbol, list);
        newLastCandles[symbol] = candles[candles.length - 1].time;
        if (list.length > 0) l(`[${symbol}] ${list.length} STRONG signal(s).`);
      } catch (err) {
        l(`[${symbol}] error: ${(err as Error).message}`);
      }
    }

    const allCandidates: CandidateSignal[] = [];
    for (const list of candidatesBySymbol.values()) allCandidates.push(...list);
    allCandidates.sort((a, b) => a.time - b.time);

    function breadthOf(cand: CandidateSignal): number {
      let count = 0;
      for (const other of allCandidates) {
        if (other.symbol === cand.symbol || other.group !== cand.group || other.dir !== cand.dir) continue;
        if (Math.abs(other.time - cand.time) <= BREADTH_WINDOW_MIN * 60) count++;
      }
      return count;
    }

    let tradesThisRun = 0;
    for (const cand of allCandidates) {
      if (tradesThisRun >= MAX_TRADES_PER_RUN) { l('MAX_TRADES_PER_RUN reached.'); break; }
      const breadth = breadthOf(cand);
      const kellyFraction = kellyFractionFor(cand.group, breadth);
      if (kellyFraction <= 0 || isNaN(balance)) continue;
      const stake = Math.max(MIN_STAKE, Number((balance * kellyFraction).toFixed(2)));

      const contractType = cand.dir === 'BUY' ? 'CALL' : 'PUT';
      const t0 = Date.now();
      try {
        const proposalRes = await wsSend(ws, {
          proposal: 1, amount: stake, basis: 'stake', contract_type: contractType,
          currency: 'USD', duration: EXPIRY_MIN, duration_unit: 'm', underlying_symbol: cand.symbol,
        }, ++reqId);
        const proposalId = proposalRes?.proposal?.id;
        if (!proposalId) { l(`[${cand.symbol}] no proposal id.`); continue; }

        const buyRes = await wsSend(ws, { buy: proposalId, price: proposalRes.proposal.ask_price }, ++reqId);
        const contractId = buyRes?.buy?.contract_id ? String(buyRes.buy.contract_id) : null;
        const entryPrice = Number(buyRes?.buy?.buy_price ?? proposalRes.proposal.ask_price);
        if (!contractId) { l(`[${cand.symbol}] no contract_id.`); continue; }

        tradesThisRun++;
        l(`[${cand.symbol}] PLACED ${cand.dir} breadth=${breadth} stake=${stake} contract=${contractId} (${Date.now() - t0}ms)`);

        await workerPost('/pending-trade', {
          contract_id: contractId, symbol: cand.symbol, direction: cand.dir,
          entry_price: entryPrice, stake, opened_at: t0,
          expected_settle_at: t0 + EXPIRY_MIN * 60 * 1000,
        });
      } catch (err) {
        l(`[${cand.symbol}] order error: ${(err as Error).message}`);
      }
    }

    ws.close();
    await workerPost('/last-candles', newLastCandles);
    await workerPost('/heartbeat', { balance });

    return Response.json({ ok: true, tradesThisRun, log });
  } catch (err) {
    return Response.json({ error: (err as Error).message, log }, { status: 500 });
  }
}