import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";

/**
 * Freshness watchdog. Asks one question of each data feed the strategy depends
 * on: is the newest row in it older than the last trading day?
 *
 * WHY THIS IS SEPARATE FROM THE JOBS IT WATCHES: a cron job that never runs
 * writes no log, emits no exit code, and looks exactly like a quiet market. Both
 * daily jobs sat at mode 644 for weeks — cron could not execute them at all, so
 * there was nothing to notice. Every check here reads the DB, not a log, so a
 * missing job and a broken job produce the same alarm. It also re-reads each
 * job's log for its last success line, which distinguishes "ran and failed"
 * from "never ran" once the alarm has fired.
 *
 * Tolerances are in TRADING days, not calendar days, and are deliberately
 * generous: NSE publishes the bhavcopy around 18:00 IST and the bulk-deal report
 * later still, so a feed being one session behind in the early evening is normal
 * operation, not a fault. The alarm is for feeds that have stopped, not feeds
 * that are merely mid-day.
 *
 * Prints a human-readable report. Exit 0 = everything fresh, exit 1 = at least
 * one feed is stale. Nothing is sent anywhere; cron mails the output or the log
 * keeps it.
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const REPO = process.env.REPO_DIR ?? ".";

/** IST is UTC+5:30 year-round, so this shift needs no DST handling. */
function istDate(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Number of NSE sessions between two dates, counting weekdays only. Exchange
 * holidays are NOT excluded — we have no holiday calendar in the DB — so this
 * over-counts by one per holiday in the window. That is why the tolerances
 * below carry a session of slack: an over-count makes the check trip early,
 * which is the wrong direction for a watchdog nobody should learn to ignore.
 */
function sessionsBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return Number.NaN;
  let n = 0;
  const cur = new Date(from);
  while (cur < to) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

interface Check {
  /** What the reader should picture when this trips. */
  feed: string;
  table: string;
  dateColumn: string;
  /** Sessions the feed may lag before this is a fault. */
  maxLagSessions: number;
  /** The cron job responsible, for the "so fix this" half of the message. */
  job: string;
  why: string;
}

const CHECKS: Check[] = [
  {
    feed: "Daily price bars",
    table: "ohlc_daily",
    dateColumn: "trade_date",
    // 2: NSE publishes the bhavcopy ~18:00 IST, so during any session today's
    // bar legitimately does not exist yet, and the previous one may be the
    // newest until the evening refresh lands.
    maxLagSessions: 2,
    job: "scan-signals.sh (step 1) / refresh-nifty100-ohlc.ts",
    why: "Every signal, stop and target is computed off these bars. Stale bars mean the scanner is trading a market that has moved on without it.",
  },
  {
    feed: "Screener quality screen",
    table: "screener_screen_cache",
    dateColumn: "run_date",
    // 2: the screen refreshes on every scan, so falling two sessions behind
    // means four consecutive scans failed to refresh it.
    maxLagSessions: 2,
    job: "scan-signals.sh (step 3) / fetch-screener-screen.ts",
    why: "The quality gate IS this screen — it is the entire difference between a positive and negative expectancy in the backtest. When it freezes the scanner keeps reporting success against a stale universe, which is exactly how a two-week outage went unnoticed. Fix: rotate SCREENER_CSRF_TOKEN and SCREENER_SESSION_ID in .env.",
  },
  {
    feed: "Universe snapshot",
    table: "universe_snapshot",
    dateColumn: "snapshot_date",
    maxLagSessions: 2,
    job: "snapshot-universe.sh",
    why: "A snapshot can only be taken in the present. Each missed weekday is index membership lost for good, and it comes back later as survivorship bias in every backtest over that window.",
  },
  {
    feed: "Bulk deals",
    table: "bulk_deals",
    dateColumn: "deal_date",
    // 4: NSE's bulk-deal report lags the session, and quiet days genuinely have
    // no qualifying block trades at all — so a gap here is weaker evidence of
    // breakage than a gap in the other feeds.
    maxLagSessions: 4,
    job: "refresh-bulk-deals.sh",
    why: "Institutional accumulation signal. Least critical of the four: a gap may be a genuinely quiet stretch rather than a broken fetch.",
  },
];

interface Result {
  feed: string;
  newest: string | null;
  lag: number;
  stale: boolean;
  detail: string;
  job: string;
  why: string;
}

interface JobRun {
  ts: string;
  job: string;
  verdict: string;
  steps: string;
}

/**
 * Every run's verdict, from the shared journal cron_finish appends to.
 *
 * This exists because a non-zero exit code goes nowhere on this host: cron's only
 * way to report a failure is to mail the output, and there is no sendmail and
 * postfix is inactive, so that mail is discarded. The journal is the durable
 * substitute.
 */
function readJobRuns(): JobRun[] {
  const path = `${REPO}/logs/cron-status.tsv`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [ts, job, verdict, steps] = l.split("\t");
      return { ts: ts ?? "", job: job ?? "", verdict: verdict ?? "", steps: steps ?? "" };
    });
}

