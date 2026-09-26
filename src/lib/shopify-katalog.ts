import { normalizeMatchKey } from "@/core/order-match";
import type { ShopifyProduct } from "@/services/shopify-client";

/**
 * SHOPIFY KATALOĞU ↔ UYGULAMA — "hangi Shopify ürünü uygulamada yok, hangisi Shopify'dan kalktı?"
 *
 * Saf (veritabanı/ağ yok) → kökten test edilir. Rotalar veriyi toplar, kararı burası verir.
 *
 * NEDEN: eski "Yeni Ürün Ekle" mağazadaki HER eksik varyantı adını Shopify'dan alarak topluca
 * ekliyordu; ayarların içinde saklıydı ve seçim yoktu. Mayıs'tan beri hiç kullanılmamış, 80 ürün
 * birikmişti. Artık kullanıcı listeden seçer, adı kendisi verir; istemediğini gizler.
 *
 * Eşleşme kuralları:
 *   1) Shopify ilanının varyant kimliği tutuyorsa ürün BAĞLI — listede görünmez.
 *   2) Tutmuyorsa barkod / stok kodu / ad ile uygulamadaki SERBEST bir ürüne (Shopify ilanı hiç
 *      olmayan ya da ilanı Shopify'dan kalkmış) benziyorsa ÖNERİ olarak gösterilir: tek tıkla
 *      bağlanır, kopya ürün açılmaz. Sahada iki ürün Shopify'da yeniden açılmış, eski ilanları
 *      ölü kalmıştı — tam bu durum.
 *   3) Aynı anahtar birden çok ürüne düşerse öneri YAPILMAZ (kör eşleşme yanlış ürüne bağlar).
 */

export interface KatalogVaryanti {
  /** Shopify varyant kimliği (sayısal, metin). Listing.externalId ile aynı biçim. */
  id: string;
  /** Varyant adı; tek varyantlı üründe boş. */
  etiket: string;
  sku: string | null;
  barkod: string | null;
  fiyat: number;
  stok: number;
  /** Varyanta özel görsel, yoksa ürünün ilk görseli. */
  gorsel: string | null;
}

export interface KatalogUrunu {
  id: string;
  baslik: string;
  tur: string;
  /** Ürünün ilk (öne çıkan) görseli. */
  gorsel: string | null;
  /** Vitrine açıldığı (yoksa oluşturulduğu) an — "en yeni önce" sıralaması. */
  eklendi: string | null;
  satista: boolean;
  handle: string;
  varyantlar: KatalogVaryanti[];
}

/** Karşılaştırmaya giren uygulama ürünü (Prisma satırından kurulur). */
export interface UygulamaUrunu {
  id: string;
  name: string;
  alias: string | null;
  barcode: string;
  sku: string;
  imageUrl: string | null;
  hidden: boolean;
  /** Shopify ilanının varyant kimliği; Shopify ilanı yoksa null. */
  shopifyVaryantId: string | null;
  /** Tüm ilanlarının (her platform) barkod ve stok kodları. */
  ilanBarkodlari: readonly string[];
  ilanSkulari: readonly string[];
}

export type OneriNedeni = "barkod" | "stok-kodu" | "ad";

export interface UrunOnerisi {
  urunId: string;
  ad: string;
  gorsel: string | null;
  neden: OneriNedeni;
}

export interface FarkVaryanti extends KatalogVaryanti {
  oneri: UrunOnerisi | null;
}

export interface FarkUrunu extends Omit<KatalogUrunu, "varyantlar"> {
  toplamVaryant: number;
  varyantlar: FarkVaryanti[];
}

export interface KalkanUrun {
  urunId: string;
  ad: string;
  gorsel: string | null;
  /** Ölü ilanın varyant kimliği. */
  varyantId: string;
  /**
   * Shopify'daki yeni hâli: bu ürüne benzeyen, uygulamada olmayan varyantlar — "yeni ilana bağla".
   * Ürün Shopify'da çok seçenekli olarak yeniden açıldıysa her seçenek ayrı aday olur.
   */
  oneriler: { varyantId: string; baslik: string; etiket: string; gorsel: string | null; fiyat: number }[];
}

