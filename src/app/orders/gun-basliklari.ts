/**
 * SİPARİŞ LİSTESİNDE GÜN BAŞLIKLARI — "Bugün · 3 sipariş", "Dün", "7 Ekim Çarşamba".
 * 9 Eki 2026 denetimi: 243 sipariş tek düz liste halindeydi, hangi günün nerede bittiği
 * okunmuyordu. Liste tarihe göre YENİDEN ESKİYE sıralı gelir (orders sayfası); başlıklar
 * İstanbul takvimine göre gün değişince araya girer.
 */
const TZ = "Europe/Istanbul";

export type ListeSatiri<T> =
  | { tur: "gun"; anahtar: string; etiket: string; adet: number }
  | { tur: "siparis"; siparis: T };

function gunAnahtari(ms: number): string {
  // en-CA → YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export function gunEtiketi(anahtar: string, nowMs: number): string {
  const bugun = gunAnahtari(nowMs);
  const dun = gunAnahtari(nowMs - 86_400_000);
  if (anahtar === bugun) return "Bugün";
  if (anahtar === dun) return "Dün";
  const [y, m, d] = anahtar.split("-").map(Number);
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", day: "numeric", month: "long", weekday: "long" }).format(
    Date.UTC(y, m - 1, d, 12)
  );
}

export function gunlereBol<T extends { date?: string | null }>(siparisler: readonly T[], nowMs: number): ListeSatiri<T>[] {
  const out: ListeSatiri<T>[] = [];
  let sonAnahtar: string | null = null;
  let baslik: { tur: "gun"; anahtar: string; etiket: string; adet: number } | null = null;
  for (const s of siparisler) {
    const ms = s.date ? Date.parse(s.date) : NaN;
    const anahtar = Number.isFinite(ms) ? gunAnahtari(ms) : "tarihsiz";
    if (anahtar !== sonAnahtar) {
      baslik = { tur: "gun", anahtar, etiket: anahtar === "tarihsiz" ? "Tarihi bilinmeyen" : gunEtiketi(anahtar, nowMs), adet: 0 };
      out.push(baslik);
      sonAnahtar = anahtar;
    }
    baslik!.adet++;
    out.push({ tur: "siparis", siparis: s });
  }
  return out;
}
