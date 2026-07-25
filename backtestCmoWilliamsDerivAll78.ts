// ============================================================================
// CMO+WilliamsR CROSS-ASSET BACKTEST — ALL DERIV SYMBOLS
//
// Runs the EXACT proven strategy logic from backtestCmoWilliamsAllAssetsV2.ts
// (cmoTriggers, williamsRTriggers, findAgreements, applyCooldown,
// evaluateFixedExpiry, adxSeries — copied unchanged) against every symbol
// Deriv currently lists, using candle history pulled directly from Deriv's
// own WebSocket API instead of Binance. This removes any price-feed mismatch
// between the backtest and what a real contract would actually be priced against.
//
// SECURITY:
//   - Reads the API token from the DERIV_TOKEN environment variable ONLY.
//   - Never hardcode a token in this file or paste it into chat/logs.
//   - If a token has ever been exposed (terminal output shared, pasted
//     anywhere, committed to git), revoke it in Deriv's app settings and
//     generate a fresh one before using it here.
//
// USAGE:
//   $env:DERIV_TOKEN = "your_token_here"
//   npx tsx backtestCmoWilliamsDerivAll78.ts
//
// This will take a while — see the runtime note printed at startup.
// ============================================================================

import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config — identical values to the validated V2 script
// ---------------------------------------------------------------------------
const DAYS_BACK = 90;
const GRANULARITY_SEC = 60; // 1-minute candles
const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const ADX_THRESHOLD = 25;

// Deriv-specific fetch tuning
const CANDLES_PER_REQUEST = 1000;
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;

const DERIV_TOKEN = process.env.DERIV_TOKEN;
if (!DERIV_TOKEN) {
  console.error('Set DERIV_TOKEN as an environment variable before running (do not hardcode it here).');
  process.exit(1);
}

const APP_ID = '33UTL66zPwWIqDVfECusS'; // cadesignalAI native app — matches derivRestAuth.ts
const REST_BASE = 'https://api.derivws.com/trading/v1/options';

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }

// ============================================================================
// EXACT proven strategy logic — copied unchanged from
// backtestCmoWilliamsAllAssetsV2.ts. Do not modify when diagnosing weak
// assets; any per-asset adjustment belongs in the selection/filter layer
// below, not here, or results stop being comparable to the validated
// 68.4% / 70.4% LTC baseline.
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

// ============================================================================
// Deriv-specific: auth, symbol discovery, paged candle fetch
// ============================================================================

