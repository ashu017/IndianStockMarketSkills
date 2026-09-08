import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sma, volAdjMomentum } from "@/lib/indicators";
import {
  evaluate,
  loadCoalescedFundamentals,
  loadOhlc,
  TECHNICAL_THRESHOLDS,
  type StockVerdict,
} from "@/lib/verdict";
import {
  recordSignalAsPosition,
  updateOpenPositions,
  loadActivePositions,
} from "@/lib/positions";
import {
  ensureAccount,
  openPaperTrade,
  updateOpenPaperTrades,
  loadActivePaperTrades,
  snapshotAccountHistory,
  summarize as summarizePaper,
  openQty,
  DEFAULT_STRATEGY,
} from "@/lib/paper";
import {
  demeanBySector,
  isSectorDemeanEnabled,
} from "@/lib/momentum-normalize";
import { CURRENT_EXIT_RULE, EXIT_RULES, describeExitRule } from "@/lib/exit-rules";
import { loadScreenUniverse } from "@/lib/screen-universe";

/**
 * The Nifty 100 / Nifty 200 signal scanner.
 *
 * Reads the local SQLite DB — no network calls, no LLM. Applies the recipe from
 * lib/verdict.ts (shared with the UI verdict card and Telegram /check command)
 * plus two scanner-specific concerns:
 *
 *   1. Market regime gate (median close vs 200-SMA) — kills all signals in bear
 *      markets to avoid buying into declines.
 *   2. Momentum ranking (vol-adjusted 12-1) — keeps only the top-N momentum
 *      names among those that pass quality + trend, matching NSE's own Nifty
 *      200 Momentum 30 construction.
 *
 * Every other check (quality gate, technical filters, trade box) is delegated
 * to lib/verdict.ts so the scanner and the UI always agree.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   INDEX_NAME="NIFTY 500"    — scan universe (default; ignored when USE_SCREENER_SCREEN=1)
 *   USE_SCREENER_SCREEN=1     — replace local quality gate with the latest cached
 *                                Screener screen (screener_screen_cache table).
 *                                The scanner treats every symbol in the latest run as
 *                                pre-approved by Screener's tightened recipe and only
 *                                runs the technical layer + momentum ranking locally.
 *   SCREENER_QUERY_HASH=<hex>  — pick a specific query hash from the cache; default = latest run
 *   IGNORE_QUALITY_GATE=1     — skip fundamental filter (informational scan)
 *   FORCE_REGIME=bull|bear    — override market-regime detection
 *   MOM_TOPN=30               — how many top-momentum stocks form the pool
 *   MAX_SIGNALS=5             — cap signals per scan (highest momentum first)
 *   SECTOR_DEMEAN=1|0         — sector-demean momentum before top-N ranking so
 *                               a single hot sector cannot flood the pool
 *                               (default ON; set to "0" to disable for A/B).
 */

interface UniverseRow {
  symbol: string;
  exchange: string;
  isin: string;
  instrument_token: number;
  sector: string | null;
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function detectRegime(
  closesByToken: Map<number, number[]>,
  override: string | null,
): { bull: boolean; reason: string } {
  if (override === "bull") return { bull: true, reason: "forced bull via FORCE_REGIME" };
  if (override === "bear") return { bull: false, reason: "forced bear via FORCE_REGIME" };
  // Median close across all universe tokens vs its own 200-SMA.
  const arrays = [...closesByToken.values()].filter((a) => a.length >= 200);
  if (arrays.length === 0) return { bull: false, reason: "no history for regime detection" };
  const minLen = Math.min(...arrays.map((a) => a.length));
  const median: number[] = [];
  for (let i = 0; i < minLen; i++) {
    const vals = arrays
      .map((a) => a[a.length - minLen + i])
      .filter((v) => Number.isFinite(v));
    vals.sort((x, y) => x - y);
    median.push(vals[Math.floor(vals.length / 2)]);
  }
  const sma200 = sma(median, 200);
  if (sma200 === null) return { bull: false, reason: "insufficient median history" };
  const last = median[median.length - 1];
  return {
    bull: last > sma200,
    reason: `median close ${last.toFixed(0)} vs 200-SMA ${sma200.toFixed(0)}`,
  };
}

interface EnrichedCandidate {
  u: UniverseRow;
  verdict: StockVerdict;
  momentum: number | null;
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const ignoreQuality = process.env.IGNORE_QUALITY_GATE === "1";
  const forceRegime = process.env.FORCE_REGIME ?? null;
  const momTopN = Number(process.env.MOM_TOPN ?? "30");
  const maxSignals = Number(process.env.MAX_SIGNALS ?? "5");
  const indexName = process.env.INDEX_NAME ?? "NIFTY 500";
  const useScreenerScreen = process.env.USE_SCREENER_SCREEN === "1";
  const screenerQueryHash = process.env.SCREENER_QUERY_HASH ?? null;
  const scanDate = istDate();
  const scanTime = new Date().toISOString();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  // Universe selection. Two modes:
  //   (a) USE_SCREENER_SCREEN=1 → read the latest cached Screener screen. The
  //       returned symbols are already quality-approved by Screener's tightened
  //       recipe (11 filters vs our local 6). The scanner still needs OHLC +
  //       sector, so we join to whichever index_universe row exists.
  //   (b) default → all stocks in the named index (Nifty 200), and the local
  //       coalesced-fundamentals quality gate runs.
  let universe: UniverseRow[];
  let screenerSource: {
    query_hash: string;
    run_date: string;
    run_ts: string;
    total_rows: number;
  } | null = null;