export interface KatalogFarki {
  yeni: FarkUrunu[];
  gizli: FarkUrunu[];
  kalkan: KalkanUrun[];
  /** Katalog eksik geldi gibi (çok fazla "kalkan") → kalkan listesi gösterilmedi. */
  kalkanSupheli: boolean;
  ozet: { yeniUrun: number; yeniVaryant: number; gizliUrun: number; kalkan: number };
}

const VARSAYILAN_VARYANT = "Default Title";

/** Shopify ürününü karşılaştırma biçimine indir. */
export function katalogUrunu(p: ShopifyProduct): KatalogUrunu {
  const urunGorseli = p.image?.src ?? null;
  return {
    id: String(p.id),
    baslik: p.title,
    tur: p.product_type || "Shopify",
    gorsel: urunGorseli,
    eklendi: p.published_at || p.created_at || null,
    satista: p.status === "active",
    handle: p.handle,
    varyantlar: (p.variants ?? []).map((v) => ({
      id: String(v.id),
      etiket: v.title && v.title !== VARSAYILAN_VARYANT ? v.title : "",
      sku: v.sku?.trim() || null,
      barkod: v.barcode?.trim() || null,
      fiyat: Number(v.price) || 0,
      stok: v.inventory_quantity ?? 0,
      gorsel: v.image ?? urunGorseli,
    })),
  };
}

/** Uygulamada kullanılacak tam ad: "Başlık — Varyant" (tek varyantta yalnız başlık). */
export function varyantTamAdi(baslik: string, etiket: string): string {
  return etiket ? `${baslik} — ${etiket}` : baslik;
}

/** Ürünün barkodu: Shopify barkodu → stok kodu → varyant kimliği (sipariş eşleşmesi ile aynı sıra). */
export function varyantKimligi(v: Pick<KatalogVaryanti, "id" | "barkod" | "sku">): string {
  return v.barkod || v.sku || `shopify-variant-${v.id}`;
}

/**
 * Anahtar → ürün indeksi. Aynı ürün aynı anahtarı iki kez verebilir (ürün barkodu = ilan
 * barkodu); bu belirsizlik SAYILMAZ. Farklı iki ürüne düşen anahtar indeksten çıkar.
 */
function tekilIndeks(girdiler: readonly { anahtar: string; urun: UygulamaUrunu }[]): Map<string, UygulamaUrunu> {
  const indeks = new Map<string, UygulamaUrunu>();
  const belirsiz = new Set<string>();
  for (const { anahtar, urun } of girdiler) {
    if (!anahtar) continue;
    const onceki = indeks.get(anahtar);
    if (!onceki) {
      if (!belirsiz.has(anahtar)) indeks.set(anahtar, urun);
    } else if (onceki.id !== urun.id) {
      indeks.delete(anahtar);
      belirsiz.add(anahtar);
    }
  }
  return indeks;
}

const kirp = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

