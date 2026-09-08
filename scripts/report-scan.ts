/**
 * Formats scan-nifty100-signals.ts JSON into the plain-text digest, and decides
 * whether the run is trustworthy.
 *
 * WHY THIS EXISTS: this summary used to be produced by a language model reading
 * the scanner's JSON on a schedule. That worked, but it made a deterministic
 * pipeline depend on an Amazon Bedrock SigV4 credential that expires in hours —
 * so the scan stopped whenever the token lapsed, for reasons that had nothing to
 * do with the market. Formatting JSON into fixed lines needs no model.
 *
 * Reads the JSON from a file path in argv[2], or from stdin when none is given
 * (the cron wrapper passes a path, since it already captured the scanner's
 * stdout to a temp file). Writes the digest on stdout. Exit codes:
 *   0  scan is sound
 *   1  scanner reported status:"error", or the JSON was unparseable
 *   3  scan ran but its inputs are stale (see the STALE lines in the output)
 *
 * Exit 3 is the whole point of the staleness half. USE_SCREENER_SCREEN=1 makes
 * the scanner take the NEWEST row in screener_screen_cache with no date bound,
 * so once the Screener cookies expire the scan keeps succeeding against a frozen
 * screen and reports status:"ok" — that went unnoticed for two weeks once. A
 * stale screen is not a scanner bug and cannot be caught by the scanner's own
 * exit code, so it is caught here and made to fail loudly.
 */

import { readFile } from "node:fs/promises";

const MAX_SCREEN_AGE_DAYS = 1; // yesterday's screen is fine pre-open; older is not
const MAX_BAR_AGE_DAYS = 4; // a long weekend plus one exchange holiday

