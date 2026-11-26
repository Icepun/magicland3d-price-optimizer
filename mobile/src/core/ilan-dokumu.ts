/**
 * ÜRÜN EKRANI KÂR DÖKÜMÜ — fiyat motorunun gider kalemlerini ekranda gösterilecek satırlara çevirir.
 *
 * Neden ayrı: kart yalnız gider KURALLARINI listeliyordu. Oysa motor iki kalemi pazaryerine özel
 * bilgiyle değiştiriyor (`core/product-commission.ts` → `resolveListingCommissionOverride`):
 *   • `paymentFeeRate` — Hepsiburada tahsilat bedeli, n11 pazarlama + hizmet bedeli: kural değil,
 *     ama kârdan düşülüyor → kartta hiç görünmüyordu (n11'de 7 TL eksik satır).
 *   • `fixedExpenseOverride` — kuraldaki sabit bedelin yerine geçen tutar (Hepsiburada'da kargoya
 *     verme süresi 1 günse 0): kart yine KURALIN tutarını yazıyordu (kesilmeyen 11,40 TL görünüyordu).
 * Satırların toplamı artık motorun düştüğü tutara eşit — rakam değişmez, yalnız döküm doğrulanır.
 */
import type { AppliedExpenseRule } from "./types";

export interface DokumSatiri {
  key: string;
  ad: string;
  /** Sipariş ölçeğinde (×adet) düşülen brüt tutar. */
  tutar: number;
}

/** Pazaryerinin satış başına kestiği oransal bedelin ekrandaki adı. */
function kesintiAdi(platform: string): string {
  if (platform === "hepsiburada") return "Tahsilat bedeli";
  if (platform === "n11") return "Pazarlama ve hizmet bedeli";
  return "Pazaryeri kesintisi";
}

export function ilanGiderSatirlari(
  platform: string,
  r: { appliedExpenseRules: AppliedExpenseRule[]; fixedExpenses: number; variableExpenses: number; minOrderQty: number }
): DokumSatiri[] {
  const adet = Math.max(1, r.minOrderQty || 1);
  const satirlar: DokumSatiri[] = [];
  const kurus = (n: number) => Math.round(n * 100) / 100;

  // Oransal kurallar her adette tekrar eder.
  let oransalToplam = 0;
  for (const k of r.appliedExpenseRules) {
    if (k.type !== "percentage" || k.amount === 0) continue;
    const tutar = k.amount * adet;
    oransalToplam += tutar;
    satirlar.push({ key: `kural-${k.id}`, ad: k.name, tutar });
  }

  // Sabit kurallar siparişe bir kez. Motor kuralın yerine pazaryerine özel tutar kullandıysa
  // (toplam tutmuyor) kural satırları değil, gerçekten düşülen tutar gösterilir.
  const sabitKurallar = r.appliedExpenseRules.filter((k) => k.type !== "percentage" && k.amount !== 0);
  const sabitKuralToplami = sabitKurallar.reduce((t, k) => t + k.amount, 0);
  if (Math.abs(sabitKuralToplami - r.fixedExpenses) < 0.005) {
    for (const k of sabitKurallar) satirlar.push({ key: `kural-${k.id}`, ad: k.name, tutar: k.amount });
  } else if (r.fixedExpenses > 0.005) {
    satirlar.push({
      key: "hizmet-bedeli",
      ad: sabitKurallar.length === 1 ? sabitKurallar[0].name : "Hizmet bedeli",
      tutar: r.fixedExpenses,
    });
  }

  // Kuralın dışında kalan değişken gider = pazaryerinin oransal kesintisi.
  const kesinti = r.variableExpenses - oransalToplam;
  if (kesinti > 0.005) satirlar.push({ key: "pazaryeri-kesintisi", ad: kesintiAdi(platform), tutar: kurus(kesinti) });

  return satirlar;
}
