-- D1 schema for trade history + daily P&L tracking
-- Apply with: wrangler d1 execute deriv-bot-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,       -- BUY / SELL
  entry_price REAL,
  exit_price REAL,
  stake REAL NOT NULL,
  payout REAL,
  result TEXT,                   -- WIN / LOSS / PENDING
  pnl REAL,                      -- profit/loss in account currency
  mode TEXT NOT NULL,            -- demo / real
  opened_at INTEGER NOT NULL,    -- unix epoch
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  signals_found INTEGER DEFAULT 0,
  orders_placed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running'  -- running / completed / error / skipped_paused / skipped_loss_limit
);

CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
