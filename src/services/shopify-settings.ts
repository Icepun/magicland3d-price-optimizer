import path from "node:path";
import { ayarDosyasiOku, ayarDosyasiYaz } from "@/lib/ayar-dosyasi";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";

/**
 * Shopify auth — Storefront API (GraphQL).
 *
 * Headless kanalında üretilen "Özel Erişim Belirteci" (shpat_...) ile
 * /api/{version}/graphql.json endpoint'ine direkt erişim. OAuth gerektirmez,
 * Basic dahil tüm Shopify planlarında çalışır.
 *
 * Kapsamlar (Storefront API izinleri ekranından açık olmalı):
 *   - unauthenticated_read_product_listings
 *   - unauthenticated_read_product_inventory
 *
 * NOT: Storefront API sadece "active" (yayında, müşteriye görünür) ürünleri
 * döndürür. Draft/archived ürünler dahil değildir.
 */
export interface ShopifyCredentials {
  shopDomain: string;
  apiVersion: string;
  storefrontAccessToken: string;
  /** Yeni dev dashboard: Client ID + Secret → client_credentials → Admin API (siparişler). Opsiyonel. */
  clientId?: string;
  clientSecret?: string;
}

interface StoredShopifySettings {
  shopDomain?: string;
  apiVersion?: string;
  storefrontAccessToken?: string;
  clientId?: string;
  clientSecret?: string;
}

const DEFAULT_API_VERSION = "2024-10";

function getSettingsFilePath() {
  return (
    process.env.SHOPIFY_SETTINGS_FILE ||
    path.join(process.cwd(), "data", "shopify-settings.json")
  );
}

async function readStoredSettings(): Promise<StoredShopifySettings> {
  // Yalnız dosya yoksa boş; bozuksa yedek, o da yoksa HATA (anahtarlar boş dosyanın üstüne yazılmasın).
  return ayarDosyasiOku<StoredShopifySettings>(getSettingsFilePath());
}

async function writeStoredSettings(settings: StoredShopifySettings) {
  // Geçici dosya + yeniden adlandırma: yazarken çökme yarım dosya bırakmaz; önceki iyi kopya yedekte.
  await ayarDosyasiYaz(getSettingsFilePath(), settings);
}

export async function getShopifyCredentials(): Promise<ShopifyCredentials> {
  const settings = await readStoredSettings();
  const shopDomain = settings.shopDomain?.trim() ?? "";
  const apiVersion = settings.apiVersion?.trim() || DEFAULT_API_VERSION;
  const storefrontAccessToken = tryDecryptSecret(settings.storefrontAccessToken);
  const clientId = settings.clientId?.trim() || undefined;
  const clientSecret = tryDecryptSecret(settings.clientSecret) || undefined;

  if (!shopDomain) {
    throw new Error("Shopify mağaza alan adı eksik");
  }
  if (!storefrontAccessToken) {
    throw new Error(
      "Shopify Storefront API token eksik. Headless kanalı → Storefront API → Özel Erişim Belirteci'ni kopyalayıp buraya yapıştır."
    );
  }

  return { shopDomain, apiVersion, storefrontAccessToken, clientId, clientSecret };
}

export async function getPublicShopifySettings() {
  const settings = await readStoredSettings();
  const storefrontAccessToken = tryDecryptSecret(settings.storefrontAccessToken);
  const clientSecret = tryDecryptSecret(settings.clientSecret);

  return {
    shopDomain: settings.shopDomain ?? "",
    apiVersion: settings.apiVersion ?? DEFAULT_API_VERSION,
    hasStorefrontAccessToken: Boolean(storefrontAccessToken),
    storefrontAccessTokenMasked: maskSecret(storefrontAccessToken),
    clientId: settings.clientId ?? "",
    hasClientSecret: Boolean(clientSecret),
    clientSecretMasked: maskSecret(clientSecret),
  };
}

export async function saveShopifySettings(input: {
  shopDomain: string;
  apiVersion?: string;
  storefrontAccessToken?: string;
  clientId?: string;
  clientSecret?: string;
}) {
  const current = await readStoredSettings();
  const next: StoredShopifySettings = {
    ...current,
    shopDomain: input.shopDomain.trim(),
    apiVersion: input.apiVersion?.trim() || current.apiVersion || DEFAULT_API_VERSION,
  };
  if (input.storefrontAccessToken?.trim()) {
    next.storefrontAccessToken = encryptSecret(input.storefrontAccessToken.trim());
  }
  if (input.clientId !== undefined) {
    next.clientId = input.clientId.trim() || undefined;
  }
  if (input.clientSecret?.trim()) {
    next.clientSecret = encryptSecret(input.clientSecret.trim());
  }
  await writeStoredSettings(next);
}

export async function clearShopifyAccessToken() {
  const current = await readStoredSettings();
  delete current.storefrontAccessToken;
  await writeStoredSettings(current);
}
