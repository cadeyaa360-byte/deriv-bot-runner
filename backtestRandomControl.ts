// ============================================================================
// CMO+WilliamsR — RANDOM-TRIGGER CONTROL TEST
//
// Purpose: the full 78-symbol run showed 70/78 assets clustered 63.5%-72.3%
// above breakeven, across totally unrelated asset classes (crypto, forex,
// indices, synthetic RNG feeds). A simple signal showing a similarly large
// edge on nearly everything is a classic symptom of a bias in the EVALUATION
// methodology (e.g. entry/exit indexing, look-ahead), not a universal real
// edge. This script tests that directly.
//
// For each symbol it runs:
//   (a) the real CMO+WilliamsR strategy — unchanged from
//       backtestCmoWilliamsAllAssetsV2.ts / backtestCmoWilliamsDerivAll78.ts
//   (b) N trials of RANDOM triggers — same raw signal count, same cooldown
//       rule, evaluated through the IDENTICAL evaluateFixedExpiry function
//
// If random triggers also score well above the 54.05% breakeven, the
// evaluation harness itself is biased and EVERY number produced so far
// (including the original LTC validation) needs to be distrusted.
// If random triggers land near 50%, as they should for a fair coin flip
// on close-to-close direction, the real signal's edge is credible.
//
// SECURITY: reads DERIV_TOKEN from env only. Never hardcode a token here.
// ============================================================================

import WebSocket from 'ws';

const DAYS_BACK = 90;
const GRANULARITY_SEC = 60;
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const CANDLES_PER_REQUEST = 1000;
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 15000;
const RANDOM_TRIALS = 10; // average over this many random-trigger draws per asset

const APP_ID = '33UTL66zPwWIqDVfECusS';
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

const DERIV_TOKEN = process.env.DERIV_TOKEN;
if (!DERIV_TOKEN) {
  console.error('Set DERIV_TOKEN as an environment variable before running.');
  process.exit(1);
}

// Optional: pass symbols as CLI args to test a subset first, e.g.
//   npx tsx backtestRandomControl.ts cryBTCUSD frxEURUSD R_100
const SYMBOL_FILTER = process.argv.slice(2);

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

function applyCooldown(triggers: { index: number; dir: Direction }[], cooldown: number): { index: number; dir: Direction }[] {
  const sorted = [...triggers].sort((a, b) => a.index - b.index);
  const kept: { index: number; dir: Direction }[] = [];
  let lastKeptIndex = -Infinity;
  for (const t of sorted) {
    if (t.index - lastKeptIndex >= cooldown) { kept.push(t); lastKeptIndex = t.index; }
  }
  return kept;
}

function evaluateFixedExpiry(triggers: { index: number; dir: Direction }[], candles: Candle[], expiryMin: number) {
  let correct = 0, total = 0;
  for (const t of triggers) {
    const expIdx = t.index + expiryMin;
    if (expIdx >= candles.length) continue;
    const entry = candles[t.index].close, exit = candles[expIdx].close;
    const actual: Direction = exit > entry ? 'BUY' : exit < entry ? 'SELL' : 'NONE' as any;
    if (actual === 'NONE' as any) continue;
    total++;
    if (actual === t.dir) correct++;
  }
  const winRate = total > 0 ? (correct / total) * 100 : 0;
  return { total, winRate, edge: winRate - BREAKEVEN };
}

// ============================================================================
// Random-trigger control generator
// ============================================================================

function generateRandomTriggers(rawCount: number, minIndex: number, maxIndex: number): { index: number; dir: Direction }[] {
  const out: { index: number; dir: Direction }[] = [];
  for (let i = 0; i < rawCount; i++) {
    const index = minIndex + Math.floor(Math.random() * (maxIndex - minIndex));
    const dir: Direction = Math.random() < 0.5 ? 'BUY' : 'SELL';
    out.push({ index, dir });
  }
  return out;
}

// ============================================================================
// Deriv REST + WebSocket plumbing (same as backtestCmoWilliamsDerivAll78.ts)
// ============================================================================

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
        if (msg.error) reject(new Error(msg.error.message || 'Deriv API error'));
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
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`Request timed out (req_id ${reqId})`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  close() { this.ws.close(); }
}

async function connectFreshSocket(token: string, accountId: string): Promise<DerivSocket> {
  const wsUrl = await getOtpWsUrl(accountId, token);
  const sock = new DerivSocket(wsUrl);
  await sock.waitReady();
  return sock;
}

async function fetchAllSymbols(sock: DerivSocket): Promise<{ symbol: string; name: string; market: string }[]> {
  const msg = await sock.send({ active_symbols: 'brief' });
  return msg.active_symbols.map((s: any) => ({ symbol: s.underlying_symbol, name: s.underlying_symbol_name, market: s.market }));
}

