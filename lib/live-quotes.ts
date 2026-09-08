import type Database from "better-sqlite3";

/**
 * Live (intraday) quotes from NSE's public NextApi endpoint
 * (`getPeerComparisonData`). ~2-5 minute delay, no auth, free.
 *
 * This module holds the fetch and the ohlc_intraday upsert; both the nightly
 * cron (scripts/refresh-live-quotes.ts, whole universe) and the on-demand page
 * fetch (app/api/quotes/route.ts, a handful of symbols) call refreshLiveQuotes()
 * so there is exactly one implementation of "what is this stock worth now".
 *
 * Deliberately does NOT import "server-only": the cron script runs it under
 * plain tsx, outside any React boundary.
 *
 * Design notes carried over from the original script:
 *   - Concurrency 4. NSE is public-cache-friendly but 8-10 concurrent requests
 *     started drawing 429s on us empirically.
 *   - One call per symbol; the response also carries 5-7 industry peers whose
 *     LTPs are equally current, so we cache those for free when they are in our
 *     universe. That is a pure bonus — never a substitute for asking directly.
 *   - Idempotent: same-day rows are overwritten in place.
 */

const BASE_URL =
  "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getPeerComparisonData&type=S&quarter=&param=industry&index=&symbol=";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

interface PeerRow {
  symbol: string;
  ltp: number | null;
  volume: number | null;
  PChange: number | null;
  marketCap: number | null;
}

/** One symbol's live mark, as handed back to callers. */
export interface LiveQuote {
  symbol: string;
  ltp_paise: number;
  perc_change: number | null;
  /** ISO timestamp of the fetch that produced this — not of the trade. */
  fetched_at: string;
  /** True when this came from an existing fresh ohlc_intraday row rather than
   *  from a new network call (see `reuseWithinSeconds`). */
  cached: boolean;
}

export interface RefreshResult {
  quote_date: string;
  fetched_at: string;
  requested: number;
  /** Symbols we asked NSE about directly and got a usable LTP for. */
  fetched: number;
  /** Reused from a recent ohlc_intraday row instead of re-asking. */
  reused: number;
  /** Peer rows persisted as a side effect of someone else's request. */
  opportunistic_peers: number;
  failed: number;
  quotes: Record<string, LiveQuote>;
}

export interface RefreshOptions {
  /** Explicit symbol list. When omitted, the whole (optionally index-filtered)
   *  index_universe is refreshed — the cron's behaviour. */
  symbols?: string[] | null;
  /** Restrict the universe to one index. Ignored when `symbols` is given. */
  indexName?: string | null;
  concurrency?: number;
  requestDelayMs?: number;
  /**
   * Skip the network call when ohlc_intraday already has a row for this symbol
   * fetched within this many seconds. 0 (the default, and the cron's setting)
   * always re-fetches.
   *
   * The page fetch sets this so that opening three strategies in a row, or
   * reloading one, does not turn into three rounds of NSE traffic for the same
   * prices. NSE's own feed is a couple of minutes delayed anyway, so a short
   * reuse window costs the reader no accuracy they actually had.
   */
  reuseWithinSeconds?: number;
  /** Cache peer LTPs seen along the way. On for the cron (free coverage), off
   *  for the page fetch (nothing there needs peers, and it keeps writes small). */
  opportunisticPeers?: boolean;
}

