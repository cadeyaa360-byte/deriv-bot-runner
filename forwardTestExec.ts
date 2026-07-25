// ============================================================================
// CMO+WilliamsR — LIVE FORWARD TEST WITH REAL EXECUTION TIMING (DEMO ONLY)
//
// Builds on forwardTest.ts. Adds two things forwardTest.ts cannot answer:
//   1. Candle-delivery latency: how long after a candle period actually
//      closes does this process receive and finish handling it.
//   2. Real order execution timing: on every signal, actually places a
//      DEMO-account trade via Deriv's proposal+buy flow and logs the full
//      timing chain plus any rejection reason. This is the only way to see
//      real rate limits, latency, or requotes -- paper logging alone can't.
//
// SAFETY: hard-refuses to run unless the authenticated account is type
// 'demo'. Do not remove this check. No real money is ever at risk if this
// check is left in place and the account used is actually a demo account.
//
// KNOWN UNCERTAINTY: the proposal/buy request/response shape below
// (contract_type, duration, duration_unit, amount, basis) follows Deriv's
// documented API, but has not been confirmed against a real response from
// this account yet. Run this, paste back what's logged under
// "[first raw proposal response]" and "[first raw buy response]", and if
// field names are wrong I'll fix them against real data.
//
// SECURITY: reads DERIV_TOKEN from env only. Never hardcode a token here.
// ============================================================================

import WebSocket from 'ws';
import * as fs from 'fs';

const GRANULARITY_SEC = 60;
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const WARMUP_CANDLES = 180;
const LOG_FILE = 'forward_test_log.csv';
const LATENCY_LOG_FILE = 'candle_latency_log.csv';
const EXEC_LOG_FILE = 'order_execution_log.csv';
const DEMO_STAKE_AMOUNT = 1; // smallest sensible demo stake, in account currency

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

const DERIV_TOKEN = process.env.DERIV_TOKEN;
if (!DERIV_TOKEN) {
  console.error('Set DERIV_TOKEN as an environment variable before running.');
  process.exit(1);
}

const SYMBOLS = [
  'stpRNG5', 'stpRNG3', 'stpRNG4', 'OTC_SSMI', 'stpRNG', 'OTC_NDX',
  'OTC_GDAXI', 'OTC_N225', 'stpRNG2', 'OTC_SPC', 'OTC_HSI', 'RDBULL',
];

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }

// ============================================================================
// EXACT proven strategy logic — unchanged
// ============================================================================

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

// ============================================================================
// Deriv REST + WebSocket plumbing — unchanged from forwardTest.ts
// ============================================================================

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
  private streams = new Map<number, (msg: any) => void>();
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
      if (reqId != null && this.streams.has(reqId)) { this.streams.get(reqId)!(msg); return; }
      if (reqId != null && this.pending.has(reqId)) {
        const { resolve, reject, timer } = this.pending.get(reqId)!;
        clearTimeout(timer);
        this.pending.delete(reqId);
        if (msg.error) { const e = new Error(msg.error.message || 'Deriv API error'); (e as any).derivError = msg.error; reject(e); }
        else resolve(msg);
      }
    });
    const onDown = (reason: string) => {
      this.closed = true;
      for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(new Error(`Socket closed: ${reason}`)); }
      this.pending.clear();
    };
    this.ws.on('close', (code) => onDown(`close code ${code}`));
    this.ws.on('error', (err) => onDown(err.message));
  }

  async waitReady() { await this.ready; }

  async send(payload: Record<string, any>): Promise<any> {
    await this.ready;
    if (this.closed) throw new Error('Socket already closed');
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`Request timed out (req_id ${reqId})`)); }, 15000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  async subscribe(payload: Record<string, any>, onUpdate: (msg: any) => void): Promise<number> {
    await this.ready;
    const reqId = ++this.reqId;
    this.streams.set(reqId, onUpdate);
    this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }));
    return reqId;
  }

  close() { this.ws.close(); }
}

// ============================================================================
// Per-symbol live state
// ============================================================================

