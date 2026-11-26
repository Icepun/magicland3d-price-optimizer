import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bustCache } from "@/lib/route-cache";
import { batchWrite } from "@/lib/libsql-batch";
import { bustProductCaches } from "@/lib/cache-busting";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { nowDbDateSql } from "@/lib/sqlite-date";
import { N11Client, N11Hatasi } from "@/services/n11-client";
import { n11Kimligi } from "@/services/n11-settings";
import { n11IlaniOku, n11IlanEslestir, type N11Ilan } from "@/lib/n11-ilanlar";

export const dynamic = "force-dynamic";

/**
 * n11 ürün/ilan senkronu — Hepsiburada senkronuyla aynı düzen, YALNIZ OKUMA (n11'e hiçbir şey yazılmaz):
 *  - "add-new":        stok kodu ürünlerimizden birine tutan n11 ilanını Listing olarak bağla; tutmayanları
 *                      UnmatchedListing havuzunda tazele ("Ürün Seç" / "Pazaryeri Ürünü Ekle").
 *  - "refresh-prices": bağlı n11 ilanlarında fiyat, stok, komisyon ve KDV oranını tazele.
 *  - "full":           ikisi birden.
 *
 * EŞLEŞTİRME (26 Kas 2026 ölçüldü): n11'de barkod boş, stok kodu dolu ve Trendyol barkodlarıyla aynı
 * biçimde. 346 ilanın 217'si mevcut ürün/ilan anahtarlarıyla tek ürüne tutuyor (194'ü Trendyol ilan
 * barkodu) — bu yüzden ürünün kendi barkodu yetmez, diğer platform ilanlarının anahtarlarına da bakılır.
 */
