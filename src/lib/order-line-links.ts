import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { parseDbDate } from "@/lib/sqlite-date";
import { FINANCE_TIME_ZONE, monthKey } from "@/lib/monthly-finance";
import { satirBagiAnahtari, satirBaglariHaritasi } from "@/core/order-line-link";

/**
 * ELLE ÜRÜN BAĞI — okuma + bağlama/kaldırma (kural: `src/core/order-line-link.ts`).
 *
 * Bağ değişince yalnız ekrandaki liste değil GEÇMİŞ de düzelir:
 *  1. Kalem geçmişinde (`OrderItemSnapshot`) o adla kayıtlı satırlar ürüne bağlanır — Raporlar'daki
 *     ürün kırılımı, planlayıcının satış hızı ve kargo kapsamı `productId`'ye bakıyor.
 *  2. Etkilenen siparişlerin kâr özeti eski sayılır (`calculationVersion = 0`) ve yalnız o
 *     siparişler arka planda yeniden hesaplanır. İşaret olmadan donmuş özet hiç değişmezdi
 *     (bkz. shouldReplaceCapturedProfit); ay bazında hesap ise başka siparişlere de dokunurdu.
 *
 * Bağlanan kalemin adı HAM satır adı olarak kalır (sipariş listesi de öyle yazar): bağ
 * kaldırılınca aynı satırlar geri bulunabilsin.
 */

const OKUMA_DILIMI = 400;

