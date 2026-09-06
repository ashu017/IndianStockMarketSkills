import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

/**
 * Generate the AI analysis (narrative + BUY/SELL/HOLD verdict) for one stock and
 * persist it into the `analysis` table, so the deep-dive page's Analysis card
 * populates.
 *
 * Why this script exists: `refresh-single-stock.ts` fetches fundamentals but never
 * writes `analysis` — only a Claude reasoning pass can produce the narrative. That
 * step previously lived exclusively in the `batch-analyze-fundamentals` skill, which
 * requires an interactive Claude session, so nothing wrote `analysis` outside a cron
 * that no longer invoked it. This makes the generation self-serve: it shells out to
 * the `claude -p` CLI (already authenticated on this host; no API key needed).
 *
 * The verdict is grounded ONLY in rows already in the DB — this script performs no
 * network fetch. Run `refresh-single-stock.ts` first if fundamentals are stale.
 *
 * ISIN choice matters. A symbol can carry both a real ISIN and a synthetic
 * `SYM-<symbol>` fallback across different index_universe rows. The UI resolves via
 * getUniverseStock()'s index priority, so we MUST key the analysis row on the same
 * ISIN or the generated row will never be displayed. resolveIsin() mirrors that
 * priority exactly.
 *
 * Env:
 *   SYMBOL=<sym>                (required)
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   FORCE=1                     regenerate even if analysis exists for today
 *   CLAUDE_BIN=<path>           override the CLI path
 *   ANALYSIS_TIMEOUT_MS=120000  per-stock LLM budget
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/home/ashunsah/.toolbox/bin/claude";
const TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS ?? "120000");
const MODEL_VERSION = "claude-cli";
const PROMPT_VERSION = "generate-analysis-v1";

/** Mirrors lib/db/index.ts getUniverseStock() index priority. */
const INDEX_PRIORITY = ["NIFTY 200", "NIFTY 100", "NIFTY 500", "AD-HOC"];

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

interface UniverseRow {
  symbol: string;
  exchange: string;
  isin: string;
  company: string | null;
  sector: string | null;
}

function resolveUniverseRow(db: Database.Database, symbol: string): UniverseRow | null {
  const sel = db.prepare(
    `SELECT symbol, exchange, isin, company, sector
     FROM index_universe WHERE index_name=? AND symbol=? LIMIT 1`,
  );
  for (const idx of INDEX_PRIORITY) {
    const r = sel.get(idx, symbol) as UniverseRow | undefined;
    if (r) return r;
  }
  return (
    (db
      .prepare(
        `SELECT symbol, exchange, isin, company, sector
         FROM index_universe WHERE symbol=? LIMIT 1`,
      )
      .get(symbol) as UniverseRow | undefined) ?? null
  );
}

interface Fundamentals {
  pe: number | null; pb: number | null; roe: number | null; roce: number | null;
  debt_equity: number | null; sales_growth_3y: number | null;
  profit_growth_3y: number | null; div_yield: number | null;
  market_cap: number | null; promoter_holding: number | null;
  as_of_date: string | null; source: string | null; source_url: string | null;
}

/**
 * Newest non-null value per column across as_of_date rows — the same coalescing
 * lib/verdict.ts uses, so the narrative cites the same numbers the verdict card does.
 */
function loadFundamentals(db: Database.Database, isin: string): Fundamentals | null {
  const cols = [
    "pe", "pb", "roe", "roce", "debt_equity", "sales_growth_3y",
    "profit_growth_3y", "div_yield", "market_cap", "promoter_holding",
    "source", "source_url",
  ];
  const picks = cols
    .map(
      (c) =>
        `(SELECT ${c} FROM fundamentals WHERE isin=@isin AND ${c} IS NOT NULL ` +
        `ORDER BY as_of_date DESC LIMIT 1) AS ${c}`,
    )
    .join(",\n       ");
  const row = db
    .prepare(
      `SELECT
       (SELECT as_of_date FROM fundamentals WHERE isin=@isin ORDER BY as_of_date DESC LIMIT 1) AS as_of_date,
       ${picks}`,
    )
    .get({ isin }) as Fundamentals | undefined;
  if (!row || row.as_of_date === null) return null;
  return row;
}