function lastLogVerdict(job: string): string {
  const path = `${REPO}/logs/${job}.log`;
  if (!existsSync(path)) {
    return `no log at logs/${job}.log — this job has never run`;
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  // Walk backwards for the harness's own verdict line, which is the only line
  // that distinguishes a successful run from one that merely started.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ (OK|FAILED)[: ]/.test(lines[i]) || / (OK|FAILED) ===/.test(lines[i])) {
      return lines[i].trim();
    }
  }
  return `log exists but has no completed run recorded (${lines.length} lines)`;
}

function main(): number {
  const today = istDate();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const results: Result[] = [];

  for (const c of CHECKS) {
    // A missing table is a real finding, not a crash: db/schema.sql lost the
    // bulk_deals DDL entirely at one point and the writer failed silently.
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(c.table) as unknown;
    if (!exists) {
      results.push({
        feed: c.feed,
        newest: null,
        lag: Number.NaN,
        stale: true,
        detail: `table ${c.table} does not exist`,
        job: c.job,
        why: c.why,
      });
      continue;
    }

    const row = db
      .prepare(`SELECT MAX(${c.dateColumn}) AS newest FROM ${c.table}`)
      .get() as { newest: string | null };
    const newest = row?.newest ?? null;

    if (!newest) {
      results.push({
        feed: c.feed,
        newest: null,
        lag: Number.NaN,
        stale: true,
        detail: `${c.table} is empty`,
        job: c.job,
        why: c.why,
      });
      continue;
    }

    const lag = sessionsBetween(newest, today);
    const stale = !Number.isFinite(lag) || lag > c.maxLagSessions;
    results.push({
      feed: c.feed,
      newest,
      lag,
      stale,
      detail: `newest ${newest}, ${lag} session(s) behind ${today} (tolerance ${c.maxLagSessions})`,
      job: c.job,
      why: c.why,
    });
  }

  db.close();

  const stale = results.filter((r) => r.stale);
  const out: string[] = [];
  out.push(`Data freshness — ${today} IST`);
  out.push("");
  for (const r of results) {
    out.push(`${r.stale ? "STALE" : "ok   "}  ${r.feed.padEnd(24)} ${r.detail}`);
  }

  if (stale.length > 0) {
    out.push("");
    out.push(`${stale.length} feed(s) stale:`);
    for (const r of stale) {
      out.push("");
      out.push(`  ${r.feed}: ${r.detail}`);
      out.push(`    Owner: ${r.job}`);
      out.push(`    Last run: ${lastLogVerdict(r.job.split(" ")[0].replace(/\.sh$/, ""))}`);
      out.push(`    Why it matters: ${r.why}`);
    }
  }

  // Second, independent question: did any job report a failure today? A feed can
  // be perfectly fresh while the job that fills it is failing on a later step,
  // and the exit code that said so was discarded by cron.
  const runs = readJobRuns();
  const todayRuns = runs.filter((r) => r.ts.startsWith(today));
  const failedToday = todayRuns.filter((r) => r.verdict === "FAILED");

  out.push("");
  if (runs.length === 0) {
    out.push("Job runs today: none recorded — logs/cron-status.tsv does not exist yet.");
  } else if (todayRuns.length === 0) {
    out.push(
      `Job runs today: NONE. Last recorded run of any job was ${runs[runs.length - 1].ts} ` +
        `(${runs[runs.length - 1].job}). If today is a weekday, cron is not firing at all.`,
    );
  } else {
    out.push(
      `Job runs today: ${todayRuns.length} (${todayRuns.length - failedToday.length} ok, ${failedToday.length} failed)`,
    );
    for (const r of failedToday) {
      out.push(`  FAILED  ${r.ts}  ${r.job}  —  ${r.steps}`);
    }
  }

  const failing = stale.length > 0 || failedToday.length > 0;
  out.push("");
  out.push(
    failing
      ? `Freshness check FAILED — ${stale.length} of ${results.length} feeds stale, ` +
          `${failedToday.length} job failure(s) today.`
      : `Freshness check passed — all ${results.length} feeds current, no job failures today.`,
  );

  process.stdout.write(out.join("\n") + "\n");
  return failing ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stdout.write(
    `Freshness check FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
