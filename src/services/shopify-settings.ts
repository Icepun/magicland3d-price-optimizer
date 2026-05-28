import fs from "node:fs/promises";
import path from "node:path";
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
}

interface StoredShopifySettings {
  shopDomain?: string;
  apiVersion?: string;
  storefrontAccessToken?: string;
}

const DEFAULT_API_VERSION = "2024-10";

function getSettingsFilePath() {
  return (
    process.env.SHOPIFY_SETTINGS_FILE ||
    path.join(process.cwd(), "data", "shopify-settings.json")
  );
}

async function readStoredSettings(): Promise<StoredShopifySettings> {
  try {
    const raw = await fs.readFile(getSettingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStoredSettings(settings: StoredShopifySettings) {
  const filePath = getSettingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function getShopifyCredentials(): Promise<ShopifyCredentials> {
  const settings = await readStoredSettings();
  const shopDomain = settings.shopDomain?.trim() ?? "";
  const apiVersion = settings.apiVersion?.trim() || DEFAULT_API_VERSION;
  const storefrontAccessToken = tryDecryptSecret(settings.storefrontAccessToken);

  if (!shopDomain) {
    throw new Error("Shopify mağaza alan adı eksik");
  }
  if (!storefrontAccessToken) {
    throw new Error(
      "Shopify Storefront API token eksik. Headless kanalı → Storefront API → Özel Erişim Belirteci'ni kopyalayıp buraya yapıştır."
    );
  }

  return { shopDomain, apiVersion, storefrontAccessToken };
}

export async function getPublicShopifySettings() {
  const settings = await readStoredSettings();
  const storefrontAccessToken = tryDecryptSecret(settings.storefrontAccessToken);

  return {
    shopDomain: settings.shopDomain ?? "",
    apiVersion: settings.apiVersion ?? DEFAULT_API_VERSION,
    hasStorefrontAccessToken: Boolean(storefrontAccessToken),
    storefrontAccessTokenMasked: maskSecret(storefrontAccessToken),
  };
}

export async function saveShopifySettings(input: {
  shopDomain: string;
  apiVersion?: string;
  storefrontAccessToken?: string;
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
  await writeStoredSettings(next);
}

export async function clearShopifyAccessToken() {
  const current = await readStoredSettings();
  delete current.storefrontAccessToken;
  await writeStoredSettings(current);
}
