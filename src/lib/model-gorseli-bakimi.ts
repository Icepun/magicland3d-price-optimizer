import fs from "node:fs";
import path from "node:path";
import { gorselleriTasi } from "@/lib/model-gorseli";
import { remotePrisma } from "@/lib/prisma";
import { perfYaz } from "@/lib/server-perf-log";

/**
 * AÇILIŞ BAKIMI — eski `ProductModelFile.thumbnail` kolonuna (eski sürüm bir cihazın) yazdığı
 * görselleri `ProductModelFileThumb` tablosuna taşır (bkz. lib/model-gorseli.ts).
 *
 * ⚠️ Açılışı ASLA bekletmez, hata fırlatmaz. ⚠️ GÜNDE EN ÇOK BİR KEZ (bu cihazda): Turso soğukken
 * tablo taraması saniyeler sürüyor; her açılışta koşması 23 Kas 2026'da uygulamayı tıkadı.
 * Ayrı bağlantıdan (`remotePrisma`) gider → ekranın sorgu kuyruğunu bekletmez.
 */
const GUN_MS = 24 * 60 * 60_000;
let basladi = false;

function isaretYolu(): string | null {
  const ayar = process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE;
  return ayar ? path.join(path.dirname(ayar), ".model-gorseli-bakimi") : null;
}

function sonKosu(yol: string | null): number {
  if (!yol) return 0;
  try {
    return Number(fs.readFileSync(yol, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

export async function modelGorseliBakimi(): Promise<void> {
  if (basladi) return;
  basladi = true;
  const yol = isaretYolu();
  if (Date.now() - sonKosu(yol) < GUN_MS) return;
  const bas = Date.now();
  try {
    const sonuc = await gorselleriTasi(remotePrisma);
    if (yol) {
      try {
        fs.writeFileSync(yol, String(Date.now()));
      } catch {
        /* işaret yazılamadı — bir sonraki açılış yeniden dener */
      }
    }
    if (sonuc.tasinan > 0) {
      perfYaz(`MODEL-GORSELI ${sonuc.tasinan} görsel taşındı (${sonuc.yontem}, ${Date.now() - bas}ms)`);
    }
  } catch (error) {
    perfYaz(`MODEL-GORSELI taşıma düştü (${Date.now() - bas}ms): ${error instanceof Error ? error.message.slice(0, 160) : "?"}`);
  }
}
