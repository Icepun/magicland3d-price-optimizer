import { remotePrisma } from "@/lib/prisma";
import { processSingleton } from "./process-singleton";
import { dilimBasi, SAKLAMA_GUN } from "@/lib/yazici-doluluk";

/**
 * Yazıcı DOLULUK örneği — relay her 5 dakikalık dilimde yazıcının durumunu bir kez yazar
 * (`PrinterStatusSample`, şema v52). Kullanıcı isteği (9 Eki 2026 denetimi): "yazıcı son 7 günde
 * ne kadar bastı, ne kadar boşta kaldı?" — şimdiye kadar yalnız SON durum tutuluyordu.
 *
 * İKİ MASAÜSTÜ (Mac + Windows) aynı anda relay çalıştırabilir. Aynı dilim tek satırdır (birincil
 * anahtar); yazıcıya ULAŞAMAYAN makinenin "offline" kaydını ulaşanın gerçek durumu ezer, tersi
 * olmaz. Yazamazsa sessizce geçer (bir sonraki dilimde yine dener) — relay'i asla bozmaz.
 */
const sonDilim = processSingleton("relay_ornekDilim", () => new Map<string, number>());
const sonTemizlik = processSingleton("relay_ornekTemizlik", () => ({ ms: 0 }));

export async function durumOrnegiYaz(printerConfigId: string, status: string, nowMs: number): Promise<void> {
  const dilim = dilimBasi(nowMs);
  if (sonDilim.get(printerConfigId) === dilim) return;
  sonDilim.set(printerConfigId, dilim);
  try {
    await remotePrisma.$executeRawUnsafe(
      `INSERT INTO "PrinterStatusSample" ("printerConfigId", "bucketMs", "status") VALUES (?, ?, ?)
       ON CONFLICT ("printerConfigId", "bucketMs") DO UPDATE SET "status" = excluded."status"
       WHERE "PrinterStatusSample"."status" = 'offline' AND excluded."status" <> 'offline'`,
      printerConfigId,
      dilim,
      status
    );
  } catch {
    sonDilim.delete(printerConfigId); // sonraki turda yeniden dene
  }
  // Saatte bir: saklama süresinden eski örnekleri sil (tablo sınırsız büyümesin).
  if (nowMs - sonTemizlik.ms > 60 * 60_000) {
    sonTemizlik.ms = nowMs;
    try {
      await remotePrisma.$executeRawUnsafe(
        `DELETE FROM "PrinterStatusSample" WHERE "bucketMs" < ?`,
        nowMs - SAKLAMA_GUN * 86_400_000
      );
    } catch {
      /* sonraki saat dener */
    }
  }
}