const Schema = z.object({
  mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const kimlik = await n11Kimligi().catch((e: Error) => {
      throw new N11Hatasi(e.message, 400);
    });
    const n11 = new N11Client(kimlik);

    // 1) n11 ilanları (sayfa başına 50). Herhangi bir sayfa düşerse senkron TÜMÜYLE durur —
    //    yarım listeyle eşleşmeyen havuzu temizlemek veri kaybettirirdi.
    const ilanlar = new Map<string, N11Ilan>();
    for (let sayfa = 0; sayfa < 200; sayfa++) {
      const s = await n11.urunler(sayfa, 50);
      for (const ham of s.icerik) {
        const ilan = n11IlaniOku(ham);
        if (ilan && !ilanlar.has(ilan.stockCode)) ilanlar.set(ilan.stockCode, ilan);
      }
      if (s.icerik.length === 0 || sayfa + 1 >= s.toplamSayfa) break;
    }

    async function refreshPrices() {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ listingId: string; productId: string; salePrice: number; stock: number; externalSku: string | null; commissionRate: number | null; vatRate: number | null }>
      >(
        `SELECT id AS listingId, productId, salePrice, stock, externalSku, commissionRate, vatRate
           FROM Listing WHERE platform = 'n11'`
      );
      const yazmalar: { sql: string; args: unknown[] }[] = [];
      const gecmis: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      const SQL = `UPDATE Listing SET salePrice = ?, listPrice = ?, stock = ?, commissionRate = ?, vatRate = ?,
                     lastSyncedAt = ${nowDbDateSql()}, updatedAt = ${nowDbDateSql()} WHERE id = ?`;
      let changed = 0;
      let gecersizFiyat = 0;
      for (const row of rows) {
        const ilan = row.externalSku ? ilanlar.get(row.externalSku) : undefined;
        if (!ilan) continue;
        // SIFIR FİYAT KORUMASI (diğer pazaryerleri gibi): geçersiz fiyat ASLA yazılmaz.
        if (!(ilan.price > 0)) { gecersizFiyat++; continue; }
        const fiyatDegisti = Math.abs(ilan.price - row.salePrice) > 0.001;
        const digerDegisti =
          ilan.stock !== Number(row.stock) ||
          (ilan.commissionRate ?? null) !== (row.commissionRate ?? null) ||
          (ilan.vatRate ?? null) !== (row.vatRate ?? null);
        if (!fiyatDegisti && !digerDegisti) continue;
        if (fiyatDegisti) {
          gecmis.push({ productId: row.productId, oldPrice: row.salePrice, newPrice: ilan.price, changeSource: "n11_sync" });
          changed++;
        }
        yazmalar.push({ sql: SQL, args: [ilan.price, ilan.listPrice, ilan.stock, ilan.commissionRate, ilan.vatRate, row.listingId] });
      }
      // TOPLU BOZULMA FRENİ: eşleşenlerin neredeyse hepsi geçersizse sorun yanıt biçimindedir.
      const eslesen = gecersizFiyat + yazmalar.length;
      if (eslesen >= 10 && gecersizFiyat > eslesen * 0.9) {
        throw new Error("n11'den gelen fiyatların neredeyse tamamı geçersiz. Fiyatlar güncellenmedi.");
      }
      if (yazmalar.length && !(await batchWrite(yazmalar))) {
        for (const w of yazmalar) await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
      }
      if (gecmis.length) await prisma.priceHistory.createMany({ data: gecmis });
      return { checked: rows.length, changed };
    }

    async function addNew() {
      const urunler = await prisma.$queryRawUnsafe<Array<{ id: string; barcode: string | null; sku: string | null }>>(
        `SELECT id, barcode, sku FROM Product`
      );
      const digerIlanlar = await prisma.$queryRawUnsafe<
        Array<{ productId: string; barcode: string | null; externalSku: string | null }>
      >(`SELECT productId, barcode, externalSku FROM Listing WHERE platform <> 'n11'`);
      const bagli = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
        `SELECT productId FROM Listing WHERE platform = 'n11'`
      );
      const eslesme = n11IlanEslestir([...ilanlar.values()], urunler, digerIlanlar);
      const bagliSet = new Set(bagli.map((b) => b.productId));

      const yazmalar: { sql: string; args: unknown[] }[] = [];
      const ILAN_SQL = `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, listPrice, stock,
                          commissionRate, vatRate, isActive, lastSyncedAt, createdAt, updatedAt)
                        VALUES (?, ?, 'n11', ?, ?, ?, ?, ?, ?, ?, ?, 1, ${nowDbDateSql()}, ${nowDbDateSql()}, ${nowDbDateSql()})`;
      const HAVUZ_SQL = `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
                         VALUES (?, 'n11', ?, ?, ?, ?, 'n11', ?, ?, ?, ${nowDbDateSql()}, ${nowDbDateSql()})
                         ON CONFLICT(platform, externalId) DO UPDATE SET
                           externalSku=excluded.externalSku, barcode=excluded.barcode, name=excluded.name,
                           price=excluded.price, stock=excluded.stock, imageUrl=excluded.imageUrl, lastSeenAt=${nowDbDateSql()}`;
      let linked = 0;
      let unmatched = 0;
      const havuzdaKalan: string[] = [];
      for (const { ilan, productId } of eslesme) {
        if (productId) {
          // Fiyatı bilinmeyen ilan bağlanmaz (0 TL'lik ilan kârı yanlış gösterirdi); fiyat gelince bağlanır.
          if (!bagliSet.has(productId) && ilan.price > 0) {
            yazmalar.push({
              sql: ILAN_SQL,
              args: [`listing_${productId}_n11`, productId, ilan.externalId, ilan.stockCode, ilan.barcode, ilan.price, ilan.listPrice, ilan.stock, ilan.commissionRate, ilan.vatRate],
            });
            bagliSet.add(productId);
            linked++;
          }
        } else {
          const id = `unmatched_n11_${ilan.externalId}`;
          havuzdaKalan.push(id);
          yazmalar.push({
            sql: HAVUZ_SQL,
            args: [id, ilan.externalId, ilan.stockCode, ilan.barcode, ilan.name, ilan.price > 0 ? ilan.price : 0, ilan.stock, ilan.imageUrl],
          });
          unmatched++;
        }
      }
      if (yazmalar.length && !(await batchWrite(yazmalar))) {
        for (const w of yazmalar) await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
      }
      // Artık havuzda olmaması gerekenleri (eşleşti / n11'den kalktı) temizle. Hiç ilan gelmediyse
      // (geçici API durumu) temizlik YOK — veri silme riski.
      if (ilanlar.size > 0) {
        if (havuzdaKalan.length) {
          await prisma.$executeRawUnsafe(
            `DELETE FROM UnmatchedListing WHERE platform = 'n11' AND id NOT IN (${havuzdaKalan.map(() => "?").join(",")})`,
            ...havuzdaKalan
          );
        } else {
          await prisma.$executeRawUnsafe(`DELETE FROM UnmatchedListing WHERE platform = 'n11'`);
        }
      }
      return { linked, unmatched };
    }

    let result: Record<string, number> = {};
    if (input.mode === "refresh-prices") result = await refreshPrices();
    else if (input.mode === "add-new") result = await addNew();
    else result = { ...(await addNew()), ...(await refreshPrices()) };

    if (Number(result.checked ?? 0) > 0) {
      await prisma.appSetting.upsert({
        where: { key: "n11LastSyncAt" },
        create: { key: "n11LastSyncAt", value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
    }
    bustProductCaches();
    bustCache("settings:");
    return NextResponse.json({ mode: input.mode, fetched: ilanlar.size, ...result });
  } catch (error) {
    if (error instanceof N11Hatasi) return NextResponse.json({ error: error.message }, { status: error.durum });
    return jsonError(error);
  }
}
