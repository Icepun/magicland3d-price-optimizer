/**
 * Model dosyasının FİLAMENT GRAMAJINI oku — yazıcılar arası karşılaştırma için.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ BU DEĞER ÜRÜN MALİYETİNE GİRMEZ. ASLA.
 *
 * İki ayrı gramaj alanı var ve karıştırılmamalı:
 *
 *   `ProductCost.filamentWeight`  → Berke'nin ELLE girdiği değer. Kâr, maliyet ve
 *                                   "gram başına kazanç" hesaplarının kaynağı budur.
 *                                   Berke bunu başka yollarla da hesaplayıp giriyor.
 *   `ProductModelFile.gramaj`     → dilimlenmiş DOSYANIN kendi gramajı (burada okunan).
 *                                   YALNIZ Modeller sayfasında, YALNIZ bilgi olarak.
 *
 * Amaç: aynı ürünün dört yazıcı için ayrı dosyaları farklı miktarda filament harcıyor
 * (destek yapısı, dolgu, dilimleyici ayarı makineye göre değişir). Bu fark hiçbir yerde
 * görünmüyordu; "bunu hangi makinede bassam daha az malzeme gider" sorusu tahminle
 * cevaplanıyordu.
 *
 * Koruma testi: `src/lib/model-gramaj.test.ts` — bu alanın maliyet yoluna sızmadığını
 * kaynak taramasıyla kilitler.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * OKUMA MALİYETİ: gcode'un gramajı başlıkta ve altbilgide yazılı, gövdede değil. Bu yüzden
 * yalnız baş ve son 400 KB aralık isteğiyle çekilir — 178 MB'lık dosyada bile ~800 KB iner.
 * Kütüphane 8,4 GB; tam indirme yapılsaydı doldurma işlemi o kadar veri çekerdi.
 * 3MF sıkıştırılmış bir arşiv olduğu için aralıkla okunamaz; tamamı iner (ortalama ~6 MB).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { gcodeMeta, readModelMeta } from "@/core/printers/model-colors";
import { getObjectBytes, getObjectRange, getObjectSize, getR2Config } from "./r2";

/** Baş/son okuma penceresi — `readHeadTail`'ın gcode için kullandığı değerle aynı. */
const WINDOW = 400_000;

export interface ModelGramajInput {
  r2Key: string | null;
  storedPath: string;
  fileType: string;
}

/**
 * Dosyanın gramajını (gram) döndür; okunamazsa `null`.
 *
 * `null` ile `0` KARIŞTIRILMAZ: gramajı okunamayan dosya "0 gram" değildir. Çağıran taraf
 * bunu "—" olarak göstermeli (BİLİNMEYEN ≠ SIFIR).
 */
export async function readModelGramaj(mf: ModelGramajInput): Promise<number | null> {
  const isGcode = /\.(gcode|gco|g)$/i.test(`.${mf.fileType}`) || /gcode|gco/i.test(mf.fileType);

  // ── Buluttaki dosya ──────────────────────────────────────────────────────────────────
  if (mf.r2Key) {
    const cfg = await getR2Config();
    if (!cfg) return null;

    if (isGcode) {
      const size = await getObjectSize(mf.r2Key, cfg);
      if (size <= 0) return null;
      // Küçük dosyada tek istek yeter; büyükte baş + son.
      if (size <= WINDOW * 2) {
        const buf = await getObjectRange(mf.r2Key, cfg, 0, size - 1);
        return gcodeMeta(buf.toString("latin1")).grams;
      }
      const [head, tail] = await Promise.all([
        getObjectRange(mf.r2Key, cfg, 0, WINDOW - 1),
        getObjectRange(mf.r2Key, cfg, size - WINDOW, size - 1),
      ]);
      // `readHeadTail` ile AYNI birleştirme — ayrıştırıcı iki parçayı satır sonuyla ayrılmış bekler.
      return gcodeMeta(`${head.toString("latin1")}\n${tail.toString("latin1")}`).grams;
    }

    // 3MF: zip, aralıkla okunamaz. Geçici dosyaya yazıp mevcut okuyucuya ver.
    const buf = await getObjectBytes(mf.r2Key, cfg);
    const tmp = path.join(os.tmpdir(), `gramaj-${crypto.randomUUID()}.3mf`);
    try {
      await fs.promises.writeFile(tmp, buf);
      return readModelMeta(tmp).grams;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // ── Yereldeki dosya ──────────────────────────────────────────────────────────────────
  if (!mf.storedPath || !fs.existsSync(mf.storedPath)) return null;
  return readModelMeta(mf.storedPath).grams;
}