interface OpenTrade { symbol: string; entryIndex: number; entryTime: number; entryPrice: number; dir: Direction; expiryIndex: number; }
interface Stats { wins: number; losses: number; }

interface SymbolState {
  candles: Candle[];
  currentOpenEpoch: number | null;
  currentCandle: Candle | null;
  lastSignalIndex: number;
  openTrades: OpenTrade[];
  stats: Stats;
}

function ensureLogHeaders() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'timestamp,symbol,direction,entry_price,exit_price,result\n');
  }
  if (!fs.existsSync(LATENCY_LOG_FILE)) {
    fs.writeFileSync(LATENCY_LOG_FILE, 'symbol,period_close_epoch,received_at_ms,processed_at_ms,delivery_latency_ms,processing_latency_ms\n');
  }
  if (!fs.existsSync(EXEC_LOG_FILE)) {
    fs.writeFileSync(EXEC_LOG_FILE, 'symbol,direction,signal_detected_ms,proposal_sent_ms,proposal_received_ms,buy_sent_ms,buy_confirmed_ms,outcome,reject_reason,proposal_to_buy_ms,total_signal_to_confirm_ms\n');
  }
}

function logResult(symbol: string, dir: Direction, entryPrice: number, exitPrice: number, result: 'WIN' | 'LOSS') {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()},${symbol},${dir},${entryPrice},${exitPrice},${result}\n`);
}

function logLatency(symbol: string, periodCloseEpoch: number, receivedAtMs: number, processedAtMs: number) {
  const expectedCloseMs = (periodCloseEpoch + GRANULARITY_SEC) * 1000;
  const deliveryLatency = receivedAtMs - expectedCloseMs;
  const processingLatency = processedAtMs - receivedAtMs;
  fs.appendFileSync(LATENCY_LOG_FILE, `${symbol},${periodCloseEpoch},${receivedAtMs},${processedAtMs},${deliveryLatency},${processingLatency}\n`);
  if (deliveryLatency > 5000) {
    console.warn(`[LATENCY WARNING] ${symbol} candle delivered ${(deliveryLatency / 1000).toFixed(1)}s after expected close`);
  }
}

function logExecution(row: {
  symbol: string; direction: Direction; signalMs: number; proposalSentMs: number;
  proposalReceivedMs: number; buySentMs: number; buyConfirmedMs: number;
  outcome: 'CONFIRMED' | 'REJECTED' | 'ERROR'; rejectReason: string;
}) {
  const proposalToBuy = row.buySentMs - row.proposalReceivedMs;
  const totalMs = row.buyConfirmedMs - row.signalMs;
  fs.appendFileSync(EXEC_LOG_FILE,
    `${row.symbol},${row.direction},${row.signalMs},${row.proposalSentMs},${row.proposalReceivedMs},${row.buySentMs},${row.buyConfirmedMs},${row.outcome},"${row.rejectReason.replace(/"/g, '')}",${proposalToBuy},${totalMs}\n`);
}

// ============================================================================
// Real demo order placement (proposal -> buy), with full timing capture
// ============================================================================

let firstProposalLogged = false;
let firstBuyLogged = false;

