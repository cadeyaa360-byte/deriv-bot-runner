// ============================================================================
// STAGE 2: BREADTH + BTC-LEAD ANALYSIS
//
// Reuses the EXACT proven strategy logic from backtestCmoWilliamsDerivAll78.ts
// (cmoTriggers, williamsRTriggers, findAgreements, applyCooldown,
// evaluateFixedExpiry, adxSeries — copied unchanged). Do not modify these
// functions here; any new logic goes in the breadth/lead analysis below.
//
// Reads cached candles from ./cache/*_stage1.json (Stage 1 output).
// Tests two untested factors:
//   1. Within-group breadth: does the number of OTHER symbols in the same
//      asset class agreeing in the same direction at ~the same time predict
//      a higher win rate on the signal?
//   2. BTC-lead: does a BTC (or ETH) signal predict same-direction signals
//      in forex/indices shortly after, and do those "led" signals win more?
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const ADX_THRESHOLD = 25;

const BREADTH_WINDOW_MIN = 2;   // how close in time two signals must be to count as "confluent"
const LEAD_WINDOW_MIN = 10;     // how far after a BTC/ETH signal to look for a "led" signal

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; }

// ============================================================================
// EXACT proven strategy logic — copied unchanged from
// backtestCmoWilliamsDerivAll78.ts. Do not modify.
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
// Groups — within-class breadth only, per the earlier decision.
// Commodities kept separate too (small group, still internally coherent).
// ============================================================================

const GROUPS: Record<string, string[]> = {
  FOREX: ['frxGBPCHF','frxEURUSD','frxUSDPLN','frxEURNZD','frxEURAUD','frxAUDCHF','frxNZDUSD','frxUSDCHF','frxGBPUSD','frxEURGBP','frxAUDUSD','frxUSDCAD','frxAUDNZD','frxEURCAD','frxNZDJPY','frxAUDJPY','frxGBPAUD','frxEURJPY','frxAUDCAD','frxGBPNZD','frxGBPCAD','frxUSDMXN'],
  INDICES: ['OTC_SSMI','OTC_NDX','OTC_GDAXI','OTC_N225','OTC_SPC','OTC_HSI','OTC_AS51','OTC_DJI','OTC_SX5E','OTC_FCHI','OTC_FTSE','OTC_AEX'],
  COMMODITIES: ['frxXPTUSD','frxXAUUSD','frxXAGUSD'],
  CRYPTO: ['cryETHUSD','cryBTCUSD'],
};

const LEAD_SYMBOLS = ['cryBTCUSD', 'cryETHUSD'];
const LEAD_TARGET_GROUPS = ['FOREX', 'INDICES', 'COMMODITIES']; // exclude crypto-vs-crypto from lead test

