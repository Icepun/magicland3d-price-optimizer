/**
 * Gider kategorilerinin varsayılan renk sırası — HEM sunucu HEM istemci kullanır.
 *
 * Ayrı dosyada duruyor çünkü `expense-admin.ts` sunucuya özel şeyler (Prisma, node:crypto)
 * içe aktarıyor; istemci bileşeni onu import edemez.
 *
 * Uygulamanın kendi grafik tokenları kullanılıyor ki gider grafiği Raporlar'daki
 * grafiklerle aynı dili konuşsun.
 */
export const KATEGORI_RENKLERI = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