async function placeDemoOrder(sock: DerivSocket, symbol: string, dir: Direction, signalMs: number) {
  const contractType = dir === 'BUY' ? 'CALL' : 'PUT';
  const proposalSentMs = Date.now();
  try {
    const proposalRes = await sock.send({
      proposal: 1,
      amount: DEMO_STAKE_AMOUNT,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration: EXPIRY_MIN,
      duration_unit: 'm',
      underlying_symbol: symbol,
    });
    const proposalReceivedMs = Date.now();
    if (!firstProposalLogged) {
      console.log('\n[first raw proposal response] (paste this back if field names look wrong)\n', JSON.stringify(proposalRes, null, 2), '\n');
      firstProposalLogged = true;
    }

    const proposalId = proposalRes?.proposal?.id;
    if (!proposalId) {
      logExecution({ symbol, direction: dir, signalMs, proposalSentMs, proposalReceivedMs, buySentMs: proposalReceivedMs, buyConfirmedMs: Date.now(), outcome: 'ERROR', rejectReason: 'No proposal id in response' });
      console.warn(`[EXEC ERROR] ${symbol} no proposal id returned`);
      return;
    }

    const buySentMs = Date.now();
    const buyRes = await sock.send({ buy: proposalId, price: proposalRes.proposal.ask_price });
    const buyConfirmedMs = Date.now();
    if (!firstBuyLogged) {
      console.log('\n[first raw buy response] (paste this back if field names look wrong)\n', JSON.stringify(buyRes, null, 2), '\n');
      firstBuyLogged = true;
    }

    logExecution({ symbol, direction: dir, signalMs, proposalSentMs, proposalReceivedMs, buySentMs, buyConfirmedMs, outcome: 'CONFIRMED', rejectReason: '' });
    console.log(`[ORDER CONFIRMED] ${symbol} ${dir} contract_id=${buyRes?.buy?.contract_id ?? 'unknown'} (signal->confirm: ${buyConfirmedMs - signalMs}ms)`);
  } catch (err) {
    const nowMs = Date.now();
    logExecution({ symbol, direction: dir, signalMs, proposalSentMs, proposalReceivedMs: nowMs, buySentMs: nowMs, buyConfirmedMs: nowMs, outcome: 'REJECTED', rejectReason: (err as Error).message });
    console.warn(`[ORDER REJECTED] ${symbol} ${dir}: ${(err as Error).message}`); console.warn('[FULL ERROR]', JSON.stringify((err as any).derivError ?? {}, null, 2));
  }
}

// ============================================================================
// Candle processing
// ============================================================================

function processNewClosedCandle(symbol: string, state: SymbolState, sock: DerivSocket) {
  const candles = state.candles;
  const idx = candles.length - 1;

  state.openTrades = state.openTrades.filter(t => {
    if (t.expiryIndex !== idx) return true;
    const exitPrice = candles[idx].close;
    const won = (exitPrice > t.entryPrice && t.dir === 'BUY') || (exitPrice < t.entryPrice && t.dir === 'SELL');
    if (won) state.stats.wins++; else state.stats.losses++;
    logResult(symbol, t.dir, t.entryPrice, exitPrice, won ? 'WIN' : 'LOSS');
    const total = state.stats.wins + state.stats.losses;
    const winRate = total > 0 ? (state.stats.wins / total) * 100 : 0;
    console.log(`[RESULT] ${symbol} ${t.dir} entry=${t.entryPrice} exit=${exitPrice} -> ${won ? 'WIN' : 'LOSS'}  (running: ${state.stats.wins}W/${state.stats.losses}L = ${winRate.toFixed(1)}%, breakeven ${BREAKEVEN.toFixed(1)}%)`);
    return false;
  });

  if (candles.length < 30) return;
  const cmoTrig = cmoTriggers(candles);
  const wrTrig = williamsRTriggers(candles);
  const agreements = findAgreements([cmoTrig, wrTrig]);
  const latest = agreements.find(a => a.index === idx);
  if (!latest) return;

  if (idx - state.lastSignalIndex < EXPIRY_MIN) return;
  state.lastSignalIndex = idx;

  const signalMs = Date.now();
  const trade: OpenTrade = {
    symbol, entryIndex: idx, entryTime: candles[idx].time,
    entryPrice: candles[idx].close, dir: latest.dir, expiryIndex: idx + EXPIRY_MIN,
  };
  state.openTrades.push(trade);
  console.log(`[SIGNAL] ${symbol} ${latest.dir} @ ${trade.entryPrice} (expires in ${EXPIRY_MIN} candles)`);

  // Fire the real demo order in parallel -- do not block candle processing on it.
  placeDemoOrder(sock, symbol, latest.dir, signalMs).catch(e => console.warn(`[EXEC FATAL] ${symbol}`, e));
}

// ============================================================================
// Main
// ============================================================================

let firstOhlcLogged = false;