/** IST calendar date. IST is UTC+5:30 with no DST, so the shift is unconditional. */
function istDate(d = new Date()): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function istTimeLabel(d = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ist.getUTCDay()];
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${weekday} ${hh}:${mm} IST`;
}

/** Whole days between two YYYY-MM-DD dates. Both are parsed as UTC midnight, so
 * this is a calendar-day difference and never off-by-one from a timezone. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Calendar days back to the most recent weekday, ignoring exchange holidays —
 * which is why MAX_BAR_AGE_DAYS carries slack rather than this being exact. */
function lastTradingDay(todayIso: string): string {
  const d = new Date(`${todayIso}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function rs(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `Rs${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function signed(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "n/a";
  return `${n >= 0 ? "+" : ""}${n}${suffix}`;
}

function readInput(): Promise<string> {
  const path = process.argv[2];
  if (path) return readFile(path, "utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<number> {
  const raw = (await readInput()).trim();
  const out: string[] = [];
  const stale: string[] = [];

  if (!raw) {
    process.stdout.write("Stock scan FAILED — scanner produced no output at all.\n");
    return 1;
  }

  // The scanner prints one JSON document, but a stray warning on stdout would
  // wreck a bare JSON.parse. Take the outermost braces and parse that.
  let data: Record<string, unknown>;
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last <= first) throw new Error("no JSON object found");
    data = JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
  } catch (err) {
    process.stdout.write(
      `Stock scan FAILED — could not parse scanner output: ${err instanceof Error ? err.message : String(err)}\n` +
        `First 400 chars of what it printed:\n${raw.slice(0, 400)}\n`,
    );
    return 1;
  }

  if (data.status === "error") {
    process.stdout.write(`Stock scan FAILED — scanner error: ${String(data.message ?? "(no message)")}\n`);
    return 1;
  }

  const today = istDate();
  const screener = data.screener as { run_date: string; total_rows: number } | null;
  const regime = (data.regime ?? {}) as { bull?: boolean; reason?: string };
  const latestBars = (data.latest_bar_dates ?? []) as string[];
  const signals = (data.signals ?? []) as Record<string, unknown>[];
  const active = (data.active_positions ?? []) as Record<string, unknown>[];
  const rotations = (data.rotations ?? []) as Record<string, unknown>[];
  const pu = (data.position_update ?? {}) as Record<string, number>;
  const paper = data.paper_account as Record<string, number | null> | null;

  // Which universe actually got used. The scanner reports this itself in
  // `source`; state it explicitly rather than inferring, because the whole
  // reason this line exists is that the choice used to be invisible.
  const usedScreen = data.source === "screener_screen";
  const universeLabel = usedScreen
    ? `Screener quality screen (run ${screener?.run_date ?? "unknown"})`
    : `${String(data.index_name ?? "index")} fallback — NOT the quality screen`;

  if (!usedScreen) {
    stale.push(
      "STALE: this scan did NOT use the Screener quality screen. Signals came from " +
        "the raw index, which has no fundamental filter at all.",
    );
  } else if (screener?.run_date) {
    const age = daysBetween(screener.run_date, today);
    if (Number.isFinite(age) && age > MAX_SCREEN_AGE_DAYS) {
      stale.push(
        `STALE: Screener screen is ${age} days old (run ${screener.run_date}, today ${today}). ` +
          "The cookies in .env have almost certainly expired — rotate SCREENER_CSRF_TOKEN " +
          "and SCREENER_SESSION_ID from a logged-in browser session. Until then every scan " +
          "silently re-uses this frozen screen.",
      );
    }
  }

  // Price data. Bars are the other input that can quietly freeze: NSE publishes
  // the bhavcopy around 18:00 IST, so an early-evening run legitimately sees
  // yesterday's date, and the tolerance covers a weekend plus a holiday.
  if (latestBars.length === 0) {
    stale.push("STALE: scanner reported no bar dates at all — OHLC data is missing.");
  } else {
    const newest = [...latestBars].sort().reverse()[0];
    const expected = lastTradingDay(today);
    const age = daysBetween(newest, today);
    if (Number.isFinite(age) && age > MAX_BAR_AGE_DAYS) {
      stale.push(
        `STALE: newest price bar is ${newest} (${age} days old; last trading day was ` +
          `${expected}). scripts/refresh-nifty100-ohlc.ts is not landing data.`,
      );
    }
  }

  out.push(`Stock signals — ${istTimeLabel()}`);
  out.push(`Universe: ${universeLabel}`);
  out.push(`Regime: ${regime.bull ? "bull" : "bear"} (${regime.reason ?? "no reason given"})`);
  out.push(
    `Screener passed ${screener?.total_rows ?? 0} · Scannable ${String(data.universe ?? 0)} · ` +
      `Signals ${String(data.signals_emitted ?? 0)}`,
  );
  out.push(`Data as of: ${latestBars[0] ?? "unknown"}`);

  if (regime.bull === false) out.push("Bear regime — long signals paused.");

  if (signals.length > 0) {
    out.push("", "[Signals]");
    for (const s of signals) {
      out.push(`[BUY] ${String(s.symbol)}  (mom rank ${String(s.mom_rank)}/30)`);
      out.push(
        `  Entry <= ${rs(s.entry_rs as number)}   ` +
          `Target ${rs(s.target_rs as number)} (+${String(s.reward_pct)}%)   ` +
          `Stop ${rs(s.stop_rs as number)} (-${String(s.risk_pct)}%)`,
      );
    }
  }

  if (active.length > 0) {
    out.push("", "[Active positions]");
    for (const p of active) {
      let line =
        `${String(p.symbol)} · entered ${String(p.entry_date)} at ${rs(p.entry_rs as number)}  ·  ` +
        `now ${rs(p.latest_close_rs as number | null)} (${signed(p.unrealized_pct as number | null, "%")})  ·  ` +
        `stop ${rs(p.stop_rs as number)}  ·  ${String(p.bars_held)}d held`;
      if (p.moved_to_breakeven === true) line += "  · stop moved to breakeven";
      if (p.scaled_out === true) line += `  · scaled out at ${rs(p.partial_exit_rs as number | null)}`;
      out.push(line);
    }
  }

  if ((pu.stopped ?? 0) > 0 || (pu.target_hit ?? 0) > 0 || (pu.time_exit ?? 0) > 0) {
    out.push("", "[Just closed since last scan]");
    out.push(`${pu.stopped ?? 0} stopped, ${pu.target_hit ?? 0} hit target, ${pu.time_exit ?? 0} timed out`);
  }

  if (rotations.length > 0) {
    out.push("", "[Rotations this scan]");
    for (const r of rotations) {
      out.push(
        `${String(r.out_symbol)} (mom ${String(r.out_mom)}) -> ${String(r.in_symbol)} ` +
          `(mom ${String(r.in_mom)}, ratio ${String(r.mom_ratio)}x)  P&L ${rs(r.realized_pnl_rs as number)}`,
      );
    }
  }

  if (paper) {
    out.push("", "[Paper account]");
    out.push(
      `Equity ${rs(paper.equity_rs)} (${signed(paper.return_pct, "%")})  ·  ` +
        `cash ${rs(paper.current_cash_rs)}  ·  realized ${rs(paper.realized_pnl_rs)}  ·  ` +
        `unrealized ${rs(paper.unrealized_pnl_rs)}`,
    );
    out.push(
      `${paper.open_count ?? 0} open · ${paper.closed_count ?? 0} closed · ` +
        `win rate ${paper.win_rate_pct == null ? "n/a" : `${paper.win_rate_pct}%`}`,
    );
  }

  if (stale.length > 0) {
    out.push("", "[!! STALE INPUTS — TREAT THESE SIGNALS AS UNRELIABLE !!]");
    for (const s of stale) out.push(s);
  }

  out.push(
    "",
    `Stock scan ${stale.length > 0 ? "COMPLETE BUT STALE" : "complete"} — ` +
      `${String(data.signals_emitted ?? 0)} signals, ${active.length} active positions, ` +
      `regime ${regime.bull ? "bull" : "bear"}, universe ${usedScreen ? "screen" : "fallback"}.`,
  );

  process.stdout.write(out.join("\n") + "\n");
  return stale.length > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stdout.write(`Stock scan FAILED — reporter crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
