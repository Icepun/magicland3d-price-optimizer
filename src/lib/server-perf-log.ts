/**
 * SUNUCU AŞAMA ÖLÇER — yavaş bir isteğin süresinin NEREYE gittiğini yakalar.
 *
 * (Tarayıcı tarafındaki `perf-log.ts` ile karıştırma: o, Performans İzleme panelini besleyen
 * istemci tamponu. Bu dosya sunucuda çalışır ve `userData/perf.log` dosyasına yazar.)
 *
 * Neden gerekti: 20 Ağu 2026'da uygulama açıldıktan sonraki ilk `/api/printers` isteği
 * 128 SANİYE sürdü, ikincisi 11 ms. İncelemede sıradaki adayların hepsi ölçümle ELENDİ —
 * modül/chunk yükleme (rota 226 modül, 307 ms), yazıcı I/O (yazıcı başına soğuk yol ≤350 ms),
 * şema göçü (0-6 ms), veritabanı zaman aşımı aritmetiği. Yani süre bilinmeyen bir bekleme
 * noktasında geçiyor ve tek yakalama yolu isteği İÇERİDEN damgalamak.
 *
 * Kayıt yalnız eşiği aşan isteklerde yazılır — normal turlar log'u şişirmez.
 */
import fs from "node:fs";
import path from "node:path";

/** Bu süreyi aşan istek kayda geçer. */
const ESIK_MS = 3_000;

function perfDosyasi(): string {
  const ayar = process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE;
  const dizin = ayar ? path.dirname(ayar) : process.cwd();
  return path.join(dizin, "perf.log");
}

/** Tek satır yaz (hata yutulur — ölçüm hiçbir zaman isteği düşürmemeli). */
export function perfYaz(satir: string): void {
  try {
    fs.appendFileSync(perfDosyasi(), `[${new Date().toISOString()}] ${satir}\n`);
  } catch {
    /* ölçüm isteğin önüne geçmez */
  }
}

export interface AsamaOlcer {
  /** Bir aşamayı bitir ve süresini kaydet. */
  damga(ad: string): void;
  /** Toplam eşiği aşarsa aşama dökümünü perf.log'a yaz. */
  bitir(ek?: string): void;
  /** Test/teşhis için: aşama süreleri. */
  dokum(): { ad: string; ms: number }[];
}

export function asamaOlcer(etiket: string, esikMs = ESIK_MS): AsamaOlcer {
  const bas = Date.now();
  let sonDamga = bas;
  const asamalar: { ad: string; ms: number }[] = [];

  return {
    damga(ad: string): void {
      const simdi = Date.now();
      asamalar.push({ ad, ms: simdi - sonDamga });
      sonDamga = simdi;
    },
    bitir(ek?: string): void {
      const toplam = Date.now() - bas;
      if (toplam < esikMs) return;
      const dokum = asamalar.map((a) => `${a.ad}=${a.ms}ms`).join(" ");
      perfYaz(`YAVAS ${etiket} toplam=${toplam}ms ${dokum}${ek ? ` ${ek}` : ""}`);
    },
    dokum(): { ad: string; ms: number }[] {
      return [...asamalar];
    },
  };
}
