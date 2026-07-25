// ============================================================================
// TELEGRAM NOTIFIER — pure observer, zero interaction with the trading logic
//
// Reads run_output.log (the captured stdout of liveRun.ts from this same
// workflow run) and sends a Telegram message ONLY for things worth knowing
// about immediately:
//   - A signal fired
//   - An order was placed or failed
//   - A trade settled (win/loss)
//   - The run errored/crashed
//   - The bot is paused or blocked from trading
//
// On a quiet run (nothing above happened), it sends nothing — EXCEPT once
// per hour it sends a short heartbeat so silence never means "is this
// still running?" It means "nothing happened, as expected."
//
// This script never reads or modifies trade logic, strategy parameters, or
// the Worker's state beyond what liveRun.ts already printed. If this script
// fails entirely, trading is unaffected — it only observes.
// ============================================================================

import * as fs from 'fs';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOG_FILE = 'run_output.log';

async function sendTelegram(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    console.error('Telegram send failed:', res.status, await res.text());
  } else {
    console.log('Telegram message sent.');
  }
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping notification (not a failure).');
    return;
  }

  if (!fs.existsSync(LOG_FILE)) {
    console.log(`No ${LOG_FILE} found — nothing to notify from this run.`);
    return;
  }

  const log = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = log.split('\n');

  const messages: string[] = [];

  // --- Fatal error / crash ---
  const fatalLine = lines.find(l => /Fatal error|^Error:|##\[error\]/.test(l));
  if (fatalLine) {
    messages.push(`🚨 <b>Run failed:</b>\n<code>${escapeHtml(fatalLine.trim().slice(0, 300))}</code>`);
  }

  // --- Paused / blocked state ---
  const workerStateLine = lines.find(l => /Worker state:/.test(l));
  if (workerStateLine && (/paused=true/.test(workerStateLine) || /canTrade=false/.test(workerStateLine))) {
    messages.push(`🚨 <b>Trading is currently paused or blocked.</b>\n<code>${escapeHtml(workerStateLine.trim())}</code>`);
  }

  // --- Order failures ---
  for (const l of lines.filter(l => /order failed/i.test(l))) {
    messages.push(`🔴 <b>Order failed:</b>\n<code>${escapeHtml(l.trim())}</code>`);
  }

  // --- Order placed (not yet settled) ---
  for (const l of lines.filter(l => /order placed/i.test(l))) {
    messages.push(`🟡 <b>Order placed:</b>\n<code>${escapeHtml(l.trim())}</code>`);
  }

  // --- Settled trades ---
  for (const l of lines.filter(l => /SETTLED/i.test(l) || /-> (WIN|LOSS)/.test(l))) {
    const emoji = /WIN/.test(l) ? '🟢' : /LOSS/.test(l) ? '🔴' : '⚪';
    messages.push(`${emoji} <b>Trade settled:</b>\n<code>${escapeHtml(l.trim())}</code>`);
  }

  // --- Balance, for context on any of the above ---
  const balanceLine = [...lines].reverse().find(l => /Balance:/i.test(l));

  // --- Stateless hourly heartbeat: only fires if nothing else did, and only
  //     near the top of the hour (this runner has no persistent storage
  //     between runs, so wall-clock is the simplest reliable "once an hour"
  //     signal without needing a database). ---
  const now = new Date();
  const isHeartbeatWindow = now.getUTCMinutes() < 10;
  if (messages.length === 0 && isHeartbeatWindow) {
    messages.push(`💓 Bot alive, no signal this cycle.${balanceLine ? '\n' + escapeHtml(balanceLine.trim()) : ''}`);
  } else if (messages.length > 0 && balanceLine) {
    messages.push(escapeHtml(balanceLine.trim()));
  }

  if (messages.length === 0) {
    console.log('Quiet run, outside heartbeat window — no Telegram message sent.');
    return;
  }

  await sendTelegram(messages.join('\n\n'));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch(err => {
  // Never let a notifier bug fail the workflow or look like a trading failure.
  console.error('Notifier error (non-fatal, trading unaffected):', err);
});
