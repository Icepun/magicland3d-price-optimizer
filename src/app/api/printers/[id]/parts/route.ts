import { NextRequest, NextResponse } from "next/server";
import { printerCfgCached } from "@/core/printers/config-cache";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerObjects } from "@/core/printers/moonraker";
import { bambuAtlananlar, getBambuStatus, mapBambuState } from "@/core/printers/bambu";
import { bambuNesnePoligonlari } from "@/core/printers/bambu-objects";
import { bambuParcaBilgisi } from "@/lib/bambu-parts";

export const dynamic = "force-dynamic";

type Cfg = { host: string; port: number; type: string; brand: string | null; accessCode: string | null; serial: string | null };

/**
 * Tabladaki parçalar — ad, merkez ve tepeden görünüş poligonu (tabla mm).
 *
 * AYRI bir uçtur çünkü yanıt ~3,8 KB ve %96'sı poligonlardan ibaret; 5 saniyelik panel
 * yoklamasına bindirilemez. Baskı boyunca değişmediği için yalnız seçici diyalog açılırken
 * bir kez çekilir.
 *
 * BAMBU: yazıcı parça listesini vermiyor — basılan 3MF'in kendisinden okunur (bkz.
 * lib/bambu-parts). Parça "adı" yazıcıya gidecek kimliktir (identify_id); ekranda ham ad
 * gösterilmediği için sorun değil. Parça yoksa `neden` kullanıcıya tek satır açıklama taşır.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // Panel bu ucu 5 sn'de bir çağırıyor; yapılandırma neredeyse hiç değişmiyor →
    // kısa ömürlü önbellek (ayar kaydedilince temizlenir).
    const cfg = await printerCfgCached<Cfg>(id);
    if (!cfg?.host) return NextResponse.json({ parts: [] });

    if (cfg.type === "bambu" || cfg.brand === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ parts: [], neden: "Bu yazıcı için erişim kodu girilmemiş." });
      }
      const s = await getBambuStatus(cfg.host, cfg.accessCode, cfg.serial);
      const durum = mapBambuState(s.gcodeState);
      if ((durum !== "printing" && durum !== "paused") || !s.filename) {
        return NextResponse.json({ parts: [], neden: "Baskı sürerken kullanılabilir." });
      }
      const bilgi = await bambuParcaBilgisi(id, s.filename);
      if (!bilgi) {
        return NextResponse.json({ parts: [], neden: "Bu baskının dosyası kütüphanede yok, parçalar okunamadı." });
      }
      if (!bilgi.etiketli) {
        return NextResponse.json({
          parts: [],
          neden: "Bu baskıda parça etiketi yok. Dilimleyicide nesne etiketlemeyi açıp yeniden dilimle.",
        });
      }
      return NextResponse.json({
        parts: bambuNesnePoligonlari(bilgi.nesneler),
        excluded: bambuAtlananlar(cfg.host, cfg.accessCode, cfg.serial).map(String),
      });
    }

    return NextResponse.json({ parts: await fetchMoonrakerObjects(cfg.host, cfg.port ?? 7125) });
  } catch (error) {
    return jsonError(error);
  }
}
