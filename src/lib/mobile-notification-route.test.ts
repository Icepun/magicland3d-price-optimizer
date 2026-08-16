import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BİLDİRİM DERİN BAĞLANTISI — uyarıya dokununca DOĞRU ekran açılmalı.
 *
 * Kalıcı bildirimleri masaüstü yazıyor ve MASAÜSTÜ yollarını taşıyorlar (`/products/<id>`,
 * `/spools?g=…`). Telefonda rota adları farklı (`/product/<id>`, `/spools`). Çeviri yanlışsa
 * kullanıcı "yazıcı hata veriyor" bildirimine dokunup boş bir ekrana düşer.
 *
 * NEDEN YAPISAL: mobil modül `@/lib/turso`'yu içe aktarıyor (ağ katmanı); kökteki vitest'te
 * bu takma ad çözülmez. Çeviri fonksiyonu saf olduğu için kaynaktan çıkarıp burada çalıştırmak
 * hem gerçek kodu doğrular hem takma-ad cerrahisi gerektirmez.
 * (Testin `mobile/` altına KONULAMAYACAĞI kuralı için bkz. mobile/AGENTS.md.)
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const KAYNAK = fs.readFileSync(
  path.join(ROOT, "mobile/src/lib/db/notifications.ts"),
  "utf8"
);

/** Gerçek `mobileRoute` gövdesini kaynaktan alıp çalıştırılabilir hale getir. */
function loadMobileRoute(): (href: string | null | undefined) => string | null {
  const basla = KAYNAK.indexOf("export function mobileRoute(");
  expect(basla, "mobileRoute bulunamadı — bildirim rotası kaldırılmış olabilir").toBeGreaterThan(-1);
  const govde = KAYNAK.slice(KAYNAK.indexOf("{", basla), KAYNAK.indexOf("\n}", basla) + 2);
  const ts = govde.replace(/: string \| null \| undefined|: string \| null/g, "");
  return new Function("href", `return (function(href)${ts})(href);`) as (
    href: string | null | undefined
  ) => string | null;
}

describe("bildirim → mobil rota çevirisi", () => {
  const rota = loadMobileRoute();

  it("ürün bildirimi ürün detayına gider (masaüstü çoğul, mobil tekil)", () => {
    expect(rota("/products/abc123")).toBe("/product/abc123");
  });

  it("filament uyarısı makara ekranına gider (grup sorgusu atılır)", () => {
    expect(rota("/spools?g=pla__siyah")).toBe("/spools");
  });

  it("yazıcı ve sipariş yolları karşılığına gider", () => {
    expect(rota("/printers")).toBe("/printers");
    expect(rota("/orders?filter=hazirlik")).toBe("/orders");
    expect(rota("/planner")).toBe("/planner");
  });

  it("tanımadığımız yol için rota YOK — yanlış ekrana atmaz", () => {
    expect(rota("/integrations/shopify")).toBeNull();
    expect(rota(null)).toBeNull();
    expect(rota("")).toBeNull();
  });
});

describe("uyarı satırı rota ile açılır", () => {
  it("her anlık uyarı türü bir rota taşır", () => {
    // Stok → ürün, filament → makaralar, baskı → yazıcılar.
    expect(KAYNAK).toContain("route: `/product/${p.id}`");
    expect(KAYNAK).toContain('route: "/spools"');
    expect(KAYNAK).toContain('route: "/printers"');
  });

  it("ekran productId yerine route'a bakar (yazıcı uyarısı da tıklanabilir)", () => {
    const ekran = fs.readFileSync(path.join(ROOT, "mobile/src/app/notifications.tsx"), "utf8");
    expect(ekran).toContain("alert.route && router.push(alert.route as never)");
    expect(ekran).not.toContain("alert.productId && router.push");
  });
});
