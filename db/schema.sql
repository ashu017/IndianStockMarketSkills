PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stock_meta (
  symbol   TEXT NOT NULL,
  exchange TEXT NOT NULL CHECK (exchange IN ('NSE','BSE')),
  isin     TEXT,
  company  TEXT,
  sector   TEXT,
  PRIMARY KEY (symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_stock_meta_isin ON stock_meta(isin);

CREATE TABLE IF NOT EXISTS holding_snapshots (
  user_id       TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,               -- YYYY-MM-DD (IST)
  symbol        TEXT NOT NULL,
  exchange      TEXT NOT NULL,
  qty           INTEGER NOT NULL,            -- shares
  avg_price     INTEGER NOT NULL,            -- x10000
  ltp           INTEGER NOT NULL,            -- paise
  close_price   INTEGER NOT NULL,            -- paise
  UNIQUE (user_id, snapshot_date, symbol, exchange),
  FOREIGN KEY (symbol, exchange) REFERENCES stock_meta(symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_hs_series ON holding_snapshots(user_id, symbol, snapshot_date);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id        TEXT NOT NULL,
  snapshot_date  TEXT NOT NULL,
  current_value  INTEGER NOT NULL,           -- paise
  invested       INTEGER NOT NULL,           -- paise
  total_pnl      INTEGER NOT NULL,           -- paise
  day_pnl        INTEGER NOT NULL,           -- paise
  holdings_count INTEGER NOT NULL,
  winners        INTEGER NOT NULL,
  losers         INTEGER NOT NULL,
  UNIQUE (user_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS fundamentals (
  isin             TEXT NOT NULL,
  as_of_date       TEXT NOT NULL,
  pe               REAL,
  pb               REAL,
  roe              REAL,
  roce             REAL,
  debt_equity      REAL,
  sales_growth_3y  REAL,
  profit_growth_3y REAL,
  div_yield        REAL,
  market_cap       INTEGER,                  -- paise
  promoter_holding REAL,
  fetched_at       TEXT,                     -- ISO-8601 UTC
  source           TEXT,
  source_url       TEXT,
  fetch_status     TEXT CHECK (fetch_status IN ('ok','stale','failed')),
  UNIQUE (isin, as_of_date)
);

CREATE TABLE IF NOT EXISTS fundamentals_extra (
  isin       TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value_num  REAL,
  unit       TEXT,
  UNIQUE (isin, as_of_date, metric_key)
);

CREATE TABLE IF NOT EXISTS peers (
  isin         TEXT NOT NULL,
  as_of_date   TEXT NOT NULL,
  peer_symbol  TEXT NOT NULL,
  peer_company TEXT,
  pe           REAL,
  roe          REAL,
  roce         REAL,
  sales_growth REAL,
  UNIQUE (isin, as_of_date, peer_symbol)
);

-- Cached Kite Connect access token (one row per user). access_token expires at
-- ~6 AM IST next day (regulatory); expires_at is stored so ingestion knows when
-- to force a fresh login instead of calling the API with a dead token.
CREATE TABLE IF NOT EXISTS kite_session (
  user_id      TEXT NOT NULL,
  access_token TEXT NOT NULL,
  kite_user_id TEXT,
  login_time   TEXT,                        -- ISO-8601 UTC
  expires_at   TEXT NOT NULL,               -- ISO-8601 UTC (next 6 AM IST)
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS analysis (
  isin           TEXT NOT NULL,
  narrative      TEXT,
  verdict        TEXT,                       -- 'BUY' | 'SELL' | 'HOLD'
  confidence     TEXT,                       -- 'Low' | 'Medium' | 'High'
  generated_at   TEXT,                       -- ISO-8601 UTC
  model_version  TEXT,
  prompt_version TEXT,
  UNIQUE (isin)
);

-- Point-in-time snapshot of the scanner universe, captured on every scanner run.
-- Guards against survivorship bias in walk-forward backtests: a stock delisted or
-- dropped from the Screener screen in 2023 must still appear in a 2023 query.
CREATE TABLE IF NOT EXISTS universe_snapshot (
  snapshot_date TEXT NOT NULL,        -- IST YYYY-MM-DD
  symbol        TEXT NOT NULL,
  exchange      TEXT NOT NULL,
  isin          TEXT,
  sector        TEXT,
  index_name    TEXT,                 -- 'NIFTY 500', 'AD-HOC', etc.
  in_screener   INTEGER NOT NULL DEFAULT 0,  -- 1 if in latest Screener screen on this date
  mcap_rs_cr    REAL,                 -- market cap in Rs Crore, if available
  PRIMARY KEY (snapshot_date, symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_universe_snapshot_date ON universe_snapshot(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_universe_snapshot_symbol ON universe_snapshot(symbol);

-- Latest snapshot per (user, symbol, exchange). ROW_NUMBER() (portable to Postgres),
-- NOT SQLite's bare-MAX()+GROUP BY idiom which is undefined on other engines.
CREATE VIEW IF NOT EXISTS v_holdings_current AS
SELECT user_id, snapshot_date, symbol, exchange, qty, avg_price, ltp, close_price
FROM (
  SELECT hs.*, ROW_NUMBER() OVER (
    PARTITION BY user_id, symbol, exchange ORDER BY snapshot_date DESC) AS rn
  FROM holding_snapshots hs
)
WHERE rn = 1;

-- Index membership: which stocks belong to which NSE index. A stock can be in
-- multiple indices (NIFTY 100 ⊂ NIFTY 200 ⊂ NIFTY 500), so composite PK includes
-- index_name. `sector` drives the financials-exempt debt/equity rule in the
-- quality gate. Rebuild quarterly when NSE rebalances.
CREATE TABLE IF NOT EXISTS index_universe (
  index_name         TEXT NOT NULL,             -- 'NIFTY 100' | 'NIFTY 200' | 'NIFTY 500' | 'NIFTY MIDCAP 150' | ...
  symbol             TEXT NOT NULL,
  exchange           TEXT NOT NULL CHECK (exchange IN ('NSE','BSE')),
  isin               TEXT NOT NULL,
  tradingsymbol      TEXT NOT NULL,
  instrument_token   INTEGER NOT NULL,
  company            TEXT,
  sector             TEXT,
  as_of_date         TEXT NOT NULL,
  PRIMARY KEY (index_name, symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_index_universe_symbol ON index_universe(symbol, exchange);
CREATE INDEX IF NOT EXISTS idx_index_universe_isin   ON index_universe(isin);

-- Legacy compat: preserved so old scripts that SELECT FROM nifty100_universe keep
-- working. Reads only the NIFTY 100 slice of index_universe.
CREATE VIEW IF NOT EXISTS nifty100_universe AS
  SELECT symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date
  FROM index_universe
  WHERE index_name = 'NIFTY 100';

-- Daily OHLCV from Kite Connect /historical/day. One row per (instrument_token, date).
-- Prices stored in paise (INTEGER) for exactness; volume as raw share count.
CREATE TABLE IF NOT EXISTS ohlc_daily (
  instrument_token INTEGER NOT NULL,
  trade_date       TEXT NOT NULL,               -- YYYY-MM-DD (IST session date)
  open             INTEGER NOT NULL,            -- paise
  high             INTEGER NOT NULL,            -- paise
  low              INTEGER NOT NULL,            -- paise
  close            INTEGER NOT NULL,            -- paise
  volume           INTEGER NOT NULL,            -- shares
  fetched_at       TEXT NOT NULL,               -- ISO-8601 UTC
  UNIQUE (instrument_token, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_ohlc_series ON ohlc_daily(instrument_token, trade_date);

-- Live/intraday quotes fetched during market hours from NSE NextApi (getPeerComparisonData).
-- Overrides today's ohlc_daily.close with the "so-far" price when the scanner runs.
-- Not authoritative — nightly bhavcopy replaces the day's row in ohlc_daily proper.
-- One row per (instrument_token, quote_date). The quote_date is IST session date;
-- fetched_at is when we last pinged NSE for it.
CREATE TABLE IF NOT EXISTS ohlc_intraday (
  instrument_token INTEGER NOT NULL,
  quote_date       TEXT NOT NULL,          -- IST YYYY-MM-DD
  ltp              INTEGER NOT NULL,       -- paise (last traded price = current running "close")
  day_high         INTEGER,                -- paise, best-effort from PeerComparison "High"
  day_low          INTEGER,                -- paise
  day_volume       INTEGER,                -- shares traded so far today
  perc_change      REAL,                   -- % vs previous close (from NSE)
  source           TEXT DEFAULT 'nse-nextapi',
  fetched_at       TEXT NOT NULL,          -- ISO-8601 UTC
  UNIQUE (instrument_token, quote_date)
);
CREATE INDEX IF NOT EXISTS idx_intraday_date ON ohlc_intraday(quote_date);

-- Screener /screen/raw/ query results cache. One row per (query_hash, symbol, run_date).
-- The scanner reads the LATEST run per query and treats the resulting symbols as the
-- quality-approved pool, replacing the per-stock fundamentals-based gate.
CREATE TABLE IF NOT EXISTS screener_screen_cache (
  query_hash   TEXT NOT NULL,      -- sha256 of the query string; stable across runs
  run_date     TEXT NOT NULL,      -- IST YYYY-MM-DD
  run_ts       TEXT NOT NULL,      -- ISO-8601 UTC of the fetch
  symbol       TEXT NOT NULL,      -- NSE tradingsymbol (mapped from Screener's display name)
  company      TEXT,               -- Screener's company display name
  screener_id  TEXT,               -- Screener's internal company slug (e.g., 'reliance-industries')
  metrics      TEXT,               -- JSON: full row of columns Screener returned
  UNIQUE (query_hash, run_date, symbol)
);
CREATE INDEX IF NOT EXISTS idx_screen_run ON screener_screen_cache(query_hash, run_date);

-- Signals emitted by scripts/scan-nifty100-signals.ts. Dedup key is (symbol,scan_date):
-- a stock firing on the same scan date won't re-insert, but multiple scans across
-- different days append independent rows. This lets us keep a trade log without
-- storing external order state.
CREATE TABLE IF NOT EXISTS signals (
  symbol         TEXT NOT NULL,
  exchange       TEXT NOT NULL,
  scan_date      TEXT NOT NULL,                 -- YYYY-MM-DD (IST scan session date)
  scan_time      TEXT NOT NULL,                 -- ISO-8601 UTC of scan execution
  side           TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  entry_paise    INTEGER NOT NULL,              -- suggested max entry price (paise)
  stop_paise     INTEGER NOT NULL,              -- stop-loss trigger (paise)
  target_paise   INTEGER NOT NULL,              -- profit target (paise)
  risk_reward    REAL NOT NULL,                 -- target-entry / entry-stop
  atr14_paise    INTEGER,                       -- ATR(14) used for the stop
  mom_rank       INTEGER,                       -- 1-based rank within eligible universe
  mom_score      REAL,                          -- vol-adjusted 12-1 momentum score
  reasons        TEXT,                          -- JSON: {quality:{...}, technical:{...}}
  UNIQUE (symbol, exchange, scan_date, side)
);
CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(scan_date, side);

-- Simulated open positions. Not real trades — the scanner opens a "paper"
-- position when a signal fires, then tracks it through every subsequent scan.
-- Exits when: today's low ≤ stop_paise, or today's high ≥ target_paise, or
-- >= 60 trading days have passed since entry. At +1R unrealized, stop moves
-- to breakeven. The Telegram digest includes an [Active positions] section.
CREATE TABLE IF NOT EXISTS open_positions (
  symbol             TEXT NOT NULL,
  exchange           TEXT NOT NULL,
  entry_scan_date    TEXT NOT NULL,       -- IST YYYY-MM-DD (scan_date that fired the signal)
  entry_scan_time    TEXT NOT NULL,       -- ISO-8601 UTC (from signals.scan_time)
  side               TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  entry_paise        INTEGER NOT NULL,
  initial_stop_paise INTEGER NOT NULL,
  current_stop_paise INTEGER NOT NULL,    -- mutates over time (moves to breakeven at +1R, then trails)
  target_paise       INTEGER NOT NULL,
  atr14_paise        INTEGER,
  status             TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','target_hit','stopped','time_exit','manual_closed')),
  exit_date          TEXT,                 -- YYYY-MM-DD when exit fired
  exit_paise         INTEGER,              -- realized price
  exit_reason        TEXT,                 -- description
  bars_held          INTEGER NOT NULL DEFAULT 0,  -- trading days between entry and today (advances daily)
  UNIQUE (symbol, exchange, entry_scan_date, side)
);
CREATE INDEX IF NOT EXISTS idx_open_positions_status ON open_positions(status);
CREATE INDEX IF NOT EXISTS idx_open_positions_symbol ON open_positions(symbol, exchange);

-- Paper trading: simulated portfolio state. One row per user (single-user for now).
-- All amounts in paise (INTEGER) for exactness. `current_cash_paise` = free cash;
-- `equity_paise` = free cash + Σ(unrealized value of every open paper_trade at LTP)
-- — updated by lib/paper.ts on every cron fire.
CREATE TABLE IF NOT EXISTS paper_account (
  user_id                TEXT PRIMARY KEY,
  starting_cash_paise    INTEGER NOT NULL,
  current_cash_paise     INTEGER NOT NULL,     -- deducted when opening, restored on close
  equity_paise           INTEGER NOT NULL,     -- cash + Σ(LTP × qty for open trades)
  risk_pct_per_trade     REAL NOT NULL DEFAULT 1.0,   -- % of equity risked per trade
  max_concurrent_trades  INTEGER NOT NULL DEFAULT 5,
  max_position_pct       REAL NOT NULL DEFAULT 25.0,  -- cap capital per position
  created_at             TEXT NOT NULL,
  last_updated_at        TEXT NOT NULL
);

-- Paper trades: every simulated position, open or closed. `entry_signal_id` links
-- to the signals table (nullable — allows manual entries via the UI). Realized
-- P&L is populated on close; before that, P&L is computed on the fly from LTP.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  exchange                TEXT NOT NULL,
  entry_signal_scan_date  TEXT,                -- FK-ish → signals.scan_date; NULL for manual entries
  entry_date              TEXT NOT NULL,       -- IST YYYY-MM-DD (== signals.scan_date at open time)
  entry_time              TEXT NOT NULL,       -- ISO-8601 UTC
  entry_paise             INTEGER NOT NULL,
  qty                     INTEGER NOT NULL,    -- whole shares
  capital_committed_paise INTEGER NOT NULL,    -- entry_paise × qty
  initial_stop_paise      INTEGER NOT NULL,
  current_stop_paise      INTEGER NOT NULL,    -- moves to breakeven at +1R, then trails
  target_paise            INTEGER NOT NULL,
  atr14_paise             INTEGER,
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','target_hit','stopped','time_exit','manual_closed','rotated_out')),
  exit_date               TEXT,
  exit_time               TEXT,
  exit_paise              INTEGER,
  exit_reason             TEXT,
  realized_pnl_paise      INTEGER,             -- populated on close
  bars_held               INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, symbol, exchange, entry_date)
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_open   ON paper_trades(user_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol, exchange);
CREATE INDEX IF NOT EXISTS idx_paper_trades_entry  ON paper_trades(entry_date);

-- Daily equity-curve snapshots. Written at the end-of-day scanner fire (last one
-- of the trading day). Enables the account chart on /paper.
CREATE TABLE IF NOT EXISTS paper_account_history (
  user_id                 TEXT NOT NULL,
  snapshot_date           TEXT NOT NULL,       -- IST YYYY-MM-DD
  cash_paise              INTEGER NOT NULL,
  unrealized_pnl_paise    INTEGER NOT NULL,    -- Σ((LTP - entry) × qty) across open
  realized_pnl_paise      INTEGER NOT NULL,    -- cumulative to-date
  equity_paise            INTEGER NOT NULL,    -- cash + Σ(LTP × qty)
  open_position_count     INTEGER NOT NULL,
  winners                 INTEGER NOT NULL,    -- open positions in profit
  losers                  INTEGER NOT NULL,    -- open positions in loss
  UNIQUE (user_id, snapshot_date)
);
