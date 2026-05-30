const tl = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  maximumFractionDigits: 2,
});

export function formatCurrency(value: number | null | undefined): string {
  return tl.format(Number(value ?? 0));
}

export function formatPercent(value: number | null | undefined): string {
  return `%${(Number(value ?? 0) * 100).toFixed(1)}`;
}

export function formatDate(value: number | string | null | undefined): string {
  if (value == null) return "—";
  const d = new Date(typeof value === "number" ? value : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}
