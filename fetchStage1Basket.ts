// ============================================================================
// STAGE 1: FETCH + CACHE — 39-symbol real-market basket, 90 days
// Reuses the EXACT proven Deriv auth/fetch code from
// backtestCmoWilliamsDerivAll78.ts unchanged. Saves raw candles to disk so
// later analysis stages (breadth, BTC-lead, USD-lead, expiry sweep, Kelly
// sizing) don't need to re-fetch.
// ============================================================================

import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

const DAYS_BACK = 90;
const GRANULARITY_SEC = 60;
const CANDLES_PER_REQUEST = 1000;
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;

const DERIV_TOKEN = process.env.DERIV_TOKEN;
if (!DERIV_TOKEN) {
  console.error('Set DERIV_TOKEN as an environment variable before running.');
  process.exit(1);
}

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

interface Candle { time: number; open: number; high: number; low: number; close: number; }

const SYMBOL_BASKET = [
  // Indices
  'OTC_SSMI', 'OTC_NDX', 'OTC_GDAXI', 'OTC_N225', 'OTC_SPC', 'OTC_HSI', 'OTC_AS51', 'OTC_DJI', 'OTC_SX5E', 'OTC_FCHI', 'OTC_FTSE', 'OTC_AEX',
  // Forex
  'frxGBPCHF', 'frxEURUSD', 'frxUSDPLN', 'frxEURNZD', 'frxEURAUD', 'frxAUDCHF', 'frxNZDUSD', 'frxUSDCHF', 'frxGBPUSD', 'frxEURGBP', 'frxAUDUSD', 'frxUSDCAD', 'frxAUDNZD', 'frxEURCAD', 'frxNZDJPY', 'frxAUDJPY', 'frxGBPAUD', 'frxEURJPY', 'frxAUDCAD', 'frxGBPNZD', 'frxGBPCAD', 'frxUSDMXN',
  // Commodities
  'frxXPTUSD', 'frxXAUUSD', 'frxXAGUSD',
  // Crypto
  'cryETHUSD', 'cryBTCUSD',
];

async function getAccounts(token: string): Promise<{ account_id: string; account_type: string }[]> {
  const res = await fetch(`${REST_BASE}/accounts`, {
    headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Accounts fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.data;
}

async function getOtpWsUrl(accountId: string, token: string): Promise<string> {
  const res = await fetch(`${REST_BASE}/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`OTP fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.data.url;
}

class DerivSocket {
  private ws: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private ready: Promise<void>;

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
        const { resolve, reject } = this.pending.get(reqId)!;
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
      this.pending.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  close() { this.ws.close(); }
}

async function fetchDerivCandles(sock: DerivSocket, symbol: string, startEpoch: number, endEpoch: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursorEnd = endEpoch;
  let attempt = 0;

  while (cursorEnd > startEpoch) {
    try {
      const msg = await sock.send({
        ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC,
        end: cursorEnd, count: CANDLES_PER_REQUEST, adjust_start_time: 1,
      });
      const candles = (msg.candles || []) as any[];
      if (candles.length === 0) break;
      for (const c of candles) all.push({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close });
      const oldestEpoch = candles[0].epoch;
      if (oldestEpoch >= cursorEnd) break;
      cursorEnd = oldestEpoch - GRANULARITY_SEC;
      attempt = 0;
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) { console.warn(`  [${symbol}] giving up: ${(err as Error).message}`); break; }
      const backoff = REQUEST_DELAY_MS * Math.pow(2, attempt);
      console.warn(`  [${symbol}] retry ${attempt}: ${(err as Error).message} (waiting ${backoff}ms)`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function main() {
  const endEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = endEpoch - DAYS_BACK * 24 * 60 * 60;

  if (!existsSync('cache')) mkdirSync('cache');

  console.log(`Fetching ${SYMBOL_BASKET.length} symbols, ${DAYS_BACK} days each. This will take a while.\n`);

  const accounts = await getAccounts(DERIV_TOKEN!);
  const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
  console.log(`Using account ${account.account_id} (${account.account_type})`);

  const wsUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
  const sock = new DerivSocket(wsUrl);
  await sock.waitReady();

  for (let i = 0; i < SYMBOL_BASKET.length; i++) {
    const symbol = SYMBOL_BASKET[i];
    const cachePath = `cache/${symbol}_stage1.json`;
    if (existsSync(cachePath)) {
      console.log(`[${i + 1}/${SYMBOL_BASKET.length}] ${symbol} — already cached, skipping.`);
      continue;
    }
    console.log(`[${i + 1}/${SYMBOL_BASKET.length}] Fetching ${symbol}...`);
    const candles = await fetchDerivCandles(sock, symbol, startEpoch, endEpoch);
    writeFileSync(cachePath, JSON.stringify(candles));
    console.log(`  Saved ${candles.length} candles to ${cachePath}`);
  }

  sock.close();
  console.log('\nAll symbols fetched and cached in ./cache/');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
