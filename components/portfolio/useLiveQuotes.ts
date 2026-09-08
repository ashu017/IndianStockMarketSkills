"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Fetches current prices for a set of symbols from /api/quotes after the page
 * has painted.
 *
 * WHY AFTER PAINT AND NOT DURING RENDER: the NSE round-trip is a second or two
 * for a handful of symbols and can fail outright. Blocking the server render on
 * it would trade a page that is always fast and sometimes slightly stale for one
 * that is always slow and sometimes broken. So the page paints with the marks
 * already in the database, then corrects them, and says which it is showing.
 *
 * A failure here is not an error state for the page — the end-of-day marks it
 * rendered with are still perfectly good numbers, just older. Callers surface
 * `state` as a freshness label, not as an alert.
 */

export interface LiveQuote {
  ltp_paise: number;
  perc_change: number | null;
  fetched_at: string;
  /** Served from a recent ohlc_intraday row rather than a fresh network call. */
  cached: boolean;
}

export type LiveQuoteMap = Record<string, LiveQuote>;

export type LiveQuoteState = "idle" | "loading" | "ok" | "error";

export interface UseLiveQuotes {
  quotes: LiveQuoteMap;
  state: LiveQuoteState;
  /** Oldest fetch time among the quotes returned — the honest "as of". Reporting
   *  the newest would overstate freshness for a mixed fresh/reused batch. */
  asOf: string | null;
  /** Symbols asked for that came back without a price. Empty until a request has
   *  actually completed, so it never reads as "everything is missing" mid-flight. */
  missing: string[];
  error: string | null;
  refresh: () => void;
}

export function useLiveQuotes(symbols: string[]): UseLiveQuotes {
  // The caller passes a fresh array on every render, so everything downstream
  // hangs off this primitive rather than the array identity — otherwise the
  // effect below refires forever. useCallback compares strings by value, which
  // is what makes `load` stable across renders.
  const key = Array.from(new Set(symbols)).sort().join(",");

  const [quotes, setQuotes] = useState<LiveQuoteMap>({});
  // Starts at "loading" because the effect below always fires a request on
  // mount. Setting it inside the effect instead would be a synchronous setState
  // in an effect body — a cascading render, and what react-hooks/set-state-in-effect
  // exists to stop. Nothing before the first `await` in load() touches state, so
  // the effect stays clean.
  const [state, setState] = useState<LiveQuoteState>(key ? "loading" : "ok");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!key) return;
      try {
        const res = await fetch("/api/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: key.split(",") }),
          signal,
        });
        const body = (await res.json()) as {
          status?: string;
          message?: string;
          quotes?: LiveQuoteMap;
        };
        if (!res.ok || body.status !== "ok") {
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        setQuotes(body.quotes ?? {});
        setError(null);
        setState("ok");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [key],
  );

  useEffect(() => {
    const ac = new AbortController();
    // react-hooks/set-state-in-effect cannot see through an async function, so it
    // reads load() as a synchronous setState. Everything load() sets happens after
    // its `await fetch(...)`, which is the sanctioned shape: subscribe to an
    // external system in an effect, set state from the callback. The abort on
    // cleanup is what keeps a superseded request from landing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const asOf = useMemo(() => {
    const stamps = Object.values(quotes).map((q) => q.fetched_at).filter(Boolean);
    if (stamps.length === 0) return null;
    return stamps.reduce((oldest, s) => (s < oldest ? s : oldest));
  }, [quotes]);

  const missing = useMemo(() => {
    if (!key || state !== "ok") return [];
    return key.split(",").filter((s) => quotes[s] === undefined);
  }, [key, quotes, state]);

  // Setting "loading" here rather than inside load() is deliberate: this runs
  // from a click, where a synchronous setState is exactly right.
  const refresh = () => {
    if (!key) return;
    setState("loading");
    void load();
  };

  return { quotes, state, asOf, missing, error, refresh };
}