  if (useScreenerScreen) {
    // Find the latest run per query_hash. If a specific hash was requested, use
    // it; else take the newest cache entry.
    let hashRow: { query_hash: string; run_date: string; run_ts: string } | undefined;
    if (screenerQueryHash) {
      hashRow = db
        .prepare(
          `SELECT query_hash, run_date, run_ts FROM screener_screen_cache
           WHERE query_hash = ?
           ORDER BY run_ts DESC LIMIT 1`,
        )
        .get(screenerQueryHash) as { query_hash: string; run_date: string; run_ts: string } | undefined;
    } else {
      hashRow = db
        .prepare(
          `SELECT query_hash, run_date, run_ts FROM screener_screen_cache
           ORDER BY run_ts DESC LIMIT 1`,
        )
        .get() as { query_hash: string; run_date: string; run_ts: string } | undefined;
    }
    if (!hashRow) {
      db.close();
      process.stdout.write(
        JSON.stringify({
          status: "error",
          message: "USE_SCREENER_SCREEN=1 but screener_screen_cache is empty. Run scripts/fetch-screener-screen.ts first.",
        }) + "\n",
      );
      process.exit(1);
      return;
    }
    const screenSymbols = db
      .prepare(
        `SELECT symbol FROM screener_screen_cache WHERE query_hash = ? AND run_date = ?`,
      )
      .all(hashRow.query_hash, hashRow.run_date) as { symbol: string }[];
    screenerSource = {
      query_hash: hashRow.query_hash,
      run_date: hashRow.run_date,
      run_ts: hashRow.run_ts,
      total_rows: screenSymbols.length,
    };
    // Join to index_universe for OHLC + sector context. A stock in Screener's
    // list that isn't in any tracked index is skipped (we have no OHLC for it).
    // The AD-HOC entries created by refresh-single-stock still count.
    // Extracted to lib/ so the one-row-per-index-membership de-duplication is
    // covered by tests/screen-universe.test.ts — see that module for why.
    universe = loadScreenUniverse(db, screenSymbols.map((s) => s.symbol));
  } else {
    universe = db
      .prepare(
        `SELECT DISTINCT symbol, exchange, isin, instrument_token, sector
         FROM index_universe
         WHERE index_name = ?
         ORDER BY symbol`,
      )
      .all(indexName) as UniverseRow[];
  }

  // Preload OHLC closes for regime detection (cheap read, one query per token).
  const closesByToken = new Map<number, number[]>();
  for (const u of universe) {
    const rows = db
      .prepare(
        `SELECT close FROM ohlc_daily WHERE instrument_token = ? ORDER BY trade_date ASC`,
      )
      .all(u.instrument_token) as { close: number }[];
    closesByToken.set(u.instrument_token, rows.map((r) => r.close));
  }
  const regime = detectRegime(closesByToken, forceRegime);

