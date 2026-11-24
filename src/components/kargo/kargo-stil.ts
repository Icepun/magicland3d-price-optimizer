import type { KargoDurumu } from "@/core/kargo-gonderisi";

/**
 * Kargo durumunun rengi — durum sinyali paletten AYRI tutulur (her durum bir bakışta
 * ayırt edilsin). Turuncu yok (Trendyol'a ayrılmış).
 */
export const KARGO_DURUM_STILI: Record<KargoDurumu, { nokta: string; rozet: string; canli: boolean }> = {
  olusturuldu: { nokta: "bg-sky-400", rozet: "bg-sky-500/12 text-sky-400 ring-sky-500/25", canli: true },
  yolda: { nokta: "bg-indigo-400", rozet: "bg-indigo-500/12 text-indigo-300 ring-indigo-500/25", canli: true },
  dagitimda: { nokta: "bg-violet-400", rozet: "bg-violet-500/14 text-violet-300 ring-violet-500/30", canli: true },
  teslim: { nokta: "bg-emerald-400", rozet: "bg-emerald-500/12 text-emerald-400 ring-emerald-500/25", canli: false },
  sorun: { nokta: "bg-red-400", rozet: "bg-red-500/12 text-red-400 ring-red-500/30", canli: true },
  iade: { nokta: "bg-amber-400", rozet: "bg-amber-500/12 text-amber-400 ring-amber-500/25", canli: true },
  iptal: { nokta: "bg-muted-foreground/60", rozet: "bg-muted/60 text-muted-foreground ring-border", canli: false },
};

export function saatYaz(ms: number): string {
  const d = new Date(ms);
  const bugun = new Date();
  const ayniGun = d.toDateString() === bugun.toDateString();
  const saat = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  return ayniGun ? saat : `${d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} ${saat}`;
}
