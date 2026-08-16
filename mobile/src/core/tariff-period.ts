/**
 * TARİFE DÖNEMİ SINIRI — yeni bir kargo tarifesi başlarken eski dönem ne zaman kapanır?
 *
 * Kural eşleşmesi KAPSAYICI (`cargo-calculator.ts`: `date > validTo` ise elenir, `date < validFrom`
 * ise elenir). Dolayısıyla eski dönem yeninin başlangıcıyla AYNI ana kapatılırsa o an iki kural
 * birden eşleşir; bir milisaniyeden fazla önce kapatılırsa arada HİÇBİR kuralın uymadığı bir
 * boşluk kalır ve kargo sessizce 0 sayılır.
 *
 * Doğrusu tam olarak bir milisaniye öncesi: milisaniye çözünürlüğünde her an tek bir döneme düşer.
 * (14 Ağu 2026'da TEX tarifesinde bu 999 ms'lik boşluk gerçekten vardı.)
 */
export function tarifeDonemSiniri(baslangic: Date): { baslangic: Date; eskiBitis: Date } {
  return {
    baslangic,
    eskiBitis: new Date(baslangic.getTime() - 1),
  };
}

/** Dönem hesabı için gereken en az alan (kaynak Prisma da olabilir ham SQL de). */
interface DonemliKural {
  validFrom?: Date | number | string | null;
  validTo?: Date | number | string | null;
}

function msDeger(deger: DonemliKural["validFrom"]): number | null {
  if (deger == null) return null;
  if (deger instanceof Date) return Number.isNaN(deger.getTime()) ? null : deger.getTime();
  if (typeof deger === "number") return Number.isFinite(deger) ? deger : null;
  const t = Date.parse(deger);
  return Number.isNaN(t) ? null : t;
}

/**
 * BUGÜN YÜRÜRLÜKTE OLAN dönemin başlangıcı (ms) — yeni eklenen kural buraya katılır.
 *
 * ⚠️ NEDEN GEREKLİ: yeni bir kurala `validFrom` verilmezse kural SINIRSIZ olur ve tüm GEÇMİŞE
 * uygulanır. Tarife dönemlendikten sonra bu, eski dönemin kurallarıyla çakışır: aynı desi
 * bandına iki kural uyar, kazanan önceliğe/satır sırasına kalır ve geçmiş siparişlerin kârı
 * sessizce değişir. Bugüne bir barem eklemek geçmişi değiştirmemeli.
 *
 * BUGÜN yürürlükte olan kurallar arasından en son başlayanı seçilir. Yaklaşan (ileri tarihli)
 * dönem bilerek atlanır — yeni kural oraya değil, bugün geçerli olan tarifeye aittir.
 * Hiç tarihli dönem yoksa `null` (sınırsız) döner: henüz dönemlenmemiş bir platformda
 * davranış aynı kalır.
 *
 * ⚠️ `validTo` DOLU OLMASI kapanmış demek DEĞİL: ileri tarihli bir tarife başlatıldığında
 * bugünkü dönem de bitiş tarihi alır (yeni tarifenin bir milisaniye öncesi) ama hâlâ
 * yürürlüktedir. Kapanmış saymak, yeni kuralı sessizce "sınırsız" doğurup tüm geçmişe
 * uygulardı — tam da engellemeye çalıştığımız şey.
 */
export function yururluktekiDonemBaslangiciMs(
  kurallar: readonly DonemliKural[],
  simdiMs: number
): number | null {
  let enSon: number | null = null;
  for (const r of kurallar) {
    const bit = msDeger(r.validTo);
    if (bit != null && bit < simdiMs) continue; // gerçekten kapanmış dönem
    const bas = msDeger(r.validFrom);
    if (bas == null || bas > simdiMs) continue; // tarihsiz ya da yaklaşan dönem
    if (enSon == null || bas > enSon) enSon = bas;
  }
  return enSon;
}
