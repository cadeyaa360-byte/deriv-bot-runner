// ============================================================================
// LIVE RUN — full validated strategy: ADX>=25 filter, breadth-based Kelly
// sizing (noise-adjusted), correct 39-symbol basket, multi-candle catch-up
// coverage (no longer misses signals between 10-min cron runs).
// ============================================================================

import WebSocket from 'ws';

const GRANULARITY_SEC = 60;
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const HISTORY_CANDLES = 300; // enough to cover indicator warmup + a long catch-up gap
const MAX_TRADES_PER_RUN = 8; // safety cap if a catch-up gap surfaces many signals at once
const MIN_STAKE = 0.35; // observed from live proposal validation_params -- may drift, not guaranteed
const SETTLEMENT_POLL_MS = 5000;
const SETTLEMENT_TIMEOUT_MS = (EXPIRY_MIN + 2) * 60 * 1000;
const LATENCY_ALERT_MS = 5000; // alert if avg signal->confirm latency this run exceeds this

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

const DERIV_TOKEN = process.env.DERIV_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const API_SHARED_SECRET = process.env.API_SHARED_SECRET;
const ALLOW_REAL_TRADING = process.env.ALLOW_REAL_TRADING;

if (!DERIV_TOKEN || !WORKER_URL || !API_SHARED_SECRET) {
  console.error('Set DERIV_TOKEN, WORKER_URL, and API_SHARED_SECRET as environment variables before running.');
  process.exit(1);
}

// Validated 39-symbol basket, grouped exactly as in the backtest.
const GROUPS: Record<string, string[]> = {
  FOREX: ['frxGBPCHF','frxEURUSD','frxUSDPLN','frxEURNZD','frxEURAUD','frxAUDCHF','frxNZDUSD','frxUSDCHF','frxGBPUSD','frxEURGBP','frxAUDUSD','frxUSDCAD','frxAUDNZD','frxEURCAD','frxNZDJPY','frxAUDJPY','frxGBPAUD','frxEURJPY','frxAUDCAD','frxGBPNZD','frxGBPCAD','frxUSDMXN'],
  INDICES: ['OTC_SSMI','OTC_NDX','OTC_GDAXI','OTC_N225','OTC_SPC','OTC_HSI','OTC_AS51','OTC_DJI','OTC_SX5E','OTC_FCHI','OTC_FTSE','OTC_AEX'],
  COMMODITIES: ['frxXPTUSD','frxXAUUSD','frxXAGUSD'],
  CRYPTO: ['cryETHUSD','cryBTCUSD'],
};

// Noise-adjusted Kelly fractions by group + breadth bucket (0,1,2,3,4+),
// from tonight's stage6AdjustedSim.ts run. Buckets beyond what was actually
// observed in the backtest (COMMODITIES 3+, CRYPTO 2+) fall back to the
// highest tested bucket's value as a conservative assumption -- NOT backed
// by real sample data at that bucket. Revisit if live data disagrees.
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

async function getWorkerState(): Promise<WorkerState> {
  const res = await fetch(`${WORKER_URL}/state`, { headers: { Authorization: `Bearer ${API_SHARED_SECRET}` } });
  if (!res.ok) throw new Error(`Worker /state failed: HTTP ${res.status}`);
  return res.json();
}

async function getLastCandles(): Promise<Record<string, number>> {
  const res = await fetch(`${WORKER_URL}/last-candles`, { headers: { Authorization: `Bearer ${API_SHARED_SECRET}` } });
  if (!res.ok) return {};
  return res.json();
}

async function setLastCandles(map: Record<string, number>): Promise<void> {
  await fetch(`${WORKER_URL}/last-candles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_SHARED_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(map),
  });
}

async function sendAlert(text: string): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/alert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch { /* non-fatal */ }
}

async function sendHeartbeat(balance?: number): Promise<void> {
  await fetch(`${WORKER_URL}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_SHARED_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof balance === 'number' ? { balance } : {}),
  });
}

interface TradeLog {
  contract_id?: string; symbol: string; direction: Direction; entry_price?: number; exit_price?: number;
  stake: number; payout?: number; result: 'WIN' | 'LOSS'; pnl: number; opened_at: number; closed_at?: number;
}

async function logTrade(trade: TradeLog): Promise<void> {
  await fetch(`${WORKER_URL}/log-trade`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_SHARED_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(trade),
  });
}

// ---------------------------------------------------------------------------
// EXACT proven strategy logic — unchanged
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

// ---------------------------------------------------------------------------
// Deriv REST + WebSocket plumbing
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
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;
  public closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const reqId = msg.req_id;
      if (reqId != null && this.pending.has(reqId)) {
        const { resolve, reject, timer } = this.pending.get(reqId)!;
        clearTimeout(timer);
        this.pending.delete(reqId);
        if (msg.error) { const e = new Error(msg.error.message || 'Deriv API error'); (e as any).derivError = msg.error; reject(e); }
        else resolve(msg);
      }
    });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => { this.closed = true; });
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