  // 1st pass — evaluate every stock using the shared engine. Keep only those that
  // pass the quality gate and are in a Golden Cross uptrend (technical[0] and [1]).
  const candidates: EnrichedCandidate[] = [];
  for (const u of universe) {
    const fundamentals = u.isin ? loadCoalescedFundamentals(db, u.isin) : null;
    const ohlc = loadOhlc(db, u.instrument_token);
    const verdict = evaluate({
      symbol: u.symbol,
      exchange: u.exchange,
      isin: u.isin,
      sector: u.sector,
      fundamentals,
      ohlc,
    });

    // In Screener-screen mode, membership in the universe already means Screener
    // approved the quality gate. The local verdict.quality can be trusted OR ignored.
    const qualityPassed =
      ignoreQuality || useScreenerScreen || (verdict.quality.length > 0 && verdict.quality.every((c) => c.ok));
    // technical[0] = "Close > 200-DMA", technical[1] = "50-DMA > 200-DMA".
    // We keep the stock only if both trend checks pass — Golden Cross regime.
    const trendPassed = verdict.technical[0]?.ok && verdict.technical[1]?.ok;
    if (!qualityPassed || !trendPassed) continue;

    // Compute momentum for ranking. Same window and formula the recipe uses.
    const closes = ohlc.map((r) => r.close);
    const momentum = volAdjMomentum(
      closes,
      TECHNICAL_THRESHOLDS.MOMENTUM_LOOKBACK,
      TECHNICAL_THRESHOLDS.MOMENTUM_SKIP,
    );
    candidates.push({ u, verdict, momentum });
  }

  // Sector-demean momentum before ranking so one hot sector (Defence, PSU
  // banks, etc.) cannot flood the top-N. Sectors with < 3 members are left
  // alone — the mean over 1-2 names would zero them out spuriously. Disabled
  // by SECTOR_DEMEAN=0 for A/B testing.
  const demeanEnabled = isSectorDemeanEnabled(process.env);
  const demean = demeanBySector(candidates, demeanEnabled);
  const rankedCandidates = demean.candidates;

  // Rank by momentum desc, take top N.
  rankedCandidates.sort((a, b) => (b.momentum ?? -Infinity) - (a.momentum ?? -Infinity));
  const topN = rankedCandidates.slice(0, momTopN);
  const momRank = new Map<string, number>();
  topN.forEach((c, i) => momRank.set(c.u.symbol, i + 1));

  // Emit signals only in bull regime, only for top-N members whose full technical
  // pack fires (breakout + volume + ATR-based stop yields a valid trade).
  const signals: {
    symbol: string;
    exchange: string;
    scan_date: string;
    scan_time: string;
    side: "BUY";
    entry_paise: number;
    stop_paise: number;
    target_paise: number;
    risk_reward: number;
    atr14_paise: number | null;
    mom_rank: number;
    mom_score: number | null;
    reasons: string;
  }[] = [];

  if (regime.bull) {
    for (const c of topN) {
      if (!c.verdict.trade) continue; // T3 (breakout) or T4 (volume) not firing today
      signals.push({
        symbol: c.u.symbol,
        exchange: c.u.exchange,
        scan_date: scanDate,
        scan_time: scanTime,
        side: "BUY",
        entry_paise: c.verdict.trade.entry_paise,
        stop_paise: c.verdict.trade.stop_paise,
        target_paise: c.verdict.trade.target_paise,
        risk_reward: c.verdict.trade.risk_reward,
        atr14_paise: c.verdict.trade.atr14_paise,
        mom_rank: momRank.get(c.u.symbol) ?? 0,
        mom_score: c.momentum,
        reasons: JSON.stringify({
          quality: c.verdict.quality,
          technical: c.verdict.technical,
          overall: c.verdict.overall,
        }),
      });
    }
  }

  signals.sort((a, b) => a.mom_rank - b.mom_rank);
  const finalSignals = signals.slice(0, maxSignals);

  const upsert = db.prepare(
    `INSERT INTO signals(symbol, exchange, scan_date, scan_time, side, entry_paise, stop_paise, target_paise,
                          risk_reward, atr14_paise, mom_rank, mom_score, reasons)
     VALUES(@symbol, @exchange, @scan_date, @scan_time, @side, @entry_paise, @stop_paise, @target_paise,
            @risk_reward, @atr14_paise, @mom_rank, @mom_score, @reasons)
     ON CONFLICT(symbol, exchange, scan_date, side) DO UPDATE SET
       scan_time=excluded.scan_time, entry_paise=excluded.entry_paise, stop_paise=excluded.stop_paise,
       target_paise=excluded.target_paise, risk_reward=excluded.risk_reward, atr14_paise=excluded.atr14_paise,
       mom_rank=excluded.mom_rank, mom_score=excluded.mom_score, reasons=excluded.reasons`,
  );
  // Ensure the paper account exists (Rs 3L default if first run).
  ensureAccount(db);

