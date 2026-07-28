// ============================================================================
// DIGIT ANALYSIS v2 — multi-batch, multi-symbol. Pure read-only statistical
// check, no trading logic.
// ============================================================================

import WebSocket from 'ws';

const SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
const BATCHES_PER_SYMBOL = 10; // 10 x ~1000 = ~10,000 ticks per symbol
const TICKS_PER_BATCH = 1000; // observed real cap from Deriv, regardless of requested count

const APP_ID = '33UTL66zPwWIqDVfECusS';
const DERIV_TOKEN = process.env.DERIV_TOKEN;

if (!DERIV_TOKEN) {
  console.error('Set DERIV_TOKEN as an environment variable before running.');
  process.exit(1);
}

const REST_BASE = 'https://api.derivws.com/trading/v1/options';

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

function lastDigitOf(price: number, pipSize: number): number {
  const str = price.toFixed(pipSize);
  return parseInt(str[str.length - 1], 10);
}

class DerivSocket {
  private ws: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
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
        const { resolve, reject, timer } = this.pending.get(reqId)!;
        clearTimeout(timer);
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
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`Request timed out (req_id ${reqId})`)); }, 20000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  close() { this.ws.close(); }
}

async function fetchAllTicksForSymbol(sock: DerivSocket, symbol: string): Promise<number[]> {
  const allPrices: number[] = [];
  let endPoint: string | number = 'latest';

  for (let batch = 0; batch < BATCHES_PER_SYMBOL; batch++) {
    const res = await sock.send({ ticks_history: symbol, style: 'ticks', count: TICKS_PER_BATCH, end: endPoint });
    const prices: number[] = res.history?.prices ?? [];
    const times: number[] = res.history?.times ?? [];
    if (prices.length === 0) break;

    allPrices.push(...prices);

    // Next batch: go further back in time than the oldest tick we just got.
    const oldestTime = times[0];
    endPoint = oldestTime - 1;

    process.stdout.write(`  [${symbol}] batch ${batch + 1}/${BATCHES_PER_SYMBOL}: ${prices.length} ticks (total so far: ${allPrices.length})\r\n`);

    // Be polite to the API between batches.
    await new Promise(r => setTimeout(r, 300));
  }

  return allPrices;
}

interface SymbolResult {
  symbol: string;
  total: number;
  digitCounts: number[];
  chiSquare: number;
  significant05: boolean;
  significant01: boolean;
}

async function main() {
  const accounts = await getAccounts(DERIV_TOKEN!);
  const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
  const wsUrl = await getOtpWsUrl(account.account_id, DERIV_TOKEN!);
  const sock = new DerivSocket(wsUrl);
  await sock.waitReady();

  const results: SymbolResult[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\nFetching ticks for ${symbol}...`);
    const prices = await fetchAllTicksForSymbol(sock, symbol);

    if (prices.length === 0) {
      console.log(`  No data returned for ${symbol}, skipping.`);
      continue;
    }

    const sample = prices[0].toString();
    const decimalPart = sample.includes('.') ? sample.split('.')[1] : '';
    const pipSize = decimalPart.length || 2;

    const digitCounts = new Array(10).fill(0);
    for (const price of prices) {
      digitCounts[lastDigitOf(price, pipSize)]++;
    }

    const total = prices.length;
    const expected = total / 10;
    let chiSquare = 0;
    for (let d = 0; d <= 9; d++) {
      chiSquare += Math.pow(digitCounts[d] - expected, 2) / expected;
    }

    results.push({
      symbol, total, digitCounts, chiSquare,
      significant05: chiSquare > 16.919,
      significant01: chiSquare > 21.666,
    });

    console.log(`  Total ticks collected: ${total}, chi-square: ${chiSquare.toFixed(3)}`);
  }

  sock.close();

  console.log('\n\n=== COMBINED RESULTS ===\n');
  console.log('Symbol  | Ticks  | Chi-Square | Significant (p<0.05) | Significant (p<0.01)');
  for (const r of results) {
    console.log(`${r.symbol.padEnd(7)} | ${String(r.total).padStart(6)} | ${r.chiSquare.toFixed(3).padStart(10)} | ${(r.significant05 ? 'YES' : 'no').padStart(21)} | ${(r.significant01 ? 'YES' : 'no').padStart(21)}`);
  }

  console.log('\nPer-digit breakdown:\n');
  for (const r of results) {
    console.log(`--- ${r.symbol} (${r.total} ticks) ---`);
    console.log('Digit | Count | Actual % | Deviation');
    for (let d = 0; d <= 9; d++) {
      const actualPct = (r.digitCounts[d] / r.total) * 100;
      const deviation = actualPct - 10;
      console.log(`${d}     | ${String(r.digitCounts[d]).padStart(5)} | ${actualPct.toFixed(2).padStart(7)}% | ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)}%`);
    }
    console.log('');
  }

  console.log('Critical value at p=0.05: 16.919');
  console.log('Critical value at p=0.01: 21.666');
  console.log('\nReminder: even a statistically significant deviation must be large enough to overcome Deriv\'s built-in payout skew on Under/Over contracts to represent a real tradeable edge -- statistical significance alone is not the same as profitability.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});