// ============================================================================
// LIVE RUN — one-shot script for GitHub Actions
//
// Unlike forwardTestExec.ts (persistent, runs until Ctrl+C), this connects,
// checks the Worker for permission to trade, looks at the latest closed
// candle for a fresh signal on each symbol, places a demo/real order if
// warranted, reports results back to the Worker, and exits.
//
// Flow per run:
//   1. GET  {WORKER_URL}/state   -> paused? loss limit hit? what mode?
//   2. If canTrade === false, log and exit immediately (no trades)
//   3. Connect to Deriv, fetch recent candles per symbol
//   4. Check for a signal on the LATEST closed candle only
//   5. If found: place order (demo or real, per Worker's mode)
//   6. Wait for contract settlement (poll), log outcome
//   7. POST {WORKER_URL}/log-trade for each settled trade
//   8. POST {WORKER_URL}/heartbeat to confirm this run completed
// ============================================================================

import WebSocket from 'ws';

const GRANULARITY_SEC = 60;
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const WARMUP_CANDLES = 60;
const STAKE_AMOUNT = 1;
const SETTLEMENT_POLL_MS = 5000;
const SETTLEMENT_TIMEOUT_MS = (EXPIRY_MIN + 2) * 60 * 1000; // expiry + buffer

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

const DERIV_TOKEN = process.env.DERIV_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const API_SHARED_SECRET = process.env.API_SHARED_SECRET;

if (!DERIV_TOKEN || !WORKER_URL || !API_SHARED_SECRET) {
  console.error('Set DERIV_TOKEN, WORKER_URL, and API_SHARED_SECRET as environment variables before running.');
  process.exit(1);
}

const SYMBOLS = [
  'stpRNG5', 'stpRNG3', 'stpRNG4', 'OTC_SSMI', 'stpRNG', 'OTC_NDX',
  'OTC_GDAXI', 'OTC_N225', 'stpRNG2', 'OTC_SPC', 'OTC_HSI', 'RDBULL',
];

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }

// ---------------------------------------------------------------------------
// Worker communication
// ---------------------------------------------------------------------------

interface WorkerState {
  mode: 'demo' | 'real';
  paused: boolean;
  canTrade: boolean;
  dailyLoss: number;
  dailyLossLimit: number;
}

async function getWorkerState(): Promise<WorkerState> {
  const res = await fetch(`${WORKER_URL}/state`, {
    headers: { Authorization: `Bearer ${API_SHARED_SECRET}` },
  });
  if (!res.ok) throw new Error(`Worker /state failed: HTTP ${res.status}`);
  return res.json();
}

async function sendHeartbeat(): Promise<void> {
  await fetch(`${WORKER_URL}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_SHARED_SECRET}` },
  });
}

interface TradeLog {
  contract_id?: string;
  symbol: string;
  direction: Direction;
  entry_price?: number;
  exit_price?: number;
  stake: number;
  payout?: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  opened_at: number;
  closed_at?: number;
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

async function fetchRecentCandles(sock: DerivSocket, symbol: string): Promise<Candle[]> {
  const msg = await sock.send({ ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: WARMUP_CANDLES, end: 'latest' });
  const hist = (msg.candles || []) as any[];
  return hist.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
}

async function placeOrder(sock: DerivSocket, symbol: string, dir: Direction): Promise<{ contractId: string | null; entryPrice: number; error: string | null }> {
  const contractType = dir === 'BUY' ? 'CALL' : 'PUT';
  try {
    const proposalRes = await sock.send({
      proposal: 1, amount: STAKE_AMOUNT, basis: 'stake', contract_type: contractType,
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
  return null; // timed out, never settled
}

// ---------------------------------------------------------------------------
// Main — one-shot run
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
  const wantedType = state.mode; // 'demo' or 'real'
  const account = accounts.find(a => a.account_type === wantedType);
  if (!account) {
    console.error(`No ${wantedType} account found on this token. Aborting run without heartbeat.`);
    process.exit(1);
  }
  console.log(`Using ${account.account_type} account ${account.account_id}`);

  const url = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
  const sock = new DerivSocket(url);
  await sock.waitReady();

  const settledTrades: TradeLog[] = [];

  for (const symbol of SYMBOLS) {
    try {
      const candles = await fetchRecentCandles(sock, symbol);
      if (candles.length < 30) {
        console.log(`[${symbol}] not enough candles (${candles.length}), skipping.`);
        continue;
      }

      const cmoTrig = cmoTriggers(candles);
      const wrTrig = williamsRTriggers(candles);
      const agreements = findAgreements([cmoTrig, wrTrig]);

      const latestIdx = candles.length - 1;
      const latest = agreements.find(a => a.index === latestIdx);

      if (!latest) {
        console.log(`[${symbol}] no signal on latest candle.`);
        continue;
      }

      const openedAt = Date.now();
      console.log(`[${symbol}] SIGNAL: ${latest.dir} @ ${candles[latestIdx].close}`);

      const { contractId, entryPrice, error } = await placeOrder(sock, symbol, latest.dir);
      if (error || !contractId) {
        console.warn(`[${symbol}] order failed: ${error}`);
        continue;
      }
      console.log(`[${symbol}] order placed, contract_id=${contractId}, waiting for settlement...`);

      const settlement = await pollForSettlement(sock, contractId);
      if (!settlement) {
        console.warn(`[${symbol}] contract ${contractId} did not settle within timeout. Not logged.`);
        continue;
      }

      const pnl = settlement.result === 'WIN' ? settlement.payout - STAKE_AMOUNT : -STAKE_AMOUNT;
      console.log(`[${symbol}] SETTLED: ${settlement.result} (pnl=${pnl.toFixed(2)})`);

      settledTrades.push({
        contract_id: contractId,
        symbol,
        direction: latest.dir,
        entry_price: entryPrice,
        exit_price: settlement.exitPrice,
        stake: STAKE_AMOUNT,
        payout: settlement.payout,
        result: settlement.result,
        pnl,
        opened_at: openedAt,
        closed_at: Date.now(),
      });
    } catch (err) {
      console.warn(`[${symbol}] error during processing: ${(err as Error).message}`);
    }
  }

  sock.close();

  for (const trade of settledTrades) {
    try {
      await logTrade(trade);
      console.log(`Logged trade to Worker: ${trade.symbol} ${trade.direction} ${trade.result}`);
    } catch (err) {
      console.warn(`Failed to log trade to Worker: ${(err as Error).message}`);
    }
  }

  await sendHeartbeat();
  console.log(`[${new Date().toISOString()}] liveRun complete. ${settledTrades.length} trade(s) settled and logged.`);
}

main().catch(err => {
  console.error('Fatal error in liveRun:', err);
  process.exit(1);
});