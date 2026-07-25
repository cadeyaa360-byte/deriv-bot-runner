// ============================================================================
// STAGE 4: BANKROLL EQUITY-CURVE SIMULATION
//
// Walks all STRONG (ADX>=25) signals across every group, in true chronological
// order, sizing each trade with the same Kelly-by-breadth table computed in
// Stage 3, and simulates bankroll growth/drawdown on a NORMALIZED starting
// balance of 1.0. From that curve we derive:
//   (a) the deposit needed so every Kelly bucket clears the broker minimum
//       stake, and
//   (b) the deposit needed so the worst historical drawdown in this window
//       never breaches a safety floor you set below.
//
// Concurrency: trades are 3-minute fixed expiry. If multiple signals fire
// close together, positions can overlap. We track total open exposure (sum
// of allocated fractions of bankroll-at-entry for still-open trades) and
// cap it — trades that would push total open exposure over MAX_CONCURRENT_
// EXPOSURE are SKIPPED (recorded as missed, not forced), same as a real
// broker/account would require if you don't have unlimited capital.
// ============================================================================

import { readFileSync, existsSync } from 'fs';

const EXPIRY_MIN = 3;
const AGREEMENT_WINDOW = 3;
const PAYOUT_RATE = 0.85;
const ADX_THRESHOLD = 25;
const BREADTH_WINDOW_MIN = 2;
const KELLY_FRACTION = 0.25;
const MAX_KELLY_CAP = 0.05;

const BROKER_MIN_STAKE = 1;        // $ — adjust if your broker's actual minimum differs
const MAX_CONCURRENT_EXPOSURE = 0.20; // never more than 20% of bankroll committed at once, across all open trades
const SAFETY_FLOOR = 0.50;         // "never let bankroll drop below 50% of starting deposit" — adjust to your risk tolerance

interface Candle { time: number; open: number; high: number; low: number; close: number; }
type Direction = 'BUY' | 'SELL';
interface Trigger { index: number; dir: Direction; }
interface Signal { index: number; dir: Direction; time: number; adx: number }
interface Trade { symbol: string; entryTime: number; exitTime: number; win: boolean; kellyFraction: number; }

// ---------------------------------------------------------------------------
// EXACT proven logic - copied unchanged.
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

