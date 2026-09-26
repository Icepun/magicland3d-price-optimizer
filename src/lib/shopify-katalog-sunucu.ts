import { prisma } from "@/lib/prisma";
import { ShopifyClient } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import {
  katalogFarki,
  katalogUrunu,
  yoksayilanOku,
  yoksayilanYaz,
  type KatalogFarki,
  type KatalogUrunu,
  type UygulamaUrunu,
} from "@/lib/shopify-katalog";

/**
 * Shopify kataloğunun SUNUCU tarafı: çekme (kısa önbellekli), uygulama ürünlerini okuma,
 * gizlenen listesi. Karar mantığı saf dosyada: `lib/shopify-katalog.ts`.
 */

/** Katalog çekimi 2-3 sn sürüyor (3 sayfa); ekle/bağla peş peşe aynı veriyi kullanır. */
const KATALOG_TTL_MS = 3 * 60_000;
export const YOKSAYILAN_ANAHTARI = "shopifyYoksayilanVaryantlar";

let onbellek: { zaman: number; urunler: KatalogUrunu[]; magaza: string } | null = null;
let suren: Promise<{ urunler: KatalogUrunu[]; magaza: string }> | null = null;

/** Shopify kataloğu (vitrindeki ürünler). `tazele` önbelleği atlar. */
export async function katalogGetir(tazele = false): Promise<{ urunler: KatalogUrunu[]; magaza: string }> {
  if (!tazele && onbellek && Date.now() - onbellek.zaman < KATALOG_TTL_MS) {
    return { urunler: onbellek.urunler, magaza: onbellek.magaza };
  }
  // Aynı anda gelen istekler tek çekimi paylaşır (rozet + pencere birlikte açılınca iki kez çekmesin).
  if (suren) return suren;
  suren = (async () => {
    const kimlik = await getShopifyCredentials();
    const ham = await new ShopifyClient(kimlik).listAllProducts();
    const urunler = ham.map(katalogUrunu);
    onbellek = { zaman: Date.now(), urunler, magaza: kimlik.shopDomain };
    return { urunler, magaza: kimlik.shopDomain };
  })();
  try {
    return await suren;
  } finally {
    suren = null;
  }
}

/** Karşılaştırmaya giren uygulama ürünleri (tek sorgu + ilanlar). */
export async function uygulamaUrunleriniOku(): Promise<UygulamaUrunu[]> {
  const satirlar = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      alias: true,
      barcode: true,
      sku: true,
      imageUrl: true,
      hidden: true,
      listings: { select: { platform: true, externalId: true, externalSku: true, barcode: true } },
    },
  });
  return satirlar.map((p) => {
    const shopify = p.listings.find((l) => l.platform === "shopify");
    return {
      id: p.id,
      name: p.name,
      alias: p.alias,
      barcode: p.barcode,
      sku: p.sku,
      imageUrl: p.imageUrl,
      hidden: p.hidden,
      shopifyVaryantId: shopify?.externalId?.trim() || null,
      ilanBarkodlari: p.listings.map((l) => l.barcode ?? "").filter(Boolean),
      ilanSkulari: p.listings.map((l) => l.externalSku ?? "").filter(Boolean),
    };
  });
}

export async function yoksayilanlariOku(): Promise<Set<string>> {
  const satir = await prisma.appSetting.findUnique({ where: { key: YOKSAYILAN_ANAHTARI } });
  return yoksayilanOku(satir?.value);
}

/** Gizlenenlere ekle / gizlenenlerden çıkar. Değişiklik yoksa yazmaz. */
export async function yoksayilanlariGuncelle(ekle: readonly string[], cikar: readonly string[]): Promise<void> {
  if (ekle.length === 0 && cikar.length === 0) return;
  const onceki = await yoksayilanlariOku();
  const deger = yoksayilanYaz(onceki, ekle, cikar);
  if (deger === JSON.stringify([...onceki])) return;
  await prisma.appSetting.upsert({
    where: { key: YOKSAYILAN_ANAHTARI },
    create: { key: YOKSAYILAN_ANAHTARI, value: deger },
    update: { value: deger },
  });
}

/** Silinecek ürünlerin Shopify varyant kimlikleri (silmeden ÖNCE okunmalı). */
export async function shopifyVaryantlari(urunIdleri: readonly string[]): Promise<string[]> {
  if (urunIdleri.length === 0) return [];
  const ilanlar = await prisma.listing.findMany({
    where: { productId: { in: [...urunIdleri] }, platform: "shopify", externalId: { not: null } },
    select: { externalId: true },
  });
  return ilanlar.map((l) => l.externalId?.trim() ?? "").filter(Boolean);
}

export async function katalogFarkiniHesapla(tazele = false): Promise<KatalogFarki & { magaza: string }> {
  const [{ urunler: katalog, magaza }, urunler, yoksayilan] = await Promise.all([
    katalogGetir(tazele),
    uygulamaUrunleriniOku(),
    yoksayilanlariOku(),
  ]);
  return { ...katalogFarki(katalog, urunler, yoksayilan), magaza };
}