  // Build a snapshot of the currently-open paper positions' momentum scores
  // BEFORE we start opening new trades — the rotation logic in openPaperTrade
  // consults this map to decide whether an incoming signal has enough edge to
  // evict a weak incumbent.
  const openMomScores = new Map<string, number>();
  {
    const openRows = db
      .prepare(`SELECT symbol, exchange FROM paper_trades WHERE user_id='local' AND status='open'`)
      .all() as { symbol: string; exchange: string }[];
    for (const p of openRows) {
      const u = db
        .prepare(
          `SELECT DISTINCT instrument_token FROM index_universe WHERE symbol=? AND exchange=? LIMIT 1`,
        )
        .get(p.symbol, p.exchange) as { instrument_token: number } | undefined;
      if (!u) continue;
      const closes = closesByToken.get(u.instrument_token) ?? (db
        .prepare(`SELECT close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date ASC`)
        .all(u.instrument_token) as { close: number }[]).map((r) => r.close);
      const mom = volAdjMomentum(
        closes,
        TECHNICAL_THRESHOLDS.MOMENTUM_LOOKBACK,
        TECHNICAL_THRESHOLDS.MOMENTUM_SKIP,
      );
      if (mom !== null && Number.isFinite(mom)) openMomScores.set(p.symbol, mom);
    }
  }

  let opened = 0;
  const openSkipReasons: { symbol: string; reason: string }[] = [];
  const rotations: {
    out_symbol: string; in_symbol: string;
    out_mom: number; in_mom: number; mom_ratio: number;
    realized_pnl_rs: number;
  }[] = [];
  const tx = db.transaction(() => {
    for (const s of finalSignals) {
      upsert.run(s);
      // Paper-trading engine — sizes qty from account equity, deducts cash,
      // records the trade in paper_trades. Legacy open_positions is still written
      // via recordSignalAsPosition() for backwards compat with any old readers.
      recordSignalAsPosition(db, {
        symbol: s.symbol, exchange: s.exchange, scan_date: s.scan_date, scan_time: s.scan_time,
        side: s.side, entry_paise: s.entry_paise, stop_paise: s.stop_paise,
        target_paise: s.target_paise, atr14_paise: s.atr14_paise,
      });
      const r = openPaperTrade(db, {
        strategy: DEFAULT_STRATEGY,
        symbol: s.symbol,
        exchange: s.exchange,
        entry_signal_scan_date: s.scan_date,
        scan_date: s.scan_date,
        scan_time: s.scan_time,
        entry_paise: s.entry_paise,
        stop_paise: s.stop_paise,
        target_paise: s.target_paise,
        atr14_paise: s.atr14_paise,
        mom_score: s.mom_score,
        open_mom_scores: openMomScores,
      });
      if (r.opened) {
        opened++;
        if (r.rotation) {
          rotations.push({
            out_symbol: r.rotation.out_symbol,
            in_symbol: r.rotation.in_symbol,
            out_mom: Number(r.rotation.out_mom_score.toFixed(3)),
            in_mom: Number(r.rotation.in_mom_score.toFixed(3)),
            mom_ratio: Number(r.rotation.mom_ratio.toFixed(3)),
            realized_pnl_rs: r.rotation.realized_pnl_paise / 100,
          });
          // Rotated-out symbols are no longer eligible for further rotation
          // in this same scan cycle.
          openMomScores.delete(r.rotation.out_symbol);
        }
      } else {
        openSkipReasons.push({ symbol: s.symbol, reason: r.reason ?? "unknown" });
      }
    }
  });
  tx();

  // Advance every open trade — check stops/targets/breakeven/time exits.
  const positionUpdate = updateOpenPaperTrades(db);
  // Also advance the legacy open_positions table so any reader that hasn't been
  // migrated to paper_trades stays consistent. Zero cost when the table is empty.
  updateOpenPositions(db);
  const activePositions = loadActivePaperTrades(db).map((p) => ({
    symbol: p.symbol,
    entry_date: p.entry_date,
    entry_paise: p.entry_paise,
    qty: p.qty,
    // Shares still held after any scale-out. Differs from qty on a part-booked
    // v2 position, and the unrealized figures are marked on this, not qty.
    qty_open: openQty(p),
    scaled_out: p.scaled_out,
    partial_exit_paise: p.partial_exit_paise,
    partial_pnl_paise: p.partial_pnl_paise,
    capital_committed_paise: p.capital_committed_paise,
    current_stop_paise: p.current_stop_paise,
    target_paise: p.target_paise,
    latest_close_paise: p.latest_close_paise,
    unrealized_pnl_paise: p.unrealized_pnl_paise,
    unrealized_pct: p.unrealized_pct,
    bars_held: p.bars_held,
    moved_to_breakeven: p.moved_to_breakeven,
  }));
  // Snapshot the equity curve once per scan (upsert on today's date, so multiple
  // fires per day just refresh the same row with the latest end-of-fire state).
  snapshotAccountHistory(db);
  const paperSummary = summarizePaper(db);

