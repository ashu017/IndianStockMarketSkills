export type Grade = "Good" | "Fair" | "Weak";
export type Range = "1M" | "3M" | "6M" | "1Y" | "ALL";
export type Exchange = "NSE" | "BSE";

// ---- DB row types (snake_case, minor units) ----
export interface HoldingRow {
  user_id: string;
  snapshot_date: string;
  symbol: string;
  exchange: Exchange;
  qty: number;
  avg_price: number; // ×10000
  ltp: number; // paise
  close_price: number; // paise
  company?: string;
  sector?: string;
  isin?: string;
}

export interface PortfolioSummaryRow {
  user_id: string;
  snapshot_date: string;
  current_value: number; // paise
  invested: number; // paise
  total_pnl: number; // paise
  day_pnl: number; // paise
  holdings_count: number;
  winners: number;
  losers: number;
}

export interface FundamentalsRow {
  isin: string;
  as_of_date: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  debt_equity: number | null;
  sales_growth_3y: number | null;
  profit_growth_3y: number | null;
  div_yield: number | null;
  market_cap: number | null; // paise
  promoter_holding: number | null;
  fetched_at: string | null;
  source: string | null;
  source_url: string | null;
  fetch_status: "ok" | "stale" | "failed" | null;
}

export interface FundamentalsExtraRow {
  isin: string;
  as_of_date: string;
  metric_key: string;
  value_num: number | null;
  unit: string | null;
}

export interface PeerRow {
  isin: string;
  as_of_date: string;
  peer_symbol: string;
  peer_company: string | null;
  pe: number | null;
  roe: number | null;
  roce: number | null;
  sales_growth: number | null;
}

export interface AnalysisRow {
  isin: string;
  narrative: string | null;
  verdict: string | null;
  confidence: string | null;
  generated_at: string | null;
  model_version: string | null;
  prompt_version: string | null;
}

export interface StockMetaRow {
  symbol: string;
  exchange: Exchange;
  isin: string | null;
  company: string | null;
  sector: string | null;
}

// ---- UI types (camelCase, rupees) — aligned to the Figma data.ts ----
export interface Holding {
  symbol: string;
  company: string;
  exchange: Exchange;
  sector: string;
  qty: number;
  avgPrice: number;
  ltp: number;
  dayChangePct: number;
  invested: number;
  current: number;
  pnl: number;
  pnlPct: number;
  dayPnl: number;
  weight: number; // computed, never stored
}

export interface FundamentalItem {
  label: string;
  value: string; // display string formatted from a numeric column (e.g. "27.4×")
  grade: Grade;
}

export interface Peer {
  symbol: string;
  company: string;
  pe: number | null;
  roe: number;
  roce: number | null;
  salesGrowth: number;
}

export interface StockDetail {
  fundamentals: FundamentalItem[];
  analysis: string;
  peers: Peer[];
  provenance: {
    fetchedAt: string;
    fetchStatus: "ok" | "stale" | "failed";
    thresholdsVersion: string;
    modelVersion?: string;
  };
}

export interface PortfolioSummary {
  currentValue: number;
  invested: number;
  totalPnl: number;
  totalPnlPct: number;
  dayPnl: number;
  dayPnlPct: number;
  holdingsCount: number;
  winners: number;
  losers: number;
  asOf: string;
}
