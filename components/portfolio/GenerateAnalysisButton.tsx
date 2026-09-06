"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Triggers on-demand AI analysis for one stock via POST /api/analysis/[symbol].
 *
 * The route shells out to the `claude -p` CLI, so a run takes tens of seconds —
 * hence an explicit button rather than generating during render. On success we
 * router.refresh() so the server component re-reads the `analysis` row and the
 * narrative appears in place.
 *
 * `hasAnalysis` picks the label: "Generate analysis" when the card is empty,
 * "Regenerate" when a narrative already exists (which forces a fresh run, since
 * the script otherwise skips a stock already analyzed today).
 */
export default function GenerateAnalysisButton({
  symbol,
  hasAnalysis,
}: {
  symbol: string;
  hasAnalysis: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const qs = hasAnalysis ? "?force=1" : "";
      const res = await fetch(`/api/analysis/${encodeURIComponent(symbol)}${qs}`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // 409 means fundamentals are missing — actionable, so surface the hint.
        setError(
          res.status === 409
            ? "No fundamentals yet — use “Refresh data” on the Verdict card first."
            : (body?.message ?? `Failed (HTTP ${res.status})`),
        );
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        onClick={run}
        disabled={loading}
        className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground/80 hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
      >
        {loading
          ? "Generating… (up to a minute)"
          : hasAnalysis
            ? "Regenerate analysis"
            : "Generate analysis"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

