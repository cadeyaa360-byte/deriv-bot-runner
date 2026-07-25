// ============================================================================
// DERIV — AUTHORIZE WITH EXISTING TOKEN
// Reads the token from $env:DERIV_TOKEN so it never has to be pasted
// anywhere, including here. Confirms the connection and prints live balance.
// ============================================================================

import WebSocket from 'ws';

const APP_ID = 1089; // fine for read/trade calls once you're already authorized
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const token = process.env.DERIV_TOKEN;

if (!token) {
  console.error('No token found. Set it first:');
  console.error('  $env:DERIV_TOKEN = "your-token-here"');
  process.exit(1);
}

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('[connected] authorizing...');
  ws.send(JSON.stringify({ authorize: token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.msg_type === 'authorize') {
    if (msg.error) {
      console.error('\nauthorize failed:', msg.error.message);
      ws.close();
      return;
    }
    const a = msg.authorize;
    console.log('\n########## AUTHORIZED ##########');
    console.log('Login ID :', a.loginid);
    console.log('Name     :', a.fullname);
    console.log('Currency :', a.currency);
    console.log('Balance  :', a.balance);
    console.log('Virtual  :', a.is_virtual ? 'yes (demo)' : 'no (REAL MONEY)');
    console.log('Scopes   :', a.scopes.join(', '));
    console.log('#################################');
    ws.close();
  }
});

ws.on('error', (err) => console.error('WebSocket error:', err.message));
ws.on('close', () => process.exit(0));
