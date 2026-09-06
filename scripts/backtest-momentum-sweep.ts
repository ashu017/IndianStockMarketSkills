/**
 * Parameter sweep over the quality_trend_momentum_breakout exit/entry rule.
 *
 * WHY: the shipped recipe (3R target, 2×ATR stop, 60-bar time exit) stops out
 * on ~75% of trades, because 3R off a 2×ATR stop is a ~6×ATR move that a
 * NIFTY-500 large cap rarely delivers inside 60 bars. This script measures what
 * actually happens to win rate, expectancy and holding period when the exit
 * knobs move, instead of arguing about it from priors.
 *
 * Usage (needs Node 20+ for better-sqlite3's prebuilt binary, and the
 * react-server condition so `server-only` resolves to its empty stub):
 *
 *   PATH="$HOME/.local/node22/bin:$PATH" \
 *     npx tsx --conditions react-server scripts/backtest-momentum-sweep.ts [stage]
 *
 * Stages, run in this order because each one's winner seeds the next
 * (coordinate descent — the full cross product is ~2000 configs and the
 * interactions between these knobs are weak enough that it isn't worth it):
 *
 *   target   one-dimensional scan of targetRMultiple
 *   time     one-dimensional scan of timeExitBars
 *   stop     one-dimensional scan of stopAtrMult
 *   manage   breakeven / trail on-off combinations
 *   partial  scale-out level × fraction
 *   entry    the max-ATR-above-SMA50 extension filter
 *   grid     focused cross product of the levers that mattered
 *   all      every stage above, sequentially
 *
 * READ THE OUTPUT WITH expectancy_r AS THE PRIMARY COLUMN, not win rate. Win
 * rate alone is trivially maximized by setting a tiny target (sell every trade
 * at +0.1R and you'll "win" 90% of them while losing money net of costs), so
 * every row reports expectancy in R, profit factor and Sharpe alongside it.
 * A config only counts as an improvement if win rate rises WITHOUT expectancy
 * falling materially.
 */
import { writeFileSync } from "node:fs";
import {
  runTechnicalBacktest,
  LIVE_MOMENTUM_PARAMS,
  type BacktestOptions,
  type MomentumParams,
} from "@/lib/backtest";

type Row = {
  label: string;
  n: number;
  win: number | null;
  exp_r: number | null;
  pf: number | null;
  avg: number | null;
  med: number | null;
  bars: number | null;
  med_bars: number | null;
  p_bars: number | null;
  stopped_pct: number;
  cagr: number | null;
  sharpe: number | null;
  maxdd: number | null;
  expo: number | null;
};

async function run(label: string, params: BacktestOptions): Promise<Row> {
  const { summary: s } = await runTechnicalBacktest("local", params);
  const totalExits = Object.values(s.exit_reasons).reduce((a, b) => a + b, 0);
  return {
    label,
    n: s.n_trades,
    win: s.win_rate_pct,
    exp_r: s.expectancy_r,
    pf: s.profit_factor,
    avg: s.avg_return_pct,
    med: s.median_return_pct,
    bars: s.avg_bars_held,
    med_bars: s.median_bars_held,
    p_bars: s.avg_partial_bars_held,
    stopped_pct: totalExits > 0 ? ((s.exit_reasons.stopped ?? 0) / totalExits) * 100 : 0,
    cagr: s.metrics?.cagr_pct ?? null,
    sharpe: s.metrics?.sharpe ?? null,
    maxdd: s.metrics?.max_drawdown_pct ?? null,
    expo: s.metrics?.exposure_time_pct ?? null,
  };
}

const f = (x: number | null, d = 2) => (x === null ? "—" : Number.isFinite(x) ? x.toFixed(d) : "∞");