async function main() {
  ensureLogHeaders();
  console.log(`Forward-testing ${SYMBOLS.length} symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Virtual outcomes -> ${LOG_FILE}`);
  console.log(`Candle latency -> ${LATENCY_LOG_FILE}`);
  console.log(`Real DEMO order execution timing -> ${EXEC_LOG_FILE}\n`);

  const accounts = await getAccounts(DERIV_TOKEN!);
  const account = accounts.find(a => a.account_type === 'demo') || accounts[0];

  if (account.account_type !== 'demo') {
    console.error(`SAFETY STOP: account ${account.account_id} is type '${account.account_type}', not 'demo'. Refusing to place real orders. Aborting.`);
    process.exit(1);
  }
  console.log(`Using DEMO account ${account.account_id}\n`);

  let sock = await (async () => { const url = await getOtpWsUrl(account.account_id, DERIV_TOKEN!); const s = new DerivSocket(url); await s.waitReady(); return s; })();

  const states = new Map<string, SymbolState>();
  for (const symbol of SYMBOLS) {
    states.set(symbol, { candles: [], currentOpenEpoch: null, currentCandle: null, lastSignalIndex: -Infinity, openTrades: [], stats: { wins: 0, losses: 0 } });
  }

  async function seedAndSubscribe(symbol: string) {
    const state = states.get(symbol)!;
    const histMsg = await sock.send({ ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: WARMUP_CANDLES, end: 'latest' });
    const hist = (histMsg.candles || []) as any[];
    state.candles = hist.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
    console.log(`[${symbol}] seeded with ${state.candles.length} candles.`);

    await sock.subscribe(
      { ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, count: 1, end: 'latest' },
      (msg) => {
        if (msg.msg_type !== 'ohlc' || !msg.ohlc) return;
        const receivedAtMs = Date.now();
        const o = msg.ohlc;
        if (!firstOhlcLogged) {
          console.log('\n[first raw ohlc message] (paste this back if field names look wrong)\n', JSON.stringify(o, null, 2), '\n');
          firstOhlcLogged = true;
        }
        const periodEpoch = Number(o.open_time ?? o.epoch);
        const candle: Candle = { time: periodEpoch, open: Number(o.open), high: Number(o.high), low: Number(o.low), close: Number(o.close) };

        if (state.currentOpenEpoch === null) {
          state.currentOpenEpoch = periodEpoch;
          state.currentCandle = candle;
          return;
        }
        if (periodEpoch !== state.currentOpenEpoch) {
          if (state.currentCandle) {
            const closedPeriodEpoch = state.currentOpenEpoch;
            state.candles.push(state.currentCandle);
            processNewClosedCandle(symbol, state, sock);
            const processedAtMs = Date.now();
            logLatency(symbol, closedPeriodEpoch, receivedAtMs, processedAtMs);
          }
          state.currentOpenEpoch = periodEpoch;
        }
        state.currentCandle = candle;
      }
    );
    console.log(`[${symbol}] subscribed to live candles.`);
  }

  for (const symbol of SYMBOLS) {
    await seedAndSubscribe(symbol);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nAll symbols live. Watching for signals — this will run until you stop it (Ctrl+C).\n');

  setInterval(async () => {
    if (sock.closed) {
      console.log('[reconnecting] socket dropped, re-establishing and re-subscribing...');
      try {
        const url = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
        sock = new DerivSocket(url);
        await sock.waitReady();
        for (const symbol of SYMBOLS) await seedAndSubscribe(symbol);
        console.log('[reconnected] all symbols re-subscribed.');
      } catch (err) {
        console.warn('[reconnect failed]', (err as Error).message);
      }
    }
  }, 10000);

  setInterval(() => {
    let totalW = 0, totalL = 0;
    for (const [, state] of states) { totalW += state.stats.wins; totalL += state.stats.losses; }
    const total = totalW + totalL;
    if (total === 0) return;
    console.log(`\n[SUMMARY] ${totalW}W / ${totalL}L across all symbols = ${((totalW / total) * 100).toFixed(1)}% (breakeven ${BREAKEVEN.toFixed(1)}%, n=${total})\n`);
  }, 5 * 60 * 1000);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });




