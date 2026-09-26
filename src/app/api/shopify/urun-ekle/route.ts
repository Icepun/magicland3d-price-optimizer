import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { batchWrite } from "@/lib/libsql-batch";
import { bustProductCaches } from "@/lib/cache-busting";
import { nowDbDateSql } from "@/lib/sqlite-date";
import { eklemePlani, varyantKimligi, type EklemePlani } from "@/lib/shopify-katalog";
import { katalogGetir, yoksayilanlariGuncelle } from "@/lib/shopify-katalog-sunucu";

/**
 * Shopify'dan SEÇİLEN ürünleri ekle. Ad kullanıcıdan, fiyat/görsel/barkod Shopify'dan gelir.
 * İstemci en fazla 20 ürünü tek istekte yollar (pencere ilerlemeyi dilim dilim gösterir).
 */
const Schema = z.object({
  urunler: z
    .array(
      z.object({
        shopifyUrunId: z.string().min(1),
        ad: z.string().max(200).default(""),
        siparisUzerine: z.boolean().default(true),
        stok: z.number().int().min(0).max(100_000).default(0),
        varyantlar: z
          .array(z.object({ id: z.string().min(1), etiket: z.string().max(80).nullable().optional() }))
          .min(1, "En az bir seçenek seç"),
      })
    )
    .min(1, "Eklenecek ürün seç")
    .max(20),
});

type Ifade = { sql: string; args: unknown[] };

function ifadeler(plan: EklemePlani): Ifade[] {
  const simdi = nowDbDateSql();
  const out: Ifade[] = [];
  for (const g of plan.gruplar) {
    out.push({
      sql: `INSERT INTO VariantGroup (id, name, createdAt, updatedAt) VALUES (?, ?, ${simdi}, ${simdi})`,
      args: [g.id, g.ad],
    });
  }
  // Ürün + ilanı ARDIŞIK: toplu yazım dilimlenirken bir ürünün ilanı ayrı dilime düşmez.
  for (const u of plan.urunler) {
    out.push({
      sql: `INSERT INTO Product (id, barcode, sku, name, categoryName, currentSalePrice, stock, imageUrl, isActive,
              source, madeToOrder, variantGroupId, variantLabel, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'shopify', ?, ?, ?, ${simdi}, ${simdi})`,
      args: [
        u.id,
        u.barkod,
        u.sku,
        u.ad,
        u.kategori,
        u.fiyat,
        u.stok,
        u.gorsel,
        u.siparisUzerine ? 1 : 0,
        u.grupId,
        u.varyantEtiketi,
      ],
    });
    out.push({
      sql: `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, stock, isActive,
              lastSyncedAt, createdAt, updatedAt)
            VALUES (?, ?, 'shopify', ?, ?, ?, ?, ?, 1, ${simdi}, ${simdi}, ${simdi})`,
      args: [u.ilan.id, u.id, u.ilan.varyantId, u.ilan.sku, u.ilan.barkod, u.ilan.fiyat, u.ilan.stok],
    });
  }
  return out;
}

export async function POST(req: Request) {
  try {
    await ensureRuntimeSchema();
    const { urunler: secimler } = Schema.parse(await req.json());

    let { urunler: katalog } = await katalogGetir(false);
    const bilinen = new Set(katalog.map((k) => k.id));
    if (secimler.some((s) => !bilinen.has(s.shopifyUrunId))) {
      // Pencere açıldıktan sonra Shopify'a eklenmiş olabilir — bir kez tazele.
      katalog = (await katalogGetir(true)).urunler;
    }

    const varyantIdleri = [...new Set(secimler.flatMap((s) => s.varyantlar.map((v) => v.id)))];
    const bagli = await prisma.listing.findMany({
      where: { platform: "shopify", externalId: { in: varyantIdleri } },
      select: { externalId: true },
    });

    // Aday barkodlar (Shopify barkodu/stok kodu + varyant kimliği) — çakışanlar önceden bilinsin.
    const katalogVaryantlari = new Map(katalog.flatMap((k) => k.varyantlar.map((v) => [v.id, v] as const)));
    const adayBarkodlar = varyantIdleri.flatMap((id) => {
      const v = katalogVaryantlari.get(id);
      return v ? [varyantKimligi(v), `shopify-variant-${v.id}`] : [];
    });
    const mevcut = adayBarkodlar.length
      ? await prisma.product.findMany({ where: { barcode: { in: adayBarkodlar } }, select: { barcode: true } })
      : [];

    const plan = eklemePlani(
      secimler,
      katalog,
      new Set(bagli.map((b) => b.externalId ?? "")),
      new Set(mevcut.map((m) => m.barcode)),
      (onek) => `${onek}_${randomUUID().replace(/-/g, "")}`
    );

    const yazilacak = ifadeler(plan);
    if (yazilacak.length > 0 && !(await batchWrite(yazilacak))) {
      for (const w of yazilacak) await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
    }

    const eklenenVaryantlar = plan.urunler.map((u) => u.ilan.varyantId);
    // Gizlenenlerden eklendiyse artık gizli sayılmasın.
    await yoksayilanlariGuncelle([], eklenenVaryantlar).catch(() => {});
    if (plan.urunler.length > 0) bustProductCaches();

    return NextResponse.json({
      eklenen: plan.urunler.length,
      urunIdleri: plan.urunler.map((u) => u.id),
      atlanan: plan.atlanan,
    });
  } catch (error) {
    return jsonError(error);
  }
}