  const latestBarDates = new Set<string>();
  for (const u of universe) {
    const r = db
      .prepare(
        // Include intraday overlay so this display metric reflects what the
        // scanner actually evaluated on (not just the last bhavcopy date).
        `SELECT MAX(d) as mx FROM (
           SELECT MAX(trade_date) AS d FROM ohlc_daily WHERE instrument_token=?
           UNION ALL SELECT MAX(quote_date) AS d FROM ohlc_intraday WHERE instrument_token=?
         )`,
      )
      .get(u.instrument_token, u.instrument_token) as { mx: string | null };
    if (r.mx) latestBarDates.add(r.mx);
  }

  db.close();

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        scan_date: scanDate,
        regime,
        index_name: indexName,
        source: useScreenerScreen ? "screener_screen" : "index_universe",
        screener: screenerSource,
        universe: universe.length,
        quality_survivors: candidates.length,
        momentum_top_n: topN.length,
        sector_demean: demean.stats,
        signals_emitted: finalSignals.length,
        latest_bar_dates: [...latestBarDates],
        // The rule NEW entries open on, so the Telegram digest can state how a
        // signal will be managed instead of restating the recipe in Python and
        // going stale the next time the rule is versioned. Positions already
        // open may be on an older rule — active_positions[] carries the state
        // each one is actually in.
        exit_rule: {
          id: CURRENT_EXIT_RULE,
          description: describeExitRule(EXIT_RULES[CURRENT_EXIT_RULE]),
          stop_atr_mult: TECHNICAL_THRESHOLDS.STOP_ATR_MULT,
          target_r_multiple: TECHNICAL_THRESHOLDS.TARGET_R_MULTIPLE,
        },
        signals: finalSignals.map((s) => ({
          symbol: s.symbol,
          entry_rs: s.entry_paise / 100,
          stop_rs: s.stop_paise / 100,
          target_rs: s.target_paise / 100,
          risk_pct: (((s.entry_paise - s.stop_paise) / s.entry_paise) * 100).toFixed(2),
          reward_pct: (((s.target_paise - s.entry_paise) / s.entry_paise) * 100).toFixed(2),
          mom_rank: s.mom_rank,
          mom_score: s.mom_score !== null ? Number(s.mom_score.toFixed(3)) : null,
        })),
        position_update: positionUpdate,
        rotations,
        open_skips: openSkipReasons,
        paper_account: paperSummary
          ? {
              starting_cash_rs: paperSummary.starting_cash_paise / 100,
              current_cash_rs: paperSummary.current_cash_paise / 100,
              equity_rs: paperSummary.equity_paise / 100,
              return_pct: Number(paperSummary.total_return_pct.toFixed(2)),
              realized_pnl_rs: paperSummary.realized_pnl_paise / 100,
              unrealized_pnl_rs: paperSummary.unrealized_pnl_paise / 100,
              open_count: paperSummary.open_count,
              closed_count: paperSummary.closed_count,
              win_rate_pct: paperSummary.win_rate_pct !== null ? Number(paperSummary.win_rate_pct.toFixed(1)) : null,
            }
          : null,
        active_positions: activePositions.map((p) => ({
          symbol: p.symbol,
          entry_date: p.entry_date,
          entry_rs: p.entry_paise / 100,
          qty: p.qty,
          qty_open: p.qty_open,
          scaled_out: p.scaled_out,
          partial_exit_rs: p.partial_exit_paise !== null ? p.partial_exit_paise / 100 : null,
          partial_pnl_rs: p.partial_pnl_paise / 100,
          capital_committed_rs: p.capital_committed_paise / 100,
          stop_rs: p.current_stop_paise / 100,
          target_rs: p.target_paise / 100,
          latest_close_rs: p.latest_close_paise !== null ? p.latest_close_paise / 100 : null,
          unrealized_pnl_rs: p.unrealized_pnl_paise !== null ? Math.round(p.unrealized_pnl_paise / 100) : null,
          unrealized_pct: p.unrealized_pct !== null ? Number(p.unrealized_pct.toFixed(2)) : null,
          bars_held: p.bars_held,
          moved_to_breakeven: p.moved_to_breakeven,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
}