function table(title: string, rows: Row[]) {
  console.log(`\n=== ${title} ===`);
  const head = [
    "config".padEnd(38),
    "n".padStart(5),
    "win%".padStart(6),
    "exp_R".padStart(7),
    "PF".padStart(6),
    "avg%".padStart(7),
    "med%".padStart(7),
    "bars".padStart(6),
    "medbar".padStart(7),
    "1st±".padStart(6),
    "stop%".padStart(6),
    "CAGR%".padStart(7),
    "Sharpe".padStart(7),
    "maxDD%".padStart(7),
    "expo%".padStart(6),
  ].join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(38),
        String(r.n).padStart(5),
        f(r.win, 1).padStart(6),
        f(r.exp_r, 3).padStart(7),
        f(r.pf).padStart(6),
        f(r.avg).padStart(7),
        f(r.med).padStart(7),
        f(r.bars, 1).padStart(6),
        f(r.med_bars, 1).padStart(7),
        f(r.p_bars, 1).padStart(6),
        f(r.stopped_pct, 1).padStart(6),
        f(r.cagr, 1).padStart(7),
        f(r.sharpe, 2).padStart(7),
        f(r.maxdd, 1).padStart(7),
        f(r.expo, 1).padStart(6),
      ].join(" "),
    );
  }
}

/** Every row from every stage, appended as it's computed, so a long sweep can
 *  be re-sorted and filtered afterwards instead of re-run. */
const allRows: { stage: string; row: Row; params: Partial<MomentumParams> }[] = [];

function writeCsv(path: string) {
  const cols: (keyof Row)[] = [
    "label", "n", "win", "exp_r", "pf", "avg", "med", "bars", "med_bars",
    "p_bars", "stopped_pct", "cagr", "sharpe", "maxdd", "expo",
  ];
  const lines = [["stage", ...cols].join(",")];
  for (const { stage, row } of allRows) {
    lines.push([stage, ...cols.map((c) => (row[c] === null ? "" : String(row[c])))].join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`\nWrote ${allRows.length} rows to ${path}`);
}

/** Best-so-far params, mutated as each stage picks a winner. */
const best: Partial<MomentumParams> = {};

/** Rank by expectancy in R, which is what compounds — win rate is reported but
 *  never optimized directly, for the reason in this file's header. */
function pickBest(rows: Row[], configs: Partial<MomentumParams>[]): Partial<MomentumParams> {
  let bi = 0;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i].exp_r ?? -Infinity) > (rows[bi].exp_r ?? -Infinity)) bi = i;
  }
  console.log(`  → best by expectancy: ${rows[bi].label}`);
  return configs[bi];
}

async function stage(
  title: string,
  variants: { label: string; params: Partial<MomentumParams> }[],
  adopt = true,
) {
  const rows: Row[] = [];
  for (const v of variants) rows.push(await run(v.label, { ...best, ...v.params }));
  table(title, rows);
  if (adopt) Object.assign(best, pickBest(rows, variants.map((v) => v.params)));
}