interface PeerRow {
  peer_symbol: string; peer_company: string | null;
  pe: number | null; roe: number | null; roce: number | null; sales_growth: number | null;
}

function loadPeers(db: Database.Database, isin: string): PeerRow[] {
  const latest = db
    .prepare(`SELECT MAX(as_of_date) AS d FROM peers WHERE isin=?`)
    .get(isin) as { d: string | null };
  if (!latest.d) return [];
  return db
    .prepare(
      `SELECT peer_symbol, peer_company, pe, roe, roce, sales_growth
       FROM peers WHERE isin=? AND as_of_date=? ORDER BY peer_symbol`,
    )
    .all(isin, latest.d) as PeerRow[];
}

function fmt(v: number | null, unit = ""): string {
  return v === null || !Number.isFinite(v) ? "n/a" : `${v}${unit}`;
}

function buildPrompt(u: UniverseRow, f: Fundamentals, peers: PeerRow[]): string {
  const peerLines = peers.length
    ? peers
        .map(
          (p) =>
            `  ${p.peer_symbol}: PE ${fmt(p.pe)}, ROE ${fmt(p.roe, "%")}, ` +
            `ROCE ${fmt(p.roce, "%")}, sales growth ${fmt(p.sales_growth, "%")}`,
        )
        .join("\n")
    : "  (no peer data available)";

  // Market cap is stored in paise; show crore so the model reads a familiar scale.
  const mcapCr =
    f.market_cap === null ? "n/a" : `Rs ${Math.round(f.market_cap / 1e9).toLocaleString("en-IN")} Cr`;

  return `You are a sector-aware equity analyst for Indian stocks. Judge ONE stock from the data below and return a verdict.

STOCK: ${u.symbol} (${u.exchange})${u.company ? ` — ${u.company}` : ""}
SECTOR: ${u.sector ?? "unknown"}
FUNDAMENTALS AS OF: ${f.as_of_date}
  P/E: ${fmt(f.pe)}
  P/B: ${fmt(f.pb)}
  ROE: ${fmt(f.roe, "%")}
  ROCE: ${fmt(f.roce, "%")}
  Debt/Equity: ${fmt(f.debt_equity)}
  Sales growth 3y: ${fmt(f.sales_growth_3y, "%")}
  Profit growth 3y: ${fmt(f.profit_growth_3y, "%")}
  Dividend yield: ${fmt(f.div_yield, "%")}
  Promoter holding: ${fmt(f.promoter_holding, "%")}
  Market cap: ${mcapCr}
PEERS:
${peerLines}

RULES
- Weigh Quality (ROE/ROCE/debt/growth) against Valuation (PE/PB vs the peers above).
- Be SECTOR-AWARE: judge banks/NBFCs on ROE and growth, NOT debt/equity (deposits are not debt). Judge IT on margins and growth. Judge cyclicals and commodities on where they sit in the cycle.
- Use ONLY the numbers above. Never invent a figure. Where a value is "n/a", say the data is missing rather than guessing, and lower your confidence.
- confidence must be "Low" when several key metrics are n/a or the ratios are distorted (e.g. post-demerger).
- narrative: ONE sentence, at most 240 characters, citing specific numbers. No preamble, no disclaimer.

Return ONLY a single-line JSON object, no markdown fence, no other text:
{"verdict":"BUY|SELL|HOLD","confidence":"Low|Medium|High","narrative":"..."}`;
}

