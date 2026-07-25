// ============================================================================
// WATCHDOG — self-healing check for the main trading-bot workflow
//
// Runs on its own, longer-interval schedule (GitHub honors longer intervals
// far more reliably than short ones). Checks how long it's been since
// trading-bot.yml last ran. If it's gone quiet beyond a generous threshold,
// this script re-triggers it directly via the GitHub API AND sends a
// Telegram alert. If everything's healthy, it stays completely silent —
// the main notifier already handles the "all good" heartbeat, so this
// only speaks up when something actually needed fixing.
//
// Uses the built-in GITHUB_TOKEN (no new secrets needed) — requires
// `permissions: actions: write` set on this workflow (see watchdog.yml).
// ============================================================================

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO; // e.g. "cadeyaa360-byte/deriv-bot-runner"
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_WORKFLOW = 'trading-bot.yml';
const STALE_THRESHOLD_MIN = 20; // generous buffer beyond the 10-min cron interval

if (!GITHUB_TOKEN || !REPO) {
  console.error('Missing GITHUB_TOKEN or REPO env var.');
  process.exit(1);
}

async function ghApi(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('No Telegram configured for watchdog alerts — logging only:', text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.error('Telegram send failed:', res.status, await res.text());
}

async function main() {
  const runsData: any = await ghApi(`/actions/workflows/${TARGET_WORKFLOW}/runs?per_page=1`);
  const latestRun = runsData.workflow_runs?.[0];

  if (!latestRun) {
    console.log('No runs found for the target workflow yet — nothing to check.');
    return;
  }

  const lastRunTime = new Date(latestRun.created_at).getTime();
  const minutesSince = (Date.now() - lastRunTime) / 60000;

  console.log(`Last ${TARGET_WORKFLOW} run: ${latestRun.created_at} (${minutesSince.toFixed(1)} min ago), conclusion=${latestRun.conclusion}`);

  if (minutesSince <= STALE_THRESHOLD_MIN) {
    console.log('Healthy — within threshold, no action needed.');
    return;
  }

  console.warn(`STALE: no run in ${minutesSince.toFixed(1)} minutes (threshold ${STALE_THRESHOLD_MIN}). Self-healing now.`);

  await ghApi(`/actions/workflows/${TARGET_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'master' }),
  });

  await sendTelegram(
    `⚠️ <b>Watchdog: trading bot had gone quiet.</b>\n` +
    `Last run was ${minutesSince.toFixed(0)} minutes ago (expected every ~10 min).\n` +
    `I've triggered a fresh run just now — no action needed from you, just an FYI.`
  );
}

main().catch(async (err) => {
  console.error('Watchdog error:', err);
  await sendTelegram(`🚨 <b>Watchdog itself hit an error:</b>\n<code>${String(err).slice(0, 300)}</code>`).catch(() => {});
});
