// ============================================================================
// BREADTH CONTROL TEST — circular time-shift permutation
//
// The Stage 3 cross-tab showed breadth's win-rate lift holding up within
// every ADX bucket — good evidence it's real, independent information.
// But unlike the core CMO+WilliamsR signal (which passed a random-trigger
// control test), breadth itself has never been isolated from a subtler
// possibility: that periods with many symbols signaling at once are simply
// easier-to-predict market regimes for everyone (e.g. calm/orderly trending
// stretches), which would make "breadth" a proxy for regime, not genuine
// cross-market confirmation.
//
// METHOD: for each trial, every symbol's own signal timestamps are rotated
// by a random offset, circularly, within that symbol's own time range. This
// keeps each symbol's signal COUNT, direction mix, and internal clustering
// completely intact — only the ALIGNMENT between symbols is destroyed.
// "Fake breadth" is then computed the same way as real breadth, but against
// these shifted times.
//
// If fake breadth ALSO shows a win-rate ramp similar to real breadth, the
// effect isn't genuine confluence — distrust the breadth-based Kelly sizing
// already live in production. If fake breadth stays flat near the baseline
// STRONG win rate, real breadth is validated.
//
// Requires the cache/*_stage1.json files from the 39-symbol fetch.
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const BREAKEVEN = (1 / (1 + PAYOUT_RATE)) * 100;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const SHUFFLE_TRIALS = 8;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; adx: number; }

// ---------------------------------------------------------------------------
// EXACT proven logic — unchanged
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
  if (!existsSync(path)) return null;
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

function breadthOf(sym: string, sigTime: number, dir: Direction, symbols: string[], data: Map<string, { signals: Signal[] }>): number {
  let breadth = 0;
  for (const other of symbols) {
    if (other === sym) continue;
    const otherEntry = data.get(other);
    if (!otherEntry) continue;
    const match = otherEntry.signals.some(s => s.dir === dir && Math.abs(s.time - sigTime) <= BREADTH_WINDOW_MIN * 60);
    if (match) breadth++;
  }
  return breadth;
}

// Circularly shift a symbol's own signal times within its own candle time range.
function shiftSignals(signals: Signal[], minTime: number, range: number, offsetSeconds: number): Signal[] {
  if (range <= 0) return signals;
  return signals.map(s => ({
    ...s,
    time: minTime + (((s.time - minTime + offsetSeconds) % range) + range) % range,
  }));
}

