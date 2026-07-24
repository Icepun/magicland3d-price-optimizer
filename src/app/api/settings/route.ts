import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { settingsBodyAffectsProfit } from "@/lib/pricing-inputs";
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
    invalidateOrdersCache();
  }
  bustCache("settings:");
  return NextResponse.json({ ok: true });
}