async function getAccounts(token: string): Promise<{ account_id: string; account_type: string }[]> {
  const res = await fetch(`${REST_BASE}/accounts`, {
    headers: {
      'Deriv-App-ID': APP_ID,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`Accounts fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.data;
}

async function getOtpWsUrl(accountId: string, token: string): Promise<string> {
  const res = await fetch(`${REST_BASE}/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: {
      'Deriv-App-ID': APP_ID,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`OTP fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.data.url;
}

// Simple request/response correlator over a single persistent WebSocket.
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

async function fetchAllSymbols(sock: DerivSocket): Promise<{ symbol: string; name: string; market: string }[]> {
  const msg = await sock.send({ active_symbols: 'brief' });
  return msg.active_symbols.map((s: any) => ({
    symbol: s.underlying_symbol,
    name: s.underlying_symbol_name,
    market: s.market,
  }));
}

async function fetchDerivCandles(sock: DerivSocket, symbol: string, startEpoch: number, endEpoch: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursorEnd = endEpoch;
  let attempt = 0;

  while (cursorEnd > startEpoch) {
    try {
      const msg = await sock.send({
        ticks_history: symbol,
        style: 'candles',
        granularity: GRANULARITY_SEC,
        end: cursorEnd,
        count: CANDLES_PER_REQUEST,
        adjust_start_time: 1,
      });
      const candles = (msg.candles || []) as any[];
      if (candles.length === 0) break;

      for (const c of candles) {
        all.push({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close });
      }

      const oldestEpoch = candles[0].epoch;
      if (oldestEpoch >= cursorEnd) break; // no progress, stop
      cursorEnd = oldestEpoch - GRANULARITY_SEC;
      attempt = 0;
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        console.warn(`  [${symbol}] giving up after ${MAX_RETRIES} retries: ${(err as Error).message}`);
        break;
      }
      const backoff = REQUEST_DELAY_MS * Math.pow(2, attempt);
      console.warn(`  [${symbol}] retry ${attempt} after error: ${(err as Error).message} (waiting ${backoff}ms)`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  // dedupe + sort ascending by time (paging can overlap at boundaries)
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

// ============================================================================
// Diagnostics — surfaces WHY an asset is weak, doesn't silently discard it
// ============================================================================

interface AssetResult {
  symbol: string;
  name: string;
  market: string;
  candleCount: number;
  rawSignals: number;
  cooledSignals: number;
  avgAdxAtSignal: number;
  overall: ReturnType<typeof evaluateFixedExpiry>;
  strong: ReturnType<typeof evaluateFixedExpiry>;
  standard: ReturnType<typeof evaluateFixedExpiry>;
  diagnosis: string;
}

function diagnose(r: Omit<AssetResult, 'diagnosis'>): string {
  if (r.candleCount < 1000) return 'Insufficient history returned — check symbol is actively traded / not suspended.';
  if (r.cooledSignals < 30) return 'Too few signals after cooldown to draw a conclusion — CMO/Williams %R rarely agree on this instrument; agreement window or cooldown may need loosening for this asset class.';
  if (r.overall.edge < -3) return 'Win rate meaningfully below breakeven — this is not noise at this sample size; the signal likely does not transfer to this instrument.';
  if (Math.abs(r.overall.edge) <= 3) return 'Roughly breakeven — consistent with no exploitable edge here, not with a bug.';
  if (r.strong.total >= 20 && r.strong.edge - r.standard.edge > 5) return 'Edge concentrated in the ADX>=25 (trending) regime — consider trading this asset only when ADX is elevated.';
  return 'Edge present and roughly in line with the validated baseline.';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const endEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = endEpoch - DAYS_BACK * 24 * 60 * 60;

  console.log(`Breakeven win rate needed at ${(PAYOUT_RATE * 100).toFixed(0)}% payout: ${BREAKEVEN.toFixed(2)}%`);
  console.log(`Pulling ~${DAYS_BACK} days of ${GRANULARITY_SEC / 60}m candles for every Deriv symbol.`);
  console.log(`This is a lot of requests (thousands) — expect this to take a while.\n`);

  const accounts = await getAccounts(DERIV_TOKEN!);
  const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
  if (!account) throw new Error('No Deriv account found for this token.');
  console.log(`Using account ${account.account_id} (${account.account_type})`);

  const wsUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
  const sock = new DerivSocket(wsUrl);
  await sock.waitReady();

  const symbols = await fetchAllSymbols(sock);
  console.log(`Found ${symbols.length} symbols across ${new Set(symbols.map(s => s.market)).size} markets.\n`);

  const results: AssetResult[] = [];

  for (const s of symbols) {
    console.log(`Fetching ${s.symbol} (${s.name})...`);
    const candles = await fetchDerivCandles(sock, s.symbol, startEpoch, endEpoch);
    if (candles.length < 100) {
      console.log(`  Skipping — only ${candles.length} candles returned.\n`);
      continue;
    }

    const cmoTrig = cmoTriggers(candles);
    const wrTrig = williamsRTriggers(candles);
    const rawAgreements = findAgreements([cmoTrig, wrTrig]);
    const cooled = applyCooldown(rawAgreements, EXPIRY_MIN);
    const adx = adxSeries(candles, 14);

    const strongSignals = cooled.filter(sig => adx[sig.index] >= ADX_THRESHOLD);
    const standardSignals = cooled.filter(sig => adx[sig.index] < ADX_THRESHOLD);
    const overall = evaluateFixedExpiry(cooled, candles, EXPIRY_MIN);
    const strong = evaluateFixedExpiry(strongSignals, candles, EXPIRY_MIN);
    const standard = evaluateFixedExpiry(standardSignals, candles, EXPIRY_MIN);
    const avgAdxAtSignal = cooled.length > 0
      ? cooled.reduce((sum, sig) => sum + adx[sig.index], 0) / cooled.length
      : 0;

    const partial: Omit<AssetResult, 'diagnosis'> = {
      symbol: s.symbol, name: s.name, market: s.market,
      candleCount: candles.length, rawSignals: rawAgreements.length, cooledSignals: cooled.length,
      avgAdxAtSignal, overall, strong, standard,
    };
    const diagnosis = diagnose(partial);
    results.push({ ...partial, diagnosis });

    console.log(`  ${candles.length} candles | signals ${cooled.length} (raw ${rawAgreements.length}) | Overall ${overall.winRate.toFixed(1)}% (n=${overall.total}, edge ${overall.edge >= 0 ? '+' : ''}${overall.edge.toFixed(1)})`);
    console.log(`  STRONG ${strong.winRate.toFixed(1)}% (n=${strong.total})  STANDARD ${standard.winRate.toFixed(1)}% (n=${standard.total})`);
    console.log(`  -> ${diagnosis}\n`);
  }

  sock.close();

  // Sort by edge descending — best performers first
  results.sort((a, b) => b.overall.edge - a.overall.edge);

  console.log('\n########## CMO+WilliamsR — ALL DERIV SYMBOLS — RANKED BY EDGE ##########');
  console.log('Symbol       | Market          | Overall        | STRONG          | STANDARD        | Diagnosis');
  console.log('-'.repeat(140));
  for (const r of results) {
    console.log(
      `${r.symbol.padEnd(12)} | ${r.market.padEnd(15)} | ${r.overall.winRate.toFixed(1).padStart(5)}% (n=${r.overall.total})`.padEnd(60)
      + `| ${r.strong.winRate.toFixed(1).padStart(5)}% (n=${r.strong.total})`.padEnd(18)
      + `| ${r.standard.winRate.toFixed(1).padStart(5)}% (n=${r.standard.total})`.padEnd(18)
      + `| ${r.diagnosis}`
    );
  }

  const above = results.filter(r => r.overall.edge > 3);
  const roughly = results.filter(r => Math.abs(r.overall.edge) <= 3);
  const below = results.filter(r => r.overall.edge < -3);
  console.log(`\nSummary: ${above.length} clearly above breakeven, ${roughly.length} roughly at breakeven, ${below.length} clearly below breakeven.`);
  console.log('Remember: this is one historical window, not forward performance. Anything here still needs forward/paper validation before it informs real trades.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
