// ============================================================================
// DERIV — REST API (PAT) FIRST CONTACT
// This newer REST layer (api.derivws.com/trading/v1/options) is what your
// "pat_..." token actually belongs to — different from the legacy WebSocket
// auth flow I used before. Rather than guess the full schema, this hits the
// accounts endpoint and prints the raw response so we build the next step
// off real data instead of assumptions.
// ============================================================================

const APP_ID = '33UTL66zPwWIqDVfECusS'; // cadesignalAI native app
const TOKEN = process.env.DERIV_TOKEN;
const BASE = 'https://api.derivws.com/trading/v1/options';

if (!TOKEN) {
  console.error('No token found. Set it first:');
  console.error('  $env:DERIV_TOKEN = "pat_..."');
  process.exit(1);
}

async function main() {
  console.log('[requesting] GET /accounts ...\n');

  const res = await fetch(`${BASE}/accounts`, {
    method: 'GET',
    headers: {
      'Deriv-App-ID': APP_ID,
      'Authorization': `Bearer ${TOKEN}`,
    },
  });

  console.log('HTTP status:', res.status);
  const text = await res.text();

  try {
    const json = JSON.parse(text);
    console.log('\nRaw response:\n', JSON.stringify(json, null, 2));
  } catch {
    console.log('\nRaw response (non-JSON):\n', text);
  }
}

main().catch((err) => console.error('Request failed:', err.message));
