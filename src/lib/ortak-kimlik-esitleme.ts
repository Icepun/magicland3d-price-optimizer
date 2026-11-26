import { ortakKimlikleriEsitle, type KimlikDogrulayici, type KimlikTanimi } from "@/lib/ortak-kimlik-deposu";
import type { OrtakEntegrasyon } from "@/core/ortak-kimlik";
import { TrendyolClient } from "@/services/trendyol-client";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { ShopifyClient } from "@/services/shopify-client";
import { N11Client } from "@/services/n11-client";
import { HepsijetClient } from "@/services/hepsijet-client";
import { TRENDYOL_KIMLIK } from "@/services/trendyol-settings";
import { HEPSIBURADA_KIMLIK } from "@/services/hepsiburada-settings";
import { SHOPIFY_KIMLIK } from "@/services/shopify-settings";
import { N11_KIMLIK } from "@/services/n11-settings";
import { HEPSIJET_KIMLIK } from "@/services/hepsijet-settings";

/** Ortak kayda taşınan bütün entegrasyonlar. */
export const KIMLIK_TANIMLARI: readonly KimlikTanimi[] = [
  TRENDYOL_KIMLIK,
  HEPSIBURADA_KIMLIK,
  SHOPIFY_KIMLIK,
  N11_KIMLIK,
  HEPSIJET_KIMLIK,
];

/**
 * Yüklemeden önce SALT OKUNUR deneme — Entegrasyonlar sayfasındaki "Bağlantıyı dene" ile aynı
 * çağrılar. Pazaryerine hiçbir şey yazılmaz.
 */
export const DOGRULAYICILAR: Partial<Record<OrtakEntegrasyon, KimlikDogrulayici>> = {
  trendyol: async (a) => {
    await new TrendyolClient({
      sellerId: a.sellerId ?? "",
      apiKey: a.apiKey ?? "",
      apiSecret: a.apiSecret ?? "",
      environment: a.environment === "stage" ? "stage" : "prod",
      integratorName: a.integratorName || "SelfIntegration",
    }).listApprovedProducts({ page: 0, size: 1 });
  },
  hepsiburada: async (a) => {
    await new HepsiburadaClient({
      merchantId: a.merchantId ?? "",
      secretKey: a.secretKey || a.password || "",
      developerUsername: a.developerUsername || a.username || "",
      environment: a.environment === "prod" ? "prod" : "test",
    }).test();
  },
  shopify: async (a) => {
    // Mağaza (Storefront) anahtarı yoksa denenecek bir şey yok — yalnız sipariş anahtarı taşınır.
    if (!a.storefrontAccessToken) return;
    await new ShopifyClient({
      shopDomain: a.shopDomain ?? "",
      apiVersion: a.apiVersion || "2024-10",
      storefrontAccessToken: a.storefrontAccessToken,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
    }).testConnection();
  },
  n11: async (a) => {
    await new N11Client({ appKey: a.appKey ?? "", appSecret: a.appSecret ?? "" }).urunler(0, 1);
  },
  hepsijet: async (a) => {
    const ortam = a.ortam === "prod" ? "prod" : "test";
    await new HepsijetClient({
      ortam,
      kullaniciAdi: a[`${ortam}.kullaniciAdi`] ?? "",
      sifre: a[`${ortam}.sifre`] ?? "",
    }).girisYap();
  },
};

const g = globalThis as unknown as { __MLHUB_ORTAK_KIMLIK__?: boolean };

/**
 * Açılıştan kısa süre sonra bu bilgisayardaki bilgileri ortak kayda taşı: ortakta yoksa ya da bu
 * bilgisayardaki daha sonra kaydedilmişse. Böylece bir bilgisayarda girilen bilgi (ör. Windows'taki
 * n11) diğer bilgisayarlara ve telefona kendiliğinden geçer.
 */
export function startOrtakKimlikEsitleme(): void {
  if (g.__MLHUB_ORTAK_KIMLIK__) return;
  g.__MLHUB_ORTAK_KIMLIK__ = true;
  const zamanlayici = setTimeout(() => {
    void ortakKimlikleriEsitle(KIMLIK_TANIMLARI, DOGRULAYICILAR).catch(() => {});
  }, 15_000);
  zamanlayici.unref?.();
}
