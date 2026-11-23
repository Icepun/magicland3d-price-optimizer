/**
 * KÂR NEREYE GİTTİ — bir ayın cirosunun hangi kesintilerle sipariş kârına indiği.
 *
 * Burada YENİ BİR KÂR FORMÜLÜ KURULMAZ. Kalemler sipariş kârının tek kaynağı olan motorun
 * (`resolveOrderProfit`) çıktısıdır; motor "yeniden hesapla"nın PROVA turuyla, Raporlar'ın
 * kullandığı aynı kayıtlı girdilerle koşturulur. Döküm her zaman KAYITLI kâra kapanır:
 * motorun açıklayamadığı fark (yüzdesel gider kuralı, yuvarlama, sonradan işlenmiş gerçek
 * kesinti) "Diğer kesintiler" satırına düşer — sayfadaki sipariş kârı ile döküm hiç ayrışmaz.
 *
 * Aynı eleme kuralları aylık özetle (`aggregateMonthlyFinance`): iptal ve TL dışı siparişler
 * hiçbir kaleme girmez (iade zararı ve giderler sayfada aylık özetten okunur).
 */
import { prisma } from "@/lib/prisma";
import { recalculateFinanceMonths, type RecalcSnapshotRow } from "@/lib/order-finance-snapshots";
import { parseManualOrderBreakdown } from "@/lib/manual-orders";
import { FINANCE_TIME_ZONE, monthKey } from "@/lib/monthly-finance";
import type { ResolvedOrderProfit } from "@/core/order-profit";

export type KarDokumuAnahtari =
  | "komisyon"
  | "kargo"
  | "urun"
  | "bedeller"
  | "reklam"
  | "ceza"
  | "kdv"
  | "diger"
  | "dokumsuz";

export const KAR_DOKUMU_ETIKETLERI: Record<KarDokumuAnahtari, string> = {
  urun: "Ürün ve paketleme",
  komisyon: "Pazaryeri komisyonu",
  kargo: "Kargo",
  kdv: "KDV",
  bedeller: "Hizmet ve tahsilat bedelleri",
  reklam: "Reklam",
  ceza: "Gecikme ve kusurlu ürün bedeli",
  diger: "Diğer kesintiler",
  dokumsuz: "Dökümü olmayan siparişler",
};

export interface KarDokumu {
  month: string;
  /** Ayın cirosu (iptal ve TL dışı hariç) — aylık özetteki ciroyla aynı küme. */
  revenue: number;
  /** Maliyeti girilmemiş satışların cirosu — kâra hiç girmedi. */
  unknownCostRevenue: number;
  /** Kesintiler (pozitif TL), büyükten küçüğe. Sıfır olanlar yok. */
  lines: { key: KarDokumuAnahtari; label: string; amount: number }[];
  /** İadeler düşülmeden önceki sipariş kârı (kayıtlı kârların toplamı). */
  orderProfitBeforeReturns: number;
  orderCount: number;
}

/** Bir siparişin döküme girecek kısmı. `sonuc` null = kalem geçmişi yok (motor çalışamadı). */
export interface DokumSiparisi {
  statusKind: string;
  currency: string;
  revenueKurus: number;
  profitKurus: number | null;
  sonuc: Pick<
    ResolvedOrderProfit,
    | "profit"
    | "unmatchedRevenue"
    | "estimatedCommission"
    | "actualCommission"
    | "cargoCost"
    | "actualCargo"
    | "productAndPackagingCost"
    | "fixedExpense"
    | "actualOrderFee"
    | "paymentFee"
    | "actualPaymentFee"
    | "internationalFee"
    | "adCost"
    | "penalty"
    | "outputVat"
    | "inputVatCredit"
  > | null;
}

/** Elle siparişin kayıtlı hesabı (motorun kendi dökümü). */
export interface DokumManuelSiparis {
  statusKind: string;
  currency: string;
  revenueKurus: number;
  profitKurus: number | null;
  dokum: {
    productCost: number;
    packagingCost: number;
    commissionCost: number;
    cargoCost: number;
    expenseRulesCost: number;
    customExpensesCost: number;
    outputVat: number;
    inputVatCredit: number;
  } | null;
}

const tl = (kurus: number) => kurus / 100;
const yuvarla = (v: number) => Math.round(v * 100) / 100;
const sayi = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const tlMi = (currency: string) => (currency || "TRY").trim().toUpperCase() === "TRY";

