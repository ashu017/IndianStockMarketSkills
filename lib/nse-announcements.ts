/**
 * NSE's own corporate-announcements API — the authoritative source for the
 * EXACT timestamp a company filed its quarterly results, as opposed to
 * Screener's quarterly table which only labels a quarter by its END date
 * (e.g. "Jun 2026"), not when results were actually announced. This is the
 * load-bearing fact for any earnings-reaction study: results are filed
 * AFTER market close (every sampled RELIANCE filing was 16:00–20:00+ IST),
 * so the market's first real chance to react is the NEXT trading day, not
 * the announcement day itself.
 *
 * Needs a session-cookie warmup (NSE blocks direct API calls without first
 * hitting a real page) — verified live against RELIANCE, returning history
 * back to 2004 in a single call, no pagination needed at this scale.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WARMUP_URL = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export interface AnnouncementRow {
  an_dt: string; // "21-Aug-2026 16:42:17" IST, as NSE returns it
  desc: string;
  sort_date: string; // "2026-08-21 16:42:17"
}

/** Matches the older ("Audited financial results") and mid-period ("Financial
 * Result Updates", "Integrated Filing- Financial") labels NSE has used —
 * confirmed by sampling RELIANCE's full history back to 2005. */
const FINANCIAL_RESULT_RE = /financial result/i;

/**
 * NSE quietly stopped using a "financial result"-labeled announcement type
 * for several companies starting around the quarter ending Mar 2025 —
 * results now show up only as an "Outcome of Board Meeting" filing. That
 * label alone is useless (boards meet for buybacks, appointments, and dozens
 * of other things), so it's only trusted as a results announcement when it
 * co-occurs on the SAME calendar date as a corroborating filing type —
 * verified against 2018-2024 dates where this co-occurrence pattern AND the
 * old "Financial Result Updates" label independently point at the same date.
 * "Investor Presentation" is the strongest corroborator (RELIANCE); some
 * companies (e.g. TCS) don't file one and instead pair the board-meeting
 * outcome with "Press Release" + "Dividend" — accepting either as
 * corroboration trades a small false-positive risk (a board meeting for an
 * unrelated reason that also happens to ship a press release the same day)
 * for meaningfully better quarter coverage; this is a heuristic, not a
 * certain classifier, and callers should treat low-confidence matches as
 * exactly that.
 */
const BOARD_MEETING_RE = /outcome of board meeting/i;
const CORROBORATING_RE = /investor presentation|press release/i;

interface NseSession {
  cookieHeader: string;
}

async function warmupSession(): Promise<NseSession> {
  const res = await fetch(WARMUP_URL, { headers: { "User-Agent": UA } });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
  return { cookieHeader };
}

/** All likely results-announcement filings for a symbol, oldest → newest.
 * Merges direct label matches with the board-meeting+investor-presentation
 * co-occurrence heuristic (see BOARD_MEETING_RE's comment), deduped by date —
 * when a date has both signals, the direct label match's own timestamp wins
 * since it's the more specific of the two. */
export async function fetchFinancialResultAnnouncements(symbol: string): Promise<AnnouncementRow[]> {
  const session = await warmupSession();
  const res = await fetch(
    `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: WARMUP_URL,
        Cookie: session.cookieHeader,
      },
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as AnnouncementRow[];

  const byDate = new Map<string, AnnouncementRow[]>();
  for (const d of data) {
    const date = (d.sort_date ?? "").slice(0, 10);
    if (!date) continue;
    const arr = byDate.get(date);
    if (arr) arr.push(d);
    else byDate.set(date, [d]);
  }

  const picked = new Map<string, AnnouncementRow>(); // date -> chosen row
  for (const [date, rows] of byDate) {
    const direct = rows.find((r) => FINANCIAL_RESULT_RE.test(r.desc ?? ""));
    if (direct) {
      picked.set(date, direct);
      continue;
    }
    const hasBoard = rows.some((r) => BOARD_MEETING_RE.test(r.desc ?? ""));
    const hasCorroborating = rows.some((r) => CORROBORATING_RE.test(r.desc ?? ""));
    if (hasBoard && hasCorroborating) {
      const board = rows.find((r) => BOARD_MEETING_RE.test(r.desc ?? ""))!;
      picked.set(date, board);
    }
  }

  return [...picked.values()].sort((a, b) => a.sort_date.localeCompare(b.sort_date));
}

/**
 * Matches each quarter-end date to the nearest financial-result announcement
 * that falls AFTER it, within a plausible filing window (companies must file
 * within 45 days of quarter-end per SEBI LODR, but real-world filings run
 * later — widen to 75 days to be safe rather than silently dropping a
 * legitimate late filing).
 */
export function matchAnnouncementToQuarter(
  quarterEndDate: string,
  announcements: AnnouncementRow[],
  maxDaysAfter = 75,
): string | null {
  const qEnd = new Date(quarterEndDate).getTime();
  let best: { ts: string; gapDays: number } | null = null;
  for (const a of announcements) {
    const ts = a.sort_date.replace(" ", "T");
    const t = new Date(ts).getTime();
    const gapDays = (t - qEnd) / 86_400_000;
    if (gapDays < 0 || gapDays > maxDaysAfter) continue;
    if (!best || gapDays < best.gapDays) best = { ts: a.sort_date, gapDays };
  }
  return best?.ts ?? null;
}

