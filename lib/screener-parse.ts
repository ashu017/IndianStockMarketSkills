/** Screener display string → number, or null for missing ("—", "", N/A). */
export function parseScreenerNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[₹%×,\s]/g, "").replace(/Cr\.?/gi, "");
  if (cleaned === "" || cleaned === "—" || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "₹ 8,14,737 Cr." → paise (crore × 1e7 rupees × 100 paise). */
export function parseCroreToPaise(s: string | null | undefined): number | null {
  const crore = parseScreenerNumber(s);
  if (crore == null) return null;
  return Math.round(crore * 1e7 * 100);
}
