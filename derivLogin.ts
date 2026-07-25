// ============================================================================
// DERIV DEMO ACCOUNT — TERMINAL ONLY
// Uses Deriv's official API (verify_email -> new_account_virtual) to spin up
// a $10,000 demo account without touching a browser. Confirmed against
// Deriv's own docs: legacy-docs.deriv.com/docs/create-account-using-api
// ============================================================================

import WebSocket from 'ws';
import readline from 'readline';

// Deriv's shared demo app_id for exploration/testing. Swap for your own
// app_id later (register one free at api.deriv.com/dashboard) once you're
// past testing — shared IDs get rate-limited fastest.
const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(res => rl.question(q, res));

function send(ws: WebSocket, payload: object) {
  ws.send(JSON.stringify(payload));
}

async function main() {
  const email = await ask('Email to use for the demo account: ');
  const residence = (await ask('2-letter residence code (Kenya = ke): ')).toLowerCase().trim();
  const password = await ask('Pick a password for this Deriv account: ');

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('\n[connected] requesting email verification code...');
    send(ws, {
      verify_email: email,
      type: 'account_opening',
    });
  });

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.msg_type === 'verify_email') {
      if (msg.error) {
        console.error('verify_email failed:', msg.error.message);
        ws.close();
        return;
      }
      console.log('[sent] check your inbox for the 6-8 char code from Deriv.');
      const code = await ask('Paste the verification code here: ');

      send(ws, {
        new_account_virtual: 1,
        client_password: password,
        verification_code: code,
        residence,
        req_id: 2,
      });
    }

    if (msg.msg_type === 'new_account_virtual') {
      if (msg.error) {
        console.error('\naccount creation failed:', msg.error.message);
        ws.close();
        rl.close();
        return;
      }
      const { client_id, oauth_token } = msg.new_account_virtual;
      console.log('\n########## DEMO ACCOUNT CREATED ##########');
      console.log('Login ID :', client_id);
      console.log('Token    :', oauth_token);
      console.log('Balance  : $10,000 virtual');
      console.log('###########################################');
      console.log('\nSave that token somewhere safe (not committed to git) —');
      console.log('it authorizes every future API call against this account.');

      // Immediately confirm the token actually works
      send(ws, { authorize: oauth_token, req_id: 3 });
    }

    if (msg.msg_type === 'authorize') {
      if (msg.error) {
        console.error('authorize check failed:', msg.error.message);
      } else {
        console.log(`\n[verified] logged in as ${msg.authorize.loginid}, balance $${msg.authorize.balance}`);
      }
      ws.close();
      rl.close();
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err.message));
  ws.on('close', () => process.exit(0));
}

main();
