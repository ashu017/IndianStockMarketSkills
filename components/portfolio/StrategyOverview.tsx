import {
  ShieldCheck,
  TrendingUp,
  Target,
  ListOrdered,
  Crosshair,
  Repeat,
  FlaskConical,
} from "lucide-react";
import type { StrategyRuleGroup } from "@/lib/strategies";

// One icon + accent per pipeline stage, matched to the rule group's ordinal
// position (StrategyRuleGroup.title always starts "N. ..." per lib/strategies.ts).
// Colors ride the same indigo/primary system as TopNav's logo tile and
// StockDetail's highlighted rows (bg-primary/10, text-primary, border-primary/20),
// not a new palette.
const STAGE_STYLE = [
  { icon: ShieldCheck, iconClass: "text-primary" },
  { icon: TrendingUp, iconClass: "text-sky-600" },
  { icon: Crosshair, iconClass: "text-emerald-600" },
  { icon: ListOrdered, iconClass: "text-amber-600" },
  { icon: Target, iconClass: "text-violet-600" },
  { icon: Repeat, iconClass: "text-rose-600" },
  // Stage 7 is the measured justification for the current exit rule plus the
  // grandfathering note — same flask as the backtest panel below it, since it's
  // where you'd go to re-run the comparison yourself.
  { icon: FlaskConical, iconClass: "text-violet-600" },
];

/** Detailed rule breakdown — the numbered pipeline stages from lib/strategies.ts's registry. */
export default function StrategyOverview({
  description,
  rules,
}: {
  description: string;
  rules?: StrategyRuleGroup[];
}) {
  if (!rules || rules.length === 0) {
    return <p className="text-sm text-muted-foreground mt-1">{description}</p>;
  }
  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-secondary/40 to-transparent p-5 sm:p-6">
      <p className="text-sm text-muted-foreground mb-5 max-w-3xl">{description}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rules.map((group, idx) => {
          const style = STAGE_STYLE[idx % STAGE_STYLE.length];
          const Icon = style.icon;
          return (
            <div
              key={group.title}
              className="rounded-lg border border-border bg-card/80 backdrop-blur-sm p-4 hover:border-primary/30 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <span className={`shrink-0 w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center ${style.iconClass}`}>
                  <Icon className="w-4 h-4" />
                </span>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {group.title}
                </h3>
              </div>
              <ul className="space-y-1.5">
                {group.items.map((item, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex gap-2 leading-relaxed">
                    <span className="text-primary/50 shrink-0">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
