export function fmtINR(amount: number, decimals = 0): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

export function fmtINRSigned(amount: number, decimals = 0): string {
  const sign = amount >= 0 ? "+" : "−";
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(amount));
  return `${sign}${formatted}`;
}

export function fmtPct(value: number, decimals = 2): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(decimals)}%`;
}

export function fmtNum(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function gainTextClass(value: number): string {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

export function gainBadgeClass(value: number): string {
  return value >= 0
    ? "bg-emerald-50 text-emerald-700"
    : "bg-red-50 text-red-700";
}
