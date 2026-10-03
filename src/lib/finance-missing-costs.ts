/**
 * "KÂR HESABI TAM DEĞİL" UYARISININ SEBEPLERİ — Raporlar.
 *
 * Uyarı yalnız sayı veriyordu ("Son 12 ayda 27 siparişin kâr hesabı tam değil") ve kullanıcı
 * hangi ürüne maliyet girmesi gerektiğini bulmak için siparişleri tek tek açmak zorundaydı.
 * 4 Eki 2026 ölçümü: son 30 günde 17 eksik siparişin sebebi 11 maliyetsiz ürün (çoğu 26 Eylül'de
 * Shopify'dan eklenenler), maliyeti girilmemiş "Hediye Paketi" satırı ve ürüne bağlanmamış 3 HB
 * ilanıydı.
 *
 * Kâr burada HESAPLANMAZ: yalnız kayıtlı özette kârı eksik görünen siparişlerin kalemlerine
 * bakılır. Ürün listesine yalnız maliyeti BUGÜN de bilinmeyen ürünler girer — maliyeti sonradan
 * girilmiş ürün "maliyet gir" diye gösterilmez.
 */
import { prisma } from "@/lib/prisma";
import { resolveProductCost } from "@/core/product-cost";
import { filamentFiyatlariOku } from "@/lib/filament-fiyatlari";
import type { ProductSalesItem, ProductSalesOrder } from "@/lib/finance-product-sales";

export interface EksikMaliyetliUrun {
  productId: string;
  name: string;
  imageUrl: string | null;
  /** Kârı eksik kalan sipariş sayısı. */
  siparis: number;
}

export interface BaglanmamisSatis {
  ad: string;
  siparis: number;
}

export interface KarEksikSebepleri {
  urunler: EksikMaliyetliUrun[];
  /** Listede gösterilmeyen (sınır dışı kalan) maliyetsiz ürün sayısı. */
  digerUrun: number;
  baglanmamis: BaglanmamisSatis[];
  digerBaglanmamis: number;
}

export interface KarEksikAdaylari {
  /** Ürün kimliği → kârı eksik siparişleri (+ kalemdeki ad, ürün silinmişse kullanılır). */
  urunler: Map<string, { siparisler: Set<string>; ad: string }>;
  /** Ürüne bağlanmamış satır adı → kârı eksik siparişleri. */
  adlar: Map<string, Set<string>>;
}

const URUN_SINIRI = 8;
const AD_SINIRI = 6;

const anahtar = (platform: string, externalOrderId: string) => `${platform}\u0000${externalOrderId}`;

/**
 * Kârı eksik (hiç hesaplanamamış ya da kısmi) siparişlerin kalemlerinden aday çıkar (SAF).
 *
 * Aylık toplamlarla AYNI eleme: iptal ve TL dışı siparişler sayılmaz.
 */
export function karEksikAdaylari({
  orders,
  items,
  rangeFrom,
}: {
  orders: ProductSalesOrder[];
  items: ProductSalesItem[];
  rangeFrom: Date;
}): KarEksikAdaylari {
  const eksik = new Set<string>();
  for (const order of orders) {
    if (order.orderedAt < rangeFrom) continue;
    if (order.statusKind === "cancelled") continue;
    if ((order.currency || "TRY").trim().toUpperCase() !== "TRY") continue;
    if (order.profitKurus == null || order.profitPartial) {
      eksik.add(anahtar(order.platform, order.externalOrderId));
    }
  }

  const urunler: KarEksikAdaylari["urunler"] = new Map();
  const adlar: KarEksikAdaylari["adlar"] = new Map();
  for (const item of items) {
    if (item.statusKind === "cancelled") continue;
    const siparis = anahtar(item.platform, item.externalOrderId);
    if (!eksik.has(siparis)) continue;
    if (item.productId) {
      const kayit = urunler.get(item.productId) ?? { siparisler: new Set<string>(), ad: item.productName };
      kayit.siparisler.add(siparis);
      urunler.set(item.productId, kayit);
    } else {
      const ad = item.productName.trim() || "Adı okunamayan ürün";
      const kayit = adlar.get(ad) ?? new Set<string>();
      kayit.add(siparis);
      adlar.set(ad, kayit);
    }
  }
  return { urunler, adlar };
}

/** Çok siparişte geçen önce, eşitlikte ada göre — liste her açılışta aynı sırada dursun. */
function sirala<T extends { siparis: number }>(liste: T[], ad: (x: T) => string): T[] {
  return liste.sort((a, b) => b.siparis - a.siparis || ad(a).localeCompare(ad(b), "tr-TR"));
}

/**
 * Adaylardan GÖSTERİLECEK listeyi kur: ürünün maliyeti bugün hâlâ bilinmiyor mu diye bakılır
 * (Ürünler ekranındaki "maliyet eksik" süzgeciyle aynı karar: `productionCostKnown`).
 */
export async function karEksikSebepleriniOku(adaylar: KarEksikAdaylari): Promise<KarEksikSebepleri> {
  const urunler: EksikMaliyetliUrun[] = [];
  const kimlikler = [...adaylar.urunler.keys()];
  if (kimlikler.length > 0) {
    const dilimOku = (ids: string[]) =>
      prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          imageUrl: true,
          cost: { include: { filamentType: { select: { costPerGram: true } } } },
        },
      });
    const [ayarSatirlari, filamentFiyatlari] = await Promise.all([
      prisma.appSetting.findMany(),
      filamentFiyatlariOku(),
    ]);
    const ayarlar = Object.fromEntries(ayarSatirlari.map((row) => [row.key, row.value]));
    // IN(...) SQLite'ın parametre sınırına dayanmasın diye dilimlenir.
    const urunBilgisi: Awaited<ReturnType<typeof dilimOku>> = [];
    for (let i = 0; i < kimlikler.length; i += 500) {
      urunBilgisi.push(...(await dilimOku(kimlikler.slice(i, i + 500))));
    }
    const bilgi = new Map(urunBilgisi.map((u) => [u.id, u]));
    for (const [productId, aday] of adaylar.urunler) {
      const urun = bilgi.get(productId);
      // Ürün silinmişse maliyeti girilemez — listede "maliyet gir" diye durmasının anlamı yok.
      if (!urun) continue;
      const cozum = resolveProductCost(
        urun.cost,
        ayarlar,
        urun.cost?.filamentType?.costPerGram ?? 0,
        filamentFiyatlari
      );
      if (cozum?.productionCostKnown) continue;
      urunler.push({
        productId,
        name: urun.name || aday.ad,
        imageUrl: urun.imageUrl ?? null,
        siparis: aday.siparisler.size,
      });
    }
  }
  const baglanmamis = [...adaylar.adlar].map(([ad, siparisler]) => ({ ad, siparis: siparisler.size }));

  const siraliUrun = sirala(urunler, (x) => x.name);
  const siraliAd = sirala(baglanmamis, (x) => x.ad);
  return {
    urunler: siraliUrun.slice(0, URUN_SINIRI),
    digerUrun: Math.max(0, siraliUrun.length - URUN_SINIRI),
    baglanmamis: siraliAd.slice(0, AD_SINIRI),
    digerBaglanmamis: Math.max(0, siraliAd.length - AD_SINIRI),
  };
}
