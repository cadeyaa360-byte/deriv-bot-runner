// ============================================================================
// STAGE 4b: BANKROLL SURVIVAL SIMULATION (corrected)
//
// Fixes vs Stage 4:
//  1. Stake is a fraction of the ORIGINAL deposit each time, not current
//     bankroll -- answers "does a fixed starting deposit survive this
//     window", not "how large would compounding make it" (a different,
//     much less trustworthy question given correlated signals).
//  2. Signals that fire within the same BREADTH_WINDOW_MIN across symbols
//     in a group are correlated, not independent bets. Before sizing, we
//     cluster same-direction signals that overlap in time into a single
//     combined trade, sized once, won/lost together based on majority
//     outcome in that cluster. This stops the sim from quietly stacking
//     several correlated bets as if they were independent.
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const KELLY_FRACTION = 0.25;
const MAX_KELLY_CAP = 0.05;
const BROKER_MIN_STAKE = 1;
const MAX_CONCURRENT_EXPOSURE = 0.20;
const SAFETY_FLOOR = 0.50; // never let bankroll drop below 50% of starting deposit

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; adx: number }

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

function kelly(winRate: number): number {
  const p = winRate / 100;
  const q = 1 - p;
  const raw = p - q / PAYOUT_RATE;
  const fractional = Math.max(0, raw) * KELLY_FRACTION;
  return Math.min(fractional, MAX_KELLY_CAP);
}

interface RawTrade { symbol: string; entryTime: number; exitTime: number; win: boolean; breadth: number; dir: Direction; group: string; }
interface ClusteredTrade { entryTime: number; exitTime: number; win: boolean; kellyFraction: number; memberCount: number; symbols: string[]; }

