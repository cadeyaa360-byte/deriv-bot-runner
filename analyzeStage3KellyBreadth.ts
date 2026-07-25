// ============================================================================
// STAGE 3: ADX-BREADTH INDEPENDENCE CHECK + KELLY SIZING BY BREADTH
//
// Reuses the EXACT proven strategy logic unchanged (cmoTriggers,
// williamsRTriggers, findAgreements, applyCooldown, evaluateFixedExpiry,
// adxSeries). Builds on Stage 2's breadth logic.
//
// Part A: cross-tabulates ADX bucket x breadth bucket win rate, to check
//   whether breadth's edge survives WITHIN each ADX bucket (i.e. is it
//   independent information, or just the same trending-regime signal
//   showing up twice).
// Part B: computes a Kelly fraction per (group, breadth bucket), using
//   quarter-Kelly for safety, so breadth can size trades instead of
//   filtering them.
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const KELLY_FRACTION = 0.25; // quarter-Kelly — full Kelly is too aggressive for live sizing
const MAX_KELLY_CAP = 0.05;  // never risk more than 5% of bankroll on one trade, regardless of Kelly output

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; adx: number }

// ---------------------------------------------------------------------------
// EXACT proven logic — copied unchanged. Do not modify.
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
// Groups — same as Stage 2
// ---------------------------------------------------------------------------
const GROUPS: Record<string, string[]> = {
  FOREX: ['frxGBPCHF','frxEURUSD','frxUSDPLN','frxEURNZD','frxEURAUD','frxAUDCHF','frxNZDUSD','frxUSDCHF','frxGBPUSD','frxEURGBP','frxAUDUSD','frxUSDCAD','frxAUDNZD','frxEURCAD','frxNZDJPY','frxAUDJPY','frxGBPAUD','frxEURJPY','frxAUDCAD','frxGBPNZD','frxGBPCAD','frxUSDMXN'],
  INDICES: ['OTC_SSMI','OTC_NDX','OTC_GDAXI','OTC_N225','OTC_SPC','OTC_HSI','OTC_AS51','OTC_DJI','OTC_SX5E','OTC_FCHI','OTC_FTSE','OTC_AEX'],
  COMMODITIES: ['frxXPTUSD','frxXAUUSD','frxXAGUSD'],
  CRYPTO: ['cryETHUSD','cryBTCUSD'],
};

