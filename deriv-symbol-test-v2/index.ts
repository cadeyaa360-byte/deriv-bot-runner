// ============================================================================
// VAL â€” detect-and-place, runs every 1 min via cron-job.org HTTP trigger.
// Places orders only; settlement is checked by the Worker's own cron.
// Strategy math ported unchanged from liveRun.ts.
// ============================================================================

const GRANULARITY_SEC = 60;
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const HISTORY_CANDLES = 300;
const MAX_TRADES_PER_RUN = 8;
const MIN_STAKE = 0.35;

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

const DERIV_TOKEN = Deno.env.get('DERIV_TOKEN');
const WORKER_URL = Deno.env.get('WORKER_URL');
const API_SHARED_SECRET = Deno.env.get('API_SHARED_SECRET');
const ALLOW_REAL_TRADING = Deno.env.get('ALLOW_REAL_TRADING');

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

// ---------------------------------------------------------------------------
// Worker communication
// ---------------------------------------------------------------------------

interface WorkerState { mode: 'demo' | 'real'; paused: boolean; canTrade: boolean; dailyLoss: number; dailyLossLimit: number; }

async function workerFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${API_SHARED_SECRET}` },
  });
}

async function acquireLock(): Promise<boolean> {
  const res = await workerFetch('/lock', { method: 'POST' });
  return res.ok;
}

async function releaseLock(): Promise<void> {
  await workerFetch('/unlock', { method: 'POST' }).catch(() => {});
}

async function getWorkerState(): Promise<WorkerState> {
  const res = await workerFetch('/state');
  if (!res.ok) throw new Error(`Worker /state failed: HTTP ${res.status}`);
  return res.json();
}

async function getLastCandles(): Promise<Record<string, number>> {
  const res = await workerFetch('/last-candles');
  if (!res.ok) return {};
  return res.json();
}

async function setLastCandles(map: Record<string, number>): Promise<void> {
  await workerFetch('/last-candles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(map),
  });
}

async function notify(text: string): Promise<void> {
  await workerFetch('/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

async function alert(text: string): Promise<void> {
  await workerFetch('/alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

async function registerPendingTrade(trade: {
  contract_id: string; symbol: string; direction: Direction;
  entry_price: number; stake: number; opened_at: number; expected_settle_at: number;
}): Promise<void> {
  await workerFetch('/pending-trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trade),
  });
}

// ---------------------------------------------------------------------------
// EXACT proven strategy logic â€” unchanged from liveRun.ts
// ---------------------------------------------------------------------------

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

function applyCooldown(triggers: { index: number; dir: Direction }[], cooldown: number): { index: number; dir: Direction }[] {
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

function kellyFractionFor(group: string, breadth: number): number {
  const table = KELLY_TABLE[group];
  if (!table) return 0;
  const idx = Math.min(breadth, table.length - 1);
  return table[idx];
}

// ---------------------------------------------------------------------------
// Deriv REST + WebSocket (Web API, matches Worker's proven pattern)
// ---------------------------------------------------------------------------

async function getAccounts(token: string): Promise<{ account_id: string; account_type: string }[]> {
  const res = await fetch(`${REST_BASE}/accounts`, { headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Accounts fetch failed: HTTP ${res.status}`);
  return (await res.json()).data;
}

