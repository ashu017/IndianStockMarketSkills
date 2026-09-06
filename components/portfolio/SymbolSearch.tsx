"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Search input for the home page. Autocomplete against index_universe;
 * pressing Enter with a non-matching typed symbol still routes to the
 * verdict page (VerdictCard will trigger a Kite-seeded fetch there).
 */

interface Suggestion {
  symbol: string;
  company: string;
  sector: string;
}

export default function SymbolSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q || q.length < 1) { setSuggestions([]); return; }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const json = (await res.json()) as { results: Suggestion[] };
        setSuggestions(json.results ?? []);
        setFocusIdx(-1);
      } catch {
        /* aborted / network */
      }
    }, 120);
    return () => { clearTimeout(t); controller.abort(); };
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const submit = (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setOpen(false);
    router.push(`/stock/${encodeURIComponent(s)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(focusIdx >= 0 && suggestions[focusIdx] ? suggestions[focusIdx].symbol : q);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Check any stock — type a symbol (e.g. TCS) or company name"
        className="w-full px-4 py-2.5 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md max-h-80 overflow-auto">
          {suggestions.map((s, i) => (
            <button
              key={`${s.symbol}-${i}`}
              onClick={() => submit(s.symbol)}
              onMouseEnter={() => setFocusIdx(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b last:border-0 border-border/50 ${
                i === focusIdx ? "bg-accent" : "hover:bg-accent/50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.symbol}</span>
                <span className="text-xs text-muted-foreground">{s.sector}</span>
              </div>
              {s.company && <div className="text-xs text-muted-foreground truncate">{s.company}</div>}
            </button>
          ))}
        </div>
      )}
      {open && q.length > 0 && suggestions.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover p-3 text-sm text-muted-foreground">
          No matches in tracked indices — pressing Enter will attempt a Kite lookup for <span className="font-mono">{q.toUpperCase()}</span>.
        </div>
      )}
    </div>
  );
}

