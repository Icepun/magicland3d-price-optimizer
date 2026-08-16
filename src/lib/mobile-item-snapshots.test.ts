import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ÜRÜN BAZLI SATIŞ GEÇMİŞİ — telefon de yazmalı.
 *
 * NE OLUYORDU: mobil finans senkronu yalnız sipariş TOPLAMINI (`OrderFinanceSnapshot`)
 * yazıyordu; kalemler (`OrderItemSnapshot`) yalnız masaüstünden yazılıyordu. Masaüstü birkaç
 * gün kapalı kaldığında o günlerin ürün kırılımı hiç kaydedilmiyor, pazaryeri penceresi
 * kayınca da BİR DAHA türetilemiyordu. Etkilenenler: üretim planındaki "satış hızı"
 * (mobile/src/lib/db/sales-rate.ts), Raporlar'ın ürün kırılımı, kargo kuralı kapsamı.
 *
 * NEDEN YAPISAL TEST: yazma yolu Turso'ya bağlı; kökteki vitest'te `@/lib/turso` çözülmez.
 * Riskin özü "şu kolonlar şu kimlikle yazılıyor mu" olduğu için kaynak üzerinde doğrulanıyor.
 * (Testin `mobile/` altına konulamayacağı kuralı: mobile/AGENTS.md.)
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const MOBIL = oku("mobile/src/lib/db/finance.ts");
const MASAUSTU = oku("src/lib/order-finance-snapshots.ts");

describe("mobil kalem anlık görüntüsü", () => {
  it("mobil OrderItemSnapshot'a yazıyor", () => {
    expect(MOBIL).toContain('INSERT INTO "OrderItemSnapshot"');
  });

  /** Kimlik masaüstüyle AYNI olmalı: farklı olsa iki cihaz aynı kalemi iki satır olarak yazardı. */
  it("satır kimliği masaüstüyle aynı düzende", () => {
    expect(MOBIL).toContain("`item:${snapshot.platform}:${snapshot.externalOrderId}:${lineIndex}`");
    expect(MASAUSTU).toContain("`item:${platform}:${externalOrderId}:${lineIndex}`");
  });

  it("kolon listesi masaüstüyle birebir", () => {
    const kolonlar = (kaynak: string) => {
      const bas = kaynak.indexOf('INSERT INTO "OrderItemSnapshot"');
      const dilim = kaynak.slice(bas, kaynak.indexOf("VALUES", bas));
      return (dilim.match(/"(\w+)"/g) ?? []).slice(1).join(",");
    };
    expect(kolonlar(MOBIL)).toBe(kolonlar(MASAUSTU));
  });

  /**
   * SQLite'ta tamsayı METİNDEN önce sıralanır: kalem satırı epoch-ms sayı ile yazılırsa
   * masaüstünün `orderedAt >= …` filtresi o satırları sessizce eler ve rapor eksik çıkar.
   */
  it("tarih ISO metin yazılır (sipariş satırıyla aynı biçim)", () => {
    const blok = MOBIL.slice(MOBIL.indexOf('INSERT INTO "OrderItemSnapshot"'));
    expect(blok).toContain("asDate(snapshot.orderedAt).toISOString()");
  });

  it("çakışmada güncellenir — kopya satır oluşmaz", () => {
    expect(MOBIL).toContain('ON CONFLICT("platform","externalOrderId","lineIndex") DO UPDATE');
  });

  it("kalemi eksik eski siparişler tamamlanır (geriye dönük delik kapanır)", () => {
    expect(MOBIL).toContain("kalemiEksik");
    // Sorgu pencere ile sınırlı: kalıcı geçmişin tamamı her senkronda çekilmemeli.
    expect(MOBIL).toContain('FROM "OrderItemSnapshot"\n        WHERE');
  });

  it("kalemler senkron girdisine gerçekten aktarılıyor", () => {
    const sync = oku("mobile/src/lib/finance-sync.ts");
    expect(sync).toContain("items: o.items.map");
    expect(sync).toContain("productId: it.productId ?? null");
  });

  it("manuel siparişler hariç — kendi tablosunda tutuluyorlar", () => {
    const blok = MOBIL.slice(MOBIL.indexOf("const itemStatements"));
    expect(blok).toContain('s.platform !== "manual"');
  });
});