async function main() {
  const which = process.argv[2] ?? "all";
  const wants = (s: string) => which === "all" || which === s;

  console.log("LIVE baseline params:", JSON.stringify(LIVE_MOMENTUM_PARAMS));
  table("Baseline (shipped recipe)", [await run("LIVE (3R / 2ATR / 60 bars)", {})]);

  if (wants("target")) {
    await stage(
      "Stage 1 — target R multiple",
      [1, 1.25, 1.5, 2, 2.5, 3, 4].map((r) => ({
        label: `target ${r}R`,
        params: { targetRMultiple: r },
      })),
    );
  }

  if (wants("time")) {
    await stage(
      "Stage 2 — time exit (bars)",
      [5, 8, 10, 15, 20, 30, 45, 60].map((b) => ({
        label: `timeExit ${b} bars`,
        params: { timeExitBars: b },
      })),
    );
  }

  if (wants("stop")) {
    await stage(
      "Stage 3 — stop width (× ATR14)",
      [1, 1.5, 2, 2.5, 3, 4].map((m) => ({
        label: `stop ${m}×ATR`,
        params: { stopAtrMult: m },
      })),
    );
  }

  if (wants("manage")) {
    await stage("Stage 4 — breakeven / trail management", [
      { label: "no breakeven, no trail", params: { breakevenRMultiple: null, trailRMultiple: null } },
      { label: "BE@0.5R, no trail", params: { breakevenRMultiple: 0.5, trailRMultiple: null } },
      { label: "BE@1R, no trail", params: { breakevenRMultiple: 1, trailRMultiple: null } },
      { label: "BE@1R, trail@1R/10d", params: { breakevenRMultiple: 1, trailRMultiple: 1, trailLookback: 10 } },
      { label: "BE@1R, trail@1R/20d", params: { breakevenRMultiple: 1, trailRMultiple: 1, trailLookback: 20 } },
      { label: "BE@1R, trail@2R/10d", params: { breakevenRMultiple: 1, trailRMultiple: 2, trailLookback: 10 } },
      { label: "BE@1R, trail@2R/20d (live)", params: { breakevenRMultiple: 1, trailRMultiple: 2, trailLookback: 20 } },
      { label: "no BE, trail@1R/10d", params: { breakevenRMultiple: null, trailRMultiple: 1, trailLookback: 10 } },
    ]);
  }

  if (wants("partial")) {
    const variants: { label: string; params: Partial<MomentumParams> }[] = [
      { label: "no partial", params: { scaleOuts: [] } },
    ];
    for (const lvl of [0.75, 1, 1.5]) {
      for (const frac of [0.33, 0.5, 0.67]) {
        variants.push({
          label: `partial ${frac} @ ${lvl}R, BE after`,
          params: {
            scaleOuts: [{ r: lvl, fraction: frac }],
            breakevenAfterPartial: true,
          },
        });
      }
    }
    await stage("Stage 5 — partial scale-out", variants);
  }

  if (wants("entry")) {
    await stage(
      "Stage 6 — entry extension filter (close − SMA50, in ATRs)",
      [null, 1, 1.5, 2, 3, 4].map((m) => ({
        label: m === null ? "no extension filter" : `max ${m}×ATR above SMA50`,
        params: { maxAtrAboveSma50: m },
      })),
    );
  }

  if (wants("combo")) {
    // Full cross product of the knobs the 1-D stages showed actually move the
    // numbers. Run from the LIVE baseline (not from coordinate-descent state)
    // because the interaction that matters most — a scale-out paired with the
    // breakeven/trail rules switched OFF — is invisible to any one-knob scan:
    // separately, removing breakeven helps expectancy and adding a scale-out
    // helps win rate, but the scale-out only keeps its tail if breakeven isn't
    // simultaneously scratching the runner out.
    const variants: { label: string; params: Partial<MomentumParams> }[] = [];
    const partials: { tag: string; params: Partial<MomentumParams> }[] = [
      { tag: "none", params: { scaleOuts: [] } },
      { tag: "0.33@1R+BE", params: { scaleOuts: [{ r: 1, fraction: 0.33 }], breakevenAfterPartial: true } },
      { tag: "0.5@1R+BE", params: { scaleOuts: [{ r: 1, fraction: 0.5 }], breakevenAfterPartial: true } },
      { tag: "0.5@1R", params: { scaleOuts: [{ r: 1, fraction: 0.5 }], breakevenAfterPartial: false } },
      { tag: "0.5@0.75R+BE", params: { scaleOuts: [{ r: 0.75, fraction: 0.5 }], breakevenAfterPartial: true } },
      { tag: "0.33@0.75R+BE", params: { scaleOuts: [{ r: 0.75, fraction: 0.33 }], breakevenAfterPartial: true } },
    ];
    for (const stop of [1.5, 2, 2.5, 3]) {
      for (const tgt of [2, 2.5, 3, 4]) {
        for (const te of [15, 20, 30, 45]) {
          for (const pt of partials) {
            variants.push({
              label: `s${stop} t${tgt} te${te} p:${pt.tag}`,
              params: {
                stopAtrMult: stop,
                targetRMultiple: tgt,
                timeExitBars: te,
                breakevenRMultiple: null,
                trailRMultiple: null,
                maxAtrAboveSma50: null,
                ...pt.params,
              },
            });
          }
        }
      }
    }
    const baseline = await run("LIVE baseline", {});
    const rows: Row[] = [];
    for (const v of variants) rows.push(await run(v.label, v.params));

    const byExp = [...rows].sort((a, b) => (b.exp_r ?? -Infinity) - (a.exp_r ?? -Infinity));
    table("Stage 8a — top 15 by expectancy (R)", byExp.slice(0, 15));

    // The user-facing objective: win rate UP and holding period DOWN, without
    // paying for it in expectancy. Gate on baseline expectancy first, then rank
    // by win rate — a config that fails the gate is buying its win rate with
    // the strategy's edge and is not an improvement however good the % looks.
    const gate = baseline.exp_r ?? 0;
    const qualified = rows.filter((r) => (r.exp_r ?? -Infinity) >= gate);
    const byWin = [...qualified].sort((a, b) => (b.win ?? -1) - (a.win ?? -1));
    table(
      `Stage 8b — top 20 by win rate among the ${qualified.length}/${rows.length} configs whose expectancy is at least baseline's ${f(gate, 3)}R`,
      byWin.slice(0, 20),
    );

    const shortHorizon = qualified.filter((r) => (r.med_bars ?? Infinity) <= 12);
    table(
      `Stage 8c — same gate, plus median hold ≤ 12 bars (${shortHorizon.length} configs), by win rate`,
      [...shortHorizon].sort((a, b) => (b.win ?? -1) - (a.win ?? -1)).slice(0, 15),
    );
    table("Baseline for reference", [baseline]);
  }

  if (wants("horizon")) {
    // The combo stage's winners all pushed the time exit OUT to 45 bars, which
    // is the opposite of the requirement here (raise win rate while SHORTENING
    // the holding period). So this stage re-searches under a hard horizon cap:
    // every config's time exit is ≤ 25 bars, which bounds the worst-case hold
    // outright, and the scale-out level is swept down to 0.5R so that the first
    // profit is booked in single-digit bars.
    const variants: { label: string; params: Partial<MomentumParams> }[] = [];
    const partials: { tag: string; params: Partial<MomentumParams> }[] = [
      { tag: "none", params: { scaleOuts: [] } },
    ];
    for (const lvl of [0.5, 0.75, 1, 1.25]) {
      for (const frac of [0.33, 0.5]) {
        partials.push({
          tag: `${frac}@${lvl}R+BE`,
          params: { scaleOuts: [{ r: lvl, fraction: frac }], breakevenAfterPartial: true },
        });
      }
    }
    for (const stop of [1.5, 2, 2.5]) {
      for (const tgt of [2, 3, 4]) {
        for (const te of [10, 12, 15, 20, 25]) {
          for (const pt of partials) {
            variants.push({
              label: `s${stop} t${tgt} te${te} p:${pt.tag}`,
              params: {
                stopAtrMult: stop,
                targetRMultiple: tgt,
                timeExitBars: te,
                breakevenRMultiple: null,
                trailRMultiple: null,
                maxAtrAboveSma50: null,
                ...pt.params,
              },
            });
          }
        }
      }
    }
    const baseline = await run("LIVE baseline", {});
    allRows.push({ stage: "baseline", row: baseline, params: {} });
    const rows: Row[] = [];
    for (const v of variants) {
      const r = await run(v.label, v.params);
      rows.push(r);
      allRows.push({ stage: "horizon", row: r, params: v.params });
    }

    const gate = baseline.exp_r ?? 0;
    const qualified = rows.filter((r) => (r.exp_r ?? -Infinity) >= gate);
    table(
      `Stage 9a — horizon-capped, top 20 by win rate among the ${qualified.length}/${rows.length} configs at or above baseline expectancy (${f(gate, 3)}R)`,
      [...qualified].sort((a, b) => (b.win ?? -1) - (a.win ?? -1)).slice(0, 20),
    );
    table(
      "Stage 9b — horizon-capped, top 15 by expectancy (R)",
      [...rows].sort((a, b) => (b.exp_r ?? -Infinity) - (a.exp_r ?? -Infinity)).slice(0, 15),
    );
    // Strictest reading of the brief: beat the baseline on expectancy AND on
    // win rate AND hold no longer than the baseline's median. Anything here is
    // an unambiguous improvement, not a trade-off the reader has to accept.
    const dominating = rows.filter(
      (r) =>
        (r.exp_r ?? -Infinity) >= gate &&
        (r.win ?? 0) > (baseline.win ?? 0) &&
        (r.med_bars ?? Infinity) <= (baseline.med_bars ?? Infinity),
    );
    table(
      `Stage 9c — configs that dominate the baseline on expectancy, win rate AND median hold (${dominating.length} of ${rows.length}), by win rate`,
      [...dominating].sort((a, b) => (b.win ?? -1) - (a.win ?? -1)).slice(0, 20),
    );
    table("Baseline for reference", [baseline]);
    writeCsv("logs/momentum-sweep-horizon.csv");
    return;
  }

  if (wants("refine")) {
    // Local search around the horizon stage's winner. Kept deliberately small:
    // this window is ~1.5 years of entries over 78 symbols, so every extra knob
    // resolved to two decimal places is a coin flip dressed up as a finding.
    // What matters here is not the argmax but whether the NEIGHBOURHOOD is flat
    // — a peak that collapses when the stop moves 0.25×ATR is a fit to noise.
    const variants: { label: string; params: Partial<MomentumParams> }[] = [];
    for (const stop of [1.75, 2, 2.25, 2.5]) {
      for (const tgt of [3, 3.5, 4, 5]) {
        for (const te of [20, 25, 30]) {
          for (const lvl of [1, 1.25, 1.5]) {
            for (const frac of [0.25, 0.33, 0.5]) {
              variants.push({
                label: `s${stop} t${tgt} te${te} ${frac}@${lvl}R`,
                params: {
                  stopAtrMult: stop,
                  targetRMultiple: tgt,
                  timeExitBars: te,
                  breakevenRMultiple: null,
                  trailRMultiple: null,
                  scaleOuts: [{ r: lvl, fraction: frac }],
                  breakevenAfterPartial: true,
                },
              });
            }
          }
        }
      }
    }
    const baseline = await run("LIVE baseline", {});
    allRows.push({ stage: "baseline", row: baseline, params: {} });
    const rows: Row[] = [];
    for (const v of variants) {
      const r = await run(v.label, v.params);
      rows.push(r);
      allRows.push({ stage: "refine", row: r, params: v.params });
    }
    const gate = baseline.exp_r ?? 0;
    const qualified = rows.filter((r) => (r.exp_r ?? -Infinity) >= gate && (r.med_bars ?? Infinity) <= 16);
    table(
      `Stage 10 — refine: ${qualified.length}/${rows.length} configs at/above baseline expectancy with median hold ≤ 16 bars, top 25 by win rate`,
      [...qualified].sort((a, b) => (b.win ?? -1) - (a.win ?? -1)).slice(0, 25),
    );
    table(
      "Stage 10b — same pool, top 15 by Sharpe (the portfolio-level read)",
      [...qualified].sort((a, b) => (b.sharpe ?? -Infinity) - (a.sharpe ?? -Infinity)).slice(0, 15),
    );
    table("Baseline for reference", [baseline]);
    writeCsv("logs/momentum-sweep-refine.csv");
    return;
  }

  if (wants("robust")) {
    // Split-sample check. A tuned parameter set that only works on the half of
    // history it was tuned on is a curve fit, and this sample (one window, one
    // static universe, ~460 trades) is small enough that that is the DEFAULT
    // expectation rather than a remote risk. Both halves are reported for the
    // baseline and the candidate so the comparison is like-for-like.
    const CAND: Partial<MomentumParams> = {
      stopAtrMult: 2,
      targetRMultiple: 4,
      timeExitBars: 25,
      breakevenRMultiple: null,
      trailRMultiple: null,
      scaleOuts: [{ r: 1.25, fraction: 0.33 }],
      breakevenAfterPartial: true,
      maxAtrAboveSma50: null,
    };
    // Split roughly in half by calendar time across the usable window
    // (2023-11 → 2026-08); the exact boundary is not tuned.
    const windows: { tag: string; w: { entryFrom?: string; entryTo?: string } }[] = [
      { tag: "full", w: {} },
      { tag: "H1 →2025-06-30", w: { entryTo: "2025-06-30" } },
      { tag: "H2 2025-07-01→", w: { entryFrom: "2025-07-01" } },
      { tag: "2024 only", w: { entryFrom: "2024-01-01", entryTo: "2024-12-31" } },
      { tag: "2025 only", w: { entryFrom: "2025-01-01", entryTo: "2025-12-31" } },
      { tag: "2026 only", w: { entryFrom: "2026-01-01" } },
    ];
    const rows: Row[] = [];
    for (const { tag, w } of windows) {
      rows.push(await run(`BASE  ${tag}`, w));
      rows.push(await run(`CAND  ${tag}`, { ...CAND, ...w }));
    }
    table("Stage 11 — split-sample robustness (baseline vs candidate, per entry window)", rows);
    return;
  }

  if (wants("ladder")) {
    // The single-rung results split into two camps: a rung at 1R buys the
    // highest win rate (~59%) but the flattest expectancy, and a rung at 1.5R
    // buys the best Sharpe (~0.64) at a lower win rate (~50%). A two-rung
    // ladder should get both — the low rung books a profit early enough to
    // convert the trade to a winner, the high rung still leaves a runner. This
    // stage tests whether that actually happens or whether it just splits the
    // difference.
    const stop = 1.75;
    const ladders: { tag: string; scaleOuts: { r: number; fraction: number }[] }[] = [
      { tag: "none", scaleOuts: [] },
      { tag: "1×0.33@1R", scaleOuts: [{ r: 1, fraction: 0.33 }] },
      { tag: "1×0.5@1R", scaleOuts: [{ r: 1, fraction: 0.5 }] },
      { tag: "1×0.5@1.5R", scaleOuts: [{ r: 1.5, fraction: 0.5 }] },
      { tag: "1×0.33@1.5R", scaleOuts: [{ r: 1.5, fraction: 0.33 }] },
      { tag: "2×0.33@1R,2R", scaleOuts: [{ r: 1, fraction: 0.33 }, { r: 2, fraction: 0.33 }] },
      { tag: "2×0.25@1R,2R", scaleOuts: [{ r: 1, fraction: 0.25 }, { r: 2, fraction: 0.25 }] },
      { tag: "2×0.33@1R,2.5R", scaleOuts: [{ r: 1, fraction: 0.33 }, { r: 2.5, fraction: 0.33 }] },
      { tag: "2×0.5/0.25@1R,2R", scaleOuts: [{ r: 1, fraction: 0.5 }, { r: 2, fraction: 0.25 }] },
      { tag: "2×0.25/0.5@1R,2R", scaleOuts: [{ r: 1, fraction: 0.25 }, { r: 2, fraction: 0.5 }] },
      { tag: "2×0.33@0.75R,1.5R", scaleOuts: [{ r: 0.75, fraction: 0.33 }, { r: 1.5, fraction: 0.33 }] },
      { tag: "2×0.33@1.25R,2.5R", scaleOuts: [{ r: 1.25, fraction: 0.33 }, { r: 2.5, fraction: 0.33 }] },
      { tag: "3×0.25@1R,2R,3R", scaleOuts: [{ r: 1, fraction: 0.25 }, { r: 2, fraction: 0.25 }, { r: 3, fraction: 0.25 }] },
    ];
    const rows: Row[] = [await run("LIVE baseline", {})];
    for (const te of [25, 30]) {
      for (const l of ladders) {
        rows.push(
          await run(`te${te} ${l.tag}`, {
            stopAtrMult: stop,
            targetRMultiple: 5,
            timeExitBars: te,
            breakevenRMultiple: null,
            trailRMultiple: null,
            scaleOuts: l.scaleOuts,
            breakevenAfterPartial: true,
          }),
        );
      }
    }
    table(`Stage 12 — scale-out ladders (stop ${stop}×ATR, target 5R, no breakeven/trail)`, rows);
    return;
  }

  if (wants("grid")) {
    // Focused cross product of the two knobs that move both objectives at once
    // (how far you're willing to hold for, and how much you demand before
    // booking), evaluated at the best-so-far setting of everything else.
    const variants: { label: string; params: Partial<MomentumParams> }[] = [];
    for (const t of [1, 1.5, 2, 2.5]) {
      for (const b of [8, 10, 15, 20, 30]) {
        variants.push({ label: `target ${t}R × ${b} bars`, params: { targetRMultiple: t, timeExitBars: b } });
      }
    }
    await stage("Stage 7 — target × time-exit grid", variants, false);
  }

  console.log("\n=== Best params found (coordinate descent, by expectancy_r) ===");
  console.log(JSON.stringify({ ...LIVE_MOMENTUM_PARAMS, ...best }, null, 2));
  table("Final candidate vs baseline", [
    await run("LIVE baseline", {}),
    await run("candidate", best),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