async function getOtpWsUrl(accountId: string, token: string): Promise<string> {
  const res = await fetch(`${REST_BASE}/accounts/${accountId}/otp`, { method: 'POST', headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OTP fetch failed: HTTP ${res.status}`);
  return (await res.json()).data.url;
}

class DerivSocket {
  private ws: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (e) => reject(e), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      const reqId = msg.req_id;
      if (reqId != null && this.pending.has(reqId)) {
        const { resolve, reject, timer } = this.pending.get(reqId)!;
        clearTimeout(timer);
        this.pending.delete(reqId);
        if (msg.error) reject(new Error(msg.error.message || 'Deriv API error'));
        else resolve(msg);
      }
    });
  }

  async waitReady() { await this.ready; }

  async send(payload: Record<string, any>): Promise<any> {
    await this.ready;
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`Request timed out (req_id ${reqId})`)); }, 15000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  close() { this.ws.close(); }
}

async function sendHeartbeat(balance?: number): Promise<void> {
  await workerFetch('/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof balance === 'number' ? { balance } : {}),
  }).catch(() => {});
}

async function fetchBalance(sock: DerivSocket): Promise<number | undefined> {
  try {
    const res = await sock.send({ balance: 1 });
    const bal = Number(res?.balance?.balance);
    return isNaN(bal) ? undefined : bal;
  } catch { return undefined; }
}

async function fetchRecentCandles(sock: DerivSocket, symbol: string): Promise<Candle[]> {
  const msg = await sock.send({ ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: HISTORY_CANDLES, end: 'latest' });
  const hist = (msg.candles || []) as any[];
  return hist.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
}

async function placeOrder(sock: DerivSocket, symbol: string, dir: Direction, stake: number): Promise<{ contractId: string | null; entryPrice: number; error: string | null }> {
  const contractType = dir === 'BUY' ? 'CALL' : 'PUT';
  try {
    const proposalRes = await sock.send({
      proposal: 1, amount: stake, basis: 'stake', contract_type: contractType,
      currency: 'USD', duration: EXPIRY_MIN, duration_unit: 'm', underlying_symbol: symbol,
    });
    const proposalId = proposalRes?.proposal?.id;
    if (!proposalId) return { contractId: null, entryPrice: 0, error: 'No proposal id in response' };

    const buyRes = await sock.send({ buy: proposalId, price: proposalRes.proposal.ask_price });
    const contractId = buyRes?.buy?.contract_id ? String(buyRes.buy.contract_id) : null;
    const entryPrice = Number(buyRes?.buy?.buy_price ?? proposalRes.proposal.ask_price);
    return { contractId, entryPrice, error: contractId ? null : 'No contract_id in buy response' };
  } catch (err) {
    return { contractId: null, entryPrice: 0, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function (): Promise<Response> {
  const runLog: string[] = [];
  const started = Date.now();

  if (!DERIV_TOKEN || !WORKER_URL || !API_SHARED_SECRET) {
    return Response.json({ error: 'Missing DERIV_TOKEN, WORKER_URL, or API_SHARED_SECRET env vars' }, { status: 500 });
  }

  try {
    const state = await getWorkerState();
    if (!state.canTrade) {
      return Response.json({ skipped: true, reason: 'canTrade=false (paused or daily loss limit hit)' });
    }

    const accounts = await getAccounts(DERIV_TOKEN);
    const wantedType = state.mode;

    if (wantedType === 'real' && ALLOW_REAL_TRADING !== 'CONFIRMED') {
      await alert('SAFETY STOP: Worker requested mode=real, but ALLOW_REAL_TRADING is not CONFIRMED on the val. Refusing to trade.');
      return Response.json({ error: 'real trading requested but not confirmed on val' }, { status: 200 });
    }

    const account = accounts.find(a => a.account_type === wantedType);
    if (!account) {
      return Response.json({ error: `No ${wantedType} account found on this token` }, { status: 500 });
    }

    const wsUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN);
    const sock = new DerivSocket(wsUrl);
    await sock.waitReady();

    const balance = await fetchBalance(sock);

    const lastCandles = await getLastCandles();
    const symbolToGroup: Record<string, string> = {};
    for (const [group, syms] of Object.entries(GROUPS)) for (const s of syms) symbolToGroup[s] = group;
    const allSymbols = Object.values(GROUPS).flat();

    const candidatesBySymbol = new Map<string, CandidateSignal[]>();
    const newLastCandles: Record<string, number> = { ...lastCandles };
    let skippedSymbols = 0;

    for (const symbol of allSymbols) {
      try {
        const candles = await fetchRecentCandles(sock, symbol);
        if (candles.length < 60) { skippedSymbols++; continue; }

        const cmoTrig = cmoTriggers(candles);
        const wrTrig = williamsRTriggers(candles);
        const agreements = applyCooldown(findAgreements([cmoTrig, wrTrig]), EXPIRY_MIN);
        const adx = adxSeries(candles, 14);

        const lastProcessed = lastCandles[symbol] ?? candles[candles.length - 2]?.time ?? 0;
        const fresh = agreements.filter(a => candles[a.index].time > lastProcessed && adx[a.index] >= ADX_THRESHOLD);
        const newestTime = candles[candles.length - 1].time;
        const newestAgreement = agreements.length > 0 ? agreements[agreements.length - 1] : null;
        runLog.push(`[${symbol}] newestCandleTime=${newestTime} lastProcessed=${lastProcessed} gap=${newestTime - lastProcessed}s newestAgreementIdx=${newestAgreement?.index ?? 'none'} maxIdx=${candles.length - 1}`);
        const group = symbolToGroup[symbol];
        const list = fresh.map(a => ({
          symbol, group, index: a.index, dir: a.dir, time: candles[a.index].time, adx: adx[a.index], entryPrice: candles[a.index].close,
        }));
        candidatesBySymbol.set(symbol, list);
        if (cmoTrig.length > 0 || wrTrig.length > 0) runLog.push(`[${symbol}] cmo=${cmoTrig.length} wr=${wrTrig.length} agreements=${agreements.length} lastADX=${adx[adx.length-1].toFixed(1)}`);
        newLastCandles[symbol] = candles[candles.length - 1].time;
      } catch (err) {
        runLog.push(`[${symbol}] fetch/process error: ${(err as Error).message}`);
      }
    }

    if (skippedSymbols > 5) {
      await alert(`WARNING: ${skippedSymbols}/${allSymbols.length} symbols skipped this run due to insufficient candle history.`);
    }

    const allCandidates: CandidateSignal[] = [];
    for (const list of candidatesBySymbol.values()) allCandidates.push(...list);
    allCandidates.sort((a, b) => a.time - b.time);

    function breadthOf(cand: CandidateSignal): number {
      let count = 0;
      for (const other of allCandidates) {
        if (other.symbol === cand.symbol) continue;
        if (other.group !== cand.group) continue;
        if (other.dir !== cand.dir) continue;
        if (Math.abs(other.time - cand.time) <= BREADTH_WINDOW_MIN * 60) count++;
      }
      return count;
    }

    let tradesThisRun = 0;
    const placedSummary: string[] = [];

    for (const cand of allCandidates) {
      if (tradesThisRun >= MAX_TRADES_PER_RUN) break;
      const breadth = breadthOf(cand);
      const kellyFraction = kellyFractionFor(cand.group, breadth);
      if (kellyFraction <= 0 || balance === undefined) continue;
      const stake = Math.max(MIN_STAKE, Number((balance * kellyFraction).toFixed(2)));

      const openedAt = Date.now();
      const { contractId, entryPrice, error } = await placeOrder(sock, cand.symbol, cand.dir, stake);

      if (error || !contractId) {
        placedSummary.push(`ðŸ”´ ${cand.symbol} ${cand.dir} order failed: ${error}`);
        continue;
      }

      tradesThisRun++;
      const expectedSettleAt = openedAt + EXPIRY_MIN * 60 * 1000;

      await registerPendingTrade({
        contract_id: contractId, symbol: cand.symbol, direction: cand.dir,
        entry_price: entryPrice, stake, opened_at: openedAt, expected_settle_at: expectedSettleAt,
      });

      placedSummary.push(`ðŸŸ¡ ${cand.symbol} ${cand.dir} adx=${cand.adx.toFixed(1)} breadth=${breadth} stake=${stake} contract=${contractId}`);
    }

    sock.close();
    await setLastCandles(newLastCandles);

    if (placedSummary.length > 0) {
      await notify(placedSummary.join('\n'));
    }

    await sendHeartbeat(balance);

    return Response.json({
      ok: true,
      elapsedMs: Date.now() - started,
      symbolsChecked: allSymbols.length,
      symbolsSkipped: skippedSymbols,
      candidatesFound: allCandidates.length,
      tradesPlaced: tradesThisRun,
      log: runLog,
    });
  } catch (err) {
    await alert(`VAL RUN ERROR: ${(err as Error).message}`);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  } finally {
  }
}