function loadCandles(symbol: string): Candle[] | null {
  const path = `cache/${symbol}_stage1.json`;
  if (!existsSync(path)) { console.warn(`Missing cache for ${symbol}, skipping.`); return null; }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// NOTE: this keeps ALL cooled signals (not just STRONG) so the ADX-bucket
// breakdown below has something to bucket by. STRONG/STANDARD emerges
// naturally as one of the ADX buckets.
function computeSignals(candles: Candle[]): Signal[] {
  const cmoTrig = cmoTriggers(candles);
  const wrTrig = williamsRTriggers(candles);
  const raw = findAgreements([cmoTrig, wrTrig]);
  const cooled = applyCooldown(raw, EXPIRY_MIN);
  const adx = adxSeries(candles, 14);
  return cooled.map(s => ({ index: s.index, dir: s.dir, time: candles[s.index].time, adx: adx[s.index] }));
}

function outcomeOf(sig: Signal, candles: Candle[]): Direction | 'NONE' {
  const expIdx = sig.index + EXPIRY_MIN;
  if (expIdx >= candles.length) return 'NONE';
  const entry = candles[sig.index].close, exit = candles[expIdx].close;
  return exit > entry ? 'BUY' : exit < entry ? 'SELL' : 'NONE';
}

function breadthOf(sym: string, sig: Signal, symbols: string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>): number {
  let breadth = 0;
  for (const other of symbols) {
    if (other === sym) continue;
    const otherEntry = data.get(other);
    if (!otherEntry) continue;
    const match = otherEntry.signals.some(s => s.dir === sig.dir && Math.abs(s.time - sig.time) <= BREADTH_WINDOW_MIN * 60);
    if (match) breadth++;
  }
  return breadth;
}

function adxBucketOf(adx: number): string {
  if (adx < 25) return '<25 (STANDARD)';
  if (adx < 35) return '25-35';
  if (adx < 45) return '35-45';
  return '45+';
}

function kelly(winRate: number): number {
  const p = winRate / 100;
  const q = 1 - p;
  const raw = p - q / PAYOUT_RATE; // Kelly fraction for binary payout b=PAYOUT_RATE
  const fractional = Math.max(0, raw) * KELLY_FRACTION;
  return Math.min(fractional, MAX_KELLY_CAP);
}

// ---------------------------------------------------------------------------
// Part A — ADX x Breadth cross-tab, per group
// ---------------------------------------------------------------------------
function analyzeCrossTab(groupName: string, symbols: string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>) {
  console.log(`\n=== ADX x BREADTH CROSS-TAB — ${groupName} ===`);
  // key: `${adxBucket}|${breadthBucket}` -> {correct, total}
  const cells = new Map<string, { correct: number; total: number }>();

  for (const sym of symbols) {
    const entry = data.get(sym);
    if (!entry) continue;
    const { candles, signals } = entry;
    for (const sig of signals) {
      const actual = outcomeOf(sig, candles);
      if (actual === 'NONE') continue;
      const breadth = Math.min(breadthOf(sym, sig, symbols, data), 3); // cap at "3+" for readability here
      const adxB = adxBucketOf(sig.adx);
      const breadthLabel = breadth === 3 ? '3+' : String(breadth);
      const key = `${adxB}|${breadthLabel}`;
      if (!cells.has(key)) cells.set(key, { correct: 0, total: 0 });
      const c = cells.get(key)!;
      c.total++;
      if (actual === sig.dir) c.correct++;
    }
  }

  const adxOrder = ['<25 (STANDARD)', '25-35', '35-45', '45+'];
  const breadthOrder = ['0', '1', '2', '3+'];
  console.log('ADX bucket      | Breadth 0        | Breadth 1        | Breadth 2        | Breadth 3+');
  for (const adxB of adxOrder) {
    let row = adxB.padEnd(16) + ' | ';
    for (const bB of breadthOrder) {
      const c = cells.get(`${adxB}|${bB}`);
      if (!c || c.total < 10) { row += '(n<10)'.padEnd(18); continue; }
      const wr = (c.correct / c.total) * 100;
      row += `${wr.toFixed(1)}% (n=${c.total})`.padEnd(18);
    }
    console.log(row);
  }
}

// ---------------------------------------------------------------------------
// Part B — Kelly sizing table per group x breadth bucket (STRONG signals only,
// since that's the proven base filter — breadth/Kelly refine sizing within it)
// ---------------------------------------------------------------------------
function analyzeKelly(groupName: string, symbols: string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>) {
  console.log(`\n=== KELLY SIZING (quarter-Kelly, capped ${(MAX_KELLY_CAP * 100).toFixed(0)}%) — ${groupName}, STRONG (ADX>=25) only ===`);
  const buckets = new Map<number, { correct: number; total: number }>();

  for (const sym of symbols) {
    const entry = data.get(sym);
    if (!entry) continue;
    const { candles, signals } = entry;
    for (const sig of signals) {
      if (sig.adx < ADX_THRESHOLD) continue;
      const actual = outcomeOf(sig, candles);
      if (actual === 'NONE') continue;
      const breadth = Math.min(breadthOf(sym, sig, symbols, data), 4);
      if (!buckets.has(breadth)) buckets.set(breadth, { correct: 0, total: 0 });
      const b = buckets.get(breadth)!;
      b.total++;
      if (actual === sig.dir) b.correct++;
    }
  }

  console.log('Breadth | WinRate | n     | Kelly fraction | Kelly %bankroll');
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(k)!;
    if (b.total < 10) continue;
    const wr = (b.correct / b.total) * 100;
    const kf = kelly(wr);
    const label = k === 4 ? '4+' : String(k);
    console.log(`${label.padEnd(7)} | ${wr.toFixed(1).padStart(6)}% | ${String(b.total).padEnd(5)} | ${kf.toFixed(4).padEnd(14)} | ${(kf * 100).toFixed(2)}%`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log(`Breakeven win rate needed at ${(PAYOUT_RATE * 100).toFixed(0)}% payout: ${BREAKEVEN.toFixed(2)}%`);
  console.log(`Kelly settings: fraction=${KELLY_FRACTION} (quarter-Kelly), cap=${(MAX_KELLY_CAP * 100).toFixed(0)}% of bankroll per trade\n`);

  const allSymbols = Object.values(GROUPS).flat();
  const data = new Map<string, { candles: Candle[]; signals: Signal[] }>();

  for (const sym of allSymbols) {
    const candles = loadCandles(sym);
    if (!candles || candles.length < 100) continue;
    const signals = computeSignals(candles);
    data.set(sym, { candles, signals });
  }

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    analyzeCrossTab(groupName, symbols, data);
  }

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    analyzeKelly(groupName, symbols, data);
  }

  console.log('\nReminder: this is one historical window. Kelly fractions here are a starting point for forward/paper testing, not a live sizing table yet — position sizing on backtest-only stats risks overfitting to this specific 90-day window.');
}

main();
