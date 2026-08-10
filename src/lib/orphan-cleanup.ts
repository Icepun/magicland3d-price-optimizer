/**
 * Ürün silinince ona bağlı satırların AÇIKÇA temizlenmesi.
 *
 * NEDEN: prisma/schema.prisma'da `onDelete: Cascade` yazıyor ama bulut (Turso) tabloları
 * runtime-schema.ts tarafından yaratılıyor ve orada ProductCost / PriceHistory /
 * ProductModelFile / PrintFileProduct için FOREIGN KEY YOK (yalnız Listing'de var).
 * Yani bulutta ürün silinince bu satırlar "yetim" kalıyor. Yedek geri yükleme
 * (src/app/api/data/import/route.ts) her satırın ürününü zorunlu tutuyor; bulunmayan ürüne
 * bakan tek bir yetim satır TÜM geri yüklemeyi hataya düşürüyor. Bu yüzden silme akışı
 * cascade'e güvenmez, bağlı satırları kendisi siler.
 *
 * FilamentUsage İSTİSNASI: o satır bir makaradan düşülen gramın KAYDI (stok geçmişi);
 * ürünle birlikte silmek filament geçmişini bozar. Bunun yerine ürün bağı koparılır
 * (productId = NULL) — `productName` metni satırda kaldığı için kayıt okunur kalır ve
 * geri yükleme artık olmayan bir ürünü aramaz.
 *
 * PERFORMANS: uzak-HTTP modunda her ifade ~96ms ve TÜM sorgular süreç genelinde sıralı.
 * Bu yüzden tüm DELETE'ler tek batch turunda gider; batch uygun değilse (embedded replica)
 * sıralı yola düşülür.
 */
import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";

/**
 * "Özel Baskılar" arşivi gerçek bir Product satırına bağlı değildir; ProductModelFile'da bu
 * sentinel id ile saklanır. Yanlışlıkla gelirse arşivi silmeyelim diye her zaman elenir.
 */
const CUSTOM_PRINT_PRODUCT_ID = "__custom__";

/** Tek turda gönderilecek en fazla ürün kimliği (SQLite parametre sınırının çok altında). */
const ID_CHUNK = 200;

/** productId kolonu olan ve ürünle birlikte SİLİNMESİ gereken tablolar. */
const CASCADE_TABLES = [
  "ProductCost",
  "PriceHistory",
  "Listing",
  "ProductModelFile",
  "PrintFileProduct",
] as const;

export type OrphanCleanupResult = {
  /** İşlenen (süzülmüş) ürün kimlikleri */
  productIds: string[];
  /** Tek istekte mi gönderildi (uzak-HTTP batch) */
  batched: boolean;
  /** Sıralı yolda etkilenen toplam satır; batch yolunda satır sayısı dönmediği için null */
  affectedRows: number | null;
};

type Statement = { sql: string; args: unknown[] };

/** Boş/yinelenen/sentinel kimlikleri ele. */
function normalizeIds(productIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of productIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || id === CUSTOM_PRINT_PRODUCT_ID) continue;
    seen.add(id);
  }
  return [...seen];
}

/**
 * Temizlik ifadelerini üret (test edilebilir olsun diye ayrı).
 * Sıra: önce bağlı satırlar silinir, en son filament kaydının bağı koparılır.
 */
export function buildOrphanCleanupStatements(productIds: readonly string[]): Statement[] {
  const ids = normalizeIds(productIds);
  if (ids.length === 0) return [];

  const statements: Statement[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const table of CASCADE_TABLES) {
      statements.push({
        sql: `DELETE FROM "${table}" WHERE "productId" IN (${placeholders})`,
        args: [...chunk],
      });
    }
    // Filament düşüm geçmişi SİLİNMEZ; yalnız ürün bağı koparılır (yukarıdaki NEDEN).
    statements.push({
      sql: `UPDATE "FilamentUsage" SET "productId" = NULL WHERE "productId" IN (${placeholders})`,
      args: [...chunk],
    });
  }
  return statements;
}

/**
 * Verilen ürünlere bağlı satırları temizler. Idempotent — aynı kimliklerle tekrar
 * çağrılabilir (silme tekrar denenirse ikinci tur zararsızdır).
 */
export async function cleanupProductOrphans(
  productIds: readonly string[]
): Promise<OrphanCleanupResult> {
  const ids = normalizeIds(productIds);
  if (ids.length === 0) return { productIds: [], batched: false, affectedRows: 0 };

  const statements = buildOrphanCleanupStatements(ids);

  // Tek istekte gönder; mod uygun değilse (embedded replica / yerel dosya) sıralı yola düş.
  if (await batchWrite(statements)) {
    return { productIds: ids, batched: true, affectedRows: null };
  }

  let affectedRows = 0;
  for (const stmt of statements) {
    affectedRows += await prisma.$executeRawUnsafe(stmt.sql, ...(stmt.args as never[]));
  }
  return { productIds: ids, batched: false, affectedRows };
}
