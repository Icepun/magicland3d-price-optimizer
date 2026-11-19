import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { perfYaz } from "@/lib/server-perf-log";
import { buyukKolonlariSondaTut, type SemaCalistirici } from "@/lib/buyuk-kolon-sonda";

/**
 * AÇILIŞ BAKIMI — büyük kolonlar (önizleme görseli) tabloda son kolon mu?
 *
 * Neden ve nasıl: `lib/buyuk-kolon-sonda.ts`. Burası yalnız o saf mantığı uygulamanın
 * veritabanına bağlar. Normalde tablo başına TEK hafif sorgudur ve hiçbir şey yazmaz; yalnız
 * tabloya yeni kolon eklenen bir sürümden sonra bir kez taşıma yapar.
 *
 * ⚠️ Açılışı ASLA bekletmez ve hata fırlatmaz (bkz. bellek: isteğe bağlı adım hızlı yolu
 * bloklamaz). Çağıran `void` ile bırakır.
 */
const calistirici: SemaCalistirici = {
  sorgu: (sql) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql),
  islem: async (ifadeler) => {
    // Uzak veritabanında tek istek ve zaman aşımı sarmalı YOK: taşıma onlarca MB yazıyor,
    // 6 sn'lik okuma tavanına takılmamalı. İkisi de tek işlemdir (ya hepsi ya hiçbiri).
    if (await batchWrite(ifadeler.map((sql) => ({ sql })))) return;
    await prisma.$transaction(ifadeler.map((sql) => prisma.$executeRawUnsafe(sql)));
  },
};

let basladi = false;

export async function buyukKolonBakimi(): Promise<void> {
  if (basladi) return;
  basladi = true;
  // Yalnız bulut veritabanında: arıza veri büyüdükçe ortaya çıkıyor; yerel geliştirme/test
  // dosyasına açılışta kendiliğinden yazmayalım.
  if (!process.env.TURSO_DATABASE_URL?.trim()) return;
  try {
    const bas = Date.now();
    const sonuclar = await buyukKolonlariSondaTut(calistirici);
    for (const s of sonuclar) {
      if (s.sonuc === "tasindi" || s.sonuc === "hata" || s.sonuc === "atlandi") {
        perfYaz(`BUYUK-KOLON ${s.tablo}.${s.kolon} ${s.sonuc} (${Date.now() - bas}ms)`);
      }
    }
  } catch {
    /* bakım uygulamayı etkilemez; sonraki açılış yeniden dener */
  }
}
