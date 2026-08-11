import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bustProfitInputCaches, bustInventoryAlertCaches } from "@/lib/cache-busting";
import { settingsBodyAffectsProfit } from "@/lib/pricing-inputs";
import { FILAMENT_SETTING_PREFIX } from "@/lib/filament-settings";
import { bustCache, swr } from "@/lib/route-cache";

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
  const body = await req.json() as Record<string, string>;

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

  await Promise.all(
    Object.entries(body).map(([key, value]) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      })
    )
  );

  // Yalnız kâr girdisi (vat/komisyon/maliyet/paketleme) değişince pahalı orders
  // önbelleğini düş. Planner hedef stok / R2 ayarları / UI tercihleri gibi finans-dışı
  // anahtarlar önbelleği KORUR → Siparişler sekmesi gereksiz yere 1-3sn yeniden çekmez.
  if (settingsBodyAffectsProfit(body)) {
    bustProfitInputCaches();
  }
  // Filament eşiği / grup susturma bu uçtan yazılıyor ama uyarıyı zil 90 saniyelik önbellekten
  // okuyor: kullanıcı az önce susturduğu uyarıyı görmeye devam ederdi.
  if (Object.keys(body).some((key) => key.startsWith(FILAMENT_SETTING_PREFIX))) {
    bustInventoryAlertCaches();
  }
  bustCache("settings:");
  return NextResponse.json({ ok: true });
}
