/**
 * TRENDYOL ÜRÜN V2 GÖÇÜ — sessiz bozulmanın kalıcı koruması.
 *
 * Eski tek uç (`/products` + `approved` parametresi) 15 Eylül 2026'da kapanıyor; o tarihe
 * kadar gün içinde 3×15 dk "brownout" ile 426 dönüyor (kullanıcının gördüğü hata buydu).
 *
 * GÖÇÜN EN TEHLİKELİ YANI: yanıt gövdesi kökten değişti (fiyat/stok artık `variants[]`
 * altında) ama TÜM alanlar opsiyonel olduğu için yanlış eşleme DERLEME HATASI VERMEZ —
 * fiyat sessizce 0, ad barkod, kategori "Trendyol" olur ve fiyat geçmişine 0 TL yazılır.
 * Bu dosya düzleştiricilerin doğru alanları okuduğunu kilitler.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ISTEMCI = readFileSync(join(process.cwd(), "src/services/trendyol-client.ts"), "utf8");
const SENKRON = readFileSync(join(process.cwd(), "src/app/api/trendyol/sync-products/route.ts"), "utf8");

describe("v2 uçları", () => {
  it("ONAYLI ÜRÜN ucu kullanılıyor (eski tek uç değil)", () => {
    expect(ISTEMCI).toContain("/products/approved?");
  });

  it("fiyat yenileme HAFİF uca gidiyor", () => {
    expect(ISTEMCI).toContain("/products/approved/inventory-and-price?");
    expect(SENKRON).toContain("listApprovedInventoryAndPrice");
  });

  it("eski uç ve kalkan `approved` parametresi kodda KALMADI", () => {
    // Eski yol: ".../products?" — yeni yollar hep bir alt segment taşıyor.
    expect(ISTEMCI).not.toMatch(/\/products\?\$\{/);
    expect(ISTEMCI).not.toContain('searchParams.set("approved"');
  });

  it("sipariş ucu da v2'ye taşındı (15 Ekim 2026)", () => {
    expect(ISTEMCI).toContain("/v2/orders?");
  });

  it("sayfa × boyut 10.000 sınırı şemada zorlanıyor", () => {
    expect(SENKRON).toContain("10_000");
  });
});

describe("sıfır fiyat koruması", () => {
  it("geçersiz fiyat yazılmıyor", () => {
    expect(SENKRON).toMatch(/Number\.isFinite\(f\.price\)/);
    expect(SENKRON).toMatch(/f\.price <= 0/);
  });

  it("toplu bozulmada senkron duruyor", () => {
    // Bir alan adı kayarsa tek tek atlamak yetmez; kullanıcıya haber verilmeli.
    expect(SENKRON).toContain("atlananSifir");
    expect(SENKRON).toMatch(/throw new Error\(/);
  });
});

describe("brownout kullanıcıya anlaşılır anlatılıyor", () => {
  it("426 VE gövde metni birlikte yakalanıyor", () => {
    // Durum kodu dokümanda garanti değil; yalnız 426'ya güvenmek yetmez.
    expect(ISTEMCI).toContain("brownout");
    expect(ISTEMCI).toContain("product v2");
    expect(ISTEMCI).toContain("status === 426");
  });

  it("ham İngilizce API metni kullanıcıya gösterilmiyor", () => {
    expect(ISTEMCI).toContain("Trendyol tarafında kısa süreli bakım var");
  });
});

describe("v2 düzleştiricileri doğru alanları okuyor", () => {
  const onayli = ISTEMCI.slice(
    ISTEMCI.indexOf("function duzlestirOnayli"),
    ISTEMCI.indexOf("function duzlestirStokFiyat"),
  );
  const stokFiyat = ISTEMCI.slice(ISTEMCI.indexOf("function duzlestirStokFiyat"));

  it("onaylı uçta fiyat/stok İÇ İÇE okunuyor", () => {
    expect(onayli).toContain("v.price?.salePrice");
    expect(onayli).toContain("v.price?.listPrice");
    expect(onayli).toContain("v.stock?.quantity");
  });

  it("onaylı uçta kategori yeni adıyla okunuyor", () => {
    // v1'de `categoryName` düzdü; v2'de `category.name`.
    expect(onayli).toContain("c.category?.name");
  });

  it("HAFİF uçta fiyat/stok DÜZ okunuyor (sarmalayıcı yok)", () => {
    // İki ucun biçimi farklı; hafif uca `price.` eklemek fiyatı 0 yapardı.
    expect(stokFiyat).toContain("v.salePrice");
    expect(stokFiyat).toContain("v.quantity");
    expect(stokFiyat).not.toContain("v.price?.");
    expect(stokFiyat).not.toContain("v.stock?.");
  });

  it("barkodsuz varyant elenmiş", () => {
    // Barkod eşleştirmenin anahtarı; boş barkod tüm eşleşmeyi bozar.
    expect(onayli).toContain("filter((v) => !!v.barcode)");
    expect(stokFiyat).toContain("filter((v) => !!v.barcode)");
  });
});
