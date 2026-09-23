import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dbEpochMs } from "@/core/sqlite-date";
import { bustProductViewCaches } from "@/lib/cache-busting";

export const dynamic = "force-dynamic";

/** Tek yanıtta dönecek en fazla ürün — toplu senkron sonrası bile yanıt küçük kalsın. */
const AZAMI = 1000;

/**
 * SON OKUMADAN BERİ DEĞİŞEN ÜRÜNLERİN STOĞU — ekrana dönüşte hafif tazeleme.
 *
 * SORUN (23 Eyl 2026): Ürünler listesi kullanıcının isteğiyle ("Yenile demedikçe veri çekme")
 * kendiliğinden hiç tazelenmiyor. Masaüstünde yapılan stok değişikliği listeye anında yansıyor
 * ama TELEFONDAN yapılan değişiklik yalnız ağır "Fiyatları Güncelle & Yenile" ile geliyordu;
 * üstelik sunucu önbelleği önce eski gövdeyi veriyordu. Kullanıcı: "stok düşüp ürünler
 * sayfasına geri gelince o ürün hâlâ güncellenmemiş görünüyor, refresh yok".
 *
 * Bu uç tek bir küçük sorgu yapar (kâr hesabı yok): `since` anından sonra güncellenmiş ürünlerin
 * yalnız stoğu. Değişiklik varsa sunucudaki liste gövdeleri de düşürülür — yoksa sonraki
 * "Yenile" önbellekteki eski stoğu geri getirip yamayı ezerdi.
 *
 * `updatedAt` iki biçimde yazılmış olabilir (telefon eskiden "…Z", masaüstü "…+00:00");
 * karşılaştırma `dbEpochMs` ile biçimden bağımsız yapılır.
 */
export async function GET(req: NextRequest) {
  try {
    const simdi = Date.now();
    const since = Number(req.nextUrl.searchParams.get("since"));
    if (!Number.isFinite(since) || since <= 0) return NextResponse.json({ now: simdi, items: [] });
    await ensureRuntimeSchema();

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; stock: number | bigint }>>(
      `SELECT "id", "stock" FROM "Product" WHERE ${dbEpochMs("updatedAt")} >= ? LIMIT ${AZAMI}`,
      Math.floor(since),
    );
    const items = rows.map((r) => ({ id: r.id, stock: Number(r.stock) }));
    if (items.length > 0) bustProductViewCaches();
    return NextResponse.json({ now: simdi, items });
  } catch (error) {
    return jsonError(error);
  }
}
