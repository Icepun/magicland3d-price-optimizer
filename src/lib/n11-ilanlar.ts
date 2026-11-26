/**
 * n11 İLANLARI — ürün listesi (`/ms/product-query`) satırını okuma ve ürünlerimizle eşleştirme.
 * Senkron ucu (`/api/n11/sync-products`) bu saf fonksiyonları kullanır.
 */
import { normalizeMatchKey } from "@/core/order-match";

export interface N11Ilan {
  /** Satıcı stok kodu — siparişler bununla gelir (Listing.externalSku). */
  stockCode: string;
  /** `n11-<ürün kimliği>` — sayısal kimlik başka pazaryerinin kimliğiyle çakışmasın diye önekli. */
  externalId: string;
  /** n11 barkodu; boşsa stok kodu (siparişler barkod kovasında stok koduyla da aranır). */
  barcode: string;
  name: string;
  /** Satış fiyatı (KDV dahil); bilinmiyorsa 0 — yazılmaz. */
  price: number;
  listPrice: number | null;
  stock: number;
  /** Komisyon — KDV HARİÇ kesir (n11 "%X + KDV" bildirir; fiyat motoru 1,2 ile çevirir). 0 geçerli. */
  commissionRate: number | null;
  /** İlanın satış KDV oranı (%). */
  vatRate: number | null;
  imageUrl: string | null;
}

const sayi = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v == null || v === "") return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};
const metin = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

/**
 * Ürün listesi satırı → ilan. Satışta olmayan (onaylanmamış / kapatılmış) ilan ve stok kodu
 * olmayan satır alınmaz (null).
 */
export function n11IlaniOku(ham: Record<string, unknown>): N11Ilan | null {
  const stockCode = metin(ham.stockCode);
  if (!stockCode) return null;
  // Ölçüldü (26 Kas 2026): 341 "Active", 5 "CatalogRejected" (katalog reddi → satışta değil).
  if (metin(ham.status) && metin(ham.status) !== "Active") return null;
  const id = metin(ham.n11ProductId) || metin(ham.productId) || stockCode;
  const fiyat = sayi(ham.salePrice);
  const liste = sayi(ham.listPrice);
  const stok = Math.floor(sayi(ham.quantity));
  const kom = sayi(ham.commissionRate);
  const kdv = sayi(ham.vatRate);
  const gorseller = Array.isArray(ham.imageUrls) ? ham.imageUrls : [];
  const gorsel = gorseller.map(metin).find((u) => /^https?:\/\//i.test(u)) ?? null;
  return {
    stockCode,
    externalId: `n11-${id}`,
    barcode: metin(ham.barcode) || stockCode,
    name: metin(ham.title) || stockCode,
    price: Number.isFinite(fiyat) && fiyat > 0 ? fiyat : 0,
    listPrice: Number.isFinite(liste) && liste > 0 ? liste : null,
    stock: Number.isFinite(stok) && stok > 0 ? stok : 0,
    commissionRate: Number.isFinite(kom) && kom >= 0 && kom < 100 ? Math.round((kom / 100) * 1_000_000) / 1_000_000 : null,
    vatRate: Number.isFinite(kdv) && kdv >= 0 && kdv < 100 ? kdv : null,
    imageUrl: gorsel,
  };
}

/**
 * İlanları ürünlerimizle eşleştir: stok kodu / barkod → ürünün barkodu, SKU'su ya da başka bir
 * platform ilanının barkodu / stok kodu. Aynı anahtar BİRDEN ÇOK ürüne düşerse o anahtar belirsizdir
 * ve kullanılmaz (yanlış ürüne bağlamaktansa havuza bırakmak; sipariş eşleştirmesiyle aynı kural).
 */
export function n11IlanEslestir(
  ilanlar: readonly N11Ilan[],
  urunler: ReadonlyArray<{ id: string; barcode: string | null; sku: string | null }>,
  digerIlanlar: ReadonlyArray<{ productId: string; barcode: string | null; externalSku: string | null }>
): Array<{ ilan: N11Ilan; productId: string | null }> {
  const harita = new Map<string, Set<string>>();
  const ekle = (anahtar: string | null, productId: string) => {
    const k = normalizeMatchKey(anahtar);
    if (!k) return;
    const s = harita.get(k) ?? new Set<string>();
    s.add(productId);
    harita.set(k, s);
  };
  for (const u of urunler) {
    ekle(u.barcode, u.id);
    ekle(u.sku, u.id);
  }
  for (const l of digerIlanlar) {
    ekle(l.barcode, l.productId);
    ekle(l.externalSku, l.productId);
  }
  return ilanlar.map((ilan) => {
    const adaylar = new Set<string>();
    for (const anahtar of [ilan.stockCode, ilan.barcode]) {
      const bulunan = harita.get(normalizeMatchKey(anahtar));
      if (bulunan) for (const id of bulunan) adaylar.add(id);
    }
    return { ilan, productId: adaylar.size === 1 ? [...adaylar][0] : null };
  });
}
