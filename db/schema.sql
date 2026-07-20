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
