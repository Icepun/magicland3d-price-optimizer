import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-error";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { FILAMENT_COLORS, groupSpools } from "@/core/filament-groups";
import { renkCipleri, TEMEL_RENKLER } from "@/app/spools/spools-view";
import { loadFilamentSettings } from "@/lib/filament-settings";
import { yaziciOzeti } from "@/lib/panel-bugun";

/**
 * Panel "Bugün" şeridinin yazıcı + filament kısmı (gönderilecek siparişleri Panel zaten
 * paylaşılan ["orders"] sorgusundan sayar). Yazıcıya BAĞLANMAZ: relay'in yazdığı satır okunur.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const [snapshots, kayitli, spools, filamentSettings] = await Promise.all([
      remotePrisma.printerSnapshot.findMany({
        select: { printerConfigId: true, name: true, status: true, online: true, updatedAt: true },
      }),
      remotePrisma.printerConfig.findMany({ where: { enabled: true }, select: { id: true } }),
      prisma.filamentSpool.findMany({
        where: { isActive: true },
        select: {
          id: true, name: true, material: true, brand: true,
          colorName: true, colorHex: true, colorKey: true,
          totalGrams: true, remainingGrams: true, openedAt: true,
        },
      }),
      loadFilamentSettings(),
    ]);
    const acik = new Set(kayitli.map((c) => c.id));
    const yazici = yaziciOzeti(
      snapshots
        .filter((s) => acik.has(s.printerConfigId))
        .map((s) => ({
          name: s.name,
          status: s.status,
          online: Boolean(s.online),
          updatedAtMs: s.updatedAt instanceof Date ? s.updatedAt.getTime() : null,
        })),
      Date.now()
    );
    // BİTEN renkler — Filament sayfasının "N renk bitti" sayısıyla AYNI fonksiyon (kapalı makarası
    // kalmayan + hiç kaydı olmayan temel renkler). Ayrı bir tanım iki ekranda farklı sayı verirdi.
    const bitenRenkler = renkCipleri(
      groupSpools(spools),
      (g) => filamentSettings.groupThresholds[g.key] ?? filamentSettings.threshold,
      filamentSettings.threshold,
      FILAMENT_COLORS.filter((c) => (TEMEL_RENKLER as readonly string[]).includes(c.key)),
      filamentSettings.watchedGroups ?? []
    )
      .filter((c) => c.durum === "biten")
      .map((c) => c.label);
    return NextResponse.json({ yazici, bitenRenkler }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
