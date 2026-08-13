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

/** Hiçbir şey okunamadı — BİLİNMEYEN ≠ SIFIR, ikisi de null kalır. */
const BOS: ModelOlcum = { gramaj: null, estPrintMin: null };

/** `readModelMeta` çıktısını ölçüme çevir; geçersiz sayılar null'a düşer. */
function topla(meta: { grams: number | null; estPrintMin: number | null }): ModelOlcum {
  const sayi = (v: number | null) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return { gramaj: sayi(meta.grams), estPrintMin: sayi(meta.estPrintMin) };
}

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
export interface ModelOlcum {
  /** Filament gramajı (gram) — okunamazsa null. */
  gramaj: number | null;
  /** Tahmini baskı süresi (dakika) — okunamazsa null. */
  estPrintMin: number | null;
}

/** Geriye uyum: yalnız gramaj isteyen çağrılar için. */
export async function readModelGramaj(mf: ModelGramajInput): Promise<number | null> {
  return (await readModelOlcum(mf)).gramaj;
}

/**
 * Gramaj VE süre — ikisi de aynı okumadan çıkar, ikinci bir indirme gerekmez.
 *
 * ⚠️ Süre de gramaj gibi YALNIZ GÖSTERİM içindir. Ürünün maliyetindeki baskı süresi
 * (`ProductCost.printTimeHours`) Berke'nin elle girdiği değerdir ve buradan ETKİLENMEZ —
 * hangi makinede basacağı onun kararı, dosya yalnız o makinenin tahminini söyler.
 */
export async function readModelOlcum(mf: ModelGramajInput): Promise<ModelOlcum> {
  const isGcode = /\.(gcode|gco|g)$/i.test(`.${mf.fileType}`) || /gcode|gco/i.test(mf.fileType);

  // ── Buluttaki dosya ──────────────────────────────────────────────────────────────────
  if (mf.r2Key) {
    const cfg = await getR2Config();
    if (!cfg) return BOS;

    if (isGcode) {
      const size = await getObjectSize(mf.r2Key, cfg);
      if (size <= 0) return BOS;
      // Küçük dosyada tek istek yeter; büyükte baş + son.
      if (size <= WINDOW * 2) {
        const buf = await getObjectRange(mf.r2Key, cfg, 0, size - 1);
        return topla(gcodeMeta(buf.toString("latin1")));
      }
      const [head, tail] = await Promise.all([
        getObjectRange(mf.r2Key, cfg, 0, WINDOW - 1),
        getObjectRange(mf.r2Key, cfg, size - WINDOW, size - 1),
      ]);
      // `readHeadTail` ile AYNI birleştirme — ayrıştırıcı iki parçayı satır sonuyla ayrılmış bekler.
      return topla(gcodeMeta(`${head.toString("latin1")}\n${tail.toString("latin1")}`));
    }

    // 3MF: zip, aralıkla okunamaz. Geçici dosyaya yazıp mevcut okuyucuya ver.
    const buf = await getObjectBytes(mf.r2Key, cfg);
    const tmp = path.join(os.tmpdir(), `gramaj-${crypto.randomUUID()}.3mf`);
    try {
      await fs.promises.writeFile(tmp, buf);
      return topla(readModelMeta(tmp));
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // ── Yereldeki dosya ──────────────────────────────────────────────────────────────────
  if (!mf.storedPath || !fs.existsSync(mf.storedPath)) return BOS;
  return topla(readModelMeta(mf.storedPath));
}