/** Tüm elle bağlar → aranabilir harita. Tablo okunamazsa boş: eşleştirme eskisi gibi sürer. */
export async function satirBaglariniOku(): Promise<Map<string, string>> {
  try {
    const satirlar = await prisma.orderLineLink.findMany({
      select: { platform: true, lineKey: true, productId: true },
    });
    return satirBaglariHaritasi(satirlar);
  } catch (err) {
    console.warn("[ürün-bağı] kayıtlar okunamadı:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

interface KalemSatiri {
  id: string;
  externalOrderId: string;
  orderedAt: Date | null;
  productId: string | null;
}

/**
 * Bu platformda bu ADLA kayıtlı kalemler. `urunId` verilirse o ürüne bağlı olanlar, verilmezse
 * hiçbir ürüne bağlı OLMAYANLAR. Ad karşılaştırması eşleştirmeyle aynı biçimde (normalize) JS'te
 * yapılır — SQL'in harf/boşluk kuralı farklı.
 */
async function adaUyanKalemler(
  platform: string,
  lineKey: string,
  urunId: string | null
): Promise<KalemSatiri[]> {
  const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","externalOrderId","orderedAt","productId","productName"
       FROM "OrderItemSnapshot"
      WHERE "platform" = ? AND ${urunId ? `"productId" = ?` : `"productId" IS NULL`}`,
    ...(urunId ? [platform, urunId] : [platform])
  );
  return satirlar
    .filter((s) => satirBagiAnahtari(String(s.productName ?? "")) === lineKey)
    .map((s) => ({
      id: String(s.id),
      externalOrderId: String(s.externalOrderId),
      orderedAt: parseDbDate(s.orderedAt),
      productId: s.productId == null ? null : String(s.productId),
    }));
}

/** Kalemlerin `productId`'sini tek turda güncelle (uzak bağlantıda tek istek). */
async function kalemleriBagla(idler: string[], urunId: string | null): Promise<void> {
  if (idler.length === 0) return;
  const ifadeler: { sql: string; args: unknown[] }[] = [];
  for (let i = 0; i < idler.length; i += OKUMA_DILIMI) {
    const dilim = idler.slice(i, i + OKUMA_DILIMI);
    ifadeler.push({
      sql: `UPDATE "OrderItemSnapshot" SET "productId" = ? WHERE "id" IN (${dilim.map(() => "?").join(",")})`,
      args: [urunId, ...dilim],
    });
  }
  if (await batchWrite(ifadeler)) return;
  for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...ifade.args);
}

export interface EtkilenenSiparisler {
  platform: string;
  externalOrderIds: string[];
  /** "YYYY-MM" — yeniden hesabın kapsamı. */
  aylar: string[];
}

function etkilenenler(platform: string, kalemler: KalemSatiri[]): EtkilenenSiparisler {
  const idler = new Set<string>();
  const aylar = new Set<string>();
  for (const k of kalemler) {
    idler.add(k.externalOrderId);
    if (k.orderedAt) aylar.add(monthKey(k.orderedAt, FINANCE_TIME_ZONE));
  }
  return { platform, externalOrderIds: [...idler], aylar: [...aylar].sort() };
}

/** Etkilenen siparişlerin kâr özetini "yeniden hesaplanmalı" diye işaretle. */
async function ozetleriEskit(e: EtkilenenSiparisler): Promise<void> {
  for (let i = 0; i < e.externalOrderIds.length; i += OKUMA_DILIMI) {
    const dilim = e.externalOrderIds.slice(i, i + OKUMA_DILIMI);
    await prisma.$executeRawUnsafe(
      `UPDATE "OrderFinanceSnapshot" SET "calculationVersion" = 0
        WHERE "platform" = ? AND "externalOrderId" IN (${dilim.map(() => "?").join(",")})`,
      e.platform,
      ...dilim
    );
  }
}

/** Bağlamadan önce gösterilecek bilgi: mevcut bağ + bu adla kayıtlı sipariş sayısı. */
export async function bagOnizlemesi(
  platform: string,
  ad: string
): Promise<{ bag: { productId: string; lineName: string } | null; siparisSayisi: number }> {
  const lineKey = satirBagiAnahtari(ad);
  if (!lineKey) return { bag: null, siparisSayisi: 0 };
  const bag = await prisma.orderLineLink.findUnique({
    where: { platform_lineKey: { platform, lineKey } },
    select: { productId: true, lineName: true },
  });
  const kalemler = [
    ...(await adaUyanKalemler(platform, lineKey, null)),
    ...(bag ? await adaUyanKalemler(platform, lineKey, bag.productId) : []),
  ];
  return { bag, siparisSayisi: new Set(kalemler.map((k) => k.externalOrderId)).size };
}

/**
 * Satır adını ürüne bağla (varsa eski bağın yerine). Geçmiş kalemler de bağlanır ve etkilenen
 * siparişler eskitilir; yeniden hesabı ÇAĞIRAN başlatır (bkz. route).
 */
export async function satiriBagla(
  platform: string,
  ad: string,
  urunId: string
): Promise<EtkilenenSiparisler> {
  const lineKey = satirBagiAnahtari(ad);
  if (!lineKey) throw new Error("Satır adı boş.");
  const eski = await prisma.orderLineLink.findUnique({
    where: { platform_lineKey: { platform, lineKey } },
    select: { productId: true },
  });
  await prisma.orderLineLink.upsert({
    where: { platform_lineKey: { platform, lineKey } },
    create: {
      id: `oll_${randomUUID()}`,
      platform,
      lineKey,
      lineName: ad.trim().slice(0, 300),
      productId: urunId,
    },
    update: { productId: urunId, lineName: ad.trim().slice(0, 300) },
  });

  const kalemler = [
    ...(await adaUyanKalemler(platform, lineKey, null)),
    ...(eski && eski.productId !== urunId ? await adaUyanKalemler(platform, lineKey, eski.productId) : []),
  ];
  await kalemleriBagla(
    kalemler.map((k) => k.id),
    urunId
  );
  const e = etkilenenler(platform, kalemler);
  await ozetleriEskit(e);
  return e;
}

/** Bağı kaldır: o adla bağlanmış geçmiş kalemler yeniden "eşleşmedi" olur. */
export async function bagiKaldir(platform: string, ad: string): Promise<EtkilenenSiparisler> {
  const lineKey = satirBagiAnahtari(ad);
  const bos: EtkilenenSiparisler = { platform, externalOrderIds: [], aylar: [] };
  if (!lineKey) return bos;
  const bag = await prisma.orderLineLink.findUnique({
    where: { platform_lineKey: { platform, lineKey } },
    select: { productId: true },
  });
  if (!bag) return bos;
  await prisma.orderLineLink.deleteMany({ where: { platform, lineKey } });
  const kalemler = await adaUyanKalemler(platform, lineKey, bag.productId);
  await kalemleriBagla(
    kalemler.map((k) => k.id),
    null
  );
  const e = etkilenenler(platform, kalemler);
  await ozetleriEskit(e);
  return e;
}
