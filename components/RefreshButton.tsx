"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const j = await res.json();
      if (j.status === "login_required") {
        setNote("Kite login required");
        window.open(j.loginUrl, "_blank");
      } else if (j.status === "in_progress") {
        setNote("Refresh already running");
      } else if (j.status === "error") {
        setNote("Refresh failed");
      }
      router.refresh();
    } catch {
      setNote("Refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {note && <span className="text-sm text-amber-600">{note}</span>}
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium transition-colors hover:border-gray-400 disabled:opacity-50"
      >
        {busy ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
