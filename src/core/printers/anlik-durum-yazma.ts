/**
 * YAZICI ANLIK DURUMU — buluta NE ZAMAN ve NASIL yazılır? (saf; veritabanına dokunmaz)
 *
 * Relay her 10 sn'de her yazıcının durumunu telefon için `PrinterSnapshot` satırına yazar.
 *
 * ── 19 Kas 2026 denetimi (Turso dökümü, sıradan bir gün) ─────────────────────────────────────
 * Bu yazma günde 28.800 ayrı istekti — uygulamanın en sık çalışan sorgusu ve hepsi YAZMA
 * (her biri ayrı bir işlem). Basan yazıcıda nozulun canlı konumu her tur değiştiği için
 * "değişmediyse yazma" koruması hiç devreye girmiyordu; her yazma satırın tamamını (plaka
 * görseli dahil, ≤40 KB) gövdede taşıyordu ve arka plan şeridinde tur başına 5 ardışık
 * gidiş-dönüş demekti.
 *
 * Yeni düzen — telefonun gördüğü veri ve tazeliği AYNI:
 *   - Turun bütün yazmaları TEK istekte (tek işlem) gider.
 *   - Bu oturumda yazılmış satıra tam satır yerine yalnız KISMİ güncelleme gider; görsel
 *     yalnız değiştiğinde gövdeye girer.
 *   - İçeriği değişmeyen yazıcıların "hayattayım" damgası tek ifadede tazelenir.
 *   - Belirli aralıkla TAM yazma yapılır: satır dışarıdan silinmişse kendiliğinden geri gelir.
 */

export interface AnlikDurum {
  name: string;
  brand: string;
  status: string;
  online: boolean;
  statusMessage: string | null;
  productName: string | null;
  productImage: string | null;
  progress: number;
  nozzle: number;
  bed: number;
  currentFilename: string | null;
  etaSec: number | null;
  detail: string | null;
}

/** İçerik değişmese de `updatedAt` en geç bu aralıkla tazelenir (telefon "masaüstü açık mı"yı buradan anlar). */
export const KALP_ATISI_MS = 30_000;
/** Kısmi güncellemeler arasında en geç bu aralıkla TAM satır yazılır (kendini onarma). */
export const TAM_YAZMA_MS = 5 * 60_000;

/**
 * İçerik parmak izi — değişmediyse yazılmaz.
 * Kalan süre 30 sn'lik kovaya, ilerleme yüzdeye yuvarlanır: saniyelik oynama her turu
 * "değişti" saydırmasın (telefon ikisini de bu hassasiyette gösteriyor).
 */
export function anlikDurumAnahtari(s: AnlikDurum): string {
  const etaKovasi = s.etaSec == null ? "-" : String(Math.round(s.etaSec / 30));
  return [
    s.status, s.online, Math.round(s.progress * 100), s.currentFilename, s.nozzle, s.bed,
    s.productName, etaKovasi, s.statusMessage, s.detail,
  ].join("|");
}

/**
 * - "tam": satırın tamamı (yoksa oluşturur). Oturumun ilk yazması ve periyodik onarım.
 * - "kismi": var olan satırın alanları (görsel yalnız değiştiyse).
 * - "kalp": yalnız `updatedAt`.
 * - "yok": bu tur yazma yok.
 */
export type YazmaTuru = "tam" | "kismi" | "kalp" | "yok";

export function yazmaKarari(g: {
  /** Buluta en son yazılan içeriğin parmak izi (bu oturumda hiç yazılmadıysa undefined). */
  yazilanAnahtar: string | undefined;
  anahtar: string;
  /** Son başarılı yazma (herhangi bir tür). */
  sonYazma: number | undefined;
  /** Son başarılı TAM yazma. */
  sonTam: number | undefined;
  simdi: number;
}): YazmaTuru {
  if (g.sonYazma == null || g.sonTam == null) return "tam";
  const degisti = g.yazilanAnahtar !== g.anahtar;
  const kalpVadesi = g.simdi - g.sonYazma >= KALP_ATISI_MS;
  if (!degisti && !kalpVadesi) return "yok";
  if (g.simdi - g.sonTam >= TAM_YAZMA_MS) return "tam";
  return degisti ? "kismi" : "kalp";
}

export interface YazmaKalemi {
  printerConfigId: string;
  durum: AnlikDurum;
  tur: Exclude<YazmaTuru, "yok">;
  /** Görsel, buluta en son yazılandan farklı mı? (yalnız "kismi" için anlamlı) */
  gorselDegisti: boolean;
}

export interface Ifade {
  sql: string;
  args: unknown[];
}

const KOLONLAR = [
  "name", "brand", "status", "statusMessage", "online", "productName", "productImage",
  "progress", "nozzle", "bed", "currentFilename", "etaSec", "detail",
] as const;

function deger(d: AnlikDurum, k: (typeof KOLONLAR)[number]): unknown {
  // SQLite'ta mantıksal değer 1/0'dır; Prisma da aynı kolona böyle yazar.
  return k === "online" ? (d.online ? 1 : 0) : d[k];
}

/**
 * Bir turun yazmalarını ifadelere çevirir. `updatedAt` çağıranın verdiği, Prisma'nın aynı kolona
 * yazdığı biçimle BİREBİR aynı değerdir (`toDbDate`) — telefon bu kolonu yaş hesabında kullanıyor
 * ve karışık biçim sıralamayı/karşılaştırmayı sessizce bozar.
 */
export function yazmaIfadeleri(kalemler: readonly YazmaKalemi[], updatedAt: string | number): Ifade[] {
  const ifadeler: Ifade[] = [];
  const kalpler: string[] = [];
  for (const k of kalemler) {
    if (k.tur === "kalp") {
      kalpler.push(k.printerConfigId);
      continue;
    }
    if (k.tur === "tam") {
      const kolonlar = ["printerConfigId", ...KOLONLAR, "updatedAt"];
      ifadeler.push({
        sql:
          `INSERT INTO "PrinterSnapshot" (${kolonlar.map((c) => `"${c}"`).join(", ")}) ` +
          `VALUES (${kolonlar.map(() => "?").join(", ")}) ` +
          `ON CONFLICT ("printerConfigId") DO UPDATE SET ` +
          [...KOLONLAR, "updatedAt"].map((c) => `"${c}" = excluded."${c}"`).join(", "),
        args: [k.printerConfigId, ...KOLONLAR.map((c) => deger(k.durum, c)), updatedAt],
      });
      continue;
    }
    // Kısmi: görsel değişmediyse gövdeye HİÇ girmez (≤40 KB, baskı boyunca aynı).
    const kolonlar = KOLONLAR.filter((c) => c !== "productImage" || k.gorselDegisti);
    ifadeler.push({
      sql:
        `UPDATE "PrinterSnapshot" SET ${[...kolonlar, "updatedAt"].map((c) => `"${c}" = ?`).join(", ")} ` +
        `WHERE "printerConfigId" = ?`,
      args: [...kolonlar.map((c) => deger(k.durum, c)), updatedAt, k.printerConfigId],
    });
  }
  if (kalpler.length) {
    ifadeler.push({
      sql: `UPDATE "PrinterSnapshot" SET "updatedAt" = ? WHERE "printerConfigId" IN (${kalpler.map(() => "?").join(", ")})`,
      args: [updatedAt, ...kalpler],
    });
  }
  return ifadeler;
}