export function katalogFarki(
  katalog: readonly KatalogUrunu[],
  urunler: readonly UygulamaUrunu[],
  yoksayilan: ReadonlySet<string>
): KatalogFarki {
  const canli = new Set<string>();
  for (const k of katalog) for (const v of k.varyantlar) canli.add(v.id);

  const bagli = new Set<string>();
  const serbest: UygulamaUrunu[] = [];
  for (const u of urunler) {
    if (u.shopifyVaryantId) bagli.add(u.shopifyVaryantId);
    if (!u.shopifyVaryantId || !canli.has(u.shopifyVaryantId)) serbest.push(u);
  }

  const barkodIndeksi = tekilIndeks(
    serbest.flatMap((u) => [u.barcode, ...u.ilanBarkodlari].map((b) => ({ anahtar: kirp(b), urun: u })))
  );
  const skuIndeksi = tekilIndeks(
    serbest.flatMap((u) => [u.sku, ...u.ilanSkulari].map((s) => ({ anahtar: kirp(s), urun: u })))
  );
  const adIndeksi = tekilIndeks(
    serbest.flatMap((u) =>
      [u.name, u.alias].map((a) => ({ anahtar: normalizeMatchKey(a), urun: u }))
    )
  );

  const oneriBul = (k: KatalogUrunu, v: KatalogVaryanti): UrunOnerisi | null => {
    const adaylar: [string, Map<string, UygulamaUrunu>, OneriNedeni][] = [
      [v.barkod ?? "", barkodIndeksi, "barkod"],
      [varyantKimligi(v), barkodIndeksi, "barkod"],
      [v.sku ?? "", skuIndeksi, "stok-kodu"],
      [v.sku ?? "", barkodIndeksi, "stok-kodu"],
      [normalizeMatchKey(varyantTamAdi(k.baslik, v.etiket)), adIndeksi, "ad"],
      // Ürün Shopify'da seçenekli olarak yeniden açıldıysa ("Kupa" → "Kupa — 20 cm") başlık tutar.
      [normalizeMatchKey(k.baslik), adIndeksi, "ad"],
    ];
    for (const [anahtar, indeks, neden] of adaylar) {
      if (!anahtar) continue;
      const u = indeks.get(anahtar);
      if (u) return { urunId: u.id, ad: u.alias?.trim() || u.name, gorsel: u.imageUrl, neden };
    }
    return null;
  };

  const yeni: FarkUrunu[] = [];
  const gizli: FarkUrunu[] = [];
  for (const k of katalog) {
    const yeniVar: FarkVaryanti[] = [];
    const gizliVar: FarkVaryanti[] = [];
    for (const v of k.varyantlar) {
      if (bagli.has(v.id)) continue;
      const satir: FarkVaryanti = { ...v, oneri: oneriBul(k, v) };
      (yoksayilan.has(v.id) ? gizliVar : yeniVar).push(satir);
    }
    const { varyantlar: _hepsi, ...ust } = k;
    void _hepsi;
    if (yeniVar.length) yeni.push({ ...ust, toplamVaryant: k.varyantlar.length, varyantlar: yeniVar });
    if (gizliVar.length) gizli.push({ ...ust, toplamVaryant: k.varyantlar.length, varyantlar: gizliVar });
  }
  const enYeniOnce = (a: FarkUrunu, b: FarkUrunu) =>
    (b.eklendi ?? "").localeCompare(a.eklendi ?? "") || a.baslik.localeCompare(b.baslik, "tr");
  yeni.sort(enYeniOnce);
  gizli.sort(enYeniOnce);

  // Shopify'dan kalkanlar: ilanı ölü, gizlenmemiş ürünler. Yeni bir varyant ona benziyorsa
  // "yeni ilana bağla" önerisi taşır (iki taraftan da aynı düzeltme yapılabilsin).
  const tersOneri = new Map<string, KalkanUrun["oneriler"]>();
  for (const k of [...yeni, ...gizli]) {
    for (const v of k.varyantlar) {
      if (!v.oneri) continue;
      const liste = tersOneri.get(v.oneri.urunId) ?? [];
      if (liste.length < 8) {
        liste.push({ varyantId: v.id, baslik: k.baslik, etiket: v.etiket, gorsel: v.gorsel, fiyat: v.fiyat });
      }
      tersOneri.set(v.oneri.urunId, liste);
    }
  }
  const kalkanAdaylari: KalkanUrun[] = urunler
    .filter((u) => !u.hidden && u.shopifyVaryantId && !canli.has(u.shopifyVaryantId))
    .map((u) => ({
      urunId: u.id,
      ad: u.alias?.trim() || u.name,
      gorsel: u.imageUrl,
      varyantId: u.shopifyVaryantId as string,
      oneriler: tersOneri.get(u.id) ?? [],
    }))
    .sort((a, b) => a.ad.localeCompare(b.ad, "tr"));

  // EMNİYET: Shopify listesi yarım gelirse (izin/ağ sorunu) bağlı ürünlerin çoğu "kalkmış" görünür
  // ve kullanıcı sağlam ürünleri silmeye yönlendirilirdi. Olağandışı çoklukta liste GÖSTERİLMEZ.
  const bagliSayisi = urunler.filter((u) => u.shopifyVaryantId).length;
  const kalkanSupheli = kalkanAdaylari.length > Math.max(20, bagliSayisi * 0.25);
  const kalkan = kalkanSupheli ? [] : kalkanAdaylari;

  return {
    yeni,
    gizli,
    kalkan,
    kalkanSupheli,
    ozet: {
      yeniUrun: yeni.length,
      yeniVaryant: yeni.reduce((t, k) => t + k.varyantlar.length, 0),
      gizliUrun: gizli.length,
      kalkan: kalkan.length,
    },
  };
}

