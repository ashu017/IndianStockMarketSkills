import type Database from "better-sqlite3";

export interface AnalysisPayload {
  isin: string;
  asOfDate: string; // YYYY-MM-DD (IST)
  fundamentals: {
    pe: number | null; pb: number | null; roe: number | null; roce: number | null;
    debt_equity: number | null; sales_growth_3y: number | null;
    profit_growth_3y: number | null; div_yield: number | null;
    market_cap: number | null; promoter_holding: number | null;
    source: string | null; source_url: string | null;
    fetch_status: "ok" | "stale" | "failed";
  };
  extra: { metric_key: string; value_num: number | null; unit: string | null }[];
  peers: {
    peer_symbol: string; peer_company: string | null;
    pe: number | null; roe: number | null; roce: number | null; sales_growth: number | null;
  }[];
  analysis: {
    narrative: string; verdict: "BUY" | "SELL" | "HOLD"; confidence: "Low" | "Medium" | "High";
    model_version: string; prompt_version: string;
  };
}

export function writeAnalysis(db: Database.Database, p: AnalysisPayload): void {
  const nowIso = new Date().toISOString();

  const fund = db.prepare(
    `INSERT INTO fundamentals(isin,as_of_date,pe,pb,roe,roce,debt_equity,sales_growth_3y,
       profit_growth_3y,div_yield,market_cap,promoter_holding,fetched_at,source,source_url,fetch_status)
     VALUES(@isin,@as_of_date,@pe,@pb,@roe,@roce,@debt_equity,@sales_growth_3y,
       @profit_growth_3y,@div_yield,@market_cap,@promoter_holding,@fetched_at,@source,@source_url,@fetch_status)
     ON CONFLICT(isin,as_of_date) DO UPDATE SET
       pe=excluded.pe,pb=excluded.pb,roe=excluded.roe,roce=excluded.roce,
       debt_equity=excluded.debt_equity,sales_growth_3y=excluded.sales_growth_3y,
       profit_growth_3y=excluded.profit_growth_3y,div_yield=excluded.div_yield,
       market_cap=excluded.market_cap,promoter_holding=excluded.promoter_holding,
       fetched_at=excluded.fetched_at,source=excluded.source,source_url=excluded.source_url,
       fetch_status=excluded.fetch_status`,
  );
  const extra = db.prepare(
    `INSERT INTO fundamentals_extra(isin,as_of_date,metric_key,value_num,unit)
     VALUES(@isin,@as_of_date,@metric_key,@value_num,@unit)
     ON CONFLICT(isin,as_of_date,metric_key) DO UPDATE SET
       value_num=excluded.value_num,unit=excluded.unit`,
  );
  const peer = db.prepare(
    `INSERT INTO peers(isin,as_of_date,peer_symbol,peer_company,pe,roe,roce,sales_growth)
     VALUES(@isin,@as_of_date,@peer_symbol,@peer_company,@pe,@roe,@roce,@sales_growth)
     ON CONFLICT(isin,as_of_date,peer_symbol) DO UPDATE SET
       peer_company=excluded.peer_company,pe=excluded.pe,roe=excluded.roe,
       roce=excluded.roce,sales_growth=excluded.sales_growth`,
  );
  const analysis = db.prepare(
    `INSERT INTO analysis(isin,narrative,verdict,confidence,generated_at,model_version,prompt_version)
     VALUES(@isin,@narrative,@verdict,@confidence,@generated_at,@model_version,@prompt_version)
     ON CONFLICT(isin) DO UPDATE SET
       narrative=excluded.narrative,verdict=excluded.verdict,confidence=excluded.confidence,
       generated_at=excluded.generated_at,model_version=excluded.model_version,
       prompt_version=excluded.prompt_version`,
  );

  const tx = db.transaction(() => {
    fund.run({ isin: p.isin, as_of_date: p.asOfDate, fetched_at: nowIso, ...p.fundamentals });
    for (const e of p.extra) extra.run({ isin: p.isin, as_of_date: p.asOfDate, ...e });
    for (const pr of p.peers) peer.run({ isin: p.isin, as_of_date: p.asOfDate, ...pr });
    analysis.run({ isin: p.isin, generated_at: nowIso, ...p.analysis });
  });
  tx();
}
