// ============================================================================
// STAGE 5: BREADTH DECORRELATION CONTROL TEST
//
// For each group, computes TWO cross-tabs side by side:
//   REAL breadth  - exactly as before, using the symbol's own group.
//   FAKE breadth  - using a randomly shuffled symbol->group mapping (fixed
//                   seed, reproducible), so "breadth" is computed against
//                   symbols that have no real reason to be correlated with
//                   the signal's own symbol.
//
// If FAKE breadth shows a similar win-rate ramp to REAL breadth, that means
// breadth is picking up something like "easy market conditions for everyone
// right now" rather than genuine cross-market confirmation -- since a random
// pairing has no business "confirming" anything.
//
// If FAKE breadth stays flat while REAL breadth ramps, that's real evidence
// breadth is genuine independent information.
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const RANDOM_SEED = 42; // fixed seed so this is reproducible

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; adx: number }

// ---------------------------------------------------------------------------
// EXACT proven logic - unchanged.
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

function breadthOf(sym: string, sig: Signal, pairSymbols: string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>): number {
  let breadth = 0;
  for (const other of pairSymbols) {
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

// simple seeded PRNG (mulberry32) so the shuffle is reproducible
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function crossTab(label: string, symbols: string[], pairSymbolsFor: (sym: string) => string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>) {
  console.log(`\n--- ${label} ---`);
  const cells = new Map<string, { correct: number; total: number }>();

  for (const sym of symbols) {
    const entry = data.get(sym);
    if (!entry) continue;
    const { candles, signals } = entry;
    const pairSymbols = pairSymbolsFor(sym);
    for (const sig of signals) {
      const actual = outcomeOf(sig, candles);
      if (actual === 'NONE') continue;
      const breadth = Math.min(breadthOf(sym, sig, pairSymbols, data), 3);
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

function main() {
  const allSymbols = Object.values(GROUPS).flat();
  const data = new Map<string, { candles: Candle[]; signals: Signal[] }>();

  for (const sym of allSymbols) {
    const candles = loadCandles(sym);
    if (!candles || candles.length < 100) continue;
    const signals = computeSignals(candles);
    data.set(sym, { candles, signals });
  }

  const rng = mulberry32(RANDOM_SEED);
  // build a fixed random pairing: each symbol gets assigned a DIFFERENT
  // random subset of the SAME SIZE as its real group, drawn from all symbols
  // (excluding itself), so breadth denominators are comparable.
  const fakePairings = new Map<string, string[]>();
  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    for (const sym of symbols) {
      const pool = allSymbols.filter(s => s !== sym);
      const shuffled = shuffle(pool, rng);
      fakePairings.set(sym, shuffled.slice(0, symbols.length - 1));
    }
  }

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    console.log(`\n=== ${groupName} ===`);
    crossTab('REAL breadth (own group)', symbols, (sym) => symbols, data);
    crossTab('FAKE breadth (random pairing, same seed)', symbols, (sym) => fakePairings.get(sym) ?? [], data);
  }

  console.log('\nIf FAKE breadth shows a similar win-rate ramp to REAL breadth in the 3+ column, breadth is likely detecting general favorable conditions, not genuine cross-market confirmation.');
  console.log('If FAKE breadth stays flat/random while REAL breadth ramps clearly, that supports breadth being real independent information.');
}

main();