async function fetchBalance(sock: DerivSocket): Promise<number | undefined> {
  try {
    const res = await sock.send({ balance: 1 });
    const bal = Number(res?.balance?.balance);
    return isNaN(bal) ? undefined : bal;
  } catch (err) {
    console.warn(`[balance fetch failed] ${(err as Error).message}`);
    return undefined;
  }
}

async function fetchRecentCandles(sock: DerivSocket, symbol: string): Promise<Candle[]> {
  const msg = await sock.send({ ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: HISTORY_CANDLES, end: 'latest' });
  const hist = (msg.candles || []) as any[];
  return hist.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
}

async function placeOrder(sock: DerivSocket, symbol: string, dir: Direction, stake: number): Promise<{ contractId: string | null; entryPrice: number; error: string | null; signalToConfirmMs: number }> {
  const contractType = dir === 'BUY' ? 'CALL' : 'PUT';
  const t0 = Date.now();
  try {
    const proposalRes = await sock.send({
      proposal: 1, amount: stake, basis: 'stake', contract_type: contractType,
      currency: 'USD', duration: EXPIRY_MIN, duration_unit: 'm', underlying_symbol: symbol,
    });
    const proposalId = proposalRes?.proposal?.id;
    if (!proposalId) return { contractId: null, entryPrice: 0, error: 'No proposal id in response', signalToConfirmMs: Date.now() - t0 };

    const buyRes = await sock.send({ buy: proposalId, price: proposalRes.proposal.ask_price });
    const contractId = buyRes?.buy?.contract_id ? String(buyRes.buy.contract_id) : null;
    const entryPrice = Number(buyRes?.buy?.buy_price ?? proposalRes.proposal.ask_price);
    return { contractId, entryPrice, error: contractId ? null : 'No contract_id in buy response', signalToConfirmMs: Date.now() - t0 };
  } catch (err) {
    return { contractId: null, entryPrice: 0, error: (err as Error).message, signalToConfirmMs: Date.now() - t0 };
  }
}