function main() {
  console.log(`Breakeven: ${BREAKEVEN.toFixed(2)}%. Running ${SHUFFLE_TRIALS} shuffle trials per group.\n`);

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;

    const data = new Map<string, { candles: Candle[]; signals: Signal[]; minTime: number; range: number }>();
    for (const sym of symbols) {
      const candles = loadCandles(sym);
      if (!candles || candles.length < 100) continue;
      const signals = computeSignals(candles);
      const minTime = candles[0].time, maxTime = candles[candles.length - 1].time;
      data.set(sym, { candles, signals, minTime, range: maxTime - minTime });
    }
    if (data.size < 2) { console.log(`Skipping ${groupName} — not enough cached symbols.\n`); continue; }

    // --- REAL breadth win-rate by bucket (STRONG tier only) ---
    const realBuckets = new Map<number, { correct: number; total: number }>();
    for (const [sym, entry] of data) {
      const simpleData = new Map([...data].map(([k, v]) => [k, { signals: v.signals }]));
      for (const sig of entry.signals) {
        if (sig.adx < ADX_THRESHOLD) continue;
        const actual = outcomeOf(sig, entry.candles);
        if (actual === 'NONE') continue;
        const breadth = Math.min(breadthOf(sym, sig.time, sig.dir, symbols, simpleData), 4);
        if (!realBuckets.has(breadth)) realBuckets.set(breadth, { correct: 0, total: 0 });
        const b = realBuckets.get(breadth)!;
        b.total++;
        if (actual === sig.dir) b.correct++;
      }
    }

    // --- FAKE (shuffled) breadth win-rate by bucket, averaged over trials ---
    const fakeBucketTrials = new Map<number, number[]>();
    for (let trial = 0; trial < SHUFFLE_TRIALS; trial++) {
      const shiftedData = new Map<string, { signals: Signal[] }>();
      for (const [sym, entry] of data) {
        const offset = Math.floor(Math.random() * Math.max(entry.range, 1));
        shiftedData.set(sym, { signals: shiftSignals(entry.signals, entry.minTime, entry.range, offset) });
      }

      const trialBuckets = new Map<number, { correct: number; total: number }>();
      for (const [sym, entry] of data) {
        for (const sig of entry.signals) {
          if (sig.adx < ADX_THRESHOLD) continue;
          const actual = outcomeOf(sig, entry.candles);
          if (actual === 'NONE') continue;
          const fakeBreadth = Math.min(breadthOf(sym, sig.time, sig.dir, symbols, shiftedData), 4);
          if (!trialBuckets.has(fakeBreadth)) trialBuckets.set(fakeBreadth, { correct: 0, total: 0 });
          const b = trialBuckets.get(fakeBreadth)!;
          b.total++;
          if (actual === sig.dir) b.correct++;
        }
      }
      for (const [breadth, b] of trialBuckets) {
        if (b.total < 10) continue;
        const wr = (b.correct / b.total) * 100;
        if (!fakeBucketTrials.has(breadth)) fakeBucketTrials.set(breadth, []);
        fakeBucketTrials.get(breadth)!.push(wr);
      }
    }

    console.log(`=== BREADTH CONTROL TEST — ${groupName} (STRONG, ADX>=25 only) ===`);
    console.log('Breadth | REAL WinRate (n)      | FAKE WinRate avg±std (shuffled)');
    const allBreadths = new Set([...realBuckets.keys(), ...fakeBucketTrials.keys()]);
    for (const breadth of [...allBreadths].sort((a, b) => a - b)) {
      const real = realBuckets.get(breadth);
      const realStr = real && real.total >= 10 ? `${(real.correct / real.total * 100).toFixed(1)}% (n=${real.total})` : '(n<10)';
      const fakeRates = fakeBucketTrials.get(breadth) || [];
      let fakeStr = '(n<10)';
      if (fakeRates.length > 0) {
        const mean = fakeRates.reduce((a, b) => a + b, 0) / fakeRates.length;
        const variance = fakeRates.reduce((a, b) => a + (b - mean) ** 2, 0) / fakeRates.length;
        fakeStr = `${mean.toFixed(1)}%±${Math.sqrt(variance).toFixed(1)}`;
      }
      const label = breadth === 4 ? '4+' : String(breadth);
      console.log(`${label.padEnd(7)} | ${realStr.padEnd(22)} | ${fakeStr}`);
    }

    const realBreadth0 = realBuckets.get(0);
    const realBreadthTop = [...realBuckets.entries()].filter(([, b]) => b.total >= 10).sort((a, b) => b[0] - a[0])[0];
    const fakeBreadth0 = fakeBucketTrials.get(0);
    const fakeBreadthTop = [...fakeBucketTrials.entries()].sort((a, b) => b[0] - a[0])[0];

    if (realBreadth0 && realBreadthTop && fakeBreadth0 && fakeBreadthTop) {
      const realRamp = (realBreadthTop[1].correct / realBreadthTop[1].total * 100) - (realBreadth0.correct / realBreadth0.total * 100);
      const fakeMean0 = fakeBreadth0.reduce((a, b) => a + b, 0) / fakeBreadth0.length;
      const fakeMeanTop = fakeBreadthTop[1].reduce((a, b) => a + b, 0) / fakeBreadthTop[1].length;
      const fakeRamp = fakeMeanTop - fakeMean0;
      console.log(`\nReal ramp (breadth 0 -> top): +${realRamp.toFixed(1)} points. Fake/shuffled ramp: ${fakeRamp >= 0 ? '+' : ''}${fakeRamp.toFixed(1)} points.`);
      if (Math.abs(fakeRamp) > realRamp * 0.4) {
        console.log('>>> Fake breadth shows a meaningful ramp too — breadth may be partly a regime proxy, not pure cross-market confluence. Treat live breadth-based sizing with caution.');
      } else {
        console.log('>>> Fake breadth\'s ramp is small relative to the real one — real breadth looks like genuine independent information.');
      }
    }
    console.log('');
  }
}

main();