function main() {
  const data = new Map<string, { candles: Candle[]; signals: Signal[] }>();
  const allSymbols = Object.values(GROUPS).flat();

  for (const sym of allSymbols) {
    const candles = loadCandles(sym);
    if (!candles || candles.length < 100) continue;
    const signals = computeSignals(candles);
    data.set(sym, { candles, signals });
  }

  const rawTrades: RawTrade[] = [];

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    const buckets = new Map<number, { correct: number; total: number }>();
    const groupRaw: RawTrade[] = [];

    for (const sym of symbols) {
      const entry = data.get(sym);
      if (!entry) continue;
      const { candles, signals } = entry;
      for (const sig of signals) {
        if (sig.adx < ADX_THRESHOLD) continue;
        const actual = outcomeOf(sig, candles);
        if (actual === 'NONE') continue;
        const breadth = Math.min(breadthOf(sym, sig, symbols, data), 4);
        const win = actual === sig.dir;
        if (!buckets.has(breadth)) buckets.set(breadth, { correct: 0, total: 0 });
        const b = buckets.get(breadth)!;
        b.total++;
        if (win) b.correct++;
        groupRaw.push({ symbol: sym, entryTime: sig.time, exitTime: sig.time + EXPIRY_MIN * 60, win, breadth, dir: sig.dir, group: groupName });
      }
    }

    const kellyByBreadth = new Map<number, number>();
    for (const [k, b] of buckets) {
      if (b.total < 10) continue;
      const wr = (b.correct / b.total) * 100;
      kellyByBreadth.set(k, kelly(wr));
    }

    for (const t of groupRaw) {
      if ((kellyByBreadth.get(t.breadth) ?? 0) > 0) rawTrades.push(t);
    }
  }

  rawTrades.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`Raw tradeable STRONG signals (pre-clustering): ${rawTrades.length}`);

  // ---------------------------------------------------------------------
  // Cluster: within a group, same direction, entries within BREADTH_WINDOW_MIN
  // of each other -> ONE combined trade (majority-outcome wins/loses together,
  // sized once using the breadth-derived Kelly fraction of the trade that
  // started the cluster).
  // ---------------------------------------------------------------------
  const used = new Array(rawTrades.length).fill(false);
  const clustered: ClusteredTrade[] = [];
  const kellyCache = new Map<string, number>(); // recompute per-trade breadth->kelly on the fly isn't stored above, so approximate via win-rate proxy below

  // Rebuild breadth->kelly per group again for lookup during clustering
  const groupKelly = new Map<string, Map<number, number>>();
  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;
    const buckets = new Map<number, { correct: number; total: number }>();
    for (const t of rawTrades) {
      if (t.group !== groupName) continue;
      if (!buckets.has(t.breadth)) buckets.set(t.breadth, { correct: 0, total: 0 });
      const b = buckets.get(t.breadth)!;
      b.total++;
      if (t.win) b.correct++;
    }
    const kb = new Map<number, number>();
    for (const [k, b] of buckets) {
      if (b.total < 10) continue;
      kb.set(k, kelly((b.correct / b.total) * 100));
    }
    groupKelly.set(groupName, kb);
  }

  for (let i = 0; i < rawTrades.length; i++) {
    if (used[i]) continue;
    const seed = rawTrades[i];
    const cluster = [seed];
    used[i] = true;
    for (let j = i + 1; j < rawTrades.length; j++) {
      if (used[j]) continue;
      const cand = rawTrades[j];
      if (cand.group !== seed.group || cand.dir !== seed.dir) continue;
      if (cand.entryTime - seed.entryTime > BREADTH_WINDOW_MIN * 60) break; // sorted by time, safe to stop
      cluster.push(cand);
      used[j] = true;
    }
    const wins = cluster.filter(c => c.win).length;
    const win = wins >= cluster.length / 2; // majority outcome
    const kf = groupKelly.get(seed.group)?.get(seed.breadth) ?? 0;
    if (kf <= 0) continue;
    clustered.push({
      entryTime: seed.entryTime,
      exitTime: Math.max(...cluster.map(c => c.exitTime)),
      win,
      kellyFraction: kf,
      memberCount: cluster.length,
      symbols: cluster.map(c => c.symbol),
    });
  }

  clustered.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`Combined (correlation-adjusted) trades: ${clustered.length}`);
  const avgClusterSize = clustered.reduce((s, c) => s + c.memberCount, 0) / clustered.length;
  console.log(`Average signals folded into each combined trade: ${avgClusterSize.toFixed(2)}`);

  // ---------------------------------------------------------------------
  // Simulate: stake = ORIGINAL deposit * kellyFraction each time (flat,
  // not compounded), bankroll tracked as running total starting at 1.0.
  // ---------------------------------------------------------------------
  const startingBankroll = 1.0;
  let bankroll = startingBankroll;
  let peakBankroll = startingBankroll;
  let minBankroll = startingBankroll;
  let maxDrawdownPct = 0;
  let skippedForExposure = 0;
  let executed = 0;

  const open: { exitTime: number; stakeFraction: number }[] = [];

  for (const trade of clustered) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitTime <= trade.entryTime) open.splice(i, 1);
    }
    const currentExposure = open.reduce((sum, o) => sum + o.stakeFraction, 0);
    if (currentExposure + trade.kellyFraction > MAX_CONCURRENT_EXPOSURE) {
      skippedForExposure++;
      continue;
    }

    const stake = startingBankroll * trade.kellyFraction; // FLAT sizing off original deposit
    open.push({ exitTime: trade.exitTime, stakeFraction: trade.kellyFraction });

    bankroll += trade.win ? stake * PAYOUT_RATE : -stake;
    executed++;

    peakBankroll = Math.max(peakBankroll, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakBankroll - bankroll) / peakBankroll);

    if (bankroll <= 0) {
      console.log(`BUSTED at combined trade ${executed} (${new Date(trade.entryTime * 1000).toISOString()})`);
      break;
    }
  }

  console.log(`\nCombined trades executed: ${executed}`);
  console.log(`Combined trades skipped (exposure cap): ${skippedForExposure}`);
  console.log(`Final bankroll (normalized, start=1.0): ${bankroll.toFixed(4)}`);
  console.log(`Peak bankroll: ${peakBankroll.toFixed(4)}`);
  console.log(`Lowest bankroll point: ${minBankroll.toFixed(4)} (${(minBankroll * 100).toFixed(1)}% of starting deposit)`);
  console.log(`Max drawdown from peak: ${(maxDrawdownPct * 100).toFixed(2)}%`);

  const usedFractions = clustered.map(t => t.kellyFraction);
  const smallestFraction = Math.min(...usedFractions);
  const depositForMinStake = BROKER_MIN_STAKE / smallestFraction;

  console.log(`\n--- Deposit analysis ---`);
  console.log(`Deposit needed so every used Kelly bucket clears the $${BROKER_MIN_STAKE} broker minimum stake: $${depositForMinStake.toFixed(2)}`);
  if (minBankroll < SAFETY_FLOOR) {
    console.log(`WARNING: this window's worst drawdown took bankroll down to ${(minBankroll * 100).toFixed(1)}% of starting deposit -- below your ${(SAFETY_FLOOR * 100).toFixed(0)}% safety floor.`);
    console.log(`A bigger deposit doesn't fix this on its own (it's a percentage-of-start result) -- it means KELLY_FRACTION or MAX_KELLY_CAP need to shrink.`);
  } else {
    console.log(`This window's worst drawdown (${(minBankroll * 100).toFixed(1)}% of start, i.e. ${((1 - minBankroll) * 100).toFixed(1)}% max loss) stayed above your ${(SAFETY_FLOOR * 100).toFixed(0)}% safety floor.`);
  }
  console.log(`\nRecommended minimum deposit: max($${Math.ceil(depositForMinStake)}, enough that a ${(maxDrawdownPct * 100).toFixed(0)}% relative drawdown is an amount you can actually absorb).`);
  console.log(`\nReminder: correlation-adjusted, flat-sizing, single 90-day window. Still no breadth-independence control test. Not a live number.`);
}

main();