function loadCandles(symbol: string): Candle[] | null {
  const path = `cache/${symbol}_stage1.json`;
  if (!existsSync(path)) { console.warn(`Missing cache for ${symbol}, skipping.`); return null; }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function computeSignals(candles: Candle[]): { signals: Signal[]; adx: number[] } {
  const cmoTrig = cmoTriggers(candles);
  const wrTrig = williamsRTriggers(candles);
  const raw = findAgreements([cmoTrig, wrTrig]);
  const cooled = applyCooldown(raw, EXPIRY_MIN);
  const adx = adxSeries(candles, 14);
  const strongOnly = cooled.filter(s => adx[s.index] >= ADX_THRESHOLD); // proven filter, applied throughout
  const signals: Signal[] = strongOnly.map(s => ({ index: s.index, dir: s.dir, time: candles[s.index].time }));
  return { signals, adx };
}

// ============================================================================
// Part 1 — within-group breadth
// ============================================================================

function analyzeBreadth(groupName: string, symbols: string[], data: Map<string, { candles: Candle[]; signals: Signal[] }>) {
  console.log(`\n=== BREADTH — ${groupName} (${symbols.length} symbols) ===`);

  // bucket: breadth count -> {correct, total}
  const buckets = new Map<number, { correct: number; total: number }>();

  for (const sym of symbols) {
    const entry = data.get(sym);
    if (!entry) continue;
    const { candles, signals } = entry;

    for (const sig of signals) {
      let breadth = 0;
      for (const other of symbols) {
        if (other === sym) continue;
        const otherEntry = data.get(other);
        if (!otherEntry) continue;
        const match = otherEntry.signals.some(
          s => s.dir === sig.dir && Math.abs(s.time - sig.time) <= BREADTH_WINDOW_MIN * 60
        );
        if (match) breadth++;
      }

      const expIdx = sig.index + EXPIRY_MIN;
      if (expIdx >= candles.length) continue;
      const entryPrice = candles[sig.index].close, exitPrice = candles[expIdx].close;
      const actual: Direction | 'NONE' = exitPrice > entryPrice ? 'BUY' : exitPrice < entryPrice ? 'SELL' : 'NONE';
      if (actual === 'NONE') continue;

      const bucketKey = Math.min(breadth, 4); // cap display at "4+"
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, { correct: 0, total: 0 });
      const b = buckets.get(bucketKey)!;
      b.total++;
      if (actual === sig.dir) b.correct++;
    }
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  console.log('Breadth | WinRate | n | Edge');
  for (const k of sortedKeys) {
    const b = buckets.get(k)!;
    const wr = b.total > 0 ? (b.correct / b.total) * 100 : 0;
    const edge = wr - BREAKEVEN;
    const label = k === 4 ? '4+' : String(k);
    console.log(`${label.padEnd(7)} | ${wr.toFixed(1).padStart(6)}% | ${String(b.total).padEnd(5)} | ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}`);
  }
}

// ============================================================================
// Part 2 — BTC/ETH lead
// ============================================================================

function analyzeLead(data: Map<string, { candles: Candle[]; signals: Signal[] }>) {
  console.log(`\n=== BTC/ETH LEAD (window: ${LEAD_WINDOW_MIN}min) ===`);

  const leadTimes: { dir: Direction; time: number }[] = [];
  for (const leadSym of LEAD_SYMBOLS) {
    const entry = data.get(leadSym);
    if (!entry) continue;
    for (const s of entry.signals) leadTimes.push({ dir: s.dir, time: s.time });
  }
  if (leadTimes.length === 0) { console.log('No BTC/ETH signals found — nothing to test.'); return; }

  let ledCorrect = 0, ledTotal = 0, unledCorrect = 0, unledTotal = 0;

  for (const groupName of LEAD_TARGET_GROUPS) {
    for (const sym of GROUPS[groupName]) {
      const entry = data.get(sym);
      if (!entry) continue;
      const { candles, signals } = entry;

      for (const sig of signals) {
        const expIdx = sig.index + EXPIRY_MIN;
        if (expIdx >= candles.length) continue;
        const entryPrice = candles[sig.index].close, exitPrice = candles[expIdx].close;
        const actual: Direction | 'NONE' = exitPrice > entryPrice ? 'BUY' : exitPrice < entryPrice ? 'SELL' : 'NONE';
        if (actual === 'NONE') continue;

        const wasLed = leadTimes.some(
          lt => lt.dir === sig.dir && sig.time - lt.time > 0 && sig.time - lt.time <= LEAD_WINDOW_MIN * 60
        );
        const win = actual === sig.dir ? 1 : 0;
        if (wasLed) { ledTotal++; ledCorrect += win; } else { unledTotal++; unledCorrect += win; }
      }
    }
  }

  const ledWr = ledTotal > 0 ? (ledCorrect / ledTotal) * 100 : 0;
  const unledWr = unledTotal > 0 ? (unledCorrect / unledTotal) * 100 : 0;
  console.log(`Led by BTC/ETH:     ${ledWr.toFixed(1)}% (n=${ledTotal}, edge ${(ledWr - BREAKEVEN >= 0 ? '+' : '')}${(ledWr - BREAKEVEN).toFixed(1)})`);
  console.log(`Not led:            ${unledWr.toFixed(1)}% (n=${unledTotal}, edge ${(unledWr - BREAKEVEN >= 0 ? '+' : '')}${(unledWr - BREAKEVEN).toFixed(1)})`);
  console.log(`Difference: ${(ledWr - unledWr).toFixed(1)} pts ${ledTotal < 30 ? '— CAUTION: small sample, treat as inconclusive' : ''}`);
}

// ============================================================================
// Main
// ============================================================================

function main() {
  console.log(`Breakeven win rate needed at ${(PAYOUT_RATE * 100).toFixed(0)}% payout: ${BREAKEVEN.toFixed(2)}%\n`);

  const allSymbols = Object.values(GROUPS).flat();
  const data = new Map<string, { candles: Candle[]; signals: Signal[] }>();

  for (const sym of allSymbols) {
    const candles = loadCandles(sym);
    if (!candles || candles.length < 100) continue;
    const { signals } = computeSignals(candles);
    data.set(sym, { candles, signals });
    console.log(`${sym}: ${candles.length} candles, ${signals.length} STRONG signals`);
  }

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue; // breadth needs at least 2 symbols to be meaningful
    analyzeBreadth(groupName, symbols, data);
  }

  analyzeLead(data);

  console.log('\nReminder: this is one historical window. Any bucket/lead effect here still needs forward validation before it changes live signal logic.');
}

main();