async function pollForSettlement(sock: DerivSocket, contractId: string): Promise<{ result: 'WIN' | 'LOSS'; exitPrice: number; payout: number } | null> {
  const deadline = Date.now() + SETTLEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await sock.send({ proposal_open_contract: 1, contract_id: contractId });
      const c = res?.proposal_open_contract;
      if (c && c.is_sold) {
        const profit = Number(c.profit ?? 0);
        return { result: profit > 0 ? 'WIN' : 'LOSS', exitPrice: Number(c.sell_price ?? c.exit_tick ?? 0), payout: Number(c.payout ?? 0) };
      }
    } catch (err) {
      console.warn(`[poll error] contract ${contractId}: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, SETTLEMENT_POLL_MS));
  }
  return null;
}

function kellyFractionFor(group: string, breadth: number): number {
  const table = KELLY_TABLE[group];
  if (!table) return 0;
  const idx = Math.min(breadth, table.length - 1);
  return table[idx];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[${new Date().toISOString()}] liveRun starting...`);

  const state = await getWorkerState();
  console.log(`Worker state: mode=${state.mode} paused=${state.paused} canTrade=${state.canTrade} dailyLoss=${state.dailyLoss}/${state.dailyLossLimit}`);

  if (!state.canTrade) {
    console.log('canTrade is false (paused or daily loss limit hit). No trades this run.');
    await sendHeartbeat();
    return;
  }

  const accounts = await getAccounts(DERIV_TOKEN!);
  const wantedType = state.mode;

  // SAFETY GATE: real trading requires BOTH the Worker to say mode='real'
  // AND a separate, locally-controlled secret to explicitly confirm it.
  if (wantedType === 'real' && ALLOW_REAL_TRADING !== 'CONFIRMED') {
    console.error('SAFETY STOP: Worker requested mode=real, but ALLOW_REAL_TRADING secret is not set to CONFIRMED. Refusing to trade. No real order will be placed.');
    await sendHeartbeat();
    return;
  }

  const account = accounts.find(a => a.account_type === wantedType);
  if (!account) {
    console.error(`No ${wantedType} account found on this token. Aborting run without heartbeat.`);
    process.exit(1);
  }
  console.log(`Using ${account.account_type} account ${account.account_id}`);
  const url = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
  const sock = new DerivSocket(url);
  await sock.waitReady();

  const balance = await fetchBalance(sock);
  console.log(`Balance: ${balance ?? 'unknown'}`);

  const lastCandles = await getLastCandles();
  const symbolToGroup: Record<string, string> = {};
  for (const [group, syms] of Object.entries(GROUPS)) for (const s of syms) symbolToGroup[s] = group;
  const allSymbols = Object.values(GROUPS).flat();

  // Pass 1: fetch candles + compute ALL STRONG candidate signals since last processed, per symbol
  const candidatesBySymbol = new Map<string, CandidateSignal[]>();
  const newLastCandles: Record<string, number> = { ...lastCandles };
  let skippedSymbols = 0;

  for (const symbol of allSymbols) {
    try {
      const candles = await fetchRecentCandles(sock, symbol);
      if (candles.length < 60) {
        console.log(`[${symbol}] insufficient history (${candles.length} candles), skipping.`);
        skippedSymbols++;
        continue;
      }

      const cmoTrig = cmoTriggers(candles);
      const wrTrig = williamsRTriggers(candles);
      const agreements = applyCooldown(findAgreements([cmoTrig, wrTrig]), EXPIRY_MIN);
      const adx = adxSeries(candles, 14);

      const lastProcessed = lastCandles[symbol] ?? candles[candles.length - 2]?.time ?? 0; // default: only catch the newest candle on first-ever run

      const fresh = agreements.filter(a => candles[a.index].time > lastProcessed && adx[a.index] >= ADX_THRESHOLD);
      const group = symbolToGroup[symbol];
      const list = fresh.map(a => ({
        symbol, group, index: a.index, dir: a.dir, time: candles[a.index].time, adx: adx[a.index], entryPrice: candles[a.index].close,
      }));
      candidatesBySymbol.set(symbol, list);
      newLastCandles[symbol] = candles[candles.length - 1].time;

      if (list.length > 0) console.log(`[${symbol}] ${list.length} STRONG signal(s) since last run.`);
    } catch (err) {
      console.warn(`[${symbol}] error fetching/processing: ${(err as Error).message}`);
    }
  }

  if (skippedSymbols > 5) {
    await sendAlert(`WARNING: ${skippedSymbols}/${allSymbols.length} symbols skipped this run due to insufficient candle history.`);
  }

  // Pass 2: compute breadth for every candidate using ALL candidates this run (within its group)
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

  // Pass 3: place orders, capped per run, sized by noise-adjusted Kelly
  const settledTrades: TradeLog[] = [];
  const latencies: number[] = [];
  let tradesThisRun = 0;

  for (const cand of allCandidates) {
    if (tradesThisRun >= MAX_TRADES_PER_RUN) {
      console.log(`Reached MAX_TRADES_PER_RUN (${MAX_TRADES_PER_RUN}), remaining signals this run skipped.`);
      break;
    }
    const breadth = breadthOf(cand);
    const kellyFraction = kellyFractionFor(cand.group, breadth);
    if (kellyFraction <= 0 || balance === undefined) {
      console.log(`[${cand.symbol}] no sizing available (kelly=${kellyFraction}, balance=${balance}), skipping.`);
      continue;
    }
    const stake = Math.max(MIN_STAKE, Number((balance * kellyFraction).toFixed(2)));
    console.log(`[${cand.symbol}] SIGNAL ${cand.dir} adx=${cand.adx.toFixed(1)} breadth=${breadth} kelly=${(kellyFraction * 100).toFixed(2)}% stake=${stake}`);

    const openedAt = Date.now();
    const { contractId, entryPrice, error, signalToConfirmMs } = await placeOrder(sock, cand.symbol, cand.dir, stake);
    latencies.push(signalToConfirmMs);
    if (error || !contractId) {
      console.warn(`[${cand.symbol}] order failed: ${error}`);
      continue;
    }
    tradesThisRun++;
    console.log(`[${cand.symbol}] order placed, contract_id=${contractId} (${signalToConfirmMs}ms), waiting for settlement...`);

    const settlement = await pollForSettlement(sock, contractId);
    if (!settlement) {
      console.warn(`[${cand.symbol}] contract ${contractId} did not settle within timeout. Not logged.`);
      continue;
    }

    const pnl = settlement.result === 'WIN' ? settlement.payout - stake : -stake;
    console.log(`[${cand.symbol}] SETTLED: ${settlement.result} (pnl=${pnl.toFixed(2)})`);

    settledTrades.push({
      contract_id: contractId, symbol: cand.symbol, direction: cand.dir, entry_price: entryPrice,
      exit_price: settlement.exitPrice, stake, payout: settlement.payout, result: settlement.result,
      pnl, opened_at: openedAt, closed_at: Date.now(),
    });
  }

  sock.close();

  for (const trade of settledTrades) {
    try { await logTrade(trade); console.log(`Logged trade: ${trade.symbol} ${trade.direction} ${trade.result}`); }
    catch (err) { console.warn(`Failed to log trade: ${(err as Error).message}`); }
  }

  await setLastCandles(newLastCandles);

  if (latencies.length > 0) {
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    if (avgLatency > LATENCY_ALERT_MS) {
      await sendAlert(`LATENCY WARNING: avg signal->confirm this run was ${avgLatency.toFixed(0)}ms (threshold ${LATENCY_ALERT_MS}ms). Execution may be degrading.`);
    }
  }

  let finalBalance: number | undefined;
  try {
    const freshUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
    const finalSock = new DerivSocket(freshUrl);
    await finalSock.waitReady();
    finalBalance = await fetchBalance(finalSock);
    finalSock.close();
  } catch (err) {
    console.warn(`[final balance check failed] ${(err as Error).message}`);
  }

  await sendHeartbeat(finalBalance);
  console.log(`[${new Date().toISOString()}] liveRun complete. ${settledTrades.length} trade(s) settled and logged.`);
}

main().catch(err => {
  console.error('Fatal error in liveRun:', err);
  process.exit(1);
});