import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bustProfitInputCaches, bustInventoryAlertCaches } from "@/lib/cache-busting";
import { settingsBodyAffectsProfit } from "@/lib/pricing-inputs";
import { FILAMENT_SETTING_PREFIX } from "@/lib/filament-settings";
import { bustCache, swr } from "@/lib/route-cache";
import { invalidateR2Config } from "@/lib/r2";
import { batchWrite } from "@/lib/libsql-batch";
import { jsonError } from "@/lib/api-error";

/** Maliyet girdisi olan sayısal ayarlar — negatif ya da sayı olmayan değer KAYDEDİLMEZ. */
const SAYISAL_MALIYET_ANAHTARLARI = new Set([
  "costElectricityPerHour", "costMachineWearPerHour", "costLaborPerHour",
  "nylonRollPrice", "nylonRollGrams", "nylonLowGrams", "nylonMediumGrams", "nylonHighGrams",
  "tapePrice", "tapeProductsPerRoll", "cardQty", "cardPrice", "stickerQty", "stickerPrice", "sakizQty", "sakizPrice",
]);

export async function GET() {
  const data = await swr("settings:v1", 60_000, computeSettings);
  return NextResponse.json(data);
}

async function computeSettings() {
  const settings = await prisma.appSetting.findMany();
  return Object.fromEntries(
    settings.map((s: { key: string; value: string }) => [s.key, s.value])
  );
}

export async function POST(req: NextRequest) {
  // Değer null → anahtar SİLİNİR (ör. renge özel filament eşiğini "Sıfırla": eskiden "" yazılıyor,
  // sayfa bunu 0 eşik sanıyordu — denetim, 23 Kas 2026).
  const body = await req.json() as Record<string, string | null>;

  // KDV oranı TÜM kâr hesabına giriyor: bozuk bir değer sessizce kaydedilirse hesap
  // varsayılana düşer ve rakamlar aylarca yanlış kalabilir. Kaynakta reddet.
  if (body.vatRate !== undefined) {
    const rate = Number(body.vatRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json(
        { error: "KDV oranı 0 ile 100 arasında bir sayı olmalı." },
        { status: 400 }
      );
    }
  }

  // Shopify sabit komisyonu TÜM Shopify siparişlerine giriyor: boş "" kaydı %0 sayılıyordu.
  if (body.shopifyCommissionRate !== undefined) {
    const oran = Number(String(body.shopifyCommissionRate ?? "").trim().replace(",", "."));
    if (body.shopifyCommissionRate === null || !String(body.shopifyCommissionRate).trim() || !Number.isFinite(oran) || oran < 0 || oran > 100) {
      return NextResponse.json({ error: "Shopify komisyonu 0 ile 100 arasında bir sayı olmalı." }, { status: 400 });
    }
    body.shopifyCommissionRate = String(oran);
  }

  for (const [key, value] of Object.entries(body)) {
    if (!SAYISAL_MALIYET_ANAHTARLARI.has(key) || value === null) continue;
    const n = Number(String(value).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Maliyet alanları sıfır ya da pozitif bir sayı olmalı." }, { status: 400 });
    }
  }

  // Yalnız DEĞİŞEN anahtarlar yazılır, hepsi TEK atomik istekte. Eskiden anahtar başına ayrı yazma
  // sırayla koşuyordu (~2 sn) ve biri düşerse ayarların bir kısmı yeni bir kısmı eski kalıyor,
  // önbellek de hiç düşmüyordu (denetim, 23 Kas 2026).
  const anahtarlar = Object.keys(body);
  let degisen: [string, string][] = Object.entries(body)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => [k, String(v)]);
  let silinen: string[] = Object.entries(body).filter(([, v]) => v === null).map(([k]) => k);
  try {
    if (anahtarlar.length) {
      const mevcut = await prisma.appSetting.findMany({ where: { key: { in: anahtarlar } }, select: { key: true, value: true } });
      const eski = new Map(mevcut.map((m) => [m.key, m.value]));
      degisen = degisen.filter(([k, v]) => eski.get(k) !== v);
      silinen = silinen.filter((k) => eski.has(k));
    }
    if (degisen.length || silinen.length) {
      const ifadeler = [
        ...degisen.map(([k, v]) => ({
          sql: `INSERT INTO "AppSetting" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
          args: [k, v] as unknown[],
        })),
        ...silinen.map((k) => ({ sql: `DELETE FROM "AppSetting" WHERE "key" = ?`, args: [k] as unknown[] })),
      ];
      if (!(await batchWrite(ifadeler))) {
        await prisma.$transaction([
          ...degisen.map(([k, v]) => prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: v }, update: { value: v } })),
          ...silinen.map((k) => prisma.appSetting.deleteMany({ where: { key: k } })),
        ]);
      }
    }
  } catch (error) {
    return jsonError(error);
  } finally {
    // Önbellekler HER HÂLDE düşer — yarım kalmış bir yazmada bile ekran veritabanındakini göstersin.
    const yazilan = Object.fromEntries([...degisen, ...silinen.map((k) => [k, ""] as [string, string])]);
    // Yalnız kâr girdisi (vat/komisyon/maliyet/paketleme) değişince pahalı orders önbelleğini düş.
    if (settingsBodyAffectsProfit(yazilan)) bustProfitInputCaches();
    // Filament eşiği / grup susturma bu uçtan yazılıyor; zil 90 saniyelik önbellekten okuyor.
    if (Object.keys(yazilan).some((key) => key.startsWith(FILAMENT_SETTING_PREFIX))) bustInventoryAlertCaches();
    // R2 anahtarları değişmiş olabilir → yeni ayar ANINDA geçerli olsun.
    invalidateR2Config();
    bustCache("settings:");
  }
  return NextResponse.json({ ok: true, degisen: degisen.length + silinen.length });
}
