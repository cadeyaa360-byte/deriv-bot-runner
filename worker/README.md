# Deriv Bot — Control Layer Setup

This is the Cloudflare Worker that gives you Telegram control over the trading
bot: pause/resume, demo/real switch, daily loss limit, trade history, and a
watchdog that alerts you if GitHub Actions stops running silently.

Run all of this in PowerShell, in this `worker` folder.

## 1. Install dependencies

```powershell
npm install
```

## 2. Log in to Cloudflare (free account, no card needed)

```powershell
npx wrangler login
```

This opens a browser window — log in or sign up, then come back to the terminal.

## 3. Create the KV namespace (live state storage)

```powershell
npx wrangler kv:namespace create STATE_KV
```

This prints something like:
```
{ binding = "STATE_KV", id = "abcd1234..." }
```
Copy that `id` value into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

## 4. Create the D1 database (trade history)

```powershell
npx wrangler d1 create deriv-bot-db
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`.

Then apply the schema:

```powershell
npx wrangler d1 execute deriv-bot-db --file=./schema.sql --remote
```

## 5. Create your Telegram bot

1. Open Telegram, message **@BotFather**
2. Send `/newbot`, follow the prompts (name + username)
3. BotFather gives you a token like `123456789:AAH...` — save it, you'll need it below

## 6. Get your Telegram chat ID

1. Message your new bot anything (e.g. "hi") — it won't reply yet, that's fine
2. In a browser, visit:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find `"chat":{"id": ...}` in the response — that number is your chat ID.
   This locks the bot so only you can control it.

## 7. Set secrets

Each command will prompt you to paste a value:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put CONFIRM_PHRASE
npx wrangler secret put API_SHARED_SECRET
```

- `CONFIRM_PHRASE` — a phrase only you know, typed back to confirm switching to
  real-money trading (e.g. `yes-go-live-2026`). Pick your own.
- `API_SHARED_SECRET` — a random string GitHub Actions will use to authenticate
  to this Worker. Generate one with:
  ```powershell
  -join ((48..57)+(97..122)|Get-Random -Count 32|%{[char]$_})
  ```
  Save this value — you'll add it as a GitHub Actions secret next.

## 8. Deploy

```powershell
npm run deploy
```

This prints your Worker's URL, something like:
`https://deriv-bot-control.<your-subdomain>.workers.dev`

## 9. Point Telegram at your deployed Worker

```powershell
$WORKER_URL = "https://deriv-bot-control.<your-subdomain>.workers.dev"
$BOT_TOKEN = "<your bot token>"
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=$WORKER_URL/telegram-webhook"
```

## 10. Test it

Message your bot `/start` in Telegram. You should get the command list back.
Try `/status` — should show demo mode, running, no loss limit.

---

Once this responds correctly, we move to the GitHub Actions workflow that
runs the actual trading logic on a schedule and reports back to this Worker.
