import Link from "next/link";
import { BarChart2 } from "lucide-react";

interface Props {
  currentPage: "overview" | "deepdive";
  stockSymbol?: string;
  sessionLabel?: string;
}

export default function TopNav({ currentPage, stockSymbol, sessionLabel }: Props) {
  return (
    <nav className="sticky top-0 z-50 bg-card/80 backdrop-blur-md border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-6">
        <Link
          href="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0"
        >
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <BarChart2 className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-foreground tracking-tight">Folio</span>
        </Link>

        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link
            href="/"
            className={`hover:text-foreground transition-colors ${currentPage === "overview" ? "text-foreground font-medium" : ""}`}
          >
            Overview
          </Link>
          {currentPage === "deepdive" && stockSymbol && (
            <>
              <span className="text-border select-none">/</span>
              <span className="text-foreground font-medium num">{stockSymbol}</span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-xs text-muted-foreground">
              {sessionLabel ?? "Session closed"}
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}