/** SAF: siparişleri döküme topla. Toplam her zaman kayıtlı kârlara kapanır. */
export function karDokumuTopla(
  month: string,
  siparisler: readonly DokumSiparisi[],
  manueller: readonly DokumManuelSiparis[] = []
): KarDokumu {
  const k: Record<KarDokumuAnahtari, number> = {
    komisyon: 0,
    kargo: 0,
    urun: 0,
    bedeller: 0,
    reklam: 0,
    ceza: 0,
    kdv: 0,
    diger: 0,
    dokumsuz: 0,
  };
  let ciro = 0;
  let bilinmeyen = 0;
  let kar = 0;
  let adet = 0;

  for (const s of siparisler) {
    if (s.statusKind === "cancelled" || !tlMi(s.currency)) continue;
    const R = tl(s.revenueKurus);
    ciro += R;
    adet++;
    if (s.profitKurus == null) {
      bilinmeyen += R;
      continue;
    }
    const P = tl(s.profitKurus);
    kar += P;
    const r = s.sonuc;
    // Motor çalışamadı (kalem geçmişi yok) ya da ürün artık okunamıyor: kayıtlı kâr duruyor ama
    // kalemleri bilinmiyor → maliyet tek satırda.
    if (!r || r.profit == null) {
      k.dokumsuz += R - P;
      continue;
    }
    const U = Math.min(R, Math.max(0, sayi(r.unmatchedRevenue)));
    bilinmeyen += U;
    const bilinen = R - U;
    const komisyon = r.actualCommission ?? sayi(r.estimatedCommission);
    const kargo = r.actualCargo ?? sayi(r.cargoCost);
    const urun = sayi(r.productAndPackagingCost);
    const bedeller =
      (r.actualOrderFee ?? sayi(r.fixedExpense)) + (r.actualPaymentFee ?? sayi(r.paymentFee)) + sayi(r.internationalFee);
    const reklam = sayi(r.adCost);
    const ceza = sayi(r.penalty);
    // Satış KDV'si cironun TAMAMINDAN; maliyeti bilinmeyen satırların payı onlarla birlikte ayrılır.
    const kdv = (R > 0 ? sayi(r.outputVat) * (bilinen / R) : 0) - sayi(r.inputVatCredit);
    k.komisyon += komisyon;
    k.kargo += kargo;
    k.urun += urun;
    k.bedeller += bedeller;
    k.reklam += reklam;
    k.ceza += ceza;
    k.kdv += kdv;
    k.diger += bilinen - (komisyon + kargo + urun + bedeller + reklam + ceza + kdv) - P;
  }

  for (const m of manueller) {
    if (m.statusKind === "cancelled" || !tlMi(m.currency)) continue;
    const R = tl(m.revenueKurus);
    ciro += R;
    adet++;
    if (m.profitKurus == null) {
      bilinmeyen += R;
      continue;
    }
    const P = tl(m.profitKurus);
    kar += P;
    const d = m.dokum;
    if (!d) {
      k.dokumsuz += R - P;
      continue;
    }
    const urun = d.productCost + d.packagingCost;
    const kdv = d.outputVat - d.inputVatCredit;
    const diger = d.expenseRulesCost + d.customExpensesCost;
    k.urun += urun;
    k.komisyon += d.commissionCost;
    k.kargo += d.cargoCost;
    k.kdv += kdv;
    k.diger += diger + (R - (urun + d.commissionCost + d.cargoCost + kdv + diger) - P);
  }

  const lines = (Object.keys(k) as KarDokumuAnahtari[])
    .map((key) => ({ key, label: KAR_DOKUMU_ETIKETLERI[key], amount: yuvarla(k[key]) }))
    // "Diğer" kuruş düzeyinde yuvarlama farkı taşır — 1 TL'nin altı gösterilmez.
    .filter((l) => Math.abs(l.amount) >= (l.key === "diger" ? 1 : 0.01))
    .sort((a, b) => b.amount - a.amount);

  return {
    month,
    revenue: yuvarla(ciro),
    unknownCostRevenue: yuvarla(bilinmeyen),
    lines,
    orderProfitBeforeReturns: yuvarla(kar),
    orderCount: adet,
  };
}

/** Bir ayın kâr dökümü — motorun prova turuyla (hiçbir şey yazılmaz). */
export async function karDokumuOku(month: string): Promise<KarDokumu> {
  const siparisler: DokumSiparisi[] = [];
  await recalculateFinanceMonths([month], {
    dryRun: true,
    dokum: (row: RecalcSnapshotRow, sonuc) => {
      siparisler.push({
        statusKind: row.statusKind,
        currency: row.currency,
        revenueKurus: row.revenueKurus,
        profitKurus: row.profitKurus,
        sonuc,
      });
    },
  });
  // Elle siparişler az (onlarca) — tarih filtresi yerine ay ayıklaması burada (karışık tarih biçimi).
  const manuel = await prisma.manualOrder.findMany({
    select: {
      orderedAt: true,
      statusKind: true,
      currency: true,
      revenueKurus: true,
      profitKurus: true,
      breakdownJson: true,
    },
  });
  const manueller: DokumManuelSiparis[] = manuel
    .filter((m) => monthKey(m.orderedAt, FINANCE_TIME_ZONE) === month)
    .map((m) => {
      let dokum: DokumManuelSiparis["dokum"] = null;
      try {
        const b = parseManualOrderBreakdown(m.breakdownJson).breakdown;
        dokum = {
          productCost: b.productCost,
          packagingCost: b.packagingCost,
          commissionCost: b.commissionCost,
          cargoCost: b.cargoCost,
          expenseRulesCost: b.expenseRulesCost,
          customExpensesCost: b.customExpensesCost,
          outputVat: b.outputVat,
          inputVatCredit: b.inputVatCredit,
        };
      } catch {
        dokum = null;
      }
      return {
        statusKind: m.statusKind,
        currency: m.currency,
        revenueKurus: m.revenueKurus,
        profitKurus: m.profitKurus,
        dokum,
      };
    });
  return karDokumuTopla(month, siparisler, manueller);
}