async function fetchDerivCandles(getSocket: () => Promise<DerivSocket>, symbol: string, startEpoch: number, endEpoch: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursorEnd = endEpoch;
  let attempt = 0;
  let sock = await getSocket();

  while (cursorEnd > startEpoch) {
    try {
      if (sock.closed) sock = await getSocket();
      const msg = await sock.send({ ticks_history: symbol, style: 'candles', granularity: GRANULARITY_SEC, end: cursorEnd, count: CANDLES_PER_REQUEST, adjust_start_time: 1 });
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
      console.warn(`  [${symbol}] retry ${attempt}: ${(err as Error).message}`);
      if (sock.closed) { try { sock = await getSocket(); } catch {} }
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const endEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = endEpoch - DAYS_BACK * 24 * 60 * 60;

  console.log(`Breakeven: ${BREAKEVEN.toFixed(2)}%. Random triggers should land near 50% win rate (below breakeven, since it's a fair coin flip on direction) if the evaluation harness is unbiased.\n`);

  const accounts = await getAccounts(DERIV_TOKEN!);
  const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
  console.log(`Using account ${account.account_id} (${account.account_type})`);

  let sock = await connectFreshSocket(DERIV_TOKEN!, account.account_id);
  const getSocket = async () => {
    if (sock.closed) { console.log('  [reconnecting]...'); sock = await connectFreshSocket(DERIV_TOKEN!, account.account_id); }
    return sock;
  };

  let symbols = await fetchAllSymbols(await getSocket());
  if (SYMBOL_FILTER.length > 0) {
    symbols = symbols.filter(s => SYMBOL_FILTER.includes(s.symbol));
    console.log(`Filtering to ${symbols.length} requested symbol(s): ${SYMBOL_FILTER.join(', ')}\n`);
  } else {
    console.log(`Testing all ${symbols.length} symbols.\n`);
  }

  interface Row { symbol: string; market: string; realWinRate: number; realN: number; realEdge: number; randMeanWinRate: number; randStdDev: number; verdict: string; }
  const rows: Row[] = [];

  for (const s of symbols) {
    console.log(`Testing ${s.symbol}...`);
    const candles = await fetchDerivCandles(getSocket, s.symbol, startEpoch, endEpoch);
    if (candles.length < 200) { console.log(`  Skipping — only ${candles.length} candles.\n`); continue; }

    const cmoTrig = cmoTriggers(candles);
    const wrTrig = williamsRTriggers(candles);
    const rawAgreements = findAgreements([cmoTrig, wrTrig]);
    const cooled = applyCooldown(rawAgreements, EXPIRY_MIN);
    const real = evaluateFixedExpiry(cooled, candles, EXPIRY_MIN);

    // Random control: same raw trigger count as the real strategy produced
    // BEFORE cooldown, run through the identical cooldown + evaluation path.
    const minIndex = 20; // past both indicator warmup periods
    const maxIndex = candles.length - EXPIRY_MIN - 1;
    const randomWinRates: number[] = [];
    for (let trial = 0; trial < RANDOM_TRIALS; trial++) {
      const randomRaw = generateRandomTriggers(rawAgreements.length, minIndex, maxIndex);
      const randomCooled = applyCooldown(randomRaw, EXPIRY_MIN);
      const randomResult = evaluateFixedExpiry(randomCooled, candles, EXPIRY_MIN);
      if (randomResult.total > 0) randomWinRates.push(randomResult.winRate);
    }
    const randMean = randomWinRates.length > 0 ? randomWinRates.reduce((a, b) => a + b, 0) / randomWinRates.length : 0;
    const randVariance = randomWinRates.length > 0 ? randomWinRates.reduce((a, b) => a + (b - randMean) ** 2, 0) / randomWinRates.length : 0;
    const randStdDev = Math.sqrt(randVariance);

    let verdict: string;
    if (randMean > BREAKEVEN + 3) {
      verdict = 'EVALUATION BIAS SUSPECTED — random triggers also clear breakeven. Distrust this result.';
    } else if (randMean > 55) {
      verdict = 'Borderline — random triggers running a bit hot. Worth more trials before trusting the real edge.';
    } else {
      verdict = 'Clean — random triggers land near 50% as expected. Real edge looks credible.';
    }

    rows.push({ symbol: s.symbol, market: s.market, realWinRate: real.winRate, realN: real.total, realEdge: real.edge, randMeanWinRate: randMean, randStdDev, verdict });

    console.log(`  REAL:   ${real.winRate.toFixed(1)}% (n=${real.total}, edge ${real.edge >= 0 ? '+' : ''}${real.edge.toFixed(1)})`);
    console.log(`  RANDOM: ${randMean.toFixed(1)}% avg over ${RANDOM_TRIALS} trials (std ${randStdDev.toFixed(1)})`);
    console.log(`  -> ${verdict}\n`);
  }

  sock.close();

  console.log('\n########## RANDOM-TRIGGER CONTROL — SUMMARY ##########');
  console.log('Symbol       | Market          | REAL            | RANDOM (avg±std)   | Verdict');
  console.log('-'.repeat(130));
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(12)} | ${r.market.padEnd(15)} | ${r.realWinRate.toFixed(1).padStart(5)}% (n=${r.realN})`.padEnd(55)
      + `| ${r.randMeanWinRate.toFixed(1)}%±${r.randStdDev.toFixed(1)}`.padEnd(20)
      + `| ${r.verdict}`
    );
  }

  const suspect = rows.filter(r => r.randMeanWinRate > BREAKEVEN + 3).length;
  const clean = rows.filter(r => r.randMeanWinRate <= 55).length;
  console.log(`\n${clean}/${rows.length} clean, ${suspect}/${rows.length} evaluation-bias suspected.`);
  if (suspect > rows.length / 4) {
    console.log('\n>>> A meaningful share of symbols show random triggers clearing breakeven. This points to a bug in evaluateFixedExpiry or the fetch/indexing pipeline, not a real edge. Do not trust the 78-symbol ranking until this is resolved.');
  } else {
    console.log('\n>>> Random triggers mostly land near 50% as expected — the real signal\'s edge looks credible, not an artifact of the evaluation harness.');
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