// ---------------------------------------------------------------------------
// Build the full trade list (STRONG only) across every group, with Kelly
// fraction assigned per-trade from that GROUP's own breadth->winrate table
// (computed here fresh, same method as Stage 3, so it's self-contained).
// ---------------------------------------------------------------------------
function main() {
  const data = new Map<string, { candles: Candle[]; signals: Signal[] }>();
  const allSymbols = Object.values(GROUPS).flat();

  for (const sym of allSymbols) {
    const candles = loadCandles(sym);
    if (!candles || candles.length < 100) continue;
    const signals = computeSignals(candles);
    data.set(sym, { candles, signals });
  }

  const allTrades: Trade[] = [];

  for (const [groupName, symbols] of Object.entries(GROUPS)) {
    if (symbols.length < 2) continue;

    // First pass: compute breadth-bucket winrate table for this group (STRONG only)
    const buckets = new Map<number, { correct: number; total: number }>();
    const rawTrades: { symbol: string; entryTime: number; exitTime: number; win: boolean; breadth: number }[] = [];

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
        rawTrades.push({
          symbol: sym,
          entryTime: sig.time,
          exitTime: sig.time + EXPIRY_MIN * 60,
          win,
          breadth,
        });
      }
    }

    // Kelly fraction per breadth bucket for this group
    const kellyByBreadth = new Map<number, number>();
    for (const [k, b] of buckets) {
      if (b.total < 10) continue;
      const wr = (b.correct / b.total) * 100;
      kellyByBreadth.set(k, kelly(wr));
    }

    for (const t of rawTrades) {
      const kf = kellyByBreadth.get(t.breadth);
      if (kf === undefined || kf <= 0) continue; // no edge / insufficient sample -> don't trade
      allTrades.push({ symbol: t.symbol, entryTime: t.entryTime, exitTime: t.exitTime, win: t.win, kellyFraction: kf });
    }
  }

  allTrades.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`Total tradeable STRONG signals across all groups: ${allTrades.length}`);

  // -------------------------------------------------------------------------
  // Chronological equity simulation on normalized bankroll = 1.0
  // -------------------------------------------------------------------------
  let bankroll = 1.0;
  let peakBankroll = 1.0;
  let maxDrawdownPct = 0;
  let minBankroll = 1.0;
  let skippedForExposure = 0;
  let executed = 0;

  // open positions: { exitTime, stakeFractionAtEntry }
  const open: { exitTime: number; stakeFraction: number }[] = [];

  for (const trade of allTrades) {
    // release any positions that have expired by this trade's entry time
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitTime <= trade.entryTime) open.splice(i, 1);
    }

    const currentExposure = open.reduce((sum, o) => sum + o.stakeFraction, 0);
    if (currentExposure + trade.kellyFraction > MAX_CONCURRENT_EXPOSURE) {
      skippedForExposure++;
      continue; // not enough free exposure budget right now
    }

    const stake = bankroll * trade.kellyFraction;
    open.push({ exitTime: trade.exitTime, stakeFraction: trade.kellyFraction });

    bankroll += trade.win ? stake * PAYOUT_RATE : -stake;
    executed++;

    peakBankroll = Math.max(peakBankroll, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    const dd = (peakBankroll - bankroll) / peakBankroll;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);

    if (bankroll <= 0) {
      console.log(`BUSTED at trade ${executed} (${new Date(trade.entryTime * 1000).toISOString()})`);
      break;
    }
  }

  console.log(`\nTrades executed: ${executed}`);
  console.log(`Trades skipped (exposure cap): ${skippedForExposure}`);
  console.log(`Final bankroll (normalized, start=1.0): ${bankroll.toFixed(4)}`);
  console.log(`Peak bankroll: ${peakBankroll.toFixed(4)}`);
  console.log(`Lowest bankroll point: ${minBankroll.toFixed(4)}`);
  console.log(`Max drawdown from peak: ${(maxDrawdownPct * 100).toFixed(2)}%`);

  // -------------------------------------------------------------------------
  // Deposit floor A: smallest Kelly fraction actually used must clear min stake
  // -------------------------------------------------------------------------
  const usedFractions = allTrades.map(t => t.kellyFraction);
  const smallestFraction = Math.min(...usedFractions);
  const depositForMinStake = BROKER_MIN_STAKE / smallestFraction;

  // -------------------------------------------------------------------------
  // Deposit floor B: worst historical drawdown must not breach SAFETY_FLOOR
  // if bankroll can dip to minBankroll (as a fraction of start), the deposit
  // needed so that dip still leaves you above SAFETY_FLOOR * deposit is just
  // deposit itself (since it's all relative) -- what actually matters is
  // whether minBankroll (relative) already breaches SAFETY_FLOOR. If it does,
  // no deposit size fixes that on its own; it means the sizing itself is too
  // aggressive for this drawdown, and MAX_KELLY_CAP / KELLY_FRACTION need to
  // shrink, not the deposit grow.
  // -------------------------------------------------------------------------
  console.log(`\n--- Deposit analysis ---`);
  console.log(`Deposit needed so every used Kelly bucket clears the $${BROKER_MIN_STAKE} broker minimum stake: $${depositForMinStake.toFixed(2)}`);
  if (minBankroll < SAFETY_FLOOR) {
    console.log(`WARNING: even at any deposit size, this window's worst drawdown took bankroll down to ${(minBankroll * 100).toFixed(1)}% of starting balance -- below your ${(SAFETY_FLOOR * 100).toFixed(0)}% safety floor.`);
    console.log(`This means the sizing (Kelly fraction / cap) is too aggressive for this floor, not that a bigger deposit fixes it. Consider lowering KELLY_FRACTION or MAX_KELLY_CAP and re-running.`);
  } else {
    console.log(`This window's worst drawdown (${(minBankroll * 100).toFixed(1)}% of start) stayed above your ${(SAFETY_FLOOR * 100).toFixed(0)}% safety floor at any deposit size.`);
  }
  console.log(`\nRecommended minimum deposit for this sizing scheme: $${Math.ceil(depositForMinStake)}`);
  console.log(`\nReminder: this is one historical 90-day window with no breadth-independence control test yet. Treat this as a starting point for forward/paper testing, not a live number.`);
}

main();