interface LlmVerdict {
  verdict: "BUY" | "SELL" | "HOLD";
  confidence: "Low" | "Medium" | "High";
  narrative: string;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Prompt goes on stdin, not argv — fundamentals text can exceed ARG_MAX limits
    // and would otherwise need shell quoting.
    const proc = spawn(CLAUDE_BIN, ["-p"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (err += String(d)));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn ${CLAUDE_BIN}: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(out);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/** Pull the JSON object out of the CLI's reply and validate every field. */
function parseVerdict(raw: string): LlmVerdict {
  const text = raw.trim();
  // Tolerate a ```json fence or surrounding prose by taking the widest {...} span.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in LLM reply: ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`LLM reply is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const o = parsed as Record<string, unknown>;
  const verdict = o.verdict;
  const confidence = o.confidence;
  const narrative = o.narrative;
  if (verdict !== "BUY" && verdict !== "SELL" && verdict !== "HOLD") {
    throw new Error(`bad verdict: ${JSON.stringify(verdict)}`);
  }
  if (confidence !== "Low" && confidence !== "Medium" && confidence !== "High") {
    throw new Error(`bad confidence: ${JSON.stringify(confidence)}`);
  }
  if (typeof narrative !== "string" || narrative.trim() === "") {
    throw new Error("narrative missing or empty");
  }
  return { verdict, confidence, narrative: narrative.trim() };
}

async function main(): Promise<void> {
  const symbol = process.env.SYMBOL;
  if (!symbol) throw new Error("SYMBOL env is required");
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const force = process.env.FORCE === "1";
  const asOfDate = istDate();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  try {
    const u = resolveUniverseRow(db, symbol);
    if (!u) {
      throw new Error(
        `${symbol} not found in index_universe — run refresh-single-stock.ts first to seed it`,
      );
    }

    if (!force) {
      const existing = db
        .prepare(`SELECT verdict, generated_at FROM analysis WHERE isin=?`)
        .get(u.isin) as { verdict: string; generated_at: string } | undefined;
      if (existing && existing.generated_at.slice(0, 10) === asOfDate) {
        process.stdout.write(
          JSON.stringify({
            status: "skipped",
            reason: "already analyzed today (use FORCE=1 to regenerate)",
            symbol: u.symbol, isin: u.isin, verdict: existing.verdict,
          }) + "\n",
        );
        return;
      }
    }

    const f = loadFundamentals(db, u.isin);
    if (!f) {
      throw new Error(
        `no fundamentals rows for ${symbol} (isin ${u.isin}) — run refresh-single-stock.ts first`,
      );
    }
    const peers = loadPeers(db, u.isin);

    const llm = parseVerdict(await runClaude(buildPrompt(u, f, peers)));

    // Re-persist the fundamentals we reasoned over under today's as_of_date, so the
    // analysis row and the numbers behind it stay auditable together.
    const payload: AnalysisPayload = {
      isin: u.isin,
      asOfDate,
      fundamentals: {
        pe: f.pe, pb: f.pb, roe: f.roe, roce: f.roce,
        debt_equity: f.debt_equity, sales_growth_3y: f.sales_growth_3y,
        profit_growth_3y: f.profit_growth_3y, div_yield: f.div_yield,
        market_cap: f.market_cap, promoter_holding: f.promoter_holding,
        source: f.source, source_url: f.source_url,
        fetch_status: "ok",
      },
      extra: [],
      peers,
      analysis: {
        narrative: llm.narrative,
        verdict: llm.verdict,
        confidence: llm.confidence,
        model_version: MODEL_VERSION,
        prompt_version: PROMPT_VERSION,
      },
    };
    writeAnalysis(db, payload);

    process.stdout.write(
      JSON.stringify({
        status: "ok",
        symbol: u.symbol, isin: u.isin, asOfDate,
        verdict: llm.verdict, confidence: llm.confidence, narrative: llm.narrative,
        peers_used: peers.length, fundamentals_as_of: f.as_of_date,
      }) + "\n",
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