/** Gizlenen varyant listesi (AppSetting metni) — bozuk değer boş listedir. */
export function yoksayilanOku(deger: string | null | undefined): Set<string> {
  if (!deger) return new Set();
  try {
    const ham = JSON.parse(deger) as unknown;
    return new Set(Array.isArray(ham) ? ham.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  } catch {
    return new Set();
  }
}

export const YOKSAYILAN_AZAMI = 3000;

/** Ekle/çıkar → saklanacak metin. En eski kayıtlar tavanı aşınca düşer. */
export function yoksayilanYaz(
  onceki: ReadonlySet<string>,
  ekle: readonly string[],
  cikar: readonly string[]
): string {
  const sonuc = new Set(onceki);
  for (const c of cikar) sonuc.delete(c);
  for (const e of ekle) {
    if (!e) continue;
    sonuc.delete(e); // yeniden eklenen sona geçsin (budamada en son düşsün)
    sonuc.add(e);
  }
  const liste = [...sonuc];
  return JSON.stringify(liste.slice(Math.max(0, liste.length - YOKSAYILAN_AZAMI)));
}

// ─── Ekleme planı ────────────────────────────────────────────────────────────────────────────

export interface EklemeSecimi {
  shopifyUrunId: string;
  /** Kullanıcının verdiği ad (çok varyantlıda grup adı). Boşsa Shopify adı. */
  ad: string;
  /** Sipariş üzerine üretilir → stok tutulmaz, "stok bitti" uyarısı çıkmaz. */
  siparisUzerine: boolean;
  /** Elde olan adet (sipariş üzerine değilse). */
  stok: number;
  varyantlar: readonly { id: string; etiket?: string | null }[];
}

export interface PlanliUrun {
  id: string;
  barkod: string;
  sku: string;
  ad: string;
  kategori: string;
  fiyat: number;
  stok: number;
  gorsel: string | null;
  siparisUzerine: boolean;
  grupId: string | null;
  varyantEtiketi: string | null;
  ilan: { id: string; varyantId: string; sku: string | null; barkod: string | null; fiyat: number; stok: number };
}

export interface EklemePlani {
  gruplar: { id: string; ad: string }[];
  urunler: PlanliUrun[];
  atlanan: { varyantId: string; ad: string; neden: string }[];
}

/**
 * Seçimleri yazılacak ürünlere çevirir — veri (fiyat, görsel, barkod) KATALOGDAN gelir, istemciden
 * yalnız ad/etiket/stok kararı alınır.
 *
 * İki ve daha fazla varyant seçildiyse varyant grubu kurulur (ad = grup adı, ürün adı "Ad — Etiket");
 * tek varyant tek ürün olur. Barkod çakışırsa varyant kimliğine düşülür, o da doluysa atlanır.
 */
export function eklemePlani(
  secimler: readonly EklemeSecimi[],
  katalog: readonly KatalogUrunu[],
  bagliVaryantlar: ReadonlySet<string>,
  mevcutBarkodlar: ReadonlySet<string>,
  yeniId: (onek: string) => string
): EklemePlani {
  const plan: EklemePlani = { gruplar: [], urunler: [], atlanan: [] };
  const katalogIndeksi = new Map(katalog.map((k) => [k.id, k]));
  const kullanilanBarkod = new Set(mevcutBarkodlar);
  const islenenVaryant = new Set<string>();

  for (const s of secimler) {
    const k = katalogIndeksi.get(s.shopifyUrunId);
    if (!k) {
      for (const v of s.varyantlar) plan.atlanan.push({ varyantId: v.id, ad: s.ad, neden: "Shopify'da bulunamadı" });
      continue;
    }
    const secilen: { v: KatalogVaryanti; etiket: string }[] = [];
    for (const sv of s.varyantlar) {
      const v = k.varyantlar.find((x) => x.id === sv.id);
      const ad = varyantTamAdi(k.baslik, v?.etiket ?? "");
      if (!v) {
        plan.atlanan.push({ varyantId: sv.id, ad, neden: "Shopify'da bulunamadı" });
      } else if (bagliVaryantlar.has(v.id) || islenenVaryant.has(v.id)) {
        plan.atlanan.push({ varyantId: v.id, ad, neden: "Zaten ekli" });
      } else {
        islenenVaryant.add(v.id);
        secilen.push({ v, etiket: sv.etiket?.trim() || v.etiket });
      }
    }
    if (secilen.length === 0) continue;

    const temelAd = s.ad.trim() || (secilen.length === 1 ? varyantTamAdi(k.baslik, secilen[0].v.etiket) : k.baslik);
    const grupId = secilen.length > 1 ? yeniId("vg") : null;
    const eklenecek: PlanliUrun[] = [];
    secilen.forEach(({ v, etiket }, i) => {
      const adaylar = [varyantKimligi(v), `shopify-variant-${v.id}`];
      const barkod = adaylar.find((b) => !kullanilanBarkod.has(b));
      if (!barkod) {
        plan.atlanan.push({ varyantId: v.id, ad: varyantTamAdi(k.baslik, v.etiket), neden: "Bu barkodla bir ürün zaten var" });
        return;
      }
      kullanilanBarkod.add(barkod);
      const id = yeniId("shp");
      const grupEtiketi = grupId ? etiket || `Seçenek ${i + 1}` : null;
      eklenecek.push({
        id,
        barkod,
        sku: v.sku || barkod,
        ad: grupEtiketi ? `${temelAd} — ${grupEtiketi}` : temelAd,
        kategori: k.tur || "Shopify",
        fiyat: v.fiyat,
        stok: s.siparisUzerine ? 0 : Math.max(0, Math.floor(s.stok || 0)),
        gorsel: v.gorsel ?? k.gorsel,
        siparisUzerine: s.siparisUzerine,
        grupId,
        varyantEtiketi: grupEtiketi,
        ilan: { id: `listing_${id}_shopify`, varyantId: v.id, sku: v.sku, barkod: v.barkod, fiyat: v.fiyat, stok: v.stok },
      });
    });
    if (eklenecek.length === 0) continue;
    // Barkod yüzünden tek varyant kaldıysa grup kurulmaz (tek üyeli grup anlamsız).
    if (grupId && eklenecek.length === 1) {
      eklenecek[0] = { ...eklenecek[0], ad: temelAd, grupId: null, varyantEtiketi: null };
    } else if (grupId) {
      plan.gruplar.push({ id: grupId, ad: temelAd });
    }
    plan.urunler.push(...eklenecek);
  }
  return plan;
}