/** IST is UTC+5:30 year-round, so this shift needs no DST handling. */
export function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function rsToPaise(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

async function fetchOne(symbol: string): Promise<PeerRow[] | null> {
  try {
    const res = await fetch(BASE_URL + encodeURIComponent(symbol), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,*/*;q=0.9",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as PeerRow[];
    if (!Array.isArray(j)) return null;
    return j;
  } catch {
    // Network failure is an expected outcome here, not an exception: NSE's
    // NextApi is flaky and every caller is designed to fall back to the last
    // end-of-day bar. Callers see it as a `failed` count.
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface UniverseRow {
  symbol: string;
  instrument_token: number;
}

export async function refreshLiveQuotes(
  db: Database.Database,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const concurrency = opts.concurrency ?? 4;
  const requestDelayMs = opts.requestDelayMs ?? 200;
  const reuseWithinSeconds = opts.reuseWithinSeconds ?? 0;
  const opportunisticPeers = opts.opportunisticPeers ?? true;

  // The universe is the token lookup, not the work list: a symbol can be worth
  // quoting (a closed trade in a stock that has since left the index) even
  // though it has no token to persist against.
  const universe = (
    opts.indexName
      ? db
          .prepare(
            `SELECT DISTINCT symbol, instrument_token FROM index_universe WHERE index_name = ? ORDER BY symbol`,
          )
          .all(opts.indexName)
      : db
          .prepare(`SELECT DISTINCT symbol, instrument_token FROM index_universe ORDER BY symbol`)
          .all()
  ) as UniverseRow[];

  const symToToken = new Map<string, number>();
  for (const u of universe) symToToken.set(u.symbol, u.instrument_token);

  const work = opts.symbols
    ? Array.from(new Set(opts.symbols))
    : universe.map((u) => u.symbol);

  const quoteDate = istDate();
  const fetchedAt = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO ohlc_intraday(instrument_token, quote_date, ltp, day_high, day_low, day_volume, perc_change, fetched_at)
     VALUES(@instrument_token, @quote_date, @ltp, @day_high, @day_low, @day_volume, @perc_change, @fetched_at)
     ON CONFLICT(instrument_token, quote_date) DO UPDATE SET
       ltp=excluded.ltp,
       day_high=COALESCE(excluded.day_high, ohlc_intraday.day_high),
       day_low=COALESCE(excluded.day_low, ohlc_intraday.day_low),
       day_volume=excluded.day_volume,
       perc_change=excluded.perc_change,
       fetched_at=excluded.fetched_at`,
  );
  const readFresh = db.prepare(
    `SELECT ltp, perc_change, fetched_at FROM ohlc_intraday
     WHERE instrument_token=? AND quote_date=? LIMIT 1`,
  );

  const quotes: Record<string, LiveQuote> = {};
  let fetched = 0;
  let reused = 0;
  let failed = 0;
  let opportunistic = 0;

  const cutoff = Date.now() - reuseWithinSeconds * 1000;

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= work.length) return;
      const symbol = work[idx];
      const token = symToToken.get(symbol);

      if (reuseWithinSeconds > 0 && token !== undefined) {
        const existing = readFresh.get(token, quoteDate) as
          | { ltp: number; perc_change: number | null; fetched_at: string }
          | undefined;
        if (existing && Date.parse(existing.fetched_at) >= cutoff) {
          quotes[symbol] = {
            symbol,
            ltp_paise: existing.ltp,
            perc_change: existing.perc_change,
            fetched_at: existing.fetched_at,
            cached: true,
          };
          reused++;
          continue;
        }
      }

      const rows = await fetchOne(symbol);
      if (!rows) {
        failed++;
        await sleep(requestDelayMs);
        continue;
      }

      // The requested symbol is always in the response, usually first but not
      // reliably so.
      const target = rows.find((r) => r.symbol === symbol);
      const targetPaise = rsToPaise(target?.ltp ?? null);
      if (target && targetPaise !== null) {
        quotes[symbol] = {
          symbol,
          ltp_paise: targetPaise,
          perc_change: target.PChange ?? null,
          fetched_at: fetchedAt,
          cached: false,
        };
        fetched++;
      } else {
        failed++;
      }

      const persist: { symbol: string; token: number; row: PeerRow }[] = [];
      if (target && token !== undefined) persist.push({ symbol, token, row: target });
      if (opportunisticPeers) {
        for (const r of rows) {
          if (r.symbol === symbol) continue;
          const tok = symToToken.get(r.symbol);
          if (tok !== undefined) persist.push({ symbol: r.symbol, token: tok, row: r });
        }
      }

      if (persist.length > 0) {
        const tx = db.transaction(() => {
          for (const p of persist) {
            const paise = rsToPaise(p.row.ltp);
            if (paise === null) continue;
            upsert.run({
              instrument_token: p.token,
              quote_date: quoteDate,
              ltp: paise,
              day_high: null,
              day_low: null,
              day_volume: p.row.volume ?? null,
              perc_change: p.row.PChange ?? null,
              fetched_at: fetchedAt,
            });
            if (p.symbol !== symbol) opportunistic++;
          }
        });
        tx();
      }

      await sleep(requestDelayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    quote_date: quoteDate,
    fetched_at: fetchedAt,
    requested: work.length,
    fetched,
    reused,
    opportunistic_peers: opportunistic,
    failed,
    quotes,
  };
}
