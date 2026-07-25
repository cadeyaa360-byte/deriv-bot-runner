// ============================================================================
// DERIV — OTP + LIVE WEBSOCKET (demo account)
// Uses the account_id confirmed from /accounts to request a short-lived OTP,
// then opens the WebSocket using the URL Deriv hands back with the OTP
// already embedded.
// ============================================================================

import WebSocket from 'ws';

const APP_ID = '33UTL66zPwWIqDVfECusS'; // cadesignalAI native app
const TOKEN = process.env.DERIV_TOKEN;
const BASE = 'https://api.derivws.com/trading/v1/options';
const DEMO_ACCOUNT_ID = 'DOT91769501';

if (!TOKEN) {
  console.error('No token found. Set it first:');
  console.error('  $env:DERIV_TOKEN = "pat_..."');
  process.exit(1);
}

async function main() {
  console.log(`[requesting] OTP for ${DEMO_ACCOUNT_ID} ...\n`);

  const res = await fetch(`${BASE}/accounts/${DEMO_ACCOUNT_ID}/otp`, {
    method: 'POST',
    headers: {
      'Deriv-App-ID': APP_ID,
      'Authorization': `Bearer ${TOKEN}`,
    },
  });

  console.log('HTTP status:', res.status);
  const body = await res.json();
  console.log('Response:', JSON.stringify(body, null, 2));

  const wsUrl = body?.data?.url;
  if (!wsUrl) {
    console.error('\nNo WebSocket URL in response — stopping here.');
    return;
  }

  console.log('\n[connecting] opening WebSocket with embedded OTP...');
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[connected] WebSocket is live. Requesting candle history for cryBTCUSD...');
    ws.send(JSON.stringify({
      ticks_history: 'cryBTCUSD',
      adjust_start_time: 1,
      count: 5000,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: 60,
    }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.msg_type === 'candles') {
      if (msg.error) {
        console.log('\n[error]', JSON.stringify(msg.error, null, 2));
        return;
      }
      const candles = msg.candles;
      const first = new Date(candles[0].epoch * 1000).toISOString();
      const last = new Date(candles[candles.length - 1].epoch * 1000).toISOString();
      console.log(`\n[got] ${candles.length} candles`);
      console.log(`  from ${first}`);
      console.log(`  to   ${last}`);
      console.log(`  sample:`, JSON.stringify(candles[0]));
      return;
    }
    if (msg.error) {
      console.log('\n[error response]\n', JSON.stringify(msg, null, 2));
      return;
    }
    console.log('\n[message]', raw.toString());
  });

  ws.on('error', (err) => console.error('WebSocket error:', err.message));
  ws.on('close', (code) => {
    console.log(`\n[closed] code ${code}`);
    process.exit(0);
  });

  // Keep it open for 10s to see any messages, then close cleanly.
  setTimeout(() => ws.close(), 10_000);
}

main().catch((err) => console.error('Request failed:', err.message));
